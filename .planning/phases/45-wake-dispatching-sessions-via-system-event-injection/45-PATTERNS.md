# Phase 45: Wake dispatching sessions via system-event injection — Pattern Map

**Mapped:** 2026-04-24
**Files analyzed:** 11 (8 modify, 3 create)
**Analogs found:** 11 / 11

> Phase 45 is a thin extension of the Phase 44 chat-delivery pipeline. Every modified file already has a strong in-tree analog — usually the file itself. The architectural twist is that `runtime.system.*` lives only in the gateway/plugin process, not in the daemon, so the daemon-side notifier hands the system-event metadata to the plugin via an extended `ChatDeliveryRequest` envelope and the plugin executes both calls (`enqueueSystemEvent` + `requestHeartbeatNow`) inline with `sendChatDelivery`. The Phase 44 long-poll plumbing carries the new payload opaquely; the Phase 44 Zod-passthrough schema absorbs the new fields without a break.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/openclaw/types.ts` | type-decl (plugin SDK shape mirror) | (n/a) | self — extend `OpenClawAgentRuntime` analog into a sibling `OpenClawSystemRuntime` block on `OpenClawRuntime` | self (extend) |
| `src/openclaw/openclaw-chat-delivery.ts` | delivery notifier (daemon-side, EventLogger callback) | event-driven | self — extend `deliverOne` to package `systemEvent` + `heartbeat` payloads and consume per-channel ACK; rewrite `renderMessage` (one-line + `dispatcherAgentId` + fallback warning) | self (extend) |
| `src/openclaw/chat-message-sender.ts` | platform-send transport (plugin-side) | request-response | self — after `sendText` succeeds, invoke `api.runtime?.system?.enqueueSystemEvent` + `requestHeartbeatNow` and return per-channel result | self (extend) |
| `src/openclaw/chat-delivery-poller.ts` | plugin long-poll loop | event-driven | self — change `dispatchAndAck` to forward the structured per-channel result returned by `sendChatDelivery` into `postChatDeliveryResult` | self (extend) |
| `src/openclaw/subscription-delivery.ts` | Zod schema (delivery shape) | CRUD (shape contract) | self — passthrough schema; no new persisted field needed (`channel` dimension lives in logs only per RESEARCH §Telemetry) | self (review-only — no edits expected) |
| `src/openclaw/adapter.ts` | wiring/bootstrap (plugin) | startup | self — feature-detect `api.runtime?.system?.enqueueSystemEvent` at `registerAofPlugin` entry; emit one-time `wake-up.system-event-unavailable` log; pass `systemEventCapable` flag to the chat-delivery poller AND post it to the daemon via a new `POST /v1/plugin/capability` (RESEARCH Option (a)) | self (extend) |
| `src/ipc/schemas.ts` | IPC envelope schemas | wire contract | self — extend `ChatDeliveryRequest` with optional `systemEvent` + `heartbeat` blocks; extend `ChatDeliveryResultPost` with optional per-channel `systemEvent`/`heartbeat` result blocks; add new `PluginCapabilityPost` schema if Option (a) chosen | self (extend) |
| `src/daemon/daemon.ts` | wiring/bootstrap (daemon) | startup | self — wire the plugin-capability cache (if Option (a)); pass `systemEventCapable` flag into `OpenClawChatDeliveryNotifier` ctor | self (extend) |
| `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` (extend) | unit test (notifier) | unit | self — extend with Phase 45 describe block (test cases 1-10 from RESEARCH §Testing Strategy Layer 1) | self (extend) |
| `src/openclaw/__tests__/chat-message-sender.test.ts` (NEW) | unit test (plugin sender) | unit | `src/openclaw/__tests__/dispatch-notification.test.ts` (same module family — pure unit test of a transform/transport function with vi.fn mocks) | role-match |
| `src/daemon/__tests__/notifier-recovery-on-restart.test.ts` (extend) | unit test (recovery path) | unit | self — extend with Phase 45 system-event-on-replay assertions | self (extend) |
| `tests/integration/wake-up-dispatcher.test.ts` (extend) | integration E2E | event-driven E2E | self — extend the Phase 44 anchor with mock `runtime.system` + capability-absent variant | self (extend) |

**No bug-NNN regression test required.** The `Agent: unknown` rendering bug is a one-line fix inside `renderMessage`; existing notifier tests (Test Case 9 in RESEARCH §Testing Strategy) lock the regression. CLAUDE.md's `bug-NNN-description.test.ts` convention is for crash-class regressions discovered in production; the agent-unknown bug is a content-rendering bug caught by unit tests.

---

## Pattern Assignments

### `src/openclaw/types.ts` (type-decl)

**Analog:** self — mirror the existing `OpenClawAgentRuntime` block into a sibling `OpenClawSystemRuntime` block on `OpenClawRuntime`.

**Existing pattern — optional, partial mirror of plugin-sdk types** (`src/openclaw/types.ts:49-73`):
```ts
/**
 * Subset of the openclaw `api.runtime.agent` surface we consume.
 * Canonical definition lives in openclaw's
 * plugin-sdk/src/plugins/runtime/types-core.ts (PluginRuntimeCore.agent).
 */
export interface OpenClawAgentRuntime {
  runEmbeddedPiAgent?: (params: Record<string, unknown>) => Promise<{...}>;
  // … other optional methods …
}

export interface OpenClawRuntime {
  agent?: OpenClawAgentRuntime;
}
```

**Phase 45 extension (new code to write):**
```ts
/**
 * Subset of the openclaw `api.runtime.system` surface we consume.
 * Canonical definition lives in openclaw's
 * plugin-sdk/src/plugins/runtime/types-core.ts (PluginRuntimeCore.system).
 *
 * Both methods are synchronous in the canonical SDK:
 *   - enqueueSystemEvent returns boolean (true = queued, false = dedup-rejected
 *     via lastText match OR empty/whitespace text). Throws when sessionKey is
 *     blank.
 *   - requestHeartbeatNow returns void (fire-and-forget).
 *
 * Both fields optional: feature-detect at notifier construction (D-45-FEATURE-DETECT).
 */
export interface OpenClawSystemRuntime {
  enqueueSystemEvent?: (
    text: string,
    options: {
      sessionKey: string;
      contextKey?: string | null;
      deliveryContext?: {
        channel?: string;
        to?: string;
        accountId?: string;
        threadId?: string | number;
      };
      trusted?: boolean;
    },
  ) => boolean;
  requestHeartbeatNow?: (opts?: {
    reason?: string;
    coalesceMs?: number;
    agentId?: string;
    sessionKey?: string;
    heartbeat?: { target?: string };
  }) => void;
}

export interface OpenClawRuntime {
  agent?: OpenClawAgentRuntime;
  system?: OpenClawSystemRuntime;            // NEW
}
```

**Convention to mirror** (lines 49-53): the JSDoc citation of `plugin-sdk/src/plugins/runtime/types-core.ts (PluginRuntimeCore.system)` is load-bearing — it lets a future maintainer find the canonical types in the installed `node_modules` without grepping. Replicate the comment shape.

**`I` prefix exception (CLAUDE.md §Conventions):** `OpenClawApi` and `OpenClawAgentRuntime` are NOT prefixed with `I`. Continue that convention here — `I` prefix is reserved for store interfaces (`ITaskStore`).

---

### `src/openclaw/openclaw-chat-delivery.ts` (delivery notifier, event-driven)

**Analog:** self.

**Existing `deliverOne` shape** (`src/openclaw/openclaw-chat-delivery.ts:138-170`) — the call site that builds the IPC envelope:
```ts
const attemptedAt = new Date().toISOString();
try {
  await this.opts.messageTool.send(target, message, {
    subscriptionId: sub.id,
    taskId: task.frontmatter.id,
    toStatus,
    delivery: sub.delivery as Record<string, unknown> | undefined,
  });
  await subscriptionStore.appendAttempt(task.frontmatter.id, sub.id, {
    attemptedAt,
    success: true,
    toStatus,
  });
  await subscriptionStore.markStatusNotified(task.frontmatter.id, sub.id, toStatus);
  // ... terminal-status update + wake-up.delivered log ...
}
```

**Phase 45 extension — pre-send envelope packaging** (sketch, integration point at line 138):
```ts
const dispatcherAgentId = delivery.dispatcherAgentId;
const contextKey = `task:${task.frontmatter.id}:${toStatus}`;        // D-45-DEDUP-KEY
const systemEventCapable = this.opts.systemEventCapable === true;     // D-45-FEATURE-DETECT
const channelDimension = systemEventCapable ? "both" : "chat";        // D-45-TELEMETRY-DIMENSION

wakeLog.info(
  {
    subscriptionId: sub.id,
    taskId: task.frontmatter.id,
    toStatus,
    source,
    sessionKey: delivery.sessionKey,
    dispatcherAgentId,
    channel: channelDimension,                                         // NEW (D-45-TELEMETRY-DIMENSION)
  },
  source === "recovery" ? "wake-up.recovery-replay" : "wake-up.attempted",
);

// Build the system-event payload only when the plugin reported capability.
const deliveryContext =
  delivery.channel
    ? {
        channel: delivery.channel,
        ...(delivery.target ? { to: delivery.target } : {}),
        ...(delivery.threadId ? { threadId: delivery.threadId } : {}),
      }
    : undefined;
const systemEvent = systemEventCapable
  ? {
      sessionKey: delivery.sessionKey,
      contextKey,
      text: renderSystemEventText({ task, toStatus, runResult }),
      ...(deliveryContext ? { deliveryContext } : {}),
    }
  : undefined;
const heartbeat = systemEventCapable
  ? {
      sessionKey: delivery.sessionKey,
      ...(dispatcherAgentId ? { agentId: dispatcherAgentId } : {}),
      coalesceMs: WAKE_UP_COALESCE_MS,                                 // 750 (RESEARCH §Coalesce)
      reason: "aof:wake-up",
      heartbeat: { target: "last" } as const,                          // D-45-HEARTBEAT-TARGET
    }
  : undefined;
```

**Phase 45 extension — per-channel ACK consumption** (sketch, after the await):
```ts
const ackResult = await this.opts.messageTool.send(target, message, {
  subscriptionId: sub.id,
  taskId: task.frontmatter.id,
  toStatus,
  delivery: sub.delivery as Record<string, unknown> | undefined,
  ...(systemEvent ? { systemEvent } : {}),
  ...(heartbeat ? { heartbeat } : {}),
});

// Per-channel telemetry (D-45-TELEMETRY).
if (ackResult?.systemEvent?.success) {
  wakeLog.info({ subscriptionId: sub.id, taskId, toStatus, source, sessionKey: delivery.sessionKey, dispatcherAgentId, contextKey }, "wake-up.system-event-enqueued");
}
if (ackResult?.heartbeat?.success) {
  wakeLog.info({ subscriptionId: sub.id, taskId, toStatus, source, sessionKey: delivery.sessionKey, dispatcherAgentId, agentId: dispatcherAgentId, coalesceMs: WAKE_UP_COALESCE_MS, reason: "aof:wake-up" }, "wake-up.heartbeat-requested");
}
if (ackResult?.systemEvent?.error) {
  wakeLog.warn({ subscriptionId: sub.id, taskId, toStatus, source, sessionKey: delivery.sessionKey, dispatcherAgentId, contextKey, kind: ackResult.systemEvent.error.kind, message: ackResult.systemEvent.error.message }, "wake-up.system-event-failed");
}
if (ackResult?.heartbeat?.error) {
  wakeLog.warn({ subscriptionId: sub.id, taskId, toStatus, source, sessionKey: delivery.sessionKey, dispatcherAgentId, contextKey, kind: ackResult.heartbeat.error.kind, message: ackResult.heartbeat.error.message }, "wake-up.system-event-failed");
}
```

**`renderMessage` rewrite — one-line + correct agent + fallback warning** (replaces existing function at lines 333-360):
```ts
function renderMessage(args: {
  task: NonNullable<Awaited<ReturnType<ITaskStore["get"]>>>;
  toStatus: string;
  dispatcherAgentId: string | undefined;                               // D-45-BUG-AGENT-UNKNOWN
  runResult: Awaited<ReturnType<typeof readRunResult>> | undefined;
  systemEventUnavailable: boolean;                                     // D-45-FALLBACK-WARNING
}): string {
  const { task, toStatus, dispatcherAgentId, runResult, systemEventUnavailable } = args;
  const glyph = renderStatusGlyph(toStatus);                           // ✓ done, ⚠ failure-class
  const id = task.frontmatter.id;
  const title = truncate(task.frontmatter.title, 120);                 // RESEARCH OQ2
  const agent = dispatcherAgentId ?? "?";
  let line = `${glyph} ${id} (${toStatus}) — ${title} [agent: ${agent}]`;
  if (systemEventUnavailable) {
    line += `\n⚠ Session-context wake-up not delivered (gateway system-event API unavailable). Upgrade OpenClaw gateway to receive automatic wake-ups on task completion.`;
  }
  return line;
}

function renderStatusGlyph(status: string): string {
  return status === "done" || status === "review" ? "✓" : "⚠";        // failure-class falls through to ⚠
}
```

**Constructor extension** (sketch — adds the `systemEventCapable` flag to `OpenClawChatDeliveryOptions`):
```ts
export interface OpenClawChatDeliveryOptions {
  resolveStoreForTask: (taskId: string) => Promise<ITaskStore | undefined>;
  messageTool: MatrixMessageTool;
  /**
   * Phase 45: whether the registered OpenClaw plugin reported that
   * `runtime.system.enqueueSystemEvent` is available. When false, the
   * notifier skips the systemEvent/heartbeat envelope fields and renders
   * the chat message with the inline fallback warning. Defaults to false
   * (errs on the side of warning during the boot capability-post race per
   * RESEARCH §R2). The daemon flips this to true after the plugin's first
   * POST /v1/plugin/capability arrives.
   */
  systemEventCapable?: boolean;
}
```

**Existing error-tagging convention to mirror** (lines 169-198): the existing `(err as Error & { kind?: string }).kind` extraction is preserved untouched. The new `wake-up.system-event-failed` events use `kind: "system-event-failed"` and `kind: "heartbeat-request-failed"` per D-45-TELEMETRY. Per-channel errors NEVER throw out of `deliverOne` — chat success and system-event success are independent (D-45-CHANNEL-ORTHOGONALITY).

**Recovery path inheritance** (lines 250-321): `replayUnnotifiedTerminals` calls `deliverOne` directly. The Phase 45 changes inside `deliverOne` are automatically inherited by the recovery pass — NO new wiring needed in this method. The `source: "recovery"` arm naturally picks up `channel: "both"` (or `"chat"` if capability is missing) and emits `wake-up.system-event-enqueued` + `wake-up.heartbeat-requested` on the recovery path too. **Same `contextKey = task:{taskId}:{toStatus}` flows through** (D-45-DEDUP-INTERACTION-WITH-RECOVERY).

**Module-level constant to add** (top of file, near line 30-37):
```ts
/**
 * Phase 45 D-45-HEARTBEAT-POLICY — coalesce window for requestHeartbeatNow.
 * 750 ms balances batching multiple completions against per-wake-up latency.
 * Sits between OpenClaw's DEFAULT_COALESCE_MS (250) and DEFAULT_RETRY_MS (1000).
 * See 45-RESEARCH §Coalesce Window Recommendation for derivation.
 */
const WAKE_UP_COALESCE_MS = 750;
```

**System-event text renderer** (new helper near `renderMessage`):
```ts
function renderSystemEventText(args: {
  task: NonNullable<Awaited<ReturnType<ITaskStore["get"]>>>;
  toStatus: string;
  runResult: Awaited<ReturnType<typeof readRunResult>> | undefined;
}): string {
  // Mirror the chat one-liner so OpenClaw's `lastText` dedup does the right
  // thing (RESEARCH §Recovery Path Interaction §"lastText vs distinct
  // contextKeys"). Distinct (taskId, toStatus) tuples MUST produce distinct
  // text — the proposed template embeds both, satisfying that contract.
  const id = args.task.frontmatter.id;
  const title = truncate(args.task.frontmatter.title, 120);
  return `Task ${id} reached status "${args.toStatus}" — ${title}`;
}
```

---

### `src/openclaw/chat-message-sender.ts` (platform-send transport, request-response)

**Analog:** self.

**Existing `sendChatDelivery` shape — current return type `Promise<void>`** (`src/openclaw/chat-message-sender.ts:110-183`):
```ts
export async function sendChatDelivery(
  api: OpenClawApi,
  req: ChatDeliveryRequest,
): Promise<void> {
  // ... resolve platform, target, threadId from req.delivery ...
  await adapter.sendText({
    cfg,
    to: target,
    text: req.message,
    ...(threadId !== undefined ? { threadId } : {}),
  });
}
```

**Phase 45 change — return per-channel result + dispatch system-event/heartbeat** (sketch — note the return type changes from `Promise<void>` to a structured ack):
```ts
/**
 * Phase 45 — per-channel result returned to chat-delivery-poller, which
 * forwards it through `postChatDeliveryResult`. The poller's existing single
 * "success/failure" semantics are preserved for the chat channel; the new
 * system-event + heartbeat channels are reported alongside but never affect
 * the chat success bit.
 */
export interface SendChatDeliveryResult {
  chat: { success: boolean; error?: { kind: string; message: string } };
  systemEvent?: { success: boolean; error?: { kind: string; message: string } };
  heartbeat?: { success: boolean; error?: { kind: string; message: string } };
}

export async function sendChatDelivery(
  api: OpenClawApi,
  req: ChatDeliveryRequest,
): Promise<SendChatDeliveryResult> {
  // --- Existing: chat send ---
  let chat: SendChatDeliveryResult["chat"];
  try {
    // ... existing platform/target/threadId resolution + adapter.sendText ...
    chat = { success: true };
  } catch (err) {
    // Preserve the existing throw shape — NoPlatformError still bubbles via
    // its `.kind = "no-platform"` so the daemon-side `OpenClawChatDeliveryNotifier`
    // catch (lines 169-230) keeps recording `agent-callback-fallback` audit
    // trail entries unchanged.
    throw err;
  }

  // --- NEW: system-event + heartbeat (D-45-PRIMITIVE) ---
  const systemRuntime = api.runtime?.system;
  let systemEvent: SendChatDeliveryResult["systemEvent"];
  if (req.systemEvent && systemRuntime?.enqueueSystemEvent) {
    try {
      systemRuntime.enqueueSystemEvent(req.systemEvent.text, {
        sessionKey: req.systemEvent.sessionKey,
        contextKey: req.systemEvent.contextKey,
        ...(req.systemEvent.deliveryContext
          ? { deliveryContext: req.systemEvent.deliveryContext }
          : {}),
      });
      systemEvent = { success: true };
    } catch (err) {
      systemEvent = {
        success: false,
        error: {
          kind: "system-event-failed",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  let heartbeat: SendChatDeliveryResult["heartbeat"];
  if (req.heartbeat && systemRuntime?.requestHeartbeatNow) {
    try {
      systemRuntime.requestHeartbeatNow({
        sessionKey: req.heartbeat.sessionKey,
        ...(req.heartbeat.agentId ? { agentId: req.heartbeat.agentId } : {}),
        coalesceMs: req.heartbeat.coalesceMs,
        reason: req.heartbeat.reason,
        heartbeat: req.heartbeat.heartbeat,
      });
      heartbeat = { success: true };
    } catch (err) {
      heartbeat = {
        success: false,
        error: {
          kind: "heartbeat-request-failed",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  return { chat, systemEvent, heartbeat };
}
```

**Existing `NoPlatformError` to preserve** (lines 41-49): the typed error class with `.kind = "no-platform"` MUST keep being thrown synchronously from inside the try-block above, so the existing daemon-side fallback path (`openclaw-chat-delivery.ts:184-227` — `agent-callback-fallback`) still trips. The `chat: { success: true | false }` field structure is for the new system-event/heartbeat ACK transport ONLY — the chat side preserves throw-on-failure semantics.

**Existing logger pattern to keep** (line 29): `const log = createLogger("chat-message-sender");` — reuse for new debug logs (e.g. `log.debug({ id: req.id, sessionKey: req.systemEvent?.sessionKey }, "system-event enqueued");`).

**Existing `parseSessionKey` invariant** (lines 84-103): DO NOT touch. The 5-part requirement is load-bearing for subagent-key safety. Phase 45 new code does NOT call `parseSessionKey` — `enqueueSystemEvent` takes the raw `sessionKey` string verbatim.

---

### `src/openclaw/chat-delivery-poller.ts` (plugin long-poll loop, event-driven)

**Analog:** self.

**Existing `dispatchAndAck` shape** (`src/openclaw/chat-delivery-poller.ts:88-108`):
```ts
async function dispatchAndAck(
  client: DaemonIpcClient,
  api: OpenClawApi,
  req: ChatDeliveryRequest,
): Promise<void> {
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
```

**Phase 45 change — forward per-channel ACK** (sketch):
```ts
async function dispatchAndAck(
  client: DaemonIpcClient,
  api: OpenClawApi,
  req: ChatDeliveryRequest,
): Promise<void> {
  let result: SendChatDeliveryResult;
  try {
    result = await sendChatDelivery(api, req);
  } catch (err) {
    // Chat send threw — preserve existing failure ACK shape so the daemon's
    // ChatDeliveryQueue.deliverResult rejects the awaiting Promise with the
    // original `kind` (e.g. "no-platform" → agent-callback-fallback path).
    const message = err instanceof Error ? err.message : String(err);
    const kind = (err as Error & { kind?: string }).kind ?? "send-failed";
    log.error({ err, id: req.id, taskId: req.taskId }, "chat delivery send failed");
    try {
      await client.postChatDeliveryResult(req.id, {
        success: false,
        error: { kind, message },
      });
    } catch (ackErr) {
      log.error({ ackErr, id: req.id }, "posting chat-delivery failure ACK failed");
    }
    return;
  }

  // Chat succeeded; post the new structured result so the daemon-side notifier
  // can emit per-channel telemetry.
  try {
    await client.postChatDeliveryResult(req.id, {
      success: result.chat.success,
      ...(result.chat.error ? { error: result.chat.error } : {}),
      ...(result.systemEvent ? { systemEvent: result.systemEvent } : {}),
      ...(result.heartbeat ? { heartbeat: result.heartbeat } : {}),
    });
  } catch (ackErr) {
    log.error({ ackErr, id: req.id }, "posting chat-delivery success ACK failed");
  }
}
```

**Module-level idempotency gate to keep** (lines 26, 35-39): `chatDeliveryPollerStarted` survives OpenClaw's per-session plugin reload — same trick as `spawn-poller.ts`. Phase 45 does NOT touch this; the gate continues to work.

**Backoff loop to keep** (lines 58-86): the exponential backoff (`INITIAL_BACKOFF_MS = 1_000`, `MAX_BACKOFF_MS = 30_000`) is unchanged. The new payload size (~0.3 KB per RESEARCH R5) is negligible.

---

### `src/openclaw/subscription-delivery.ts` (Zod schema)

**Analog:** self — review-only.

**Existing schema** (`src/openclaw/subscription-delivery.ts:15-54`) — already carries `dispatcherAgentId`, `capturedAt`, `pluginId`, `wakeUpMode`, with `.passthrough()` for forward-compat. No new field required for Phase 45 per RESEARCH §Telemetry Implementation Plan §"Subscription delivery payload — no `channel` field added."

**Decision lock-in:** the `channel` dimension is per-attempt log telemetry only. NOT added to `OpenClawChatDelivery` because it conflates per-attempt outcomes with subscription-scoped state. The structured logs (`wake-up.attempted.channel`, `wake-up.delivered.channel`) carry the audit; the schema stays unchanged.

**Watch-item:** if a future planner finds a need to persist a per-subscription "preferred wake-up mode," extend `wakeUpMode` enum with `system-event` rather than adding a `channel` field. Keep the channel boolean (`systemEventCapable`) in process state, not subscription state.

---

### `src/openclaw/adapter.ts` (wiring/bootstrap, plugin-side)

**Analog:** self.

**Existing wiring pattern** (`src/openclaw/adapter.ts:46-149`) — the `registerAofPlugin` entry point is the natural feature-detect point.

**Existing optional-runtime check pattern (idiom in this codebase)** — see how `api.registerHttpRoute` is feature-detected at line 141:
```ts
if (typeof api.registerHttpRoute === "function") {
  const proxy = buildStatusProxyHandler(socketPath);
  api.registerHttpRoute({ path: "/aof/metrics", handler: proxy, auth: "gateway" });
  api.registerHttpRoute({ path: "/aof/status", handler: proxy, auth: "gateway" });
}
```

**Phase 45 extension — feature-detect + capability-post** (sketch, before the `startSpawnPollerOnce` call at line 147):
```ts
// Phase 45 D-45-FEATURE-DETECT — does this OpenClaw build expose the
// system-event runtime surface? Older gateways and the standalone adapter
// (CLAUDE.md §Fragile two-path) lack it; we degrade gracefully.
const systemEventCapable = typeof api.runtime?.system?.enqueueSystemEvent === "function";
if (!systemEventCapable) {
  // One-time diagnostic — daemon log + (after capability post) every chat
  // wake-up message will carry the user-facing fallback warning.
  log.warn(
    {
      runtimeKeys: api.runtime ? Object.keys(api.runtime) : null,
      systemKeys: api.runtime?.system ? Object.keys(api.runtime.system) : null,
    },
    "wake-up.system-event-unavailable",
  );
}

// Forward the capability bit to the daemon so the daemon-side notifier
// renders chat messages with or without the fallback warning. Fire-and-forget;
// the notifier defaults to systemEventCapable=false during the boot race
// (RESEARCH §R2 acceptable per "errs on the side of being noisy when
// degraded").
void client
  .postPluginCapability({ pluginId: "openclaw", systemEventCapable })
  .catch((err) => log.warn({ err, systemEventCapable }, "postPluginCapability failed (will retry on next plugin reload)"));

startSpawnPollerOnce(client, api);
startChatDeliveryPollerOnce(client, api);
```

**Existing client-method-add convention to mirror** — the `DaemonIpcClient` methods follow a uniform shape (`src/openclaw/daemon-ipc-client.ts:100-133`):
```ts
async postSpawnResult(id: string, result: SpawnResultPost): Promise<void> {
  const { statusCode, body } = await this.postRaw(
    `/v1/spawns/${encodeURIComponent(id)}/result`,
    result,
    10_000,
  );
  this.requireSuccess(statusCode, body, `POST /v1/spawns/${id}/result`);
}
```

**Phase 45 new client method (in `daemon-ipc-client.ts`):**
```ts
async postPluginCapability(post: PluginCapabilityPost): Promise<void> {
  const { statusCode, body } = await this.postRaw(
    "/v1/plugin/capability",
    post,
    5_000,
  );
  this.requireSuccess(statusCode, body, "POST /v1/plugin/capability");
}
```

**Existing log convention** (line 24): `const log = createLogger("openclaw");` — reuse for the feature-detect warning above. The `wake-up.system-event-unavailable` event name MUST be lowercase-dot-format to match the existing `wake-up.*` channel from `openclaw-chat-delivery.ts:30` (`wakeLog`).

---

### `src/ipc/schemas.ts` (IPC envelope schemas)

**Analog:** self.

**Existing `ChatDeliveryRequest` shape** (`src/ipc/schemas.ts:152-169`):
```ts
export const ChatDeliveryRequest = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  taskId: z.string(),
  toStatus: z.string(),
  message: z.string(),
  delivery: z
    .object({
      kind: z.string(),
      target: z.string().optional(),
      sessionKey: z.string().optional(),
      sessionId: z.string().optional(),
      channel: z.string().optional(),
      threadId: z.string().optional(),
    })
    .passthrough(),
});
export type ChatDeliveryRequest = z.infer<typeof ChatDeliveryRequest>;
```

**Phase 45 extension — additive optional blocks (passthrough preserved):**
```ts
export const ChatDeliveryRequest = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  taskId: z.string(),
  toStatus: z.string(),
  message: z.string(),
  delivery: z.object({
    kind: z.string(),
    target: z.string().optional(),
    sessionKey: z.string().optional(),
    sessionId: z.string().optional(),
    channel: z.string().optional(),
    threadId: z.string().optional(),
  }).passthrough(),

  // NEW — Phase 45 D-45-PRIMITIVE
  systemEvent: z.object({
    sessionKey: z.string().describe("OpenClaw session key — required by enqueueSystemEvent"),
    contextKey: z.string().describe("Per-transition dedup tag: `task:{taskId}:{toStatus}` (D-45-DEDUP-KEY)"),
    text: z.string().describe("One-line completion text injected into the next agent turn's context"),
    deliveryContext: z.object({
      channel: z.string().optional(),
      to: z.string().optional(),
      accountId: z.string().optional(),
      threadId: z.union([z.string(), z.number()]).optional(),
    }).optional().describe(
      "Optional channel routing hint for OpenClaw's heartbeat-driven turn output",
    ),
  }).optional().describe(
    "When present, plugin invokes runtime.system.enqueueSystemEvent with these args after the chat send. Omitted when the daemon does not know the plugin to be system-event-capable.",
  ),

  heartbeat: z.object({
    sessionKey: z.string().describe("Same session key as systemEvent.sessionKey"),
    agentId: z.string().optional().describe("Optional dispatcherAgentId for OpenClaw's heartbeat-runner logs"),
    coalesceMs: z.number().int().nonnegative().describe("750 ms per RESEARCH §Coalesce — locked at the daemon"),
    reason: z.string().describe("Stable string for OpenClaw heartbeat-runner logs (e.g. 'aof:wake-up')"),
    heartbeat: z.object({
      target: z.literal("last").describe("D-45-HEARTBEAT-TARGET — required to deliver to last active channel"),
    }),
  }).optional().describe(
    "When present, plugin invokes runtime.system.requestHeartbeatNow after enqueueSystemEvent.",
  ),
});
export type ChatDeliveryRequest = z.infer<typeof ChatDeliveryRequest>;
```

**Existing `ChatDeliveryResultPost` shape** (`src/ipc/schemas.ts:172-181`):
```ts
export const ChatDeliveryResultPost = z.object({
  success: z.boolean(),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
});
```

**Phase 45 extension — per-channel result blocks:**
```ts
const ChannelResult = z.object({
  success: z.boolean(),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
});

export const ChatDeliveryResultPost = z.object({
  success: z.boolean(),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
  // NEW — per-channel ACK fields. Optional so older plugins continue to ACK
  // with just { success } and the daemon-side notifier records "chat" channel
  // only (no system-event telemetry events fire — same as systemEventCapable=false).
  systemEvent: ChannelResult.optional().describe(
    "Plugin-reported outcome of runtime.system.enqueueSystemEvent. Absent when the request had no `systemEvent` field.",
  ),
  heartbeat: ChannelResult.optional().describe(
    "Plugin-reported outcome of runtime.system.requestHeartbeatNow. Absent when the request had no `heartbeat` field.",
  ),
});
export type ChatDeliveryResultPost = z.infer<typeof ChatDeliveryResultPost>;
```

**Phase 45 new schema — `PluginCapabilityPost`** (RESEARCH OQ1 Option (a)):
```ts
/**
 * Phase 45 — POST /v1/plugin/capability envelope.
 *
 * The plugin posts this once at boot (after registerAofPlugin's feature-detect
 * runs). The daemon caches the latest capability set per pluginId and uses it
 * to gate the systemEvent/heartbeat fields on outbound ChatDeliveryRequests.
 *
 * Fire-and-forget on the plugin side — failures fall back to the next plugin
 * reload. Daemon defaults to `systemEventCapable: false` until the first POST
 * lands (RESEARCH §R2 boot capability race; acceptable noisy-when-degraded).
 */
export const PluginCapabilityPost = z.object({
  pluginId: z.string().default("openclaw"),
  systemEventCapable: z.boolean(),
});
export type PluginCapabilityPost = z.infer<typeof PluginCapabilityPost>;
```

**Descriptor convention to mirror** (`src/schemas/subscription.ts` end-to-end + `src/ipc/schemas.ts:194-200`): every new field carries `.describe()`. `npm run docs:generate` enforces this.

**`.strict()` discipline** (lines 37-48 — `InvokeToolRequest` uses `.strict()` to reject unknown envelope fields): `ChatDeliveryRequest` already uses `passthrough()` on the inner `delivery` block but NOT `.strict()` on the outer envelope. Phase 45 ADDS new top-level fields — this works because the outer envelope was always permissive. NO `.strict()` should be added in Phase 45 (would break older plugins).

---

### `src/daemon/daemon.ts` (wiring/bootstrap, daemon-side)

**Analog:** self.

**Existing notifier construction** (`src/daemon/daemon.ts:194-197`):
```ts
const chatNotifier = new OpenClawChatDeliveryNotifier({
  resolveStoreForTask,
  messageTool: queueBackedMessageTool,
});
```

**Phase 45 change — pass `systemEventCapable` flag** (sketch — uses a closure-captured mutable cache that the new `/v1/plugin/capability` route writes to):
```ts
// Phase 45 — shared mutable capability state, written by the
// /v1/plugin/capability route handler, read by the notifier on every send.
const pluginCapabilities = new Map<string, { systemEventCapable: boolean }>();
const getSystemEventCapable = (): boolean =>
  pluginCapabilities.get("openclaw")?.systemEventCapable === true;

const chatNotifier = new OpenClawChatDeliveryNotifier({
  resolveStoreForTask,
  messageTool: queueBackedMessageTool,
  // Read fresh each time deliverOne fires — capability may flip from false→true
  // mid-life (boot race RESEARCH §R2). Notifier accepts either a boolean or a
  // getter; a getter avoids the "freeze the value at construction" gotcha.
  systemEventCapable: false,           // initial; daemon flips via accessor (see notifier ctor TODO)
});
```

**Better pattern (recommended):** make the notifier accept a `() => boolean` getter rather than a static boolean. Mirrors the `getStateProvider`-style pattern already used elsewhere in `daemon.ts`:
```ts
// In OpenClawChatDeliveryNotifier:
systemEventCapable?: boolean | (() => boolean);
// ...inside deliverOne:
const capable = typeof this.opts.systemEventCapable === "function"
  ? this.opts.systemEventCapable()
  : this.opts.systemEventCapable === true;
```

**Existing recovery-pass IIFE to keep** (lines 199-254): no changes. The recovery pass calls `replayUnnotifiedTerminals` which calls `deliverOne`. The new `systemEventCapable` flag will be checked inside `deliverOne` and the recovery path picks it up automatically. Boot timing: if the plugin posts capability AFTER the recovery pass runs, the recovered tasks will get `channel: "chat"` (with fallback warning); subsequent live wake-ups will get `channel: "both"`. Acceptable per RESEARCH §R2.

**Existing IpcDeps wiring to extend** (Phase 45 needs a new dep so the new route handler can write to `pluginCapabilities`):
```ts
const deps: IpcDeps = {
  // ... existing fields ...
  // NEW Phase 45:
  setPluginCapability: (post) => pluginCapabilities.set(post.pluginId, { systemEventCapable: post.systemEventCapable }),
};
```

**`IpcDeps` extension in `src/ipc/types.ts`** (mirror the existing `chatDeliveryQueue` / `deliverChatResult` pattern at lines 58-64):
```ts
/** Phase 45 — sets the capability cache when the plugin posts /v1/plugin/capability. */
setPluginCapability?: (post: PluginCapabilityPost) => void;
```

**New IPC route to add** — `src/ipc/routes/plugin-capability.ts`:
```ts
// Mirror the shape of src/ipc/routes/delivery-result.ts (POST + Zod parse + 405 on non-POST).
// Wired in src/ipc/server-attach.ts under the static `routes` map at line 38.
```

---

### `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` (unit test extension)

**Analog:** self — extend existing file with new `describe` block: `"OpenClawChatDeliveryNotifier — Phase 45 system-event injection"`.

**Existing test conventions to follow** (`src/openclaw/__tests__/openclaw-chat-delivery.test.ts:1-50`):
- `vi.mock("../../logging/index.js", ...)` — mocked logger so `wakeLog.info` calls don't pollute test output (lines 13-15).
- `makeFixture()` helper — tmpdir + real `FilesystemTaskStore` + real `SubscriptionStore` (lines 17-38).
- `makeEvent(taskId, to)` helper — builds a `task.transitioned` event (lines 40-49).
- `vi.fn(async () => undefined)` mock for `messageTool.send` — assert call shape via `expect(send).toHaveBeenCalledWith(target, message, ctx)`.

**Phase 45 test cases to add** (per RESEARCH §Testing Strategy Layer 1, cases 1-10):

```ts
describe("OpenClawChatDeliveryNotifier — Phase 45 system-event injection", () => {
  it("packages systemEvent + heartbeat envelope when systemEventCapable=true", async () => {
    const { store, subStore, taskId } = await makeFixture();
    await subStore.create(taskId, "notify:openclaw-chat", "completion", {
      kind: OPENCLAW_CHAT_DELIVERY_KIND,
      sessionKey: "agent:main:telegram:group:42",
      channel: "telegram",
      target: "-42",
      threadId: "1",
      dispatcherAgentId: "main",
    });

    const send = vi.fn(async () => ({ chat: { success: true } }));
    const notifier = new OpenClawChatDeliveryNotifier({
      resolveStoreForTask: async () => store,
      messageTool: { send },
      systemEventCapable: true,
    });

    await notifier.handleEvent(makeEvent(taskId, "done"));

    expect(send).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/^✓ TASK-\d+ \(done\) — /),
      expect.objectContaining({
        systemEvent: expect.objectContaining({
          sessionKey: "agent:main:telegram:group:42",
          contextKey: `task:${taskId}:done`,
          text: expect.any(String),
          deliveryContext: { channel: "telegram", to: "-42", threadId: "1" },
        }),
        heartbeat: expect.objectContaining({
          sessionKey: "agent:main:telegram:group:42",
          agentId: "main",
          coalesceMs: 750,
          reason: "aof:wake-up",
          heartbeat: { target: "last" },
        }),
      }),
    );
  });

  it("omits systemEvent + heartbeat when systemEventCapable=false; renders fallback warning", async () => {
    // assert: send called WITHOUT systemEvent/heartbeat keys; rendered message
    // contains "Session-context wake-up not delivered"
  });

  it("renders one-line message with correct dispatcherAgentId (NOT 'unknown')", async () => {
    // D-45-BUG-AGENT-UNKNOWN: assert message contains "[agent: main]" not
    // "[agent: ?]" or "Agent: unknown"
  });

  it("emits wake-up.attempted with channel='both' when capable, 'chat' when not", async () => {
    // Spy on the mocked logger (vi.fn) and assert the channel field
  });

  it("emits wake-up.system-event-enqueued + .heartbeat-requested on success ACK", async () => {
    // send returns { chat: { success: true }, systemEvent: { success: true }, heartbeat: { success: true } }
  });

  it("emits wake-up.system-event-failed with kind on systemEvent error", async () => {
    // send returns { chat: { success: true }, systemEvent: { success: false, error: { kind: "system-event-failed", message: "..." } } }
  });

  it("emits wake-up.delivered with channel reflecting actual outcomes", async () => {
    // both succeeded → "both"; system-event failed but chat ok → "chat"
  });

  it("recovery path inherits Phase 45 behavior", async () => {
    // call replayUnnotifiedTerminals; assert send called with same systemEvent/heartbeat shape
  });

  it("WAKE_UP_COALESCE_MS constant is 750", async () => {
    // assert via the heartbeat.coalesceMs argument
  });

  it("contextKey format is task:{taskId}:{toStatus}", async () => {
    // D-45-DEDUP-KEY assertion
  });
});
```

---

### `src/openclaw/__tests__/chat-message-sender.test.ts` (NEW unit test)

**Analog:** `src/openclaw/__tests__/dispatch-notification.test.ts` (closest in this module family — pure unit test of a transform/transport function with no fixtures).

**Imports + mock pattern to copy** (`src/openclaw/__tests__/dispatch-notification.test.ts:1-19`):
```ts
import { describe, expect, it, vi } from "vitest";
import { sendChatDelivery } from "../chat-message-sender.js";
import type { OpenClawApi } from "../types.js";
import type { ChatDeliveryRequest } from "../../ipc/schemas.js";
```

**Mock api shape to copy from `adapter.test.ts:36-55` `makeMockClient` style:**
```ts
function makeMockApi(overrides: Partial<OpenClawApi> = {}): OpenClawApi {
  const sendText = vi.fn(async () => undefined);
  return {
    registerService: vi.fn(),
    registerTool: vi.fn(),
    on: vi.fn(),
    runtime: {
      channel: {
        outbound: {
          loadAdapter: vi.fn(async () => ({ sendText })),
        },
      },
    } as unknown as OpenClawApi["runtime"],
    ...overrides,
  };
}
```

**Test cases (per RESEARCH §Testing Strategy Layer 1, cases 11-14):**
```ts
describe("sendChatDelivery — Phase 45 system-event injection", () => {
  it("calls runtime.system.enqueueSystemEvent with req.systemEvent args when capability present", async () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeatNow = vi.fn();
    const api = makeMockApi({
      runtime: {
        channel: { outbound: { loadAdapter: vi.fn(async () => ({ sendText: vi.fn(async () => undefined) })) } },
        system: { enqueueSystemEvent, requestHeartbeatNow },
      } as unknown as OpenClawApi["runtime"],
    });
    const req: ChatDeliveryRequest = {
      id: "d-1",
      subscriptionId: "s-1",
      taskId: "TASK-001",
      toStatus: "done",
      message: "✓ TASK-001 (done) — probe [agent: main]",
      delivery: { kind: "openclaw-chat", sessionKey: "agent:main:telegram:group:42", target: "-42", channel: "telegram" },
      systemEvent: {
        sessionKey: "agent:main:telegram:group:42",
        contextKey: "task:TASK-001:done",
        text: "Task TASK-001 reached status \"done\" — probe",
        deliveryContext: { channel: "telegram", to: "-42" },
      },
      heartbeat: {
        sessionKey: "agent:main:telegram:group:42",
        agentId: "main",
        coalesceMs: 750,
        reason: "aof:wake-up",
        heartbeat: { target: "last" },
      },
    };

    const result = await sendChatDelivery(api, req);

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Task TASK-001 reached status \"done\" — probe",
      expect.objectContaining({
        sessionKey: "agent:main:telegram:group:42",
        contextKey: "task:TASK-001:done",
        deliveryContext: { channel: "telegram", to: "-42" },
      }),
    );
    expect(requestHeartbeatNow).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:group:42",
        agentId: "main",
        coalesceMs: 750,
        reason: "aof:wake-up",
        heartbeat: { target: "last" },
      }),
    );
    expect(result.systemEvent).toEqual({ success: true });
    expect(result.heartbeat).toEqual({ success: true });
  });

  it("skips system-event/heartbeat calls when api.runtime.system absent (graceful degrade)", async () => {
    // api.runtime has no `system` key. Assert no throw, result.systemEvent and result.heartbeat are undefined.
  });

  it("tags synchronous throw from enqueueSystemEvent with kind='system-event-failed'", async () => {
    // enqueueSystemEvent.mockImplementation(() => { throw new Error("system events require a sessionKey"); });
    // Assert result.systemEvent.error.kind === "system-event-failed"
  });

  it("tags synchronous throw from requestHeartbeatNow with kind='heartbeat-request-failed'", async () => {
    // Same pattern, different mock
  });

  it("preserves NoPlatformError throw path (chat send fails before system-event runs)", async () => {
    // delivery.sessionKey is a 4-part subagent key, no channel set → NoPlatformError thrown
    // assert system-event mocks NOT called
  });
});
```

**`vi.mock` of logger** (mirror `openclaw-chat-delivery.test.ts:13-15`): include the same logger mock so `log.debug`/`log.error` calls don't noise the test output.

---

### `src/daemon/__tests__/notifier-recovery-on-restart.test.ts` (extend with Phase 45 assertions)

**Analog:** self — extend with one additional describe block.

**Existing Phase 44 test fixture pattern to reuse** (`src/daemon/__tests__/notifier-recovery-on-restart.test.ts:50-73`):
```ts
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "notifier-recovery-"));
  store = new FilesystemTaskStore(dir, { projectId: null });
  await store.init();
  subStore = new SubscriptionStore(async (taskId) => { /* ... */ });
});
```

**Phase 45 test to add:**
```ts
describe("replayUnnotifiedTerminals — Phase 45 system-event on recovery", () => {
  it("packages systemEvent + heartbeat on recovery path when systemEventCapable=true", async () => {
    // Create a terminal task + active openclaw-chat sub with sessionKey
    // Construct notifier with systemEventCapable: true and a vi.fn() messageTool
    // Call replayUnnotifiedTerminals(store)
    // Assert messageTool.send was called with same systemEvent/heartbeat shape as live path
    // (same contextKey format, same coalesceMs, same target=last)
  });

  it("uses contextKey task:{taskId}:{toStatus} on recovery (D-45-DEDUP-INTERACTION-WITH-RECOVERY)", async () => {
    // Assert the contextKey passed to enqueueSystemEvent matches what the live path would use
  });
});
```

---

### `tests/integration/wake-up-dispatcher.test.ts` (extend Phase 44 anchor)

**Analog:** self.

**Existing E2E pattern from `src/daemon/__tests__/chat-delivery-e2e.test.ts:49-115`** — full daemon harness with real Unix socket, real `FilesystemTaskStore`, real `EventLogger`, real `ChatDeliveryQueue`, real `attachIpcRoutes`.

**Phase 45 test cases to add** (per RESEARCH §Testing Strategy Layer 2):
```ts
it("[Phase 45] full daemon → plugin → mock-runtime round-trip enqueues system event + requests heartbeat", async () => {
  // Add a mock runtime.system to the harness's OpenClawApi:
  const enqueueSystemEvent = vi.fn(() => true);
  const requestHeartbeatNow = vi.fn();
  const fakeApi: OpenClawApi = {
    // ... existing channel.outbound stub ...
    runtime: {
      channel: { outbound: { loadAdapter: vi.fn(async () => ({ sendText: vi.fn(async () => undefined) })) } },
      system: { enqueueSystemEvent, requestHeartbeatNow },
    } as unknown as OpenClawApi["runtime"],
    // ...
  };
  // Notifier constructed with systemEventCapable: true (or via capability post)
  // Trigger a transition; await delivery
  // Assert enqueueSystemEvent and requestHeartbeatNow each called once with expected args
});

it("[Phase 45] capability absent: chat delivery succeeds, fallback warning in chat message, system-event call NOT made", async () => {
  // Drop `system` from fakeApi.runtime
  // Notifier constructed with systemEventCapable: false
  // Trigger transition, capture the message passed to sendText
  // Assert enqueueSystemEvent NOT called, message contains "Session-context wake-up not delivered"
});
```

**Env-gate pattern** (matches `tests/integration/daemon-restart-midpoll.test.ts`):
```ts
const SHOULD_RUN = process.env.AOF_INTEGRATION === "1";
describe.skipIf(!SHOULD_RUN)("wake-up-dispatcher Phase 45", () => { /* ... */ });
```

---

## Shared Patterns

### Logger pattern (all production files)
**Source:** `createLogger` from `src/logging/index.js`, module-scoped constant.

```ts
import { createLogger } from "../logging/index.js";
const log = createLogger("component-name");
const wakeLog = createLogger("wake-up-delivery");          // dedicated channel for wake-up.* events
```

**Apply to:** every production file modified in Phase 45. NEVER `console.*` in core modules (CLAUDE.md §Conventions).
**Reference sites:** `openclaw-chat-delivery.ts:26,30`, `chat-message-sender.ts:29`, `chat-delivery-poller.ts:20`, `adapter.ts:24`, `chat-delivery-queue.ts:24`.

### Error-kind tagging via duck-type
**Source:** `src/ipc/chat-delivery-queue.ts:79-81, 149-153`.

```ts
const err = new Error(msg);
(err as Error & { kind?: string }).kind = "...";
reject(err);
```

**Apply to:** Phase 45 new error tags `"system-event-failed"`, `"heartbeat-request-failed"`. The downstream catch in `openclaw-chat-delivery.ts:171-174` extracts `.kind` via duck-typing — preserve that contract end-to-end. The plugin-side `sendChatDelivery` returns the structured `error.kind` directly (no Error throw needed for these channels — they're recorded in the per-channel ACK).

### Zod descriptor + z.infer pairing (schema changes)
**Source:** `src/ipc/schemas.ts` end-to-end.

```ts
export const Foo = z.object({
  field: z.string().describe("Human-readable docs surface"),
}).passthrough();
export type Foo = z.infer<typeof Foo>;
```

**Apply to:** every new schema field in `ipc/schemas.ts` and the `OpenClawChatDelivery` extension (if any). Every field carries `.describe()`. No `interface` alongside Zod schemas — Zod is source of truth (CLAUDE.md §Conventions).

### Optional-runtime feature-detect
**Source:** `src/openclaw/adapter.ts:141`.

```ts
if (typeof api.registerHttpRoute === "function") { /* use it */ }
```

**Apply to:** `api.runtime?.system?.enqueueSystemEvent` capability detection at `registerAofPlugin` entry. The optional-chaining traversal handles "no runtime", "no system surface", "system but no enqueueSystemEvent" uniformly.

### Module-level idempotency gate
**Source:** `src/openclaw/chat-delivery-poller.ts:26,35-39` + `src/openclaw/spawn-poller.ts` (same pattern).

```ts
let chatDeliveryPollerStarted = false;
export function startChatDeliveryPollerOnce(client, api): void {
  if (chatDeliveryPollerStarted) return;
  chatDeliveryPollerStarted = true;
  // ...
}
```

**Apply to:** Phase 45 capability-post should be fire-and-forget INSIDE `registerAofPlugin` (called per-plugin-reload). It's NOT a long-poll, so no module gate needed — but the `void client.postPluginCapability(...).catch(...)` pattern preserves "errors don't halt plugin registration."

### Subscription dedupe via `notifiedStatuses`
**Source:** `src/openclaw/openclaw-chat-delivery.ts:60-63` (filter) + `:151` (mark).

```ts
const chatSubs = active.filter(
  (s) => resolveDeliveryKind(s) === OPENCLAW_CHAT_DELIVERY_KIND
    && !s.notifiedStatuses.includes(to),
);
// ... after success:
await subscriptionStore.markStatusNotified(task.frontmatter.id, sub.id, toStatus);
```

**Apply to:** Phase 45 does NOT introduce a second dedup layer (D-45-DEDUP-INTERACTION-WITH-RECOVERY). The `notifiedStatuses` ledger is the only AOF-side dedup; OpenClaw's `lastText` provides the (best-effort) system-event dedup. RESEARCH §Recovery Path Interaction §"Implication for Phase 45 design" point 3.

### `try/catch → appendAttempt` audit trail
**Source:** `src/openclaw/openclaw-chat-delivery.ts:138-198`.

Every chat-delivery outcome (success OR failure) MUST produce a `subscriptionStore.appendAttempt(...)` call. Phase 45 does NOT change this — system-event success/failure is recorded ONLY in the wake-up.* logs, NOT in `attempts[]`. Rationale: per-channel ACK is operational telemetry, not subscription state. The chat-channel attempt record continues to be the source of truth for "did we attempt to deliver this status."

### `.passthrough()` on shared envelope schemas
**Source:** `src/schemas/subscription.ts` `SubscriptionDelivery`, `src/openclaw/subscription-delivery.ts` `OpenClawChatDelivery`, `src/ipc/schemas.ts` `EventBase`.

**Apply to:** Phase 45 ADDITIONS to `ChatDeliveryRequest` and `ChatDeliveryResultPost` are top-level. The outer envelope was permissive (no `.strict()`); preserve that. Older plugins that don't include `systemEvent`/`heartbeat` in the ACK continue to work — the field is optional.

### Vitest-mock-logger for unit tests
**Source:** `src/openclaw/__tests__/openclaw-chat-delivery.test.ts:13-15`.

```ts
vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() }),
}));
```

**Apply to:** all new Phase 45 unit tests AND the `chat-message-sender.test.ts` new file. The integration/E2E tests use real `createLogger`.

### Docstring-on-export convention
**Source:** `src/openclaw/dispatch-notification.ts:1-14`, `src/openclaw/openclaw-chat-delivery.ts:1-12`, `src/ipc/chat-delivery-queue.ts:1-17`, `src/openclaw/chat-message-sender.ts:1-23`.

Every module-level export carries a multi-line JSDoc block explaining the plugin-vs-core boundary, the precedence rules, and the `@module` tag. Phase 45 additions (`renderSystemEventText`, `WAKE_UP_COALESCE_MS`, `SendChatDeliveryResult`, `OpenClawSystemRuntime`, `PluginCapabilityPost`) MUST follow this pattern — `npm run docs:generate` enforces it.

### Plugin/standalone two-path discipline (CLAUDE.md §Fragile)
**Source:** `src/openclaw/types.ts:71-73` (the `OpenClawRuntime` interface with `agent?` is OPTIONAL — the standalone adapter doesn't bring an OpenClaw runtime at all).

**Apply to:** Phase 45 MUST work in standalone mode. The standalone HTTP adapter never registers a `OpenClawChatDeliveryNotifier` (it has no chat at all), so the new code paths are unreachable from standalone — the `systemEventCapable` flag stays `false`/unset. Add a unit test that verifies `OpenClawChatDeliveryNotifier` constructed without `systemEventCapable` (i.e. undefined) defaults to "no system-event" behavior.

---

## No Analog Found

Every Phase 45 file extends an existing file with a strong in-tree analog. No greenfield modules.

The sole NEW file is `src/openclaw/__tests__/chat-message-sender.test.ts` (no existing test file for `chat-message-sender.ts`). Its analog is `src/openclaw/__tests__/dispatch-notification.test.ts` — same module family, same pure-function-with-vi.fn-mocks shape.

Optional NEW file: `src/ipc/routes/plugin-capability.ts` (only if RESEARCH OQ1 Option (a) is chosen by planner). Analog: `src/ipc/routes/delivery-result.ts` — same POST + Zod parse + 405-on-non-POST shape.

---

## Risks Surfaced for Planner

1. **Boot capability-post race (RESEARCH §R2):** the daemon defaults `systemEventCapable: false`. The recovery pass may fire wake-ups with `channel: "chat"` (and the inline fallback warning) BEFORE the plugin's first `POST /v1/plugin/capability` lands. Acceptable per "errs on the side of being noisy when degraded." Plan-phase MUST decide: (a) accept the boot-window warning noise; OR (b) block the recovery pass behind capability arrival (adds boot latency). Recommend (a).

2. **Plugin restart between enqueue and heartbeat coalesce (RESEARCH §R1):** out of scope for Phase 45 — telemetry will surface this if it happens (no `wake-up.heartbeat-requested` after a `wake-up.system-event-enqueued`). Document in plan but do not mitigate.

3. **`lastText` dedup vs distinct `contextKey`s (RESEARCH §R3):** the proposed system-event text format `Task TASK-NNN reached status "done" — title` embeds both `taskId` and `toStatus`, which guarantees distinct text per transition and bypasses OpenClaw's `lastText` collision risk. The contextKey is correct identity; the text-distinctness is what actually prevents drops. Plan-phase MUST keep both invariants together — changing the text template to drop `toStatus` would silently break dedup.

4. **Standalone mode (RESEARCH §R4):** chat-delivery never runs in standalone. Phase 45 doesn't break it because the `OpenClawChatDeliveryNotifier` is never constructed. Plan-phase test case: assert standalone-adapter daemon startup does NOT instantiate `OpenClawChatDeliveryNotifier` (already true; no Phase 45 change required, but lock with a test).

5. **Heartbeat handler not registered (OpenClaw invariant 8 from RESEARCH §requestHeartbeatNow):** if OpenClaw boot order ever changes such that AOF's heartbeat fires before OpenClaw's runtime has registered the handler, the request becomes a no-op. AOF cannot detect this. Out of scope for Phase 45; surface in plan as a known limitation.

---

## Metadata

**Analog search scope:**
- `src/openclaw/` (full)
- `src/ipc/` (full)
- `src/daemon/` (full)
- `src/schemas/` (review)
- `tests/integration/` (review)

**Files scanned:** 14 production + 6 test files.

**Files read (non-overlapping ranges):**
- `src/openclaw/types.ts` (full, 90 LOC)
- `src/openclaw/openclaw-chat-delivery.ts` (full, 385 LOC)
- `src/openclaw/chat-message-sender.ts` (full, 184 LOC)
- `src/openclaw/chat-delivery-poller.ts` (full, 113 LOC)
- `src/openclaw/subscription-delivery.ts` (full, 57 LOC)
- `src/openclaw/adapter.ts` (full, 151 LOC)
- `src/openclaw/dispatch-notification.ts` (full, 66 LOC)
- `src/openclaw/daemon-ipc-client.ts` (1-300 — methods only)
- `src/openclaw/matrix-notifier.ts` (1-56)
- `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` (1-200)
- `src/openclaw/__tests__/dispatch-notification.test.ts` (1-80)
- `src/openclaw/__tests__/adapter.test.ts` (full)
- `src/ipc/schemas.ts` (full, 210 LOC)
- `src/ipc/types.ts` (full, 73 LOC)
- `src/ipc/chat-delivery-queue.ts` (full, 167 LOC)
- `src/ipc/plugin-registry.ts` (full, 83 LOC)
- `src/ipc/server-attach.ts` (full, 109 LOC)
- `src/ipc/routes/delivery-result.ts` (full, 105 LOC)
- `src/ipc/routes/session-events.ts` (full, 176 LOC)
- `src/daemon/daemon.ts` (140-260, notifier wiring + recovery IIFE)
- `src/daemon/__tests__/notifier-recovery-on-restart.test.ts` (1-80)
- `src/daemon/__tests__/chat-delivery-e2e.test.ts` (1-120)

**Pattern extraction date:** 2026-04-24

**Load-bearing observations for the planner:**

1. **Phase 45's biggest architectural twist is daemon-vs-plugin separation.** `runtime.system.*` only exists in the gateway (plugin) process. The daemon-side `OpenClawChatDeliveryNotifier` cannot call `enqueueSystemEvent` directly — it ships the call args to the plugin via the existing `ChatDeliveryRequest` envelope. Phase 44 already established this IPC channel; Phase 45 adds two optional fields (`systemEvent`, `heartbeat`) plus matching ACK fields. Single round-trip preserved.

2. **The Phase 44 schema is forward-compatible without break.** `OpenClawChatDelivery` uses `.passthrough()`. `ChatDeliveryRequest.delivery` uses `.passthrough()`. Outer envelopes do NOT use `.strict()`. Phase 45 additions are purely additive at every layer.

3. **The recovery path participates automatically.** `replayUnnotifiedTerminals` calls `deliverOne` which is where Phase 45 changes land. NO additional recovery-path wiring needed. Boot capability-post race is acceptable per RESEARCH §R2.

4. **Capability-post is the cleanest forwarding mechanism (Option (a)).** The alternative (long-poll header) couples capability into hot-path polling. Option (a) is one-shot at boot, easy to test, fits existing IPC pattern shape.

5. **No new long-poll, no new queue.** Phase 45 reuses `/v1/deliveries/wait` + `/v1/deliveries/{id}/result` unchanged. The only new route is `POST /v1/plugin/capability` (one-shot; not a long-poll).

6. **`renderMessage` rewrite is the only significant refactor.** Today's multi-line format → one-line + correct agent + optional fallback warning. Three test cases pin this (BREVITY, BUG-AGENT-UNKNOWN, FALLBACK-WARNING).

7. **Coalesce window (750 ms) is the load-bearing tunable.** Plan-phase should keep it as a literal `WAKE_UP_COALESCE_MS` constant in `openclaw-chat-delivery.ts` per CLAUDE.md "no flag sprawl." Telemetry will surface if 750 ms is wrong; the deferred batched-heartbeat scheduler can revisit.

## PATTERN MAPPING COMPLETE
