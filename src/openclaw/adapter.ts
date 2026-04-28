/**
 * OpenClaw plugin — thin IPC bridge to the AOF daemon (Phase 43).
 *
 * Post-43, the daemon owns scheduler/store/logger/metrics/permissions (D-02).
 * The plugin only: (1) keeps a DaemonIpcClient singleton alive, (2) forwards
 * 4/7 lifecycle hooks via IPC (D-07+A1), (3) proxies tools via /v1/tool/invoke
 * (D-06), (4) starts the long-poll spawn-poller once (D-09), (5) proxies
 * /aof/status + /aof/metrics to the daemon's /status (Open Q4).
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/index.js";
import { daemonSocketPath } from "../config/paths.js";
import { toolRegistry } from "../tools/tool-registry.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { DaemonIpcClient, ensureDaemonIpcClient } from "./daemon-ipc-client.js";
import { startSpawnPollerOnce, stopSpawnPoller } from "./spawn-poller.js";
import { startChatDeliveryPollerOnce, stopChatDeliveryPoller } from "./chat-delivery-poller.js";
import { OpenClawToolInvocationContextStore } from "./tool-invocation-context.js";
import { buildStatusProxyHandler } from "./status-proxy.js";
import { mergeDispatchNotificationRecipient } from "./dispatch-notification.js";
import type { OpenClawApi } from "./types.js";

const log = createLogger("openclaw");

export interface AOFPluginOptions {
  dataDir: string;
  pollIntervalMs?: number;
  defaultLeaseTtlMs?: number;
  maxConcurrentDispatches?: number;
  dryRun?: boolean;
  /** Test-only IPC client injection. */
  daemonIpcClient?: DaemonIpcClient;
  /** Test-only invocation-context-store injection. */
  invocationContextStore?: OpenClawToolInvocationContextStore;
}

// callbackDepth source of truth is the IPC envelope (D-06). Env fallback only
// for subscriber re-dispatch paths where callback-delivery.ts mutates
// AOF_CALLBACK_DEPTH in-process (CLAUDE.md §Fragile documented exception).
function parseCallbackDepth(params: { callbackDepth?: number }): number {
  if (typeof params.callbackDepth === "number") return params.callbackDepth;
  return parseInt(process.env.AOF_CALLBACK_DEPTH ?? "0", 10);
}

export function registerAofPlugin(
  api: OpenClawApi,
  opts: AOFPluginOptions,
): { mode: "thin-bridge"; daemonSocketPath: string } {
  const socketPath = daemonSocketPath(opts.dataDir);
  const client = opts.daemonIpcClient ?? ensureDaemonIpcClient({ socketPath });
  const invocationContextStore =
    opts.invocationContextStore ?? new OpenClawToolInvocationContextStore();

  if (typeof client.selfCheck === "function") {
    void client
      .selfCheck()
      .then((ok) => {
        if (!ok) log.warn({ socketPath }, "daemon unreachable on register — will retry on first invoke");
      })
      .catch((err) => log.warn({ err, socketPath }, "selfCheck threw during register"));
  }

  // OpenClaw fires hooks as (event, ctx); session identifiers live on ctx.
  const withCtx = (e: unknown, c: unknown): unknown =>
    e && typeof e === "object" && c && typeof c === "object"
      ? { ...(e as Record<string, unknown>), ...(c as Record<string, unknown>) }
      : e;

  // FORWARDED (4/7) — mutate daemon-owned state.
  api.on("session_end", (event, ctx) => {
    const m = withCtx(event, ctx);
    invocationContextStore.clearSessionRoute(m);
    void client.postSessionEnd(m).catch((err) => log.error({ err }, "postSessionEnd failed"));
  });
  api.on("agent_end", (event, ctx) => {
    void client.postAgentEnd(withCtx(event, ctx)).catch((err) => log.error({ err }, "postAgentEnd failed"));
  });
  api.on("before_compaction", () => {
    invocationContextStore.clearAll();
    void client.postBeforeCompaction().catch((err) => log.error({ err }, "postBeforeCompaction failed"));
  });
  api.on("message_received", (event, ctx) => {
    const m = withCtx(event, ctx);
    invocationContextStore.captureMessageRoute(m);
    void client.postMessageReceived(m).catch((err) => log.error({ err }, "postMessageReceived failed"));
  });

  // LOCAL-ONLY (3/7).
  api.on("message_sent", (event, ctx) =>
    invocationContextStore.captureMessageRoute(withCtx(event, ctx)),
  );
  api.on("before_tool_call", (event, ctx) =>
    invocationContextStore.captureToolCall(withCtx(event, ctx)),
  );
  api.on("after_tool_call", (event, ctx) =>
    invocationContextStore.clearToolCall(withCtx(event, ctx)),
  );

  // Tool-registry loop → IPC proxy.
  for (const [name, def] of Object.entries(toolRegistry)) {
    api.registerTool({
      name,
      description: def.description,
      parameters: zodToJsonSchema(def.schema) as {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
      },
      execute: async (id, params) => {
        const p =
          name === "aof_dispatch"
            ? mergeDispatchNotificationRecipient(params, id, invocationContextStore)
            : params;
        const response = await client.invokeTool({
          pluginId: "openclaw",
          name,
          params: p,
          actor: p.actor as string | undefined,
          projectId: (p.project ?? p.projectId) as string | undefined,
          correlationId: randomUUID(),
          toolCallId: id,
          callbackDepth: parseCallbackDepth(p),
        });
        if ("error" in response) {
          throw new Error(`${response.error.kind}: ${response.error.message}`);
        }
        const body =
          typeof response.result === "string"
            ? response.result
            : JSON.stringify(response.result, null, 2);
        return { content: [{ type: "text" as const, text: body }] };
      },
    });
  }

  // /aof/status + /aof/metrics → IPC proxies to daemon /status (Open Q4).
  // auth: "gateway" — OpenClaw >= 2026.4.11 rejects registrations without
  // an auth descriptor. These are loopback-only observability surfaces; the
  // gateway-token-protected mode is the correct choice.
  if (typeof api.registerHttpRoute === "function") {
    const proxy = buildStatusProxyHandler(socketPath);
    api.registerHttpRoute({ path: "/aof/metrics", handler: proxy, auth: "gateway" });
    api.registerHttpRoute({ path: "/aof/status", handler: proxy, auth: "gateway" });
  }

  // Wrap the long-poll loops as plugin services so OpenClaw can lifecycle
  // them. Without this, every Node process that loads the AOF plugin (the
  // gateway main + every per-session worker per CLAUDE.md "Flavor 1") would
  // call `startSpawnPollerOnce` directly during register(), spawning a
  // long-poll handle that keeps the worker alive forever.
  //
  // OpenClaw's `startPluginServices` (verified in
  // ~/Projects/openclaw/src/plugins/services.ts) runs only in the gateway
  // main process, exactly once during server startup. Workers never invoke
  // it. So registering as a service confines poller startup to the one
  // process that actually owns the dispatch bridge, and gives us a clean
  // stop hook for gateway shutdown.
  //
  // The `startXPollerOnce` helpers stay idempotent at the module level —
  // that's still useful because OpenClaw may re-register a plugin within
  // the same process (config reload, hot-swap), and the gate prevents a
  // double-start in that scenario. Stop is similarly idempotent.
  //
  // See .planning/debug/2026-04-28-aof-dispatch-ghosting-and-worker-hygiene.md
  // (Workstream 2 audit) for the full investigation context.
  api.registerService({
    id: "aof-spawn-poller",
    start: () => startSpawnPollerOnce(client, api),
    stop: () => { stopSpawnPoller(); },
  });
  api.registerService({
    id: "aof-chat-delivery-poller",
    start: () => startChatDeliveryPollerOnce(client, api),
    stop: () => { stopChatDeliveryPoller(); },
  });
  return { mode: "thin-bridge", daemonSocketPath: socketPath };
}
