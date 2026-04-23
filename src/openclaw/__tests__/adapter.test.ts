/**
 * OpenClaw plugin adapter tests — post-Phase-43 thin-bridge shape.
 *
 * The plugin is now a thin IPC proxy to the AOF daemon (D-02). In-plugin
 * scheduler / store / subscription / permission behaviour has moved server-side
 * and is covered by `src/daemon/__tests__/ipc-integration.test.ts` and the
 * tool handlers' own test files. These tests assert the plugin contract only:
 *   - tool-registry loop registers all shared tools with IPC-proxy execute
 *   - aof_dispatch passes captured session routes through
 *     mergeDispatchNotificationRecipient before invokeTool
 *   - event hooks attach for all 7 OpenClaw lifecycle signals
 *   - HTTP routes /aof/status + /aof/metrics are wired
 *   - registerAofPlugin does NOT call api.registerService (D-02 invariant)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { registerAofPlugin } from "../adapter.js";
import type { OpenClawApi } from "../types.js";
import type { DaemonIpcClient } from "../daemon-ipc-client.js";
import { resetDaemonIpcClient } from "../daemon-ipc-client.js";
import { stopSpawnPoller } from "../spawn-poller.js";
import type { InvokeToolResponse } from "../../ipc/schemas.js";

vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }),
}));

function makeMockClient(): DaemonIpcClient {
  return {
    invokeTool: vi.fn(
      async (_env: unknown): Promise<InvokeToolResponse> => ({
        result: { ok: true },
      }),
    ),
    // Never resolves — parks the spawn-poller's long-poll loop on await until
    // `stopSpawnPoller()` flips the module gate in afterEach so the loop can
    // exit cleanly without throwing and spamming logs.
    waitForSpawn: vi.fn(() => new Promise<undefined>(() => {})),
    postSpawnResult: vi.fn(async () => undefined),
    postSessionEnd: vi.fn(async () => undefined),
    postAgentEnd: vi.fn(async () => undefined),
    postBeforeCompaction: vi.fn(async () => undefined),
    postMessageReceived: vi.fn(async () => undefined),
    selfCheck: vi.fn(async () => true),
    socketPath: "/tmp/fake.sock",
  } as unknown as DaemonIpcClient;
}

describe("OpenClaw adapter (thin-bridge, Phase 43)", () => {
  afterEach(() => {
    // Tear down the module-level spawn-poller + DaemonIpcClient singletons so
    // the next test starts clean. Without this, the poller keeps spinning a
    // mock client in the background after the test returns, accumulating
    // microtasks across the suite (manifests as OOM / ERR_IPC_CHANNEL_CLOSED
    // in the pool worker).
    stopSpawnPoller();
    resetDaemonIpcClient();
  });

  it("registers all shared-registry tools + HTTP routes + 7 event hooks; does NOT register a service", () => {
    const services: Array<{ id: string }> = [];
    const tools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }> = [];
    const routes: Array<{ path: string; auth: "gateway" | "plugin" }> = [];
    const events: Record<string, (...args: unknown[]) => void> = {};

    const api: OpenClawApi = {
      registerService: (def) => services.push({ id: def.id }),
      registerTool: (def) => tools.push(def as (typeof tools)[number]),
      registerHttpRoute: (def) => routes.push({ path: def.path, auth: def.auth }),
      on: (event, handler) => {
        events[event] = handler;
      },
    };

    const result = registerAofPlugin(api, {
      dataDir: "/tmp/aof",
      daemonIpcClient: makeMockClient(),
    });

    // D-02 structural invariant: plugin no longer registers a scheduler service.
    expect(services).toEqual([]);

    // All 16 tools from the shared registry (13 core + 3 project-management tools).
    expect(tools.map((t) => t.name)).toEqual([
      "aof_dispatch",
      "aof_task_update",
      "aof_task_complete",
      "aof_status_report",
      "aof_task_edit",
      "aof_task_cancel",
      "aof_task_dep_add",
      "aof_task_dep_remove",
      "aof_task_block",
      "aof_task_unblock",
      "aof_context_load",
      "aof_task_subscribe",
      "aof_task_unsubscribe",
      "aof_project_create",
      "aof_project_list",
      "aof_project_add_participant",
    ]);

    // HTTP routes preserved as IPC proxies (Open Q4), each registered with
    // auth: "gateway" so the OpenClaw gateway loader accepts them
    // (>= 2026.4.11 rejects registrations missing the auth descriptor).
    expect(routes).toEqual([
      { path: "/aof/metrics", auth: "gateway" },
      { path: "/aof/status", auth: "gateway" },
    ]);

    // All 7 hooks wired (D-07 + A1).
    for (const name of [
      "session_end",
      "before_compaction",
      "agent_end",
      "message_received",
      "message_sent",
      "before_tool_call",
      "after_tool_call",
    ]) {
      expect(events[name]).toBeDefined();
    }

    expect(result.mode).toBe("thin-bridge");
    expect(result.daemonSocketPath).toMatch(/daemon\.sock$/);
  });

  it("tool execute proxies through client.invokeTool with the D-06 envelope", async () => {
    const tools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }> = [];
    const api: OpenClawApi = {
      registerService: vi.fn(),
      registerTool: (def) => tools.push(def as (typeof tools)[number]),
      registerHttpRoute: vi.fn(),
      on: vi.fn(),
    };

    const client = makeMockClient();
    registerAofPlugin(api, {
      dataDir: "/tmp/aof",
      daemonIpcClient: client,
    });

    const statusTool = tools.find((t) => t.name === "aof_status_report");
    expect(statusTool).toBeDefined();
    const result = (await statusTool!.execute("tc-42", { actor: "main" })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(client.invokeTool).toHaveBeenCalledTimes(1);
    const envelope = (client.invokeTool as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as Record<string, unknown>;
    expect(envelope.pluginId).toBe("openclaw");
    expect(envelope.name).toBe("aof_status_report");
    expect(envelope.toolCallId).toBe("tc-42");
    expect(envelope.actor).toBe("main");
    expect(typeof envelope.correlationId).toBe("string");
    expect(envelope.callbackDepth).toBe(0);

    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
  });

  it("aof_dispatch runs mergeDispatchNotificationRecipient and forwards the resulting params", async () => {
    const tools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }> = [];
    const events: Record<string, (...args: unknown[]) => void> = {};
    const api: OpenClawApi = {
      registerService: vi.fn(),
      registerTool: (def) => tools.push(def as (typeof tools)[number]),
      registerHttpRoute: vi.fn(),
      on: (event, handler) => {
        events[event] = handler;
      },
    };

    const client = makeMockClient();
    registerAofPlugin(api, {
      dataDir: "/tmp/aof",
      daemonIpcClient: client,
    });

    // Prime the invocation-context store with a captured session + tool call.
    events["message_received"]?.(
      {},
      { sessionKey: "agent:main:telegram:group:42", target: "telegram:-10042", channel: "telegram" },
    );
    events["before_tool_call"]?.(
      { toolName: "aof_dispatch", toolCallId: "tc-1" },
      { sessionKey: "agent:main:telegram:group:42", agentId: "main" },
    );

    const dispatchTool = tools.find((t) => t.name === "aof_dispatch");
    await dispatchTool!.execute("tc-1", {
      title: "Test",
      brief: "probe",
      actor: "main",
    });

    const envelope = (client.invokeTool as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      params: Record<string, unknown>;
    };
    const delivery = envelope.params.notifyOnCompletion as Record<string, unknown>;
    expect(delivery).toBeDefined();
    expect(delivery.kind).toBe("openclaw-chat");
    expect(delivery.sessionKey).toBe("agent:main:telegram:group:42");
  });

  it("aof_dispatch respects notifyOnCompletion: false (no delivery object added)", async () => {
    const tools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }> = [];
    const api: OpenClawApi = {
      registerService: vi.fn(),
      registerTool: (def) => tools.push(def as (typeof tools)[number]),
      registerHttpRoute: vi.fn(),
      on: vi.fn(),
    };

    const client = makeMockClient();
    registerAofPlugin(api, {
      dataDir: "/tmp/aof",
      daemonIpcClient: client,
    });

    const dispatchTool = tools.find((t) => t.name === "aof_dispatch");
    await dispatchTool!.execute("tc-optout", {
      title: "Opted-out",
      brief: "no delivery",
      actor: "main",
      notifyOnCompletion: false,
    });

    const envelope = (client.invokeTool as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      params: Record<string, unknown>;
    };
    expect(envelope.params.notifyOnCompletion).toBe(false);
  });

  it("invokeTool error envelope is surfaced as a thrown Error", async () => {
    const tools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }> = [];
    const api: OpenClawApi = {
      registerService: vi.fn(),
      registerTool: (def) => tools.push(def as (typeof tools)[number]),
      registerHttpRoute: vi.fn(),
      on: vi.fn(),
    };

    const client = makeMockClient();
    (client.invokeTool as unknown as { mockResolvedValueOnce: (v: InvokeToolResponse) => void }).mockResolvedValueOnce({
      error: { kind: "validation", message: "bad input" },
    });

    registerAofPlugin(api, {
      dataDir: "/tmp/aof",
      daemonIpcClient: client,
    });

    const t = tools.find((x) => x.name === "aof_status_report");
    await expect(t!.execute("tc-e", { actor: "main" })).rejects.toThrow(/validation: bad input/);
  });

  it("event hooks forward the 4 A1-amended signals via IPC", async () => {
    const events: Record<string, (...args: unknown[]) => void> = {};
    const api: OpenClawApi = {
      registerService: vi.fn(),
      registerTool: vi.fn(),
      registerHttpRoute: vi.fn(),
      on: (event, handler) => {
        events[event] = handler;
      },
    };

    const client = makeMockClient();
    registerAofPlugin(api, {
      dataDir: "/tmp/aof",
      daemonIpcClient: client,
    });

    events["session_end"]?.({}, {});
    events["agent_end"]?.({ agent: "swe-backend" });
    events["before_compaction"]?.();
    events["message_received"]?.({}, { sessionKey: "k" });
    events["message_sent"]?.({});
    events["before_tool_call"]?.({});
    events["after_tool_call"]?.({});

    expect(client.postSessionEnd).toHaveBeenCalledTimes(1);
    expect(client.postAgentEnd).toHaveBeenCalledTimes(1);
    expect(client.postBeforeCompaction).toHaveBeenCalledTimes(1);
    expect(client.postMessageReceived).toHaveBeenCalledTimes(1);
    // The 3 local-only hooks do not forward.
  });
});
