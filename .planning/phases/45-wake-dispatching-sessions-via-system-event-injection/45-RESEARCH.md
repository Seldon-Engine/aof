# Phase 45: Wake dispatching sessions via system-event injection — Research

**Researched:** 2026-04-24
**Domain:** OpenClaw runtime integration (system-events queue + heartbeat coalescer) + AOF chat-delivery hook extension
**Confidence:** HIGH

---

## Phase Goal

Phase 44 closed the *chat audit* half of the dispatcher wake-up loop: when a dispatched task reaches a `notifyOn`-matching terminal status, AOF's `OpenClawChatDeliveryNotifier` posts a message to the dispatcher's chat. UAT proved the message lands but the orchestrator does not react — chat messages are passive. Phase 45 closes the *agent reaction* half by adding two OpenClaw runtime calls inside the existing `deliverOne` hook: `runtime.system.enqueueSystemEvent` (appends the completion text to the dispatcher session's pending-events queue, so the next turn's prompt context contains it) and `runtime.system.requestHeartbeatNow` (forces that session to actually take a turn within a coalesce window instead of waiting up to the user's `heartbeat.every` interval — 15 minutes for `main`). Both channels (chat + system-event) fire on every wake-up, gated by the same `notifyOn` list. The chat path is reclassified as "human observer / audit trail"; the system-event path is the load-bearing wake-up. Out of scope: AOF-side batched-heartbeat scheduler, vestigial-chat-code refactor, project-wide subscription, `target: "last"` change, structured (non-text) payloads.

---

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-45-GOAL:** Dispatcher's next turn receives the completion as turn-context AND reacts to it (not just "a chat message exists").
- **D-45-PRIMITIVE:** Use `runtime.system.enqueueSystemEvent(text, { sessionKey, contextKey, deliveryContext })` + `runtime.system.requestHeartbeatNow({ sessionKey, coalesceMs, heartbeat: { target: "last" }, reason })`. Mirrors OpenClaw's own cron pattern (see §OpenClaw Cron Call-Site).
- **D-45-CHANNEL-ORTHOGONALITY:** Both channels fire on every wake-up subject to `notifyOn`. Chat = human-visible observer/audit. System-event = the actual agent wake-up.
- **D-45-MESSAGE-BREVITY:** Chat wake-up message MUST be one line. Approximate template: `✓ TASK-NNN ({status}) — {title}` for completion, `⚠ TASK-NNN ({status}) — {title}` for failure-class.
- **D-45-BUG-AGENT-UNKNOWN:** Fix the `Agent: unknown` bug in `renderMessage`. Use `delivery.dispatcherAgentId` (from `OpenClawChatDelivery` schema), NOT `event.actor`.
- **D-45-HEARTBEAT-POLICY:** Always call `requestHeartbeatNow` after `enqueueSystemEvent` with a coalesce window (`coalesceMs`).
- **D-45-HEARTBEAT-TARGET:** Always pass `heartbeat: { target: "last" }` on `requestHeartbeatNow` — matches OpenClaw cron pattern; without it, heartbeat goes to default `target: "none"` (suppressed).
- **D-45-FEATURE-DETECT:** Extend `OpenClawApi` in `src/openclaw/types.ts` with optional `runtime?.system?.enqueueSystemEvent` / `requestHeartbeatNow`. Inspect at notifier construction. If absent → emit one-time `wake-up.system-event-unavailable` log + chat-only fallback.
- **D-45-FALLBACK-WARNING:** When system-event API unavailable, the chat message MUST include an inline warning: "⚠ Session-context wake-up not delivered (gateway system-event API unavailable). Upgrade OpenClaw gateway to receive automatic wake-ups on task completion."
- **D-45-DEDUP-KEY:** `contextKey = "task:{taskId}:{toStatus}"` on every `enqueueSystemEvent` call.
- **D-45-NOTIFYON-GATING:** Both channels follow the SAME `notifyOn` list — no second per-channel opt-in.
- **D-45-DEDUP-INTERACTION-WITH-RECOVERY:** Same `contextKey` across live and recovery paths. OpenClaw's own dedup handles boot-recovery replay. Do NOT add a second AOF-side dedup layer for system-events; `notifiedStatuses` continues to track delivery-attempt accounting only.
- **D-45-TELEMETRY:** Four new structured log events on `wakeLog`: `wake-up.system-event-enqueued`, `.heartbeat-requested`, `.system-event-unavailable`, `.system-event-failed`. Each carries `subscriptionId, taskId, toStatus, sessionKey, dispatcherAgentId, contextKey` (and `kind + message` for `.failed`).
- **D-45-TELEMETRY-DIMENSION:** Existing `wake-up.attempted` and `wake-up.delivered` gain `channel` field (`"chat"` | `"system-event"` | `"both"`).

### Claude's Discretion

- Exact chat message template wording (one-line shape locked; exact words flexible)
- Exact `coalesceMs` value (500–1000ms range locked; exact value researched — see §Coalesce Window Recommendation)
- Whether to derive a `deliveryContext` for `enqueueSystemEvent` (mimic cron's `requesterOrigin` if useful — see §OpenClaw Cron Call-Site for the recommendation)
- Whether to persist a `channel` field on the subscription record itself (optional; recommended NO — it's per-attempt telemetry, not subscription-scoped state)

### Deferred Ideas (OUT OF SCOPE)

- AOF-side batched-heartbeat scheduler (~10s window across affected sessions) — future phase
- Refactor pass to strip vestigial chat-delivery code — wait for Phase 45 telemetry to validate observer-only classification
- Per-channel `notifyOn` overrides — speculative; don't build
- Structured (non-text) system-event payloads — Phase 45 uses plain one-line text
- Project-wide subscription (backlog 999.4)
- Stale-OpenClaw-worker detection (backlog 999.5)

---

## Project Constraints (from CLAUDE.md)

The following CLAUDE.md directives constrain Phase 45 implementation. Plans MUST honor them:

| Directive | Source | Phase 45 Impact |
|-----------|--------|-----------------|
| Config via `getConfig()` only; no `process.env` outside `config/registry` | §Conventions | Coalesce window must be a literal constant or a registered config key — NOT `process.env.AOF_COALESCE_MS` |
| `createLogger('component')`; no `console.*` | §Conventions | Reuse existing `wakeLog = createLogger("wake-up-delivery")` |
| `ITaskStore` methods only; no direct `serializeTask` + `writeFileAtomic` | §Conventions | Subscription updates already use `SubscriptionStore` — preserve |
| Zod schemas as source of truth | §Conventions | If `runtime.system` capability flag is persisted on subscription delivery, schema must extend `OpenClawChatDelivery` |
| No circular deps; verify with `npx madge` | §Conventions | New IPC schema lives in `src/ipc/schemas.ts` (existing pattern), not in `openclaw/` |
| Two adapters (plugin/standalone); changes risk breaking one mode | §Fragile | Standalone HTTP adapter has NO `runtime.system` — feature-detect MUST gracefully degrade |
| Chat-delivery cross-process chain blocks on plugin ACK; don't add async work without understanding | §Fragile | The new system-event call adds another async hop on the same chain — preserve the per-request timeout pattern in `ChatDeliveryQueue` |
| Always reset Vitest workers after aborted test runs | §Orphan vitest workers | Plan steps that re-run tests should include the orphan-kill incantation |
| Dual-launchctl-kickstart after deploy (gateway + daemon) | §Build & Release | Phase 45 UAT requires fresh processes after deploy — both jobs |
| Zombie `openclaw-agent` cache + stale `openclaw` worker | §Build & Release | UAT must verify with reboot or `kill -9` of zombies; manifest mismatch = false negative |

---

## Phase Requirements

> Per CONTEXT.md, Phase 45 is decision-driven via D-45-* (no REQ-IDs). Each `D-45-*` decision is implicitly a requirement for Phase 45. The plan-phase MUST treat each `D-45-*` ID as the unit of REQ-ID-equivalent traceability.

| D-ID | Behavior | Research Support |
|------|----------|------------------|
| D-45-GOAL | Dispatcher's next turn includes completion as context AND agent reacts | Manual UAT only (unmockable). Code-side guarantee: enqueueSystemEvent + requestHeartbeatNow both succeed (verifiable via telemetry). |
| D-45-PRIMITIVE | Use `runtime.system.enqueueSystemEvent` + `requestHeartbeatNow` | Signatures verified against installed `.d.ts` (§OpenClaw Primitive Contracts) |
| D-45-CHANNEL-ORTHOGONALITY | Both channels fire on every wake-up | New code lives inside `deliverOne`; no branch removes chat path |
| D-45-MESSAGE-BREVITY + D-45-BUG-AGENT-UNKNOWN | One-line message with correct agent | `renderMessage` rewrite (§Hook Point) |
| D-45-HEARTBEAT-POLICY + D-45-HEARTBEAT-TARGET | `requestHeartbeatNow` with coalesce + `target: "last"` | Cron call-site pattern (§OpenClaw Cron Call-Site Reference) |
| D-45-FEATURE-DETECT | Extend `OpenClawApi`; degrade gracefully | Standalone adapter / older OpenClaw lacks `runtime.system` (§Hook Point) |
| D-45-FALLBACK-WARNING | Inline chat warning when system-event API unavailable | `renderMessage` accepts a `systemEventUnavailable` flag (§Fallback Warning Surface) |
| D-45-DEDUP-KEY + D-45-DEDUP-INTERACTION-WITH-RECOVERY | `task:{taskId}:{toStatus}` shared across live + recovery | OpenClaw dedup is on `lastText` (text-equality), not `contextKey` — see §Recovery Path Interaction for the implication |
| D-45-NOTIFYON-GATING | Both channels gated by same `notifyOn` | Already enforced by existing `chatSubs.filter(s => !s.notifiedStatuses.includes(to))` — no new code |
| D-45-TELEMETRY + D-45-TELEMETRY-DIMENSION | Four new events + `channel` field on existing two | All in `deliverOne` and `replayUnnotifiedTerminals` (§Telemetry Implementation Plan) |

---

## OpenClaw Primitive Contracts

**Source:** `[VERIFIED: /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/infra/system-events.d.ts]`, `[VERIFIED: /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/infra/heartbeat-wake.d.ts]`, `[VERIFIED: /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/plugins/runtime/types-core.d.ts]` (OpenClaw 2026.4.22+, installed locally).

### `enqueueSystemEvent`

```ts
export type SystemEvent = {
  text: string;
  ts: number;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  trusted?: boolean;
};

type SystemEventOptions = {
  sessionKey: string;        // required, throws if blank
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  trusted?: boolean;         // defaults to true
};

export declare function enqueueSystemEvent(
  text: string,
  options: SystemEventOptions,
): boolean;
```

**Where `DeliveryContext`** (from `plugin-sdk/src/utils/delivery-context.types.d.ts`):
```ts
export type DeliveryContext = {
  channel?: string;       // e.g. "telegram"
  to?: string;            // e.g. "-1003844680528"
  accountId?: string;
  threadId?: string | number;  // e.g. 1
};
```

**Invariants (verified by reading `system-events-B0HpjUDQ.js`):**

1. **Synchronous, returns `boolean`** — NOT a Promise. `true` if event was queued, `false` if rejected.
2. **`sessionKey` is required** — `requireSessionKey` throws `Error("system events require a sessionKey")` on empty/whitespace.
3. **Empty/whitespace text → `false`** (silently dropped).
4. **Dedup is on `lastText`, NOT `contextKey`** — if the queue's most-recent text equals the new text (after `.trim()`), `false` is returned and nothing is queued. `contextKey` is recorded but does NOT participate in dedup. Distinct text with the same `contextKey` enqueues twice.
5. **Per-session bounded queue** — `MAX_EVENTS = 20`; oldest event drops on overflow.
6. **`contextKey` is normalized** — lowercased + trimmed via `normalizeOptionalLowercaseString`. Use lowercase keys to avoid surprise mismatches.
7. **Drained on agent turn** — OpenClaw's heartbeat handler calls `drainSystemEventEntries(sessionKey)` and injects the texts into the next turn's prompt context.

### `requestHeartbeatNow`

```ts
export declare function requestHeartbeatNow(opts?: {
  reason?: string;
  coalesceMs?: number;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: { target?: string };
}): void;
```

**Invariants (verified by reading `heartbeat-wake-D_G4Eh9_.js`):**

1. **Synchronous, returns `void`** — fire-and-forget.
2. **`coalesceMs` semantics:** schedules a single timer at `Date.now() + max(0, coalesceMs)`. Default if omitted: `DEFAULT_COALESCE_MS = 250` ms.
3. **Coalescing rule:** if a timer is already scheduled and its dueAt is ≤ the new request's dueAt, the new request is folded into the existing timer (not rescheduled). All pending wakes drain in one batch when the timer fires.
4. **Per-target merge** — wakes are keyed by `getWakeTargetKey({ agentId, sessionKey })`. Multiple `requestHeartbeatNow` calls for the same `(agentId, sessionKey)` collapse into one batch entry.
5. **`heartbeat: { target: "last" }`** — required to deliver to the session's last active channel. Default would be `target: "none"` (suppressed). The cron service ALWAYS passes `target: "last"` via `runHeartbeatOnce` and `requestHeartbeatNow` (`server.impl-D40kmTX8.js:4190, 4198, 4218, 4250`).
6. **`reason`** — observable in OpenClaw's heartbeat-runner logs; use a stable, grep-friendly value like `"aof:wake-up"`.
7. **Retries on busy** — if the heartbeat handler returns `{ status: "skipped", reason: "requests-in-flight" }`, the request is re-queued with a `DEFAULT_RETRY_MS = 1000` ms backoff. AOF caller does not need to handle this.
8. **No handler registered → no-op** — `requestHeartbeatNow` queues but the timer fires against a `null` handler if `setHeartbeatWakeHandler` was never called. In practice the OpenClaw runtime registers it during boot. AOF cannot detect this; it is invisible from the call-site.

### `runtime.system` surface (PluginRuntimeCore)

`[VERIFIED: types-core.d.ts:61-73]`

```ts
system: {
  enqueueSystemEvent: typeof import("../../infra/system-events.js").enqueueSystemEvent;
  requestHeartbeatNow: typeof import("../../infra/heartbeat-wake.js").requestHeartbeatNow;
  runHeartbeatOnce: (opts?: RunHeartbeatOnceOptions) => Promise<HeartbeatRunResult>;
  runCommandWithTimeout: ...;
  formatNativeDependencyHint: ...;
}
```

Phase 45 only needs `enqueueSystemEvent` and `requestHeartbeatNow`. `runHeartbeatOnce` is the synchronous variant the cron uses for foreground delivery; we do NOT need it (we want fire-and-forget coalesce).

---

## OpenClaw Cron Call-Site Reference Pattern

The canonical example lives in **two** OpenClaw chunks. Both are read-only references — Phase 45 will not modify them.

### Pattern A: background-task delivery (closer to AOF's use case)

`[VERIFIED: /opt/homebrew/lib/node_modules/openclaw/dist/task-registry-BJCE3lhL.js:1748-1762]`

```js
function queueTaskSystemEvent(task, text) {
  const owner = resolveTaskDeliveryOwner(task);
  const ownerKey = owner.sessionKey?.trim();
  if (!ownerKey) return false;
  enqueueSystemEvent(text, {
    sessionKey: ownerKey,
    contextKey: `task:${task.taskId}`,         // NOTE: no toStatus suffix
    deliveryContext: owner.requesterOrigin     // optional channel hint
  });
  requestHeartbeatNow({
    reason: "background-task",
    sessionKey: ownerKey
    // NOTE: no `heartbeat: { target: "last" }`, no `coalesceMs`
  });
  return true;
}
```

### Pattern B: cron job delivery (closer to "force a turn now" semantics)

`[VERIFIED: /opt/homebrew/lib/node_modules/openclaw/dist/server.impl-D40kmTX8.js:4162-4255]`

```js
async function executeMainSessionCronJob(state, job, abortSignal, waitWithAbort) {
  // ... resolve text/sessionKey ...
  state.deps.enqueueSystemEvent(text, {
    agentId: job.agentId,
    sessionKey: targetMainSessionKey,
    contextKey: `cron:${job.id}`
  });
  if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
    // foreground path: runHeartbeatOnce with target: "last"
    heartbeatResult = await state.deps.runHeartbeatOnce({
      reason: `cron:${job.id}`,
      agentId: job.agentId,
      sessionKey: targetMainSessionKey,
      heartbeat: { target: "last" }
    });
    // ... (busy/retry loop) ...
  }
  // background fallback path:
  state.deps.requestHeartbeatNow({
    reason: `cron:${job.id}`,
    agentId: job.agentId,
    sessionKey: targetMainSessionKey,
    heartbeat: { target: "last" }
  });
}
```

### What Phase 45 should mirror

| Concern | AOF choice | Source pattern |
|---------|-----------|----------------|
| `sessionKey` shape | `delivery.sessionKey` (already captured Phase 44) | Pattern A — same shape (`agent:<agentId>:<platform>:...`) |
| `contextKey` | `task:{taskId}:{toStatus}` (D-45-DEDUP-KEY) | Diverges from Pattern A — we want per-transition dedup, not per-task |
| `agentId` param to `enqueueSystemEvent` | **omit** — OpenClaw type (`SystemEventOptions`) does not include `agentId`; cron-job code passes it but the system-events module does not consume it | Cron Pattern B passes it; AOF should not |
| `deliveryContext` | **derive from `delivery.channel/threadId/target`** when available; otherwise omit | Pattern A passes `owner.requesterOrigin` |
| `agentId` param to `requestHeartbeatNow` | pass `delivery.dispatcherAgentId` if set, otherwise omit | Pattern B passes it; useful for OpenClaw's heartbeat-runner logs |
| `heartbeat: { target: "last" }` | **always pass** | Pattern B (D-45-HEARTBEAT-TARGET) |
| `coalesceMs` | pass an explicit value (see §Coalesce Window Recommendation) | OpenClaw's default is 250 ms; Pattern A doesn't pass it; we want a slightly larger window for batching |
| `reason` | stable string like `"aof:wake-up"` | Pattern B uses `cron:${job.id}` shape |

**On `deliveryContext`:** Phase 45 SHOULD construct one when `delivery.channel` is present. Without it, the heartbeat-driven turn may fail to deliver text back to the same chat. Recommended derivation:

```ts
const deliveryContext = delivery.channel
  ? {
      channel: delivery.channel,
      to: delivery.target,
      threadId: delivery.threadId,
    }
  : undefined;
```

This mirrors Pattern A (`owner.requesterOrigin` shape) using the fields Phase 44 already persists on `OpenClawChatDelivery`.

---

## Hook Point in AOF

### Architectural reality: daemon vs plugin

**Critical:** `OpenClawChatDeliveryNotifier` is constructed in the **daemon process** (`src/daemon/daemon.ts:194`), but `runtime.system` only exists in the **OpenClaw plugin process** (gateway). The daemon does NOT have direct access to the OpenClaw API. Phase 45 cannot call `enqueueSystemEvent` directly from `deliverOne`.

There are two options:

**Option A — extend the chat-delivery long-poll IPC** (RECOMMENDED): Add `systemEvent` and `heartbeat` request fields to the existing `ChatDeliveryRequest` envelope (or create a sibling envelope). The plugin already polls `/v1/deliveries/wait` and ACKs back via `/v1/deliveries/{id}/result`. Reuse the same plumbing: when the plugin receives a request, after `sendChatDelivery` succeeds, it ALSO calls `api.runtime.system.enqueueSystemEvent` + `requestHeartbeatNow`. The plugin reports per-channel success/failure in the ACK so the daemon's telemetry can record both. Single IPC round-trip per wake-up.

**Option B — add a second IPC envelope/queue + poller** (NOT recommended): Mirrors the chat path but doubles the long-poll load and adds a second blocking await on the EventLogger callback chain (already flagged as fragile in CLAUDE.md §Fragile).

**Recommendation: Option A.** It preserves a single IPC hop, matches the existing pattern, and lets the plugin enforce the "both channels fire orthogonally on every wake-up" contract atomically (D-45-CHANNEL-ORTHOGONALITY).

### Files modified

| File | Change |
|------|--------|
| `src/openclaw/types.ts` | Extend `OpenClawApi.runtime` with optional `system?: { enqueueSystemEvent, requestHeartbeatNow }` matching the OpenClaw `.d.ts` shapes |
| `src/openclaw/openclaw-chat-delivery.ts` | Pass `delivery` (or extracted system-event fields) through `messageTool.send` so the IPC envelope carries them; rewrite `renderMessage` for one-line + correct agent + optional warning; emit four new telemetry events; add `channel` field to existing two events |
| `src/openclaw/chat-message-sender.ts` | After `sendText`, call `api.runtime?.system?.enqueueSystemEvent` + `requestHeartbeatNow` (when capability present); catch each separately; report per-channel result back to daemon via extended ACK |
| `src/openclaw/chat-delivery-poller.ts` | Receive extended ACK; surface per-channel error kind back to the daemon |
| `src/ipc/schemas.ts` | Extend `ChatDeliveryRequest` with `systemEvent?: { sessionKey, contextKey, text, deliveryContext? }` and `heartbeat?: { sessionKey, agentId?, coalesceMs, reason, heartbeat: { target: "last" } }` (or just `wake?: { ... }` aggregating both); extend `ChatDeliveryResultPost` with optional per-channel result fields |
| `src/ipc/chat-delivery-queue.ts` | No structural change — extended envelope flows through opaquely |
| `src/openclaw/adapter.ts` | Feature-detect at plugin boot: log `wake-up.system-event-unavailable` when `api.runtime?.system?.enqueueSystemEvent` is undefined; pass the capability flag into the chat-delivery-poller (so the poller knows whether to skip the system-event path AND whether to set the `systemEventUnavailable` flag on outbound chat messages) |
| `src/daemon/daemon.ts` | No new wiring — the existing `replayUnnotifiedTerminals` path already calls `deliverOne`, so the new behavior automatically participates in recovery |

### Insertion point inside `deliverOne` (current line 124+)

Today (Phase 44):
```ts
const message = renderMessage({ task, toStatus, actor, reason, runResult });
wakeLog.info({ ... }, source === "recovery" ? "wake-up.recovery-replay" : "wake-up.attempted");
const attemptedAt = new Date().toISOString();
try {
  await this.opts.messageTool.send(target, message, {
    subscriptionId: sub.id,
    taskId: task.frontmatter.id,
    toStatus,
    delivery: sub.delivery as Record<string, unknown> | undefined,
  });
  // ... ledger updates ...
}
```

Phase 45 changes (sketch):

```ts
const dispatcherAgentId =
  (delivery as { dispatcherAgentId?: string }).dispatcherAgentId;
const message = renderMessage({
  task,
  toStatus,
  dispatcherAgentId,            // D-45-BUG-AGENT-UNKNOWN
  runResult,
  systemEventUnavailable: this.opts.systemEventUnavailable, // D-45-FALLBACK-WARNING
});
wakeLog.info({
  subscriptionId: sub.id, taskId, toStatus, source,
  sessionKey: delivery.sessionKey, dispatcherAgentId,
  channel: this.opts.systemEventUnavailable ? "chat" : "both",  // D-45-TELEMETRY-DIMENSION
}, source === "recovery" ? "wake-up.recovery-replay" : "wake-up.attempted");

// Pass system-event metadata via the messageTool envelope.
// The plugin executes both channels and reports per-channel ACK.
const ackResult = await this.opts.messageTool.send(target, message, {
  subscriptionId: sub.id,
  taskId: task.frontmatter.id,
  toStatus,
  delivery: sub.delivery as Record<string, unknown> | undefined,
  systemEvent: this.opts.systemEventCapable ? {
    sessionKey: delivery.sessionKey,
    contextKey: `task:${task.frontmatter.id}:${toStatus}`,  // D-45-DEDUP-KEY
    text: renderSystemEventText({ task, toStatus, runResult }),
    ...(deliveryContextOf(delivery) ? { deliveryContext: deliveryContextOf(delivery) } : {}),
  } : undefined,
  heartbeat: this.opts.systemEventCapable ? {
    sessionKey: delivery.sessionKey,
    agentId: dispatcherAgentId,
    coalesceMs: 750,                                        // see §Coalesce Window
    reason: "aof:wake-up",
    heartbeat: { target: "last" },                         // D-45-HEARTBEAT-TARGET
  } : undefined,
});

// Emit per-channel telemetry from the ackResult
if (ackResult?.systemEvent?.success) wakeLog.info({...}, "wake-up.system-event-enqueued");
if (ackResult?.systemEvent?.error)   wakeLog.warn({..., kind: "system-event-failed"}, "wake-up.system-event-failed");
if (ackResult?.heartbeat?.success)   wakeLog.info({...}, "wake-up.heartbeat-requested");
if (ackResult?.heartbeat?.error)     wakeLog.warn({..., kind: "heartbeat-request-failed"}, "wake-up.system-event-failed");
```

`renderMessage` rewrite (one-line + agent fix):
```ts
function renderMessage(args: {
  task: ...;
  toStatus: string;
  dispatcherAgentId: string | undefined;
  runResult: ...;
  systemEventUnavailable: boolean;
}): string {
  const { task, toStatus, dispatcherAgentId, runResult, systemEventUnavailable } = args;
  const lead = renderStatusGlyph(toStatus);   // ✓ for done, ⚠ for failure-class
  const id = task.frontmatter.id;
  const title = task.frontmatter.title;
  const agent = dispatcherAgentId ?? "?";
  let line = `${lead} ${id} (${toStatus}) — ${title} [agent: ${agent}]`;
  if (systemEventUnavailable) {
    line += `\n⚠ Session-context wake-up not delivered (gateway system-event API unavailable). Upgrade OpenClaw gateway to receive automatic wake-ups on task completion.`;
  }
  return line;
}
```

### Plugin-side (chat-message-sender or new sibling)

After `await adapter.sendText({...})` succeeds (or even on failure — the two channels are orthogonal per D-45-CHANNEL-ORTHOGONALITY), invoke:

```ts
let systemEventResult: { success: boolean; error?: { kind: string; message: string } } | undefined;
if (req.systemEvent && api.runtime?.system?.enqueueSystemEvent) {
  try {
    api.runtime.system.enqueueSystemEvent(req.systemEvent.text, {
      sessionKey: req.systemEvent.sessionKey,
      contextKey: req.systemEvent.contextKey,
      ...(req.systemEvent.deliveryContext ? { deliveryContext: req.systemEvent.deliveryContext } : {}),
    });
    systemEventResult = { success: true };
  } catch (err) {
    systemEventResult = { success: false, error: { kind: "system-event-failed", message: errMsg(err) } };
  }
}
let heartbeatResult: { success: boolean; error?: ... } | undefined;
if (req.heartbeat && api.runtime?.system?.requestHeartbeatNow) {
  try {
    api.runtime.system.requestHeartbeatNow({
      sessionKey: req.heartbeat.sessionKey,
      ...(req.heartbeat.agentId ? { agentId: req.heartbeat.agentId } : {}),
      coalesceMs: req.heartbeat.coalesceMs,
      reason: req.heartbeat.reason,
      heartbeat: req.heartbeat.heartbeat,
    });
    heartbeatResult = { success: true };
  } catch (err) {
    heartbeatResult = { success: false, error: { kind: "heartbeat-request-failed", message: errMsg(err) } };
  }
}
return { chatSuccess, systemEvent: systemEventResult, heartbeat: heartbeatResult };
```

Both calls are synchronous — no Promise to await — but wrap in try/catch because `requireSessionKey` throws on empty/whitespace.

---

## Coalesce Window Recommendation

**Recommended value: `coalesceMs: 750`** `[ASSUMED — A1]`

### Rationale

| Reference | Value | Context |
|-----------|-------|---------|
| OpenClaw default (`DEFAULT_COALESCE_MS`) | 250 ms | `[VERIFIED: heartbeat-wake-D_G4Eh9_.js:43]` |
| Cron Pattern A | (omitted → 250 ms default) | Background-task delivery |
| OpenClaw retry on busy (`DEFAULT_RETRY_MS`) | 1000 ms | `[VERIFIED: heartbeat-wake-D_G4Eh9_.js:44]` |
| Wake-now busy retry delay (cron) | 250 ms | `[VERIFIED: server.impl-D40kmTX8.js:4178]` `wakeNowHeartbeatBusyRetryDelayMs ?? 250` |
| AOF Phase 45 recommendation | **750 ms** | Sits comfortably between OpenClaw's coalesce default (250 ms — too tight) and busy-retry delay (1000 ms — at the boundary). |

Why 750 ms rather than the 250 ms default:

1. **Batching multiple completions:** The user's stated motivation in DISCUSSION-LOG was "batch multiple notifications in one context payload." A 250 ms window often falls between two close-together task completions (e.g. parent + child finishing within ~500 ms). 750 ms is wide enough to fold typical multi-completion bursts into one heartbeat turn that drains all queued system-events together (`drainSystemEventEntries` is per-session and atomic).
2. **Latency budget:** Wake-up latency under Phase 45 = `coalesceMs + heartbeat-handler runtime`. The heartbeat handler typically runs in ~100–500 ms (turn dispatch + LLM call). 750 ms coalesce keeps total wake-up under ~1.5 s — well below human "instant" threshold.
3. **Below busy-retry threshold:** Setting `coalesceMs ≥ DEFAULT_RETRY_MS` (1000) would let a busy-retry timer fire BEFORE our coalesced timer, producing a double-wake. 750 ms guarantees we fire first.
4. **Empirical alignment:** OpenClaw cron uses `DEFAULT_COALESCE_MS = 250` for a single cron-job-fired wake-up (no batching expected). AOF dispatcher wake-ups have a HIGHER batching opportunity (multiple subagents completing tasks in a managed flow), so a wider window is justified.

**Plan-phase action:** Codify `750` as a literal constant `WAKE_UP_COALESCE_MS` in `openclaw-chat-delivery.ts` (or as a registered config key in `src/config/registry.ts` if we want it tunable — recommend literal for now per CLAUDE.md "no flag sprawl"). The deferred AOF batched-heartbeat scheduler can revisit this if telemetry shows pathological behavior.

---

## Failure Modes & Error Contracts

| Failure source | What throws / returns | Phase 45 error kind | Telemetry event | Fatal? |
|----------------|----------------------|---------------------|-----------------|--------|
| `enqueueSystemEvent` with empty `sessionKey` | throws `Error("system events require a sessionKey")` | `system-event-failed` | `wake-up.system-event-failed` | NO — chat delivery still proceeds |
| `enqueueSystemEvent` with empty/whitespace text | returns `false` (no throw) | (no error — but treat `false` return as `kind: "system-event-rejected"` for symmetry, OR omit and rely on the absence of `wake-up.system-event-enqueued`) | optional: `wake-up.system-event-failed` with `kind: "rejected-empty"` | NO |
| `enqueueSystemEvent` with duplicate text (lastText match) | returns `false` (no throw) | (intentional dedup — log at debug level only or silently swallow) | none | NO — expected behavior |
| `requestHeartbeatNow` | does not throw under normal conditions; `void` return | (n/a unless wrapper catches) | `wake-up.heartbeat-requested` on success | NO |
| `requestHeartbeatNow` synchronous throw (defensive) | wrap in try/catch | `heartbeat-request-failed` | `wake-up.system-event-failed` (with `kind: "heartbeat-request-failed"`) | NO |
| `runtime.system.enqueueSystemEvent` undefined (older gateway) | n/a — feature-detect skips | n/a | `wake-up.system-event-unavailable` once at boot + `channel: "chat"` on each subsequent attempt | NO — graceful degrade |
| `runtime.system` undefined entirely | n/a — same as above | n/a | same | NO |
| `runtime` undefined (truly ancient gateway / standalone adapter) | feature-detect at adapter boot | n/a | `wake-up.system-event-unavailable` | NO |
| Plugin process restarted between enqueue and ack | The system-events queue lives in the gateway process memory (`globals` map) — restart wipes it. AOF cannot detect this. The IPC ACK still completes successfully if the call returned before the crash. | n/a | n/a | NO but agent will not wake up — covered by Phase 44 `replayUnnotifiedTerminals` if subscription was not yet marked notified |
| Daemon → plugin IPC timeout | Existing `ChatDeliveryQueue` `DEFAULT_TIMEOUT_MS = 60_000` | `timeout` (existing) | `wake-up.timed-out` (existing) | NO — both channels skipped |

**Error-kind tagging convention** (D-45-TELEMETRY): use the `(err as Error & { kind?: string }).kind = "..."` duck-type pattern already established in Phase 44. New kinds: `"system-event-failed"`, `"heartbeat-request-failed"`. Both are non-fatal — `deliverOne` does NOT throw on either; chat delivery success/failure is recorded independently.

---

## Recovery Path Interaction

### `replayUnnotifiedTerminals` is sufficient (no new code path needed)

`[VERIFIED: src/openclaw/openclaw-chat-delivery.ts:250-321]` and `[VERIFIED: src/daemon/daemon.ts:224-254]`.

- The boot-recovery IIFE in `daemon.ts:224-254` enumerates per-project stores, calls `chatNotifier.replayUnnotifiedTerminals(store)` for each, then attaches the live `addOnEvent` listener.
- `replayUnnotifiedTerminals` calls `this.deliverOne({...source: "recovery"})` for every active subscription on a terminal-status task whose `notifiedStatuses` ledger does not yet record that terminal status.
- Phase 45 changes are **inside** `deliverOne`. So the recovery path automatically gets system-event + heartbeat behavior without any new wiring.
- The WR-01 + WR-02 mitigation (live listener attached AFTER replay completes) preserves the "no double-fire" guarantee.

### Dedup behavior under recovery — IMPORTANT NUANCE

CONTEXT.md (D-45-DEDUP-INTERACTION-WITH-RECOVERY) states "OpenClaw's own system-event dedup guarantees the agent sees exactly one event per `(taskId, toStatus)` tuple." This is **partially true but not via `contextKey`** — re-read of the implementation:

- OpenClaw dedups on `lastText` (text-equality of the most-recent event in the queue), NOT on `contextKey`. `contextKey` is recorded but does not participate in the dedup decision (`enqueueSystemEvent` body, line 47: `if (entry.lastText === cleaned) return false`).
- This means: if the daemon crashes AFTER `enqueueSystemEvent` returned `true` but BEFORE the ledger update, AND the queue is drained between crash and recovery, AND we re-enqueue the same text → it WILL be enqueued again (because `lastText` was reset on drain). The user-visible duplicate is bounded to 1 (one extra event) and only happens in the specific race window.
- Conversely: if the daemon crashes AFTER the system-event was enqueued AND the queue was NOT drained yet → re-enqueue produces `false` (text matches `lastText`) → no duplicate.
- The `notifiedStatuses` ledger remains the load-bearing dedup for AOF. Once `markStatusNotified(taskId, subId, toStatus)` lands, the next `replayUnnotifiedTerminals` pass filters this subscription out via `!s.notifiedStatuses.includes(toStatus)`.

**Implication for Phase 45 design:**

1. Keep `contextKey = "task:{taskId}:{toStatus}"` as documented (D-45-DEDUP-KEY) — it's the right *identity* even if dedup is text-driven. OpenClaw exposes `isSystemEventContextChanged(sessionKey, contextKey)` which CAN be used for context-change detection if a future need arises.
2. The CONTEXT.md claim "OpenClaw's own system-event dedup guarantees exactly one event per `(taskId, toStatus)`" should be tempered: dedup is best-effort via `lastText` and operates only when the queue has not drained between attempts. The actual at-most-once property comes from AOF's `notifiedStatuses` ledger, not from OpenClaw's contextKey.
3. **No second AOF dedup layer needed** — confirmed by both mechanisms (OpenClaw text-dedup AND AOF ledger). The plan-phase MUST NOT introduce one.

---

## Telemetry Implementation Plan

All events use `wakeLog = createLogger("wake-up-delivery")` (already exists at `openclaw-chat-delivery.ts:30`).

### New events

| Event name | Where it lands | Carried fields | Trigger condition |
|------------|----------------|----------------|-------------------|
| `wake-up.system-event-enqueued` | `deliverOne` after ack returns successful `systemEvent.success` | `subscriptionId, taskId, toStatus, source, sessionKey, dispatcherAgentId, contextKey` | Plugin reported `enqueueSystemEvent` returned `true` |
| `wake-up.heartbeat-requested` | `deliverOne` after ack returns successful `heartbeat.success` | `subscriptionId, taskId, toStatus, source, sessionKey, dispatcherAgentId, agentId, coalesceMs, reason` | Plugin reported `requestHeartbeatNow` did not throw |
| `wake-up.system-event-unavailable` | (a) in `registerAofPlugin` ONCE at boot when feature-detect fails; (b) in `deliverOne` on each attempt when capability flag is false | (a): `gatewayApiKeys` (for diagnosis); (b): `subscriptionId, taskId, toStatus, sessionKey, dispatcherAgentId` | `api.runtime?.system?.enqueueSystemEvent` is undefined |
| `wake-up.system-event-failed` | `deliverOne` on receipt of `systemEvent.error` OR `heartbeat.error` from ack | `subscriptionId, taskId, toStatus, source, sessionKey, dispatcherAgentId, contextKey, kind, message` | Plugin reported either call threw |

### Extended dimension on existing events

| Event name | New field | Values | Source |
|------------|-----------|--------|--------|
| `wake-up.attempted` (already exists, line 135) | `channel` | `"chat"` (capability absent), `"both"` (capability present, both will fire), `"system-event"` (theoretical: chat path bypassed — not possible in Phase 45 since both always fire when capability exists) | Set from `this.opts.systemEventCapable` flag |
| `wake-up.recovery-replay` (already exists, line 135) | `channel` | same | same |
| `wake-up.delivered` (already exists, line 167) | `channel` | `"chat"` if only chat succeeded, `"system-event"` if only system-event succeeded, `"both"` if both succeeded | Computed from per-channel ack results |

**Subscription delivery payload — no `channel` field added.** D-45-TELEMETRY-DIMENSION lives in the structured logs only. Adding it to `OpenClawChatDelivery` schema would conflate per-attempt outcomes with subscription-scoped state. The audit trail is already recoverable from the daemon log via `wake-up.attempted.channel` + `wake-up.delivered.channel`. (This is also Claude's Discretion per CONTEXT.)

### Wave-0 telemetry tests (Vitest)

- Mock `messageTool.send` returns `{ chatSuccess: true, systemEvent: { success: true }, heartbeat: { success: true } }`. Assert all four log events fire with expected fields.
- Mock returns `{ chatSuccess: true, systemEvent: { success: false, error: { kind: "system-event-failed", message: "..." } }, heartbeat: { success: true } }`. Assert `wake-up.system-event-failed` fires with `kind` field.
- Mock with `systemEventCapable: false`. Assert `wake-up.attempted` carries `channel: "chat"` and no system-event events fire.

---

## Fallback Warning Surface

### Insertion point

In `renderMessage` (today at `openclaw-chat-delivery.ts:333-360`). The function gains a new arg `systemEventUnavailable: boolean` and conditionally appends the warning line.

### Per-message vs per-process

**Recommendation: per-message append.** Rationale:

- The audit trail is human-readable and the warning is short. Per-message appending costs nothing and ensures every chat message a human reads when the gateway is degraded carries the explanation.
- A "first-message-only" gate would require process-state (a `WeakSet<sessionKey>` of "already warned" sessions). That state is process-local, would not survive plugin reload, and would require thread-safety reasoning. Per-message is simpler and idempotent.
- The user explicitly asked for the warning to be visible WHERE THE USER WILL SEE IT (DISCUSSION-LOG response to D-45-FALLBACK-WARNING). Per-message maximizes that visibility without surprising "where did the warning go?" cases when an old chat-history message gets re-read.

### Wording

Locked from CONTEXT.md D-45-FALLBACK-WARNING: `⚠ Session-context wake-up not delivered (gateway system-event API unavailable). Upgrade OpenClaw gateway to receive automatic wake-uphs on task completion.`

(Plan-phase may tighten the wording further; the obligation is the substance, not the exact characters.)

### How the daemon knows the capability

The daemon's `OpenClawChatDeliveryNotifier` does NOT directly inspect the OpenClaw API (it's a different process). The capability flag must be:

1. Detected in the plugin (`registerAofPlugin` in `adapter.ts`) at boot.
2. Forwarded to the daemon via either:
   - **(a)** A new `POST /v1/plugin/capability` IPC call right after `registerAofPlugin` returns. Daemon caches the latest capability set per pluginId.
   - **(b)** A field on every `ChatDeliveryRequest` that the plugin sets when ACK'ing — but this is too late (the daemon already rendered the message). NOT viable for the in-message warning.
   - **(c)** A startup probe — the daemon long-polls a `GET /v1/plugin/handshake` or sets the capability lazily on first ACK.

**Recommendation: (a)** — explicit `POST /v1/plugin/capability` from `registerAofPlugin` after the feature-detect, with body `{ pluginId: "openclaw", systemEventCapable: boolean }`. The daemon `OpenClawChatDeliveryNotifier` reads this state via a new `getPluginCapability(pluginId)` accessor, defaulting to `systemEventCapable: false` (safer to warn unnecessarily during boot race than to silently degrade). When the flag flips to `true` after the first capability post, the warning stops appearing.

A simpler alternative: pass `systemEventCapable` into the notifier's constructor as an `opts` flag. This requires re-construction on capability change, but capability is essentially boot-time-stable, so this is fine.

**Plan-phase decides which pathway**; both are viable. Recommend (a) for cleanliness.

---

## Testing Strategy

### Layer 1: Unit tests (vitest, fast, mockable)

**Location:** `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` (extend existing file with new `describe` block: `"OpenClawChatDeliveryNotifier — Phase 45 system-event injection"`)

Test cases (using the existing `makeFixture` + `MockMatrixMessageTool` pattern):

1. **System-event payload is built correctly when capability present** — with `systemEventCapable: true`, the mock messageTool's `send()` is called with `systemEvent: { sessionKey: "agent:main:telegram:...", contextKey: "task:TASK-001:done", text: "...", deliveryContext: { channel: "telegram", to: "...", threadId: "1" } }` and `heartbeat: { sessionKey: "...", agentId: "main", coalesceMs: 750, reason: "aof:wake-up", heartbeat: { target: "last" } }`.
2. **No system-event payload when capability absent** — with `systemEventCapable: false`, `send()` is called WITHOUT `systemEvent`/`heartbeat` keys. The chat message carries the fallback warning line.
3. **Telemetry: `wake-up.attempted` carries `channel: "both"` when capable** — assert via spying on the mocked logger.
4. **Telemetry: `wake-up.system-event-enqueued` fires when ack reports success** — mock messageTool resolves with `{ chatSuccess: true, systemEvent: { success: true }, heartbeat: { success: true } }`.
5. **Telemetry: `wake-up.system-event-failed` fires with kind on either side throwing** — separate cases for `systemEvent.error.kind = "system-event-failed"` and `heartbeat.error.kind = "heartbeat-request-failed"`.
6. **`wake-up.delivered` carries channel reflecting actual outcomes** — `"both"` when both succeeded; `"chat"` when system-event failed but chat succeeded; etc.
7. **Recovery path inherits new behavior** — invoke `replayUnnotifiedTerminals` on a fixture with a terminal task + active subscription; assert the same system-event call shape is built.
8. **Fallback warning rendered in chat message ONLY when `systemEventUnavailable: true`** — snapshot or substring assertion on the rendered message.
9. **One-line message format + correct agent id** — assert `Agent: ${dispatcherAgentId}` appears (NOT `Agent: unknown`) when `delivery.dispatcherAgentId` is set; when it's missing, falls back to `[agent: ?]`.
10. **`coalesceMs` constant is 750** — tested by reading the value passed to `messageTool.send`.

Mocking strategy:
- The test layer does NOT need to mock `runtime.system.enqueueSystemEvent` directly because `deliverOne` does not call it — the plugin does. Daemon-side tests assert the IPC envelope shape; plugin-side tests (in `chat-message-sender.test.ts`) assert the runtime calls.

**Plugin-side tests** (extend `src/openclaw/__tests__/chat-message-sender.test.ts`):

11. **`enqueueSystemEvent` called with correct args when `req.systemEvent` present** — fake `api.runtime.system.enqueueSystemEvent = vi.fn()`. Assert call shape.
12. **`requestHeartbeatNow` called with correct args** — same pattern.
13. **Both calls swallowed if runtime.system absent** — assert no throw, ack reports both as `undefined`.
14. **Per-channel error tagging on synchronous throws** — `enqueueSystemEvent.mockImplementation(() => { throw new Error("..."); })` produces ack with `systemEvent.error.kind === "system-event-failed"`.

### Layer 2: Integration tests (`tests/integration/`, gated `AOF_INTEGRATION=1`)

Extend `tests/integration/wake-up-dispatcher.test.ts` (Phase 44's anchor) with:

15. **Full daemon → plugin → mock-runtime round-trip** — Phase 44's harness already has a mock outbound adapter; add a mock `runtime.system` that records `enqueueSystemEvent` and `requestHeartbeatNow` calls. Assert both fire exactly once per dispatch with the expected `contextKey`.
16. **Capability absent end-to-end** — drop `runtime.system` from the harness's mock api. Assert chat delivery still happens, the warning is in the chat message, and `wake-up.system-event-unavailable` log event fires.

### Layer 3: Manual UAT (the unmockable acceptance test)

Per CONTEXT.md §specifics, the UAT is:

> Rerun the Telegram probe that ended Phase 44's UAT. Success = the main agent responds IN CHAT about the completion WITHOUT the user having to ask. The agent's turn must be triggered by the heartbeat, and the completion text must be in the turn context.

Steps (incorporating CLAUDE.md's deploy-time hygiene):

1. `npm run typecheck && npm test && npm run test:e2e && npm run build && npm run deploy`
2. Verify `op run` wrapper present in plists (`rg -A 1 "ProgramArguments" ~/Library/LaunchAgents/ai.openclaw.gateway.plist ai.openclaw.aof.plist | rg "oprun"`).
3. `launchctl kickstart -k gui/$(id -u)/ai.openclaw.aof` AND `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway`.
4. **Reboot** to clear zombie `openclaw-agent` processes (CLAUDE.md §Build & Release Flavor 1).
5. Verify no stale workers (`stat -f %m /opt/homebrew/lib/node_modules/openclaw/` vs `ps -eo pid,lstart,command | grep openclaw`).
6. From Telegram (the `agent:main:telegram:group:-1003844680528:topic:1` topic), invoke a probe `aof_dispatch` and walk away.
7. Wait for child task to complete.
8. **Pass criterion:** the orchestrator agent posts in the same Telegram topic about the completion (its own message, not the chat-delivery audit message) WITHOUT the user prompting.
9. Verify daemon log contains `wake-up.system-event-enqueued` AND `wake-up.heartbeat-requested` AND `wake-up.delivered` with `channel: "both"` for the dispatched task.
10. Verify the chat audit message is one line and shows `agent: main` (not `unknown`).

If pass criterion fails despite logs showing successful enqueue+heartbeat: the issue is OpenClaw-side (heartbeat handler, prompt context injection). Debug via `~/.openclaw/agents/main/sessions/<sid>.jsonl` and the agent's transcript per CLAUDE.md §End-to-end debugging.

### Phase 44 UAT regression

Phase 44 UAT Scenario A (the chat audit message itself appears) MUST continue to pass. Phase 45 only adds behavior; it does not remove the chat path.

---

## Validation Architecture

> Per `.planning/config.json` (`workflow.nyquist_validation` is absent → treat as enabled).

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 1.x (project default) |
| Config file | `vitest.config.ts` (root) + `tests/integration/vitest.config.ts` (E2E gated) |
| Quick run command | `npx vitest run src/openclaw/__tests__/openclaw-chat-delivery.test.ts src/openclaw/__tests__/chat-message-sender.test.ts` |
| Full suite command | `npm run typecheck && npm test` |
| Integration gate | `AOF_INTEGRATION=1 npx vitest run tests/integration/wake-up-dispatcher.test.ts --config tests/integration/vitest.config.ts` |

### Phase Requirements → Test Map

| D-ID | Behavior | Test Type | Automated Command | File Exists? |
|------|----------|-----------|-------------------|-------------|
| D-45-PRIMITIVE | enqueueSystemEvent + requestHeartbeatNow called with correct args | unit (plugin) | `npx vitest run src/openclaw/__tests__/chat-message-sender.test.ts -t "Phase 45"` | ❌ Wave 0 — extend existing test file |
| D-45-CHANNEL-ORTHOGONALITY | Both channels fire on every wake-up | unit (daemon notifier) | `npx vitest run src/openclaw/__tests__/openclaw-chat-delivery.test.ts -t "system-event"` | ❌ Wave 0 |
| D-45-MESSAGE-BREVITY | Chat message is one line | unit (renderMessage) | same | ❌ Wave 0 |
| D-45-BUG-AGENT-UNKNOWN | Agent id shows real value, not "unknown" | unit (renderMessage) | same | ❌ Wave 0 |
| D-45-HEARTBEAT-POLICY | requestHeartbeatNow always called after enqueue | unit | same | ❌ Wave 0 |
| D-45-HEARTBEAT-TARGET | `heartbeat: { target: "last" }` always passed | unit | same | ❌ Wave 0 |
| D-45-FEATURE-DETECT | Capability detection at boot + log-once | unit (adapter) | `npx vitest run src/openclaw/__tests__/adapter.test.ts -t "system-event capability"` | ❌ Wave 0 — file may not exist; check first |
| D-45-FALLBACK-WARNING | Warning appears in chat message when system-event unavailable | unit (renderMessage) | `npx vitest run src/openclaw/__tests__/openclaw-chat-delivery.test.ts -t "fallback warning"` | ❌ Wave 0 |
| D-45-DEDUP-KEY | contextKey = `task:{taskId}:{toStatus}` | unit | `npx vitest run src/openclaw/__tests__/openclaw-chat-delivery.test.ts -t "contextKey"` | ❌ Wave 0 |
| D-45-NOTIFYON-GATING | Both channels gated by same notifyOn | unit — Phase 44 already covers via `notifiedStatuses` | `npx vitest run src/openclaw/__tests__/openclaw-chat-delivery.test.ts -t "dedupes"` | ✅ Phase 44 file |
| D-45-DEDUP-INTERACTION-WITH-RECOVERY | Same contextKey across live + recovery paths | unit (replay test) | `npx vitest run src/daemon/__tests__/notifier-recovery-on-restart.test.ts -t "Phase 45"` | ❌ Wave 0 — extend existing file |
| D-45-TELEMETRY (4 new events) | Each event fires with correct payload | unit (logger spy) | `npx vitest run src/openclaw/__tests__/openclaw-chat-delivery.test.ts -t "telemetry"` | ❌ Wave 0 |
| D-45-TELEMETRY-DIMENSION | `channel` field on existing two events | unit (logger spy) | same | ❌ Wave 0 |
| D-45-GOAL | Agent's next turn includes completion AND agent reacts | manual UAT | (none — see §Testing Strategy Layer 3) | manual only |
| **End-to-end IPC envelope shape** | Daemon → plugin envelope carries systemEvent + heartbeat fields | integration | `AOF_INTEGRATION=1 npx vitest run tests/integration/wake-up-dispatcher.test.ts` | ✅ extend Phase 44 anchor |

### Sampling Rate

- **Per task commit:** `npx vitest run src/openclaw/__tests__/openclaw-chat-delivery.test.ts src/openclaw/__tests__/chat-message-sender.test.ts` (~3 s)
- **Per wave merge:** `npm run typecheck && npm test` (~10 s for unit suite)
- **Phase gate:** Full suite GREEN + `AOF_INTEGRATION=1 ... wake-up-dispatcher.test.ts` GREEN + manual UAT pass

### Wave 0 Gaps

- [ ] Extend `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` with Phase 45 describe block (test cases 1–10 above)
- [ ] Extend `src/openclaw/__tests__/chat-message-sender.test.ts` with plugin-side runtime mocks (test cases 11–14)
- [ ] Extend `src/daemon/__tests__/notifier-recovery-on-restart.test.ts` with Phase 45 system-event-on-replay assertions
- [ ] Extend `tests/integration/wake-up-dispatcher.test.ts` with mock `runtime.system` + capability-absent variant
- [ ] (If using Option (a) capability post) add `src/openclaw/__tests__/adapter.test.ts` with feature-detect + capability-post-to-daemon assertions

No new framework install required. No new fixtures required (existing `makeFixture` + `MockMatrixMessageTool` cover the ground).

---

## Risks & Open Questions

### R1 (LOW risk): Plugin process restart between enqueue and heartbeat coalesce

**What:** `requestHeartbeatNow` schedules a timer in plugin-process memory. If the plugin restarts within the coalesce window (750 ms), the timer is lost AND the system-event remains in the queue until the next heartbeat naturally fires (up to `heartbeat.every` minutes later).

**Mitigation:** Out of scope for Phase 45. The system-event still lands when the next natural heartbeat fires, so the agent eventually wakes up — just with up to 15 min latency in the worst case. Phase 45 telemetry will surface this if it happens (no `wake-up.heartbeat-requested` ACK after a `wake-up.system-event-enqueued`).

**Plan-phase action:** Mention in PATTERNS.md so future phases can revisit.

### R2 (LOW risk): Capability flag race at boot

**What:** Daemon starts before plugin posts capability. The first wake-up after boot may render the fallback warning incorrectly.

**Mitigation:** The capability flag in the daemon defaults to `false` ("system-event NOT capable"). On the first capability post from the plugin, the flag flips to `true`. Boot-window wake-ups (rare — `replayUnnotifiedTerminals` runs, but recovery itself takes <1 s and the plugin posts capability within the same plugin-bootstrap cycle) may render a stale "unavailable" warning. Acceptable per "errs on the side of being noisy when degraded" framing.

**Alternative:** Block `replayUnnotifiedTerminals` until capability is known. Adds latency to boot and complicates the daemon-startup IIFE. NOT recommended.

### R3 (LOW risk): `lastText` dedup vs distinct contextKeys

**What:** OpenClaw's text-equality dedup (see §Recovery Path Interaction) means two transitions whose rendered text happens to be identical (e.g. same task transitioning `done` → `cancelled` → `done` with identical templates) collapse into one queue entry. Plan-phase D-45-DEDUP-KEY assumes contextKey-based dedup, which is wrong.

**Mitigation:** Embed `toStatus` AND `taskId` in the rendered text (the proposed one-line template `✓ TASK-NNN ({status}) — {title}` does exactly this), so distinct transitions produce distinct text and bypass `lastText` dedup. This is already the natural template shape.

### R4 (MEDIUM risk): Standalone adapter has no `runtime.system`

**What:** The standalone HTTP adapter (CLAUDE.md §Fragile two-path) does not load OpenClaw at all — `runtime` is undefined. Phase 45 must not break standalone mode.

**Mitigation:** D-45-FEATURE-DETECT covers this — graceful degrade to chat-only when `runtime.system?.enqueueSystemEvent` is undefined. Plan-phase MUST add a unit test that constructs the notifier with `systemEventCapable: false` and asserts no system-event-related code paths fire.

### R5 (LOW risk): IPC envelope size growth

**What:** Adding `systemEvent` + `heartbeat` fields to `ChatDeliveryRequest` enlarges every long-poll response. Today's envelope is ~1 KB; Phase 45 adds ~0.3 KB. Negligible.

### Open Question OQ1: Where to detect capability — adapter vs first IPC handshake?

The Hook Point §"How the daemon knows the capability" recommends Option (a): `POST /v1/plugin/capability` from `registerAofPlugin` after feature-detect. An alternative is to make the `chat-delivery-poller`'s long-poll request include the capability as a header/query param on every poll. The latter is more robust to plugin reload but couples capability into the poll path.

**Plan-phase decision needed.** Recommendation: explicit capability post (cleaner, easier to test, matches existing IPC patterns).

### Open Question OQ2: Should the chat-delivery one-liner template include the title at all?

The current Phase 44 template includes `task.frontmatter.title` (multi-line). The proposed one-line template `✓ TASK-NNN ({status}) — {title}` keeps it. For tasks with very long titles in a busy group chat, this could become noisy. Alternatives: truncate title to 80 chars; omit title and rely on TASK-ID for lookup. CONTEXT.md leaves the exact wording as Claude's Discretion — recommend keeping title with a 120-char truncation to balance grep-ability and noise.

### Open Question OQ3: `deliveryContext` vs no-`deliveryContext` for `enqueueSystemEvent`?

OpenClaw cron Pattern A passes `deliveryContext: owner.requesterOrigin`. Cron Pattern B does NOT. Reading the system-events module: `deliveryContext` is recorded on each event; when the heartbeat fires, `resolveSystemEventDeliveryContext` merges the contexts of all queued events to determine where to deliver. For Phase 45's case (single dispatcher session, single chat target), passing `deliveryContext` ensures the agent's next turn output goes to the same chat. **Recommendation: always pass it** when `delivery.channel` is set (see §OpenClaw Cron Call-Site §"On `deliveryContext`" for derivation). Plan-phase should lock this.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Recommended `coalesceMs = 750` | §Coalesce Window Recommendation | Wake-up latency too high (>1 s) or too low (no batching). Tunable; telemetry will surface either failure mode. Low-stakes. |
| A2 | Per-message warning append (not first-message-only) is the right surface for D-45-FALLBACK-WARNING | §Fallback Warning Surface | Slightly noisy chat history when gateway is degraded. User-driven preference; can be revisited if telemetry shows degraded operation lasting hours. |
| A3 | Capability flag forwarded to daemon via explicit `POST /v1/plugin/capability` | §Hook Point §"How the daemon knows the capability" | If plan-phase prefers the long-poll-header pattern, the implementation surface shifts. Both work; capability-post is cleaner. |
| A4 | OpenClaw 2026.4.22+ ships `runtime.system` (verified locally; not yet verified for the user's deployed version) | §OpenClaw Primitive Contracts | If the user's deployed gateway is older, feature-detect will trip and fallback warning will appear in every chat message. The mitigation (graceful degrade) is built in by D-45-FEATURE-DETECT. |
| A5 | The 999.5 stale-worker problem (CLAUDE.md §Build & Release Flavor 2) is not blocking for Phase 45 deploy | §Testing Strategy Layer 3 | UAT may fail if the user is hit by stale-worker errors after deploy; the manual `kill -9` dance is in CLAUDE.md. Detection of false negatives requires the user to inspect `lstart` per worker. |
| A6 | `notifiedStatuses` ledger is sufficient as the only AOF-side dedup layer (no second layer needed) | §Recovery Path Interaction | Already validated by Phase 44 + this research's reading of OpenClaw code. Confidence: HIGH. |

---

## Sources

### Primary (HIGH confidence)

- `[VERIFIED]` `/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/infra/system-events.d.ts` — `SystemEvent` type, `enqueueSystemEvent` signature
- `[VERIFIED]` `/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/infra/heartbeat-wake.d.ts` — `requestHeartbeatNow` signature, `HeartbeatWakeRequest` type
- `[VERIFIED]` `/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/plugins/runtime/types-core.d.ts` — `PluginRuntimeCore.system` surface
- `[VERIFIED]` `/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/utils/delivery-context.types.d.ts` — `DeliveryContext` shape
- `[VERIFIED]` `/opt/homebrew/lib/node_modules/openclaw/dist/system-events-B0HpjUDQ.js` (lines 1–116) — runtime invariants of `enqueueSystemEvent` (dedup is on `lastText`, MAX_EVENTS=20, sync, etc.)
- `[VERIFIED]` `/opt/homebrew/lib/node_modules/openclaw/dist/heartbeat-wake-D_G4Eh9_.js` (lines 40–199) — coalesce timer semantics, `DEFAULT_COALESCE_MS = 250`, `DEFAULT_RETRY_MS = 1000`, target merge by `(agentId, sessionKey)`
- `[VERIFIED]` `/opt/homebrew/lib/node_modules/openclaw/dist/task-registry-BJCE3lhL.js:1748-1779` — Cron Pattern A (background-task delivery)
- `[VERIFIED]` `/opt/homebrew/lib/node_modules/openclaw/dist/server.impl-D40kmTX8.js:4162-4255` — Cron Pattern B (cron job delivery with `target: "last"`)
- `[VERIFIED]` `src/openclaw/openclaw-chat-delivery.ts` (full file read) — current `deliverOne` shape, `wakeLog`, `replayUnnotifiedTerminals`
- `[VERIFIED]` `src/openclaw/chat-message-sender.ts` (full file read) — current `sendChatDelivery` flow
- `[VERIFIED]` `src/openclaw/types.ts` (full file read) — current `OpenClawApi` shape (no `system` extension yet)
- `[VERIFIED]` `src/openclaw/adapter.ts` (full file read) — `registerAofPlugin` boot point
- `[VERIFIED]` `src/openclaw/subscription-delivery.ts` (full file read) — `OpenClawChatDelivery` Zod schema with `dispatcherAgentId`, `capturedAt`, `pluginId`, `wakeUpMode`
- `[VERIFIED]` `src/daemon/daemon.ts:170-254` — daemon notifier wiring + recovery IIFE
- `[VERIFIED]` `src/ipc/schemas.ts:134-181` — `ChatDeliveryRequest` / `ChatDeliveryResultPost` schemas
- `[VERIFIED]` `src/ipc/chat-delivery-queue.ts` (full file read) — queue + ack semantics
- `[VERIFIED]` `src/openclaw/chat-delivery-poller.ts` (full file read) — long-poll loop
- `[VERIFIED]` `.planning/phases/44-deliver-completion-notification-wake-ups-to-dispatching-agen/44-VERIFICATION.md` — Phase 44 fields confirmed live (dispatcherAgentId, capturedAt, sessionKey)

### Secondary (MEDIUM confidence)

- `[CITED]` `.planning/phases/45-wake-dispatching-sessions-via-system-event-injection/45-CONTEXT.md` — locked decisions
- `[CITED]` `.planning/phases/45-wake-dispatching-sessions-via-system-event-injection/45-DISCUSSION-LOG.md` — rationale + alternatives considered
- `[CITED]` `CLAUDE.md` §Fragile, §Conventions, §Build & Release — operational constraints

### Tertiary (LOW confidence — flagged in Assumptions Log)

- `[ASSUMED]` `coalesceMs = 750` is the right starting value (A1)
- `[ASSUMED]` Per-message fallback-warning append is preferred (A2)
- `[ASSUMED]` Explicit capability-post IPC is the cleanest forwarding mechanism (A3)
- `[ASSUMED]` User's deployed OpenClaw is recent enough to expose `runtime.system` (A4) — graceful degrade is built in regardless

---

## Metadata

**Confidence breakdown:**
- OpenClaw primitive contracts: HIGH — read directly from installed `.d.ts` and minified runtime
- Cron call-site reference: HIGH — both Pattern A and Pattern B fully read
- AOF hook-point integration: HIGH — full file reads of all touched files
- Coalesce window recommendation: MEDIUM — value is reasoned but `[ASSUMED]` until production telemetry confirms (telemetry shipping IS Phase 45)
- Failure mode enumeration: HIGH — derived from reading `enqueueSystemEvent` body + heartbeat-wake module
- Recovery path interaction: HIGH — re-read confirms `lastText`-based dedup (clarifies a CONTEXT.md statement that needed nuance)
- Telemetry plan: HIGH — schema and insertion points fully traced
- Testing strategy: HIGH — extends Phase 44 patterns 1:1; manual UAT preserves Phase 44 acceptance criterion

**Research date:** 2026-04-24
**Valid until:** 2026-05-08 (14 days — OpenClaw chunk hashes change frequently; re-verify cron call-site filename if planning is delayed past this window)

## RESEARCH COMPLETE
