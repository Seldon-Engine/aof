/**
 * Chat-delivery poller — plugin-side long-poll loop that drains
 * `GET /v1/deliveries/wait` and dispatches each received `ChatDeliveryRequest`
 * to `sendChatDelivery` (which calls the platform-specific OpenClaw outbound
 * send inside the gateway process).
 *
 * Mirrors `spawn-poller.ts` — same module-scope idempotency gate, same
 * exponential backoff on transport errors, same fire-and-forget handler
 * invocation so one slow send cannot stall the loop.
 *
 * @module openclaw/chat-delivery-poller
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/index.js";
import type { DaemonIpcClient } from "./daemon-ipc-client.js";
import type { OpenClawApi } from "./types.js";
import { sendChatDelivery } from "./chat-message-sender.js";
import type { ChatDeliveryRequest } from "../ipc/schemas.js";

const log = createLogger("chat-delivery-poller");
const wakeLog = createLogger("wake-up-delivery");

const EMBEDDED_WAKE_TIMEOUT_MS = 120_000; // 2 minutes — enough for a wake turn

/**
 * Prefix the wake message with a notification framing so the agent treats it
 * as informational rather than a directive. Without this, the agent reads the
 * wake message as its turn's prompt and starts acting (loading skills, calling
 * tools) — heavier than necessary for a "task X finished" notification.
 *
 * Heartbeat-path wakes don't need this: the heartbeat run drains queued
 * system events as turn-context, not as the prompt itself.
 */
const EMBEDDED_WAKE_PROMPT_PREFIX =
  "[AOF status notification — read-only. The task below has ALREADY transitioned " +
  "to its reported state; the daemon has recorded the transition. Do NOT call " +
  "aof_task_complete, aof_task_update, or any other tool that would change the " +
  "task's state — those calls will be rejected by the daemon (the task is in a " +
  "terminal state).\n\n" +
  "What to do: (a) if this notification is unrelated to your active work, reply " +
  "with the literal text NO_REPLY and nothing else; (b) if you want to acknowledge " +
  "or summarize this status to the originating chat, prefix your reply with " +
  "[[reply_to_current]] so it routes back to the user — assistant text without " +
  "that prefix stays in your session transcript and is NOT delivered to the " +
  "human. Default to NO_REPLY unless an acknowledgment is genuinely useful.]\n\n";

/**
 * Per-process set of sessionKeys with an in-flight embedded wake run.
 * OpenClaw serializes runs for the same sessionKey via its session lane, but
 * we still want to prevent N redundant queued runs draining one-by-one when
 * a backlog (recovery-replay) hits the chat-delivery-poller all at once.
 *
 * Race-tolerant: the first run already called enqueueSystemEvent; if a
 * second wake arrives mid-flight, OpenClaw's system-events queue carries the
 * new event for the next run (or for the agent's natural next turn). We
 * never miss events, we just collapse the in-flight runs.
 */
const inFlightEmbeddedWakes = new Set<string>();

const WAIT_TIMEOUT_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

let chatDeliveryPollerStarted = false;

/**
 * Start the long-poll loop if it is not already running. Safe to call from
 * every `registerAofPlugin` invocation — subsequent calls are no-ops. The
 * module-scope gate survives OpenClaw's per-session plugin reload cycle
 * (same trick as `startSpawnPollerOnce`).
 */
export function startChatDeliveryPollerOnce(client: DaemonIpcClient, api: OpenClawApi): void {
  if (chatDeliveryPollerStarted) {
    log.debug("chat delivery poller already started — skip");
    return;
  }
  chatDeliveryPollerStarted = true;
  log.info({ socketPath: client.socketPath }, "chat delivery poller starting");

  void runLoop(client, api).catch((err) => {
    log.error({ err }, "chat delivery poller loop terminated unexpectedly");
    chatDeliveryPollerStarted = false;
  });
}

/** Test helper — stop the loop. It exits after the current waitForChatDelivery resolves. */
export function stopChatDeliveryPoller(): void {
  chatDeliveryPollerStarted = false;
}

/** Test helper — observe current gate state. */
export function isChatDeliveryPollerStarted(): boolean {
  return chatDeliveryPollerStarted;
}

async function runLoop(client: DaemonIpcClient, api: OpenClawApi): Promise<void> {
  let backoffMs = INITIAL_BACKOFF_MS;

  while (chatDeliveryPollerStarted) {
    try {
      const req = await client.waitForChatDelivery(WAIT_TIMEOUT_MS);
      if (!req) {
        backoffMs = INITIAL_BACKOFF_MS;
        continue;
      }

      log.info(
        { id: req.id, subscriptionId: req.subscriptionId, taskId: req.taskId },
        "delivery received",
      );

      // Fire-and-forget: don't block the loop on send latency.
      void dispatchAndAck(client, api, req);

      backoffMs = INITIAL_BACKOFF_MS;
    } catch (err) {
      log.warn({ err, backoffMs }, "delivery poll error, retrying after backoff");
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  log.info("chat delivery poller stopped");
}

async function dispatchAndAck(
  client: DaemonIpcClient,
  api: OpenClawApi,
  req: ChatDeliveryRequest,
): Promise<void> {
  // Phase 45 (minimal in-poller): system-event injection runs INDEPENDENTLY
  // of chat send. The two channels carry orthogonal load:
  //   - chat = human-visible audit message (requires an outbound platform;
  //     fails on subagent/main/cron sessionKeys that don't map to one)
  //   - system-event = the actual agent wake-up (works for any sessionKey
  //     that the heartbeat/embedded-pi runtime knows about, including
  //     `agent:main:main` and `agent:<id>:telegram:...`)
  // Phase 44 originally coupled them by firing only the chat path; that
  // left main/cron-style sessions silent. Decoupling lets the wake-up fire
  // even when there's no outbound chat for the dispatcher.
  injectSessionWakeUp(api, req);

  try {
    await sendChatDelivery(api, req);
    await client.postChatDeliveryResult(req.id, { success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, id: req.id, taskId: req.taskId }, "chat delivery send failed");
    try {
      await client.postChatDeliveryResult(req.id, {
        success: false,
        error: { kind: "send-failed", message },
      });
    } catch (ackErr) {
      log.error({ ackErr, id: req.id }, "posting chat-delivery failure ACK failed");
    }
  }
}

/**
 * Push the rendered completion message into the dispatcher's pending
 * system-event queue and request a coalesced heartbeat to drain it.
 * Mirrors OpenClaw's own cron pattern (canonical example:
 * `~/Projects/openclaw/src/cron/...` calls
 * `enqueueSystemEvent + requestHeartbeatNow` with `target: "last"`).
 *
 * Feature-detects `runtime.system.enqueueSystemEvent` /
 * `requestHeartbeatNow`. If either is missing the whole call is a no-op
 * with a single info-level telemetry event so the gap is visible during
 * older-gateway rollout. Throws are swallowed — see comment at the
 * call site for why this can't fail the chat ACK.
 */
function injectSessionWakeUp(api: OpenClawApi, req: ChatDeliveryRequest): void {
  const capturedSessionKey = req.delivery.sessionKey;
  if (!capturedSessionKey) {
    wakeLog.debug(
      { id: req.id, taskId: req.taskId, toStatus: req.toStatus },
      "wake-up.system-event-skipped-no-sessionkey",
    );
    return;
  }

  const system = api.runtime?.system;
  const enqueue = system?.enqueueSystemEvent;
  const heartbeat = system?.requestHeartbeatNow;
  if (typeof enqueue !== "function" || typeof heartbeat !== "function") {
    wakeLog.info(
      {
        id: req.id,
        taskId: req.taskId,
        toStatus: req.toStatus,
        hasEnqueue: typeof enqueue === "function",
        hasHeartbeat: typeof heartbeat === "function",
      },
      "wake-up.system-event-unavailable",
    );
    return;
  }

  // Ephemeral sessions (cron, subagent) don't heartbeat after their one-shot
  // run terminates. A wake-up enqueued against `agent:X:cron:UUID` would sit
  // unread until that exact cron job fires again — wrong destination for
  // dispatch-completion notifications. Redirect to the agent's main session,
  // which is the agent's ongoing inbox and runs the heartbeat loop that
  // actually drains the system-event queue. Chat-delivery (above) is left on
  // the original sessionKey since chat is the human-audit channel and may
  // legitimately be no-op on these keys (NoPlatformError → fallback).
  const mainKey = readMainKey(api);
  const wakeSessionKey = redirectEphemeralSessionKey(capturedSessionKey, mainKey);
  const redirected = wakeSessionKey !== capturedSessionKey;
  if (redirected) {
    wakeLog.info(
      {
        id: req.id,
        taskId: req.taskId,
        toStatus: req.toStatus,
        capturedSessionKey,
        wakeSessionKey,
      },
      "wake-up.session-redirected",
    );
  }

  const contextKey = `task:${req.taskId}:${req.toStatus}`;
  try {
    enqueue(req.message, { sessionKey: wakeSessionKey, contextKey });
    wakeLog.info(
      {
        id: req.id,
        subscriptionId: req.subscriptionId,
        taskId: req.taskId,
        toStatus: req.toStatus,
        sessionKey: wakeSessionKey,
        ...(redirected ? { capturedSessionKey } : {}),
        contextKey,
      },
      "wake-up.system-event-enqueued",
    );
  } catch (err) {
    wakeLog.warn(
      {
        err,
        id: req.id,
        taskId: req.taskId,
        toStatus: req.toStatus,
        sessionKey: wakeSessionKey,
        ...(redirected ? { capturedSessionKey } : {}),
        contextKey,
      },
      "wake-up.system-event-failed",
    );
    return;
  }

  // Choose the wake delivery mechanism based on whether the redirected agent
  // has heartbeats enabled. Heartbeat-enabled agents (those with
  // `cfg.agents.list[X].heartbeat.every` or matching default): the cheap
  // `requestHeartbeatNow` path triggers a coalesced heartbeat that drains
  // the queued system event. Agents without heartbeat config: heartbeat
  // gating in `runHeartbeatOnce` returns `skipped: disabled`, leaving the
  // queued event unread. Spawn a one-off `runEmbeddedPiAgent` instead — it
  // bypasses heartbeat gating entirely and forces an agent run that drains
  // the queue.
  const wakeAgentId = parseAgentIdFromSessionKey(wakeSessionKey);
  const heartbeatEnabled = wakeAgentId
    ? agentHasHeartbeat(api, wakeAgentId)
    : false;

  if (heartbeatEnabled) {
    try {
      heartbeat({
        sessionKey: wakeSessionKey,
        reason: `aof-task-${req.toStatus}`,
        heartbeat: { target: "last" },
      });
      wakeLog.info(
        {
          id: req.id,
          subscriptionId: req.subscriptionId,
          taskId: req.taskId,
          toStatus: req.toStatus,
          sessionKey: wakeSessionKey,
          ...(redirected ? { capturedSessionKey } : {}),
          mechanism: "heartbeat",
        },
        "wake-up.heartbeat-requested",
      );
    } catch (err) {
      wakeLog.warn(
        {
          err,
          id: req.id,
          taskId: req.taskId,
          toStatus: req.toStatus,
          sessionKey: wakeSessionKey,
          ...(redirected ? { capturedSessionKey } : {}),
        },
        "wake-up.heartbeat-request-failed",
      );
    }
    return;
  }

  // No heartbeat for this agent — spawn an embedded run directly. Fire and
  // forget; the run is fire-and-forget like AOF's worker-spawn path. Its
  // outcome is observable via the agent's session JSONL and our telemetry.
  if (!wakeAgentId) {
    wakeLog.warn(
      {
        id: req.id,
        taskId: req.taskId,
        toStatus: req.toStatus,
        sessionKey: wakeSessionKey,
      },
      "wake-up.embedded-run-skipped-no-agent-id",
    );
    return;
  }

  void wakeViaEmbeddedRun(api, {
    id: req.id,
    subscriptionId: req.subscriptionId,
    taskId: req.taskId,
    toStatus: req.toStatus,
    capturedSessionKey,
    redirected,
    wakeSessionKey,
    agentId: wakeAgentId,
    prompt: req.message,
  });
}

/**
 * Spawn a one-shot embedded agent run on the wake target's main session,
 * with the completion notification as the prompt. Bypasses heartbeat
 * gating — runs even for agents that have no `heartbeat.every` config.
 *
 * Fire-and-forget. Errors are logged via wakeLog.warn but do not surface
 * to the caller (the chat ACK already returned).
 *
 * Resumes the existing session if one exists at sessionKey (so the agent
 * has its full transcript context), otherwise creates a fresh sessionId.
 */
async function wakeViaEmbeddedRun(
  api: OpenClawApi,
  args: {
    id: string;
    subscriptionId: string;
    taskId: string;
    toStatus: string;
    capturedSessionKey: string;
    redirected: boolean;
    wakeSessionKey: string;
    agentId: string;
    prompt: string;
  },
): Promise<void> {
  // Atomic has-and-add — claim the slot before any await yields to another
  // concurrent wake call. Without this, two wakes spawning in the same
  // microtask both pass the `.has()` check before either calls `.add()`.
  if (inFlightEmbeddedWakes.has(args.wakeSessionKey)) {
    wakeLog.info(
      {
        id: args.id,
        subscriptionId: args.subscriptionId,
        taskId: args.taskId,
        toStatus: args.toStatus,
        sessionKey: args.wakeSessionKey,
        agentId: args.agentId,
      },
      "wake-up.embedded-run-deduped",
    );
    return;
  }
  inFlightEmbeddedWakes.add(args.wakeSessionKey);

  const runtime = api.runtime;
  const runtimeAgent = runtime?.agent;
  const runEmbeddedPiAgent = runtimeAgent?.runEmbeddedPiAgent;
  if (typeof runEmbeddedPiAgent !== "function") {
    inFlightEmbeddedWakes.delete(args.wakeSessionKey);
    wakeLog.info(
      {
        id: args.id,
        taskId: args.taskId,
        toStatus: args.toStatus,
        sessionKey: args.wakeSessionKey,
      },
      "wake-up.embedded-run-unavailable",
    );
    return;
  }

  const cfg = (runtime as { config?: { loadConfig?: () => Record<string, unknown> } } | undefined)
    ?.config?.loadConfig?.();
  if (!cfg) {
    inFlightEmbeddedWakes.delete(args.wakeSessionKey);
    wakeLog.warn(
      {
        id: args.id,
        taskId: args.taskId,
        toStatus: args.toStatus,
        sessionKey: args.wakeSessionKey,
      },
      "wake-up.embedded-run-no-config",
    );
    return;
  }

  // Resume the existing session if we can find it; otherwise fresh UUID.
  // Resuming preserves the agent's transcript so the wake message lands in
  // its existing context, which is the whole point of routing to `:main`.
  const sessionLookup = lookupSessionEntry(runtimeAgent, cfg, args.agentId, args.wakeSessionKey);
  const sessionId = sessionLookup?.sessionId ?? randomUUID();
  const sessionEntry = sessionLookup?.entry;

  const workspaceDirRaw = runtimeAgent?.resolveAgentWorkspaceDir?.(cfg, args.agentId);
  if (!workspaceDirRaw) {
    inFlightEmbeddedWakes.delete(args.wakeSessionKey);
    wakeLog.warn(
      {
        id: args.id,
        taskId: args.taskId,
        toStatus: args.toStatus,
        sessionKey: args.wakeSessionKey,
        agentId: args.agentId,
      },
      "wake-up.embedded-run-no-workspace",
    );
    return;
  }
  const ensured = await runtimeAgent?.ensureAgentWorkspace?.({ dir: workspaceDirRaw });
  const workspaceDir =
    (ensured && typeof ensured === "object" && "dir" in ensured ? ensured.dir : undefined)
    ?? workspaceDirRaw;
  const agentDir = runtimeAgent?.resolveAgentDir?.(cfg, args.agentId) ?? workspaceDirRaw;
  const sessionFile =
    runtimeAgent?.session?.resolveSessionFilePath?.(sessionId, sessionEntry, {
      agentId: args.agentId,
    }) ?? `${agentDir}/sessions/${sessionId}.jsonl`;

  const runId = randomUUID();
  wakeLog.info(
    {
      id: args.id,
      subscriptionId: args.subscriptionId,
      taskId: args.taskId,
      toStatus: args.toStatus,
      sessionKey: args.wakeSessionKey,
      ...(args.redirected ? { capturedSessionKey: args.capturedSessionKey } : {}),
      agentId: args.agentId,
      runId,
      resumedSession: sessionLookup !== undefined,
      mechanism: "embedded-run",
    },
    "wake-up.embedded-run-spawning",
  );

  try {
    const startedMs = Date.now();
    const result = await runEmbeddedPiAgent({
      sessionId,
      sessionKey: args.wakeSessionKey,
      sessionFile,
      workspaceDir,
      agentDir,
      config: cfg,
      prompt: `${EMBEDDED_WAKE_PROMPT_PREFIX}${args.prompt}`,
      agentId: args.agentId,
      timeoutMs: EMBEDDED_WAKE_TIMEOUT_MS,
      runId,
      lane: "aof-wake",
      senderIsOwner: true,
      trigger: "manual",
    });
    const meta = (result as { meta?: { durationMs?: number; error?: unknown; aborted?: boolean } }).meta;
    wakeLog.info(
      {
        id: args.id,
        subscriptionId: args.subscriptionId,
        taskId: args.taskId,
        toStatus: args.toStatus,
        sessionKey: args.wakeSessionKey,
        agentId: args.agentId,
        runId,
        durationMs: meta?.durationMs ?? Date.now() - startedMs,
        aborted: meta?.aborted ?? false,
        error: meta?.error,
      },
      meta?.error ? "wake-up.embedded-run-error" : "wake-up.embedded-run-completed",
    );
  } catch (err) {
    wakeLog.warn(
      {
        err,
        id: args.id,
        taskId: args.taskId,
        toStatus: args.toStatus,
        sessionKey: args.wakeSessionKey,
        agentId: args.agentId,
        runId,
      },
      "wake-up.embedded-run-threw",
    );
  } finally {
    inFlightEmbeddedWakes.delete(args.wakeSessionKey);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_MAIN_KEY = "main";
const EPHEMERAL_SESSION_SEGMENTS = new Set(["cron", "subagent"]);

/**
 * Read the configured `cfg.session.mainKey` from the OpenClaw runtime. Used
 * to construct the redirected wake-up sessionKey for ephemeral
 * (cron/subagent) sources. Falls back to `"main"` — the OpenClaw default —
 * if the runtime config doesn't expose it (older gateways / minimal mocks).
 */
function readMainKey(api: OpenClawApi): string {
  const runtime = api.runtime as { config?: { loadConfig?: () => unknown } } | undefined;
  const cfg = runtime?.config?.loadConfig?.();
  if (!cfg || typeof cfg !== "object") return DEFAULT_MAIN_KEY;
  const session = (cfg as { session?: { mainKey?: unknown } }).session;
  const mainKey = session?.mainKey;
  return typeof mainKey === "string" && mainKey.trim().length > 0
    ? mainKey.trim()
    : DEFAULT_MAIN_KEY;
}

/**
 * Extract the agentId segment from a sessionKey. Returns undefined if the
 * shape doesn't match `agent:<agentId>:...`.
 *
 * Exported for testing.
 */
export function parseAgentIdFromSessionKey(sessionKey: string): string | undefined {
  const parts = sessionKey.split(":");
  if (parts.length < 2 || parts[0] !== "agent") return undefined;
  const agentId = parts[1]?.trim();
  return agentId && agentId.length > 0 ? agentId : undefined;
}

interface AgentEntryShape {
  id?: unknown;
  heartbeat?: { every?: unknown } | unknown;
}

/**
 * Cheap structural check for whether an agent has heartbeats enabled.
 * Mirrors OpenClaw's `resolveHeartbeatIntervalMs` precedence:
 *   1. `cfg.agents.list[X].heartbeat.every` (per-agent override)
 *   2. `cfg.agents.defaults.heartbeat.every` (workspace default)
 *
 * Returns true iff *some* `every` is set (any non-empty string). Used to
 * decide between `requestHeartbeatNow` (cheap) and `runEmbeddedPiAgent`
 * (heavy fallback) at wake time.
 *
 * Exported for testing.
 */
export function agentHasHeartbeat(api: OpenClawApi, agentId: string): boolean {
  const runtime = api.runtime as { config?: { loadConfig?: () => unknown } } | undefined;
  const cfg = runtime?.config?.loadConfig?.();
  if (!cfg || typeof cfg !== "object") return false;
  const agents = (cfg as { agents?: unknown }).agents;
  if (!agents || typeof agents !== "object") return false;

  const list = (agents as { list?: unknown }).list;
  if (Array.isArray(list)) {
    const entry = list.find((candidate): candidate is AgentEntryShape => {
      if (!candidate || typeof candidate !== "object") return false;
      return (candidate as { id?: unknown }).id === agentId;
    });
    if (entry) {
      const hb = (entry as { heartbeat?: unknown }).heartbeat;
      if (hb && typeof hb === "object") {
        const every = (hb as { every?: unknown }).every;
        if (typeof every === "string" && every.trim().length > 0) return true;
      }
    }
  }

  const defaults = (agents as { defaults?: unknown }).defaults;
  if (defaults && typeof defaults === "object") {
    const defaultHb = (defaults as { heartbeat?: unknown }).heartbeat;
    if (defaultHb && typeof defaultHb === "object") {
      const every = (defaultHb as { every?: unknown }).every;
      if (typeof every === "string" && every.trim().length > 0) return true;
    }
  }

  return false;
}

interface SessionEntryShape {
  sessionId?: string;
  sessionFile?: string;
  [key: string]: unknown;
}

/**
 * Look up an existing session entry for the given sessionKey via the
 * runtime's session-store helpers. Used to RESUME the agent's main session
 * (preserving its transcript) when spawning the embedded wake run.
 *
 * Returns undefined if the runtime helpers are absent OR the store has no
 * matching entry. Callers fall back to a fresh sessionId in that case.
 */
function lookupSessionEntry(
  runtimeAgent: { session?: { resolveStorePath?: unknown; loadSessionStore?: unknown } } | undefined,
  cfg: Record<string, unknown>,
  agentId: string,
  sessionKey: string,
): { sessionId: string; entry: SessionEntryShape } | undefined {
  const session = runtimeAgent?.session;
  const resolveStorePath = session?.resolveStorePath;
  const loadSessionStore = session?.loadSessionStore;
  if (typeof resolveStorePath !== "function" || typeof loadSessionStore !== "function") {
    return undefined;
  }
  try {
    const sessionCfg = (cfg as { session?: { store?: string } }).session;
    const storePath = (resolveStorePath as (
      store?: string,
      opts?: { agentId?: string },
    ) => string)(sessionCfg?.store, { agentId });
    if (!storePath) return undefined;
    const store = (loadSessionStore as (path: string) => Record<string, SessionEntryShape>)(
      storePath,
    );
    const entry = store?.[sessionKey];
    if (entry?.sessionId) {
      return { sessionId: entry.sessionId, entry };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Redirect ephemeral session keys (cron/subagent) to the agent's main session
 * for wake-up purposes. Format: `agent:<agentId>:<segment>[:rest]`.
 *
 * - `agent:X:cron:UUID`     → `agent:X:<mainKey>`
 * - `agent:X:subagent:UUID` → `agent:X:<mainKey>`
 * - everything else (including `agent:X:telegram:...`, `agent:X:main`,
 *   `agent:X:matrix:...`, `agent:X:whatsapp:...`) → unchanged
 *
 * Why: ephemeral sessions terminate after their one-shot run and don't keep
 * a heartbeat loop running, so a system-event queued against them sits
 * unread. The agent's main session does heartbeat and will drain the queue.
 *
 * Exported for testing.
 */
export function redirectEphemeralSessionKey(sessionKey: string, mainKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length < 3 || parts[0] !== "agent") return sessionKey;
  const agentId = parts[1];
  const segment = parts[2];
  if (!agentId || !segment) return sessionKey;
  if (!EPHEMERAL_SESSION_SEGMENTS.has(segment)) return sessionKey;
  return `agent:${agentId}:${mainKey}`;
}
