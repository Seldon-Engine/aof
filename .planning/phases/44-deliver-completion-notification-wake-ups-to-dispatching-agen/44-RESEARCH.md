# Phase 44: Deliver completion-notification wake-ups to dispatching agent sessions — Research

**Researched:** 2026-04-24
**Domain:** OpenClaw plugin ↔ aof-daemon session-targeted notification delivery (post-Phase-43 thin bridge)
**Confidence:** HIGH on existing pipeline archaeology; MEDIUM on what "wake-up" should mean for non-chat session kinds.

---

## Summary

The chat-delivery pipeline shipped in Phase 43 already delivers a task-completion **chat message** to whichever Telegram/Matrix room the dispatcher was using when it called `aof_dispatch`. That chain is end-to-end tested (`src/daemon/__tests__/chat-delivery-e2e.test.ts`) and terminates at `runtime.channel.outbound.loadAdapter(platform).sendText(...)`.

**The wake-up gap is not in the delivery chain; it is in the addressable-identity layer in front of it.** Today the dispatcher's identity is captured only at `aof_dispatch`-time by the plugin-local `OpenClawToolInvocationContextStore`, keyed by `toolCallId`, with a **1-hour in-memory TTL, no persistence, and no cross-process visibility** (`src/openclaw/tool-invocation-context.ts:24`). Everything that survives the IPC hop is whatever `mergeDispatchNotificationRecipient` happened to copy onto the subscription `delivery` payload (`src/openclaw/dispatch-notification.ts:35-51`) — `{sessionKey, sessionId, channel, threadId, target, kind: "openclaw-chat"}`. Nothing else is kept.

The dispatcher therefore gets woken up today iff (a) the dispatcher was running in a platform session whose `sessionKey` the plugin could capture from a recent `message_received` / `message_sent` event **and** (b) that session is a chat surface with an outbound adapter registered (Telegram today is the only one we've smoke-tested). CLI sessions, direct agent-to-agent sessions, `runEmbeddedPiAgent` child sessions (i.e. the ones AOF itself spawns), and any session where the agent dispatched without a prior chat message all fall off the end.

**Primary recommendation:** Reframe Phase 44 as **"make the dispatcher identity a first-class, persisted, core-schema field on the subscription so multiple delivery surfaces can consume it — and make the `openclaw-chat` kind honor the Telegram case end-to-end."** Ship Telegram as the in-scope surface, design the schema for the stretch cases, and defer the non-chat delivery implementations to follow-up phases.

**The three decisions the planner must lock** (detailed in §11 Open Design Questions):
1. **Does the subscription persist "dispatcher identity" or "delivery route"?** (Normalize upward or keep plugin-idiom-dominated?)
2. **Is wake-up a message-send (today's `openclaw-chat`) or a session-resume primitive (new)?** For Telegram it's a message. For a `runEmbeddedPiAgent` child it must be something else.
3. **How does the subscription survive daemon restart and late dispatch-completion races?** Current subscription storage is durable (`subscriptions.json` colocated with the task file), but the `OpenClawToolInvocationContextStore` is in-memory only — dispatchers that wait >1h will lose their route today.

---

## User Constraints (from phase instructions)

### Locked Decisions (from STATE.md Roadmap Evolution + ROADMAP.md)

- **Scope = close the gap where an orchestrating session calls `aof_dispatch` but never gets woken up when the task completes.**
- **Today's scope = Telegram-bound sessions actually resume.** [CITED: STATE.md:59]
- **Stretch = works for any session kind.** [CITED: STATE.md:59]
- **Depends on Phase 43** (thin-plugin / daemon-as-single-authority, shipped). [CITED: ROADMAP.md:171]

### Deferred (OUT OF SCOPE)

- **Project-wide opt-in completion subscription** — backlog 999.4, depends on Phase 44. [CITED: ROADMAP.md:198-208]
- Cross-plugin fan-out beyond OpenClaw (Slack / CLI / other gateways). [CITED: 43-CONTEXT.md D-13]
- Remote daemon over TCP. [CITED: 43-CONTEXT.md deferred]
- Per-plugin ACLs.

### Claude's Discretion (not explicitly constrained; research must recommend)

- Whether to introduce a new subscription kind (e.g. `openclaw-session-wake`) alongside `openclaw-chat` or extend `openclaw-chat`.
- Whether to persist the dispatcher session context in the subscription delivery payload verbatim or canonicalize it.
- TTL / lifecycle of the dispatcher-identity capture (the in-memory `OpenClawToolInvocationContextStore`).
- Whether dispatchers auto-subscribe on every `aof_dispatch` or opt in via flag.

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| WAKE-01 | An agent session that calls `aof_dispatch` against a Telegram-routable chat receives a message in that chat when the dispatched task reaches a terminal status. | §1 pipeline trace; §3 today's Telegram path already does this — verify REQ via `bug-NNN-dispatcher-wake-up-on-completion.test.ts` end-to-end harness. |
| WAKE-02 | The dispatcher's identity is captured at `aof_dispatch` time with sufficient information to reach the session later, persisted on the subscription (survives daemon restart), and is observable in subscription audit trail. | §2 addressable identity; §4 subscription-registration shape. |
| WAKE-03 | Wake-ups dedupe per (subscriptionId, terminal status) — a single `done` transition must not fire twice even across daemon restart. | §6 race analysis; existing `notifiedStatuses` ledger in `TaskSubscription` (`src/schemas/subscription.ts:73`). |
| WAKE-04 | When the wake-up platform is unavailable (Telegram API error, plugin detached, outbound adapter missing), the subscription records the failure and the task **is not blocked**. | §6 failure modes; existing try/catch in `OpenClawChatDeliveryNotifier.deliverOne` (`src/openclaw/openclaw-chat-delivery.ts:124-140`). |
| WAKE-05 | Subscription-registration shape is documented such that backlog 999.4 (project-wide subscriptions) can extend it without schema break. | §4. |
| WAKE-06 (stretch) | Non-chat dispatcher sessions (CLI, `runEmbeddedPiAgent` children, direct agent-to-agent) receive *some* surface of wake-up OR the subscription explicitly records "no delivery surface for session kind X, falling back to agent-callback kind". | §3 delivery surfaces; §11 open questions. |

Note: no REQ-IDs exist in `.planning/REQUIREMENTS.md` (file does not exist). These IDs are research-proposed for the planner/discuss-phase to ratify.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Capture dispatcher session identity at `aof_dispatch` | Plugin (OpenClaw) | — | OpenClaw idioms (sessionKey, channel, threadId) live plugin-side per Phase 43 D-07 [CITED: 43-CONTEXT.md]. Already implemented via `OpenClawToolInvocationContextStore`. |
| Persist subscription with dispatcher identity | Daemon (ITaskStore + SubscriptionStore) | — | Post-Phase-43, daemon is sole writer (D-02) [CITED: 43-VERIFICATION.md]. `subscriptions.json` is colocated with task file. |
| Detect terminal transition & fire delivery callback | Daemon (EventLogger `onEvent` callback) | — | EventLogger callback registration lives in `startAofDaemon` [VERIFIED: `src/daemon/daemon.ts:196`]. |
| Render wake-up message | Daemon (`OpenClawChatDeliveryNotifier`) | — | Task status, outcome, blockers, notes all live in daemon-owned task store. |
| Enqueue wake-up for plugin to execute | Daemon (`ChatDeliveryQueue`) | — | `queueBackedMessageTool` already does this [VERIFIED: `src/daemon/daemon.ts:147-191`]. |
| Long-poll for wake-ups | Plugin (`chat-delivery-poller`) | — | Plugin is the active puller per Phase 43 D-09 [CITED: 43-CONTEXT.md]. |
| Execute platform send (Telegram) | Plugin (`chat-message-sender.ts`) | — | `runtime.channel.outbound.loadAdapter("telegram")` is only reachable inside the gateway process [VERIFIED: `src/openclaw/chat-message-sender.ts:125-137`]. |
| Execute session-resume (stretch) | Plugin | Daemon (spawn via `PluginBridgeAdapter`) | `runtime.agent.runEmbeddedPiAgent` is already used for NEW spawns (post-43 flow). Resuming an existing session would need a new `runtime.agent.resumeSession` or similar — we haven't verified one exists. |

---

## Standard Stack

The pipeline is already wired. No new libraries. Verified as of 2026-04-24 against `package.json`.

### Core (already in-tree — no install needed)

| Module | Purpose | Why Standard |
|--------|---------|--------------|
| `zod` (existing) | Schema source of truth for new subscription payload fields. | All IPC schemas already Zod-based. |
| `better-sqlite3` / `hnswlib-node` / `pino` | Stack unchanged. Phase 44 does not introduce persistence beyond existing `subscriptions.json`. | — |
| `node:events` (EventEmitter) | `ChatDeliveryQueue` pattern (already used). | — |
| `node:http` with `{ socketPath }` | IPC transport. Never `fetch` per CLAUDE.md [CITED: `openclaw/daemon-ipc-client.ts:186`]. | — |

### No Alternatives Considered

The pipeline pattern (daemon-side EventLogger callback → in-memory queue → plugin long-poll → `POST /v1/deliveries/{id}/result`) is the one Phase 43 blessed. Diverging from it would fork the chat-delivery infrastructure and break `999.4`'s stated intent to "amplify the same delivery problem."

**Installation:** None required.

---

## Today's Completion-Notification Mechanism (Answer to Question 1)

### Pipeline trace — end-to-end

1. **Trigger point.** An `ITaskStore` mutation that results in a status transition calls the store's `transition()` method (`src/store/task-store.ts:616`). The store itself is **not** where the event is emitted — the caller (tool handler, scheduler action handler, protocol router) invokes `EventLogger.logTransition(taskId, from, to, actor, reason)` on the same call-site. Emission sites:
   - `src/tools/task-workflow-tools.ts:248,258,268,277` (ready, in-progress, review, done transitions via MCP tools)
   - `src/tools/task-crud-tools.ts:188` (`aof_task_update`)
   - `src/dispatch/lifecycle-handlers.ts:56,66,88,102,132,164` (deadletter, requeue, promote, ready)
   - `src/dispatch/recovery-handlers.ts:72,87` (stale-heartbeat recovery)
   - `src/dispatch/alert-handlers.ts:50` (alert → blocked)
   - `src/protocol/router-helpers.ts:108-137` (agent-reported completion/rejection via AOF/1 protocol)

2. **EventLogger.log.** `EventLogger.log()` writes a JSONL line to `events/YYYY-MM-DD.jsonl` and synchronously fires every registered `onEvent` callback (`src/events/logger.ts:72-79`). `console.warn` is the fallback on thrown callbacks — the caller is not informed.

3. **Callback registration** happens in `startAofDaemon` (`src/daemon/daemon.ts:192-196`):
   ```ts
   const chatNotifier = new OpenClawChatDeliveryNotifier({ resolveStoreForTask, messageTool: queueBackedMessageTool });
   logger.addOnEvent((event) => chatNotifier.handleEvent(event));
   ```
   There is no `NotificationService` (dedupe/routing notifier at `src/events/notifier.ts`) registered by default. The "notifier" is the chat-delivery-specific `OpenClawChatDeliveryNotifier`.

4. **OpenClawChatDeliveryNotifier.handleEvent** (`src/openclaw/openclaw-chat-delivery.ts:49-83`):
   - Early-exits on non-`task.transitioned` events and on transitions whose `to` status is not in `{blocked, review, done, cancelled, deadletter}` (TRIGGER_STATUSES).
   - Resolves the task's project store via `resolveStoreForTask(taskId)` (`src/daemon/resolve-store-for-task.ts`).
   - Lists active subscriptions via colocated `subscriptions.json` and filters to those with `delivery.kind === "openclaw-chat"` that haven't already been notified for this status (via `notifiedStatuses` ledger — persistent dedupe).
   - For each matching subscription: renders a message, calls `messageTool.send(target, message, ctx)`, then updates the subscription (append attempt; mark notified; flip to `delivered` + `deliveredAt` on terminal status).

5. **QueueBackedMessageTool.send** (`src/daemon/daemon.ts:147-191`):
   - Preserves the original `ctx.delivery` payload (so sessionKey/channel/threadId aren't shadowed by a flat `target`).
   - Calls `ChatDeliveryQueue.enqueueAndAwait({ subscriptionId, taskId, toStatus, message, delivery })`.
   - Returns the `done` promise which resolves on plugin ACK (success) or rejects on plugin failure ACK.

6. **ChatDeliveryQueue.enqueueAndAwait** (`src/ipc/chat-delivery-queue.ts:41-59`): generates `id = randomUUID()`, adds to `pending` map, emits `"enqueue"` event, and returns `{ id, done }` where `done` is a promise held in a `waiters` map.

7. **GET /v1/deliveries/wait long-poll** (`src/ipc/routes/delivery-wait.ts`): 25-second keepalive; fast-path claim if queue has work, else subscribes to `"enqueue"` events and races timeout vs. new work vs. client disconnect. Returns 200 + `ChatDeliveryRequest` body or 204 on timeout.

8. **Plugin chat-delivery-poller.runLoop** (`src/openclaw/chat-delivery-poller.ts:58-86`): module-scope `chatDeliveryPollerStarted` gate (survives OpenClaw's per-session plugin reload cycle — same trick as `spawn-poller`). 30s client-side `AbortSignal.timeout`. Exponential backoff 1s→30s on transport errors. Fire-and-forget `dispatchAndAck` so one slow send can't stall the loop.

9. **sendChatDelivery** (`src/openclaw/chat-message-sender.ts:87-162`):
   - Parses `delivery.sessionKey` (format: `agent:<agentId>:<platform>:<chatType>:<chatId>[:topic:<topicId>]`) OR uses explicit `delivery.channel`/`delivery.target`.
   - Calls `api.runtime.channel.outbound.loadAdapter(platform)` — the **unified outbound adapter API** (post-consolidation plugin-sdk). Throws if `loadAdapter` missing or adapter doesn't expose `sendText`.
   - Invokes `adapter.sendText({ cfg, to: target, text: message, threadId? })`.

10. **POST /v1/deliveries/{id}/result** (`src/ipc/routes/delivery-result.ts`): Zod-validates `ChatDeliveryResultPost`; calls `deps.deliverChatResult(id, result)` → `ChatDeliveryQueue.deliverResult` which resolves/rejects the awaiting promise. Idempotent (second POST with same id is a no-op).

11. **Back in the notifier**: `messageTool.send(...)` resolves → subscription marked `notifiedStatuses += toStatus`; terminal → `status = "delivered"`. If it throws → `appendAttempt({success: false})` + `failureReason`.

**Status:** The entire chain works today for Telegram. [VERIFIED: `chat-delivery-e2e.test.ts` exercises every layer from EventLogger callback through real HTTP long-poll.]

### Subscription registration happens where?

Subscriptions for completion-notification are **implicitly created** inside `aofDispatch` itself (`src/tools/project-tools.ts:253-265`) when `notifyOnCompletion` is a truthy object. The subscription gets:
- `subscriberId = completionDelivery.subscriberId ?? "notify:${kind}"` — NOT the dispatcher's identity. It's an arbitrary tag.
- `granularity = "completion"`.
- `delivery = completionDelivery` (verbatim, including `{kind, target?, sessionKey?, sessionId?, channel?, threadId?}`).

The caller-visible `aof_dispatch` response includes `notificationSubscriptionId` (`src/tools/project-tools.ts:108`), but the agent never has to do anything with it. There is **no** dispatcher opt-out at the call site unless the caller explicitly passes `notifyOnCompletion: false` — and there is **no auto-capture** unless the pre-handler transform (`mergeDispatchNotificationRecipient`) finds a captured session route in the invocation-context store.

### The plugin-local session-route capture

`OpenClawToolInvocationContextStore` (`src/openclaw/tool-invocation-context.ts`) maintains three in-memory Maps:
- `bySessionKey`, `bySessionId` — populated on every `message_received` / `message_sent` event (plugin lifecycle hooks `api.on("message_received" | "message_sent")` in `src/openclaw/adapter.ts:83-92`).
- `byToolCallId` — populated on `before_tool_call` event for `aof_dispatch` specifically.

`byToolCallId` is then consumed by `mergeDispatchNotificationRecipient` **inside the plugin's tool execute closure, BEFORE the IPC hop** (`src/openclaw/adapter.ts:110-114`). This is the only place the session route is bound to the subscription.

**TTL:** `DEFAULT_ROUTE_TTL_MS = 60 * 60 * 1000` (1 hour). [VERIFIED: `tool-invocation-context.ts:24`]

**In-memory-only:** there is no persistence. Daemon restart does not affect this store because the store lives in the plugin process. Gateway restart destroys it. OpenClaw per-session plugin reload does NOT destroy it because the module-level singleton (`invocationContextStore = new OpenClawToolInvocationContextStore()` at `adapter.ts:53`) survives reload — BUT only if `registerAofPlugin` reuses the injected instance across reloads, which it doesn't (`adapter.ts:52-53` creates a fresh one per call unless `opts.invocationContextStore` is passed; post-Phase-43 no one passes it from production code).

**This is the wake-up gap fulcrum.** See §5.

---

## What "Dispatching Agent Session" Means Concretely (Answer to Question 2)

When OpenClaw dispatches a tool call, the plugin captures these identifiers from the invocation context:

| Field | Extracted from | Persisted where today? |
|-------|---------------|----------------------|
| `sessionKey` | `message_received` / `message_sent` event (`event.sessionKey` / `payload.sessionKey` / `context.sessionKey`) [CITED: `tool-invocation-context.ts:71-76`] | In-memory only; attached to `aof_dispatch.notifyOnCompletion.sessionKey` at call time; persisted on subscription. |
| `sessionId` | Same event, `event.sessionId` etc. [CITED: `tool-invocation-context.ts:77-82`] | Same as above. |
| `replyTarget` (→ `target`) | `event.replyTarget` / `event.target` / `event.lastTo` [CITED: `tool-invocation-context.ts:83-91`] | Same. |
| `channel` | `event.channel` / `event.lastChannel` / `route.channel` [CITED: `tool-invocation-context.ts:101-107`] | Same. |
| `threadId` | `event.threadId` / `event.topicId` [CITED: `tool-invocation-context.ts:108-114`] | Same. |
| `actor` | `event.agentId` / `event.fromAgent` [CITED: `tool-invocation-context.ts:115-120`] | **NOT persisted** on subscription delivery today. Dropped. |
| `capturedAt` | `new Date().toISOString()` | **NOT persisted**. Dropped. |

### sessionKey format (production)

Real-world sessionKey examples from the test suite (`src/openclaw/__tests__/tool-invocation-context.test.ts`):
- `agent:main:telegram:group:42` — agent `main`, platform `telegram`, chatType `group`, chatId `42`.
- `agent:main:telegram:group:42:topic:7` — same but with a topic/thread suffix.
- Direct agent-to-agent sessions get keys like `agent:main:subagent:<sessionId>` (`src/openclaw/openclaw-executor.ts:262`).

The parse function is `parseSessionKey` at `src/openclaw/chat-message-sender.ts:64`, which returns `{platform, chatId, threadId?}` — **it requires at least 5 colon-separated parts starting with `agent`**, and returns `undefined` for any other shape. This is important: **direct agent-to-agent sessionKeys follow a DIFFERENT pattern** (4 parts: `agent:<agentId>:subagent:<sessionId>`) and will NOT parse. A Telegram-style wake-up for a subagent would fail at `sendChatDelivery` with `"cannot resolve platform"`.

### Addressable identity that already flows from plugin → daemon

Via `InvokeToolRequest` envelope (`src/ipc/schemas.ts:37-49`):
- `pluginId` (defaults `"openclaw"`)
- `name`, `params`, `actor`, `projectId`, `correlationId`, `toolCallId`, `callbackDepth`

The `params` object, for `aof_dispatch` specifically, contains `notifyOnCompletion` after `mergeDispatchNotificationRecipient` has populated it. **The `toolCallId` itself is NOT attached to the subscription** — it becomes moot once the subscription is written.

### The punchline

Every piece of addressable identity the planner could want to persist is already collected plugin-side. The plumbing work for Phase 44 is: **(a) make `actor` / `capturedAt` / `pluginId` survive the IPC hop onto the subscription delivery payload; (b) give them formal Zod fields so `subscriptions.json` is schema-validated; (c) make the notifier use them.** No new capture mechanism is needed.

---

## What "Wake-Up" Means per Session Kind (Answer to Question 3)

### Today's only working wake-up: Telegram chat

For any session whose `sessionKey` matches `agent:*:telegram:*:*`, a wake-up is a Telegram `sendText`. This path is fully wired, tested, and demonstrated to work in the e2e test. **Verifying WAKE-01 (Telegram sessions actually resume) is therefore "confirm the existing pipeline hasn't silently regressed under Phase 43's thin-bridge restructuring plus any installed-version/env drift," not "build it."** See the Validation Architecture section below for how to frame the test.

### Other chat platforms (design-ready, not verified)

`sendChatDelivery` (`src/openclaw/chat-message-sender.ts:127`) calls `runtime.channel.outbound.loadAdapter(platform)` which is the **unified adapter API** post-consolidation. Any platform that registers an outbound adapter exposing `sendText({to, text, threadId?})` works automatically — Slack, Discord, Matrix, etc. We have no evidence these actually work in production; the e2e test only stubs out a Telegram-like adapter.

### Direct agent-to-agent sessions

A dispatcher that IS itself a spawned agent (via `runEmbeddedPiAgent`) has:
- sessionKey of the form `agent:<agentId>:subagent:<sessionId>` (`src/openclaw/openclaw-executor.ts:262`) — **does NOT parse** through `parseSessionKey`.
- No outbound channel to send into; the subagent is not Telegram-attached.

**Current behavior:** `sendChatDelivery` throws `"cannot resolve platform"`, the plugin ACKs failure, the subscription records `failureReason` — no wake-up delivered. This is a silent gap today, NOT a regression.

**Design options for the stretch case:**

| Option | How it would work | Cost | Risk |
|--------|-------------------|------|------|
| A. Fall back to `agent-callback` kind | If `parseSessionKey` returns nothing AND no explicit `channel`, create a second subscription (or swap kind) that uses `callback-delivery.ts::deliverSingleCallback` — spawns a NEW session with a prompt containing the completion summary. | Low (all plumbing exists). | The "wake-up" is actually a fresh spawn, not a resume of the original session. If the original session was waiting on its own tool-call return, it will never see the wake-up. |
| B. New `runtime.agent.resumeSession` | Post a synthetic message into the existing subagent's session inbox so it resumes mid-conversation. | Requires OpenClaw runtime API we haven't confirmed exists. `OpenClawAgentRuntime` exposes `session.resolveSessionFilePath` but NO `resumeSession` or `postMessage` (`src/openclaw/types.ts:66-69`). | Unverified plugin-sdk surface. Would be a gateway-side change first. |
| C. Plugin-side session-inbox append | Write a message to the session's on-disk transcript (`~/.openclaw/agents/<agent>/sessions/<sessionId>.jsonl`) and kick the session to re-process. | Unverified whether OpenClaw re-reads the transcript on its own. Likely requires a gateway-supported primitive. | Same as B. |
| D. Use existing spawn pipeline | For subagent sessions with a captured `sessionId`, enqueue a SpawnRequest that tells the gateway "resume session X with this context". | `SpawnQueue` already exists from Phase 43. | Needs spawn-poller support for a resume flavor. Could piggyback on `SpawnRequest` by adding an optional `resumeSessionId` field. |

**Recommendation (MEDIUM confidence):** Ship option A as the stretch case — fall back to `agent-callback` kind when `parseSessionKey` fails — so the dispatcher still gets *some* wake-up. Defer B/C/D to a future phase that depends on an OpenClaw API change.

### CLI sessions

A CLI dispatcher (e.g. someone running `aof dispatch` from a terminal) has no sessionKey capture at all — the `message_received` path never fires. Today's behavior: `mergeDispatchNotificationRecipient` finds nothing to attach; subscription has no delivery and falls through to agent-callback (via `resolveDeliveryKind` default at `src/schemas/subscription.ts:89`). The **CLI user gets no wake-up** unless they asked for one explicitly. Recommendation: document the gap; a CLI wake-up would need a TTY-reattach primitive (out of scope).

### Summary table — Phase 44 coverage by session kind

| Session kind | Today's wake-up? | Phase 44 (core scope)? | Phase 44 (stretch)? | Defer to later? |
|--------------|-----------------|-----------------------|--------------------|-----------------|
| Telegram (direct / group / topic) | **Works via chat-delivery** (verify only) | ✅ Must verify & harden | — | — |
| Other chat platforms (Slack, Discord, Matrix) | Theoretically works via `runtime.channel.outbound.loadAdapter` | Nice-to-have smoke test | ✅ | — |
| `runEmbeddedPiAgent` subagent | ❌ Silent failure | Document gap + persist identity | ✅ Fallback to agent-callback | Real session-resume → future phase |
| CLI / direct-terminal | ❌ No capture possible | — | — | ✅ |

---

## Subscription-Registration Shape (Answer to Question 4)

### Current `SubscriptionDelivery` schema

From `src/schemas/subscription.ts:36-39`:
```ts
export const SubscriptionDelivery = z.object({
  kind: z.string().min(1),
}).passthrough();
```

**Core only requires `kind`.** Everything else is plugin-opaque and currently written verbatim by the plugin-side transform. This is extensible but under-specified — there's no schema enforcement on `sessionKey` or `channel` types.

### Proposed Phase 44 subscription record shape

Extend `SubscriptionDelivery` with a formally-Zod-typed `OpenClawChatDelivery` discriminated subtype:

```ts
// src/openclaw/openclaw-chat-delivery.ts or new src/openclaw/subscription-delivery.ts
export const OpenClawChatDelivery = z.object({
  kind: z.literal("openclaw-chat"),

  // Addressable identity — captured at aof_dispatch time in the plugin.
  sessionKey: z.string().optional(),
  sessionId: z.string().optional(),
  channel: z.string().optional(),
  threadId: z.string().optional(),
  target: z.string().optional(),

  // NEW in Phase 44 — promoted from the drop-floor of today's capture.
  dispatcherAgentId: z.string().optional(),   // was .actor
  capturedAt: z.string().datetime().optional(),
  pluginId: z.string().default("openclaw").optional(),

  // NEW in Phase 44 — refines what kind of wake-up this is.
  wakeUpMode: z.enum(["chat-message", "agent-callback-fallback"]).default("chat-message").optional(),
});
```

### Lifecycle

- **Auto-registered on `aof_dispatch`** if the plugin's `OpenClawToolInvocationContextStore` has a route for the current `toolCallId` AND the caller didn't pass `notifyOnCompletion: false`. Today's behavior already does this; Phase 44 just enriches the payload.
- **Explicit opt-out** via `notifyOnCompletion: false` (already supported, `src/openclaw/dispatch-notification.ts:25`).
- **Explicit override** via `notifyOnCompletion: { kind, ... }` (already supported, `src/openclaw/dispatch-notification.ts:27-31`).
- **TTL** on the subscription itself: none — survives until terminal transition OR cancellation. **TTL on the plugin-side route capture (`OpenClawToolInvocationContextStore`)**: 1 hour today. See §6 for race.
- **Persistence:** `subscriptions.json` colocated with the task file. Survives daemon restart trivially. Survives gateway restart.

### How 999.4 will extend this shape

999.4 (project-wide opt-in subscription) needs:
- A subscription that is **not attached to a task directory** — project-scoped, not task-scoped. Would likely live at `~/.aof/data/Projects/<project>/subscriptions.json` or similar.
- A `scope: "task" | "project"` discriminator on the subscription — or a new `ProjectSubscription` schema that reuses `SubscriptionDelivery` verbatim.

**Concrete 999.4-compatible decision Phase 44 must make:** use `SubscriptionDelivery` verbatim for project-scope — don't fork a separate schema. That means:
- `kind` field stays polymorphic.
- The same `dispatcherAgentId` / `sessionKey` / route identity fields work for "every-project-task completion → notify this session" without modification.
- The only new bit 999.4 adds is the *container* (project-level `subscriptions.json`) and a different event trigger (any task transition within the project, not just one task). The notifier callback can stay the same.

### Should it be explicit or implicit?

**Recommend IMPLICIT (auto) for Phase 44**, matching today's behavior. Rationale:
- The whole user-visible value of "wake me up when my dispatched task completes" is defeated if the agent has to remember to opt in.
- Explicit opt-out (`notifyOnCompletion: false`) is already there.
- 999.4 being explicit (`aof_project_subscribe`) is a different cognitive surface and user should choose it deliberately.

---

## The Delivery Gap (Answer to Question 5 — failing-test shape)

### Concrete failing-test description

**Name:** `bug-NNN-dispatcher-wake-up-on-completion.test.ts`
**Type:** Integration (`createTestHarness()` + `ChatDeliveryQueue` + `OpenClawChatDeliveryNotifier` + a mock `sendChatDelivery`).
**RED behavior:** Today's code silently drops the wake-up in several concrete situations. Planner picks ONE to turn RED first:

**Case 1 (Wake-Up Gap A — captured route dropped by TTL):**
1. `OpenClawToolInvocationContextStore.captureToolCall(event)` with `toolCallId=X`, `sessionKey=agent:main:telegram:group:42`.
2. Advance clock by 65 minutes (past `DEFAULT_ROUTE_TTL_MS`).
3. Call `mergeDispatchNotificationRecipient({}, "X", store)`.
4. **Expected (RED):** params has `notifyOnCompletion.sessionKey === "agent:main:telegram:group:42"`.
5. **Actual today:** `pruneExpired()` evicted the entry; `consumeToolCall` returns undefined; subscription gets NO route; wake-up never fires on task completion.

**Case 2 (Wake-Up Gap B — captured route is plugin-in-memory-only across plugin crash):**
1. Capture a route in the plugin process.
2. Simulate plugin process restart (new `OpenClawToolInvocationContextStore` instance).
3. Completion event fires.
4. Subscription in `subscriptions.json` has the captured route (this part works — captured at dispatch time, already written).
5. **Expected (GREEN today):** completion fires, delivery enqueues, plugin (restarted one) long-polls, gets it, sends via Telegram. **This actually works today** — the subscription is persistent. Good.
6. **Failure case:** if the captured route was NOT yet attached to the subscription (i.e. the agent dispatched but the capture somehow failed), there's no recovery path because the in-memory state is gone.

**Case 3 (Wake-Up Gap C — dispatcher is a subagent):**
1. Subagent (`runEmbeddedPiAgent` child) calls `aof_dispatch`. Captured sessionKey has format `agent:X:subagent:Y`.
2. Task completes → notifier fires → `chat-delivery-poller` gets it → `sendChatDelivery` parses sessionKey → `parseSessionKey` returns `undefined` (only 4 parts, no platform) → throws `"cannot resolve platform"`.
3. **Expected (Phase 44 stretch):** fallback to agent-callback kind OR explicit failure recorded on subscription with a "no delivery surface" reason.
4. **Actual today:** generic `send-failed` error on subscription; no fallback; subagent never wakes.

**Case 4 (Wake-Up Gap D — race: transition fires before subscription is persisted):**
1. Agent calls `aof_dispatch`.
2. IPC in flight. Daemon receives.
3. Before `aofDispatch` handler finishes `subscriptionStore.create(...)`, some OTHER handler (very fast dispatch) could theoretically transition the task.
4. **This is mostly not real today** — `aofDispatch` writes the subscription synchronously before returning (`project-tools.ts:253-265`) and the earliest transition is an `assign` action from the NEXT scheduler poll (30s default). Still worth a regression test.

**The planner's RED test choice should be Case 1** — it's the clearest gap, has a deterministic clock-advance trigger, and directly motivates persisting the route at capture time rather than at dispatch time. All other cases either already work or depend on missing OpenClaw APIs.

---

## Failure Modes & Races (Answer to Question 6)

| # | Failure mode | Current behavior | Mitigation (Phase 44) |
|---|-------------|------------------|----------------------|
| F1 | Dispatcher session TTL expires (>1h) between capture and dispatch | Route dropped by `pruneExpired`; subscription written with no route; no wake-up fires | **Make the invocation-context store TTL configurable + bump default**, OR attach the captured route at `message_received` time rather than at dispatch time. Flag for planner: this is the Case 1 RED test. |
| F2 | Plugin crashes between `captureToolCall` and `execute` | In-memory store gone; `consumeToolCall` returns undefined; subscription has no route | Acceptable loss (dispatch hasn't happened yet). Not worth persisting across plugin restart. |
| F3 | Plugin crashes between `aof_dispatch` IPC send and ACK | Daemon has enqueued the task but plugin doesn't know outcome. Because `aof_dispatch` runs synchronously inside the IPC invoke-tool route, the daemon writes the subscription before returning the response. **Subscription is durable. Route is durable**. Next plugin attach will wake on completion. | None needed — already works. |
| F4 | Multiple dispatchers for same task | `subscriptionStore.create` appends per call; both get subscriptions; both get woken | Accepted. Document. |
| F5 | Notifier fires before subscription persisted | Impossible today: scheduler polls every 30s, subscription write is synchronous before `aofDispatch` returns. But worth a guard: | If the notifier can't find the task yet (newly-created, not flushed?), log + retry on next event. Already handled via `active.filter(...)` returning `[]`. |
| F6 | Platform unavailable (Telegram down) | Plugin ACKs failure; notifier records `appendAttempt({success: false, error})`; **no retry** (chat-delivery has no retry loop) | Phase 44 could add a retry scheduled via `retryPendingDeliveries` pattern from `callback-delivery.ts`, OR leave best-effort. **Recommend best-effort** — retry logic for chat delivery is a different surface from agent-callback retries (non-idempotent for chat). Planner decision. |
| F7 | Daemon crashes between enqueue and ACK | `ChatDeliveryQueue` is in-memory — on restart the queue is empty. Subscription was not marked `notifiedStatuses += toStatus` yet. On next event (there may not be one since the task is already terminal), notifier won't re-fire. **The wake-up is lost.** | Phase 44 should add a "recovery" pass in notifier startup: scan active subscriptions for terminal tasks where `notifiedStatuses` doesn't include the current terminal status, and re-enqueue. Mirror the `retryPendingDeliveries` pattern. |
| F8 | Plugin crashes between `POST /v1/deliveries/{id}/result` and daemon processing | Deamon's `deliverResult` is idempotent; a re-POST is a no-op but no re-POST will happen because the plugin can't distinguish "ACK succeeded" from "ACK dropped". Plugin-side fire-and-forget means it might have already moved on. | If ACK HTTP call fails on plugin side, `chat-delivery-poller.ts:99-106` logs and continues. The daemon's `done` promise never resolves → notifier `appendAttempt` with... nothing, because the promise just hangs. **This is a real race; planner should add a daemon-side timeout on the `done` promise**, e.g. 2× the plugin's keepalive (~60s). |
| F9 | Duplicate wake-ups if notifier is retried (EventLogger callback throws and callback system retries) | EventLogger does NOT retry callbacks — `logger.ts:72-79` catches `err`, logs via `console.warn`, moves on. So F9 is not a real concern today. | None needed. |
| F10 | Plugin long-poll disconnect between claim and POST result | `delivery-wait.ts:70-74` clears `settled` flag on `res.close`. Claimed delivery is **leaked** — `pending.delete(id)` happened in `tryClaim`. The awaiter on the daemon side hangs forever. | **Same mitigation as F8**: daemon-side timeout on `done`. Alternatively: on `res.close` after claim, re-enqueue. The simpler fix is the timeout. |

### Specific to CLAUDE.md's fragility warning about the chain blocking on plugin ACK

CLAUDE.md flags: *"The notifier's `messageTool.send()` BLOCKS on plugin ACK — a slow/broken plugin stalls the EventLogger callback."* [CITED: CLAUDE.md:33]

This is F10 / F8 scaled up: a plugin that accepts a long-poll but never POSTs a result stalls the notifier forever, which stalls every downstream EventLogger callback for that event. Not fatal (EventLogger catches thrown callbacks AND subsequent events still fire because each `log()` call awaits its own callbacks sequentially — but sequentially means one bad callback blocks the next event's processing).

**Phase 44 MUST add a timeout** on `ChatDeliveryQueue.enqueueAndAwait`'s returned `done` promise. Recommended: 60s (2× the 25s server-side keepalive + plugin's 30s client timeout + generous grace). On timeout: reject `done`, record the failure on the subscription, continue. This is the single most valuable hardening item in the phase.

---

## Plugin/Daemon Split Post-Phase-43 (Answer to Question 7)

| Concern | Owner | Why |
|---------|-------|-----|
| Subscription registration (CRUD + persistence) | **Daemon** | Daemon is sole writer of `subscriptions.json` post-Phase-43 D-02. `aofDispatch` runs in the daemon's tool-invoke route (`src/ipc/routes/invoke-tool.ts`). |
| Route capture at plugin-lifecycle-hook time | **Plugin** | Sessionkey/channel/threadId are OpenClaw idioms. Captured via `api.on("message_received"|"message_sent"|"before_tool_call")` which are plugin-only events per D-07. |
| Route transformation at dispatch-time | **Plugin** | `mergeDispatchNotificationRecipient` runs BEFORE the IPC call because the capture state is plugin-local [CITED: `src/openclaw/adapter.ts:110-114`]. |
| Notifier firing on `task.transitioned` | **Daemon** | `logger.addOnEvent` wiring is in `startAofDaemon` [VERIFIED: `daemon.ts:196`]. |
| Delivery enqueue / queue state | **Daemon** | `ChatDeliveryQueue` is in `src/ipc/`, daemon-side only. |
| Platform-specific send (Telegram API call) | **Plugin** | `runtime.channel.outbound.loadAdapter` is only reachable inside the gateway process. |
| ACK routing | Both (IPC) | `POST /v1/deliveries/{id}/result` is daemon-side; plugin drives it. |

### IPC routes — already exist, no new routes needed

Phase 44 adds NO new IPC routes. Everything terminates on the existing `/v1/deliveries/wait` + `/v1/deliveries/{id}/result` pair.

### Route capture happens in the plugin — but so does its TTL drop-off

This is the one awkwardness: a captured route that's about to expire is only known to the plugin, but the "should I extend this TTL because the agent is still active" signal (ongoing `message_received` / `message_sent`) is also plugin-local. So mitigation for F1 MUST be plugin-side. Possible fixes:
- Bump `DEFAULT_ROUTE_TTL_MS` to infinity (or daemon-session-lifetime).
- Refresh TTL on every `message_received` (only new captures refresh today; re-capture of same sessionKey resets TTL, so actively-chatting sessions are fine).
- **Attach route to subscription at capture time**, not at dispatch time — but this requires knowing the taskId at capture time, which we don't until the agent actually calls `aof_dispatch`. Doesn't work.

Recommendation: **bump TTL to 24h** (or disable the TTL) and rely on `clearSessionRoute` (fired on `session_end`) for cleanup. This is a 1-line change.

---

## Test Surfaces (Answer to Question 8)

### Unit tests (colocated in `src/**/__tests__/`)

| Test file | What it covers | Notes |
|-----------|---------------|-------|
| `src/openclaw/__tests__/dispatch-notification.test.ts` (exists) | `mergeDispatchNotificationRecipient` merging logic | Extend with new `dispatcherAgentId`, `pluginId`, `capturedAt` fields. |
| `src/openclaw/__tests__/tool-invocation-context.test.ts` (exists) | Capture/consume/TTL/clear | Add regression: TTL expiry does NOT drop a route captured within window. |
| `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` (exists, 8 tests) | Notifier delivery logic | Add: subagent sessionKey fallback to agent-callback kind (stretch). |
| `src/ipc/__tests__/chat-delivery-queue.test.ts` (exists) | Queue semantics | Add: `enqueueAndAwait` with timeout (F8/F10 mitigation). |
| `src/daemon/__tests__/bug-NNN-dispatcher-wake-up-on-completion.test.ts` (NEW) | End-to-end regression for Case 1 RED described in §5 | Mirror `chat-delivery-e2e.test.ts` shape. |

### Integration tests (`tests/integration/`, `AOF_INTEGRATION=1`)

| Test file | What it covers |
|-----------|---------------|
| `tests/integration/wake-up-dispatcher.test.ts` (NEW) | Real daemon + plugin long-poll + real `ChatDeliveryQueue` + captured Telegram sessionKey → dispatcher gets a wake-up message | Use `startTestDaemon` + `plugin-ipc-client` helpers from `tests/integration/helpers/`. |
| `tests/integration/wake-up-restart-recovery.test.ts` (NEW) | Scenario F7: daemon restart between transition and delivery — new notifier startup should replay unnotified terminal subscriptions | Only if planner adopts the F7 recovery pass. |

### E2E tests (`tests/e2e/suites/*.test.ts`)

| Test | Rationale |
|------|-----------|
| `tests/e2e/suites/dispatcher-wake-up.e2e.test.ts` (NEW) | Harness flow: (1) create a subscription with a `openclaw-chat` delivery; (2) transition task through blocked → review → done; (3) assert one wake-up per trigger status, terminal flips subscription to `delivered`; (4) simulate Telegram send failure — subscription records failure but task lifecycle is unblocked. |

### Regression test naming

Per CLAUDE.md convention: `bug-NNN-dispatcher-wake-up-on-completion.test.ts`. The phase lands a single canonical regression test at the integration level.

### Test harness flow

```
createTestHarness()                    # tmpDir + real FilesystemTaskStore + EventLogger
  └── startTestDaemon()                # full daemon on a tmp Unix socket
       └── plugin-ipc-client helpers   # acts as the plugin side
  └── OpenClawToolInvocationContextStore (shared reference, inject via AOFPluginOptions)
  └── simulate message_received → captureMessageRoute
  └── simulate before_tool_call(aof_dispatch) → captureToolCall
  └── call aof_dispatch via plugin-ipc-client (invokeTool)
  └── simulate subscription.delivery captured sessionKey (assert)
  └── transition task via store.transition() + logger.logTransition
  └── chatDeliveryQueue eventually resolves a wake-up
  └── assert chat-message-sender was called (or the stubbed adapter's sendText saw the call)
  └── assert subscription.status === "delivered"
```

**Skills note:** the `openclaw agent` end-to-end debugging channel (CLAUDE.md §End-to-end debugging) is the right harness for Test B / Test C from Phase 43's human-verification matrix once there's a real fix to smoke-test. Not needed for unit/integration.

---

## Validation Architecture

**Nyquist-mandated — this section drives VALIDATION.md in the next GSD step.**

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (per `package.json`) — single runner for unit + integration + e2e, different configs. |
| Config files | Root `vitest.config.ts` (unit); separate config for `tests/e2e/` (sequential, single fork, 60s timeout); integration gated on `AOF_INTEGRATION=1`. |
| Quick run command | `npx vitest run src/openclaw/__tests__/ src/ipc/__tests__/chat-delivery-queue.test.ts src/daemon/__tests__/chat-delivery-*.test.ts` |
| Full suite | `npm run typecheck && npm test` (unit) + `AOF_INTEGRATION=1 npm run test:integration:plugin` (integration) + `npm run test:e2e` |
| Orphan cleanup | `ps -eo pid,command \| grep -E "node \(vitest" \| xargs -r kill -9` after any aborted run (CLAUDE.md mandate). |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| WAKE-01 | Telegram dispatcher gets a chat wake-up on task completion | integration | `AOF_INTEGRATION=1 npx vitest run tests/integration/wake-up-dispatcher.test.ts` | ❌ Wave 0 |
| WAKE-01 (regression) | End-to-end chat-delivery still works post-Phase-44 | e2e-ish | `npx vitest run src/daemon/__tests__/chat-delivery-e2e.test.ts` | ✅ exists, must stay green |
| WAKE-02 | Dispatcher identity captured + persisted on subscription | unit | `npx vitest run src/openclaw/__tests__/dispatch-notification.test.ts` | ✅ exists, needs new assertions |
| WAKE-02 (schema) | `SubscriptionDelivery` validates new fields | unit | `npx vitest run src/schemas/__tests__/subscription.test.ts` | ❓ — verify existence in Wave 0 |
| WAKE-03 | Dedupe per (sub, status) across daemon restart | integration | `AOF_INTEGRATION=1 npx vitest run tests/integration/wake-up-restart-recovery.test.ts` | ❌ Wave 0 |
| WAKE-03 (unit) | `notifiedStatuses` ledger prevents double-fire | unit | `npx vitest run src/openclaw/__tests__/openclaw-chat-delivery.test.ts -t "dedupes per-status"` | ✅ exists |
| WAKE-04 | Platform unavailable → subscription records failure, task unblocked | unit | `npx vitest run src/openclaw/__tests__/openclaw-chat-delivery.test.ts -t "records a delivery failure"` | ✅ exists |
| WAKE-04 (timeout) | `ChatDeliveryQueue.enqueueAndAwait` resolves `done` on timeout | unit | `npx vitest run src/ipc/__tests__/chat-delivery-queue.test.ts -t "timeout"` | ❌ Wave 0 |
| WAKE-05 | Subscription shape extensible to project scope (999.4 compatibility) | typecheck + schema compat | `npm run typecheck` + schema snapshot test | partial; add snapshot |
| WAKE-06 | Subagent sessionKey fallback recorded | unit | `npx vitest run src/openclaw/__tests__/chat-message-sender.test.ts -t "subagent"` | ❓ — verify existence in Wave 0 |
| Regression | `bug-NNN-dispatcher-wake-up-on-completion` | integration | `AOF_INTEGRATION=1 npx vitest run tests/integration/bug-NNN-dispatcher-wake-up-on-completion.test.ts` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `npm run typecheck && npx vitest run src/openclaw/__tests__/ src/ipc/__tests__/chat-delivery-queue.test.ts src/daemon/__tests__/chat-delivery-e2e.test.ts` (~5-10s)
- **Per wave merge:** full unit (`npm test`) — ~10s
- **Phase gate:** full unit + `AOF_INTEGRATION=1 npm run test:integration:plugin` + `npm run test:e2e`
- **Manual smoke test (human-verify like Phase 43 Tests A-E):** via `openclaw agent --agent main --session-id <sid>` channel — have the main agent dispatch a task against a no-op worker, observe that (a) daemon enqueues a completion delivery, (b) Telegram session receives the wake-up message, (c) subscription.json shows `status: "delivered"`.

### Wave 0 Gaps

- [ ] `tests/integration/wake-up-dispatcher.test.ts` — primary integration RED test.
- [ ] `src/daemon/__tests__/bug-NNN-dispatcher-wake-up-on-completion.test.ts` — the canonical regression anchor.
- [ ] `src/ipc/__tests__/chat-delivery-queue.test.ts` timeout case RED.
- [ ] `src/openclaw/__tests__/dispatch-notification.test.ts` assertions for new fields.
- [ ] `src/schemas/__tests__/subscription.test.ts` — confirm exists; add schema snapshot if missing.
- [ ] `tests/integration/wake-up-restart-recovery.test.ts` — only if F7 recovery pass is in-scope.
- [ ] No framework install needed — Vitest is tree-resident.

### Dimensions mapped

| Dimension | How it's validated |
|-----------|-------------------|
| **Correctness** — dispatcher actually wakes up | Integration `wake-up-dispatcher.test.ts` + existing `chat-delivery-e2e.test.ts` regression. |
| **Delivery reliability** — no dropped wake-ups | F7 recovery pass test + F8/F10 `enqueueAndAwait` timeout test + plugin-restart integration test. |
| **Race safety** — notifier vs. subscription vs. transition ordering | Synchronous subscription-write in `aofDispatch` is a defense; integration test that fires a transition immediately after dispatch proves no race. |
| **Backwards compatibility** — existing chat-delivery chain unchanged for non-dispatcher consumers | `chat-delivery-e2e.test.ts` must stay green unmodified. 8 existing tests in `openclaw-chat-delivery.test.ts` must stay green unmodified. |
| **Observability** — logs/events confirm wake-up attempted + delivered + ACKed | Subscription's `attempts[]` array is the audit trail. Assert `attempts.length >= 1` with `success: true` on the integration test. The notifier logs `"chat delivery enqueued"` (`chat-delivery-queue.ts:54`), `"delivery received"` (`chat-delivery-poller.ts:69`), `"dispatching chat delivery"` (`chat-message-sender.ts:118`) — existing log statements, no new instrumentation needed. |

---

## Phase Boundary for Planning (Answer to Question 10)

Recommended plan wave structure:

### Wave 0 — RED tests + test-infrastructure gap-filling
- `tests/integration/wake-up-dispatcher.test.ts` (RED) — integration test for WAKE-01, deliberately failing against the to-TTL gap (Case 1).
- `src/ipc/__tests__/chat-delivery-queue.test.ts` — RED test for `enqueueAndAwait` timeout (F8/F10). Currently `done` hangs forever.
- `src/daemon/__tests__/bug-NNN-dispatcher-wake-up-on-completion.test.ts` (RED) — canonical regression anchor.
- If planner adopts F7 recovery pass: `tests/integration/wake-up-restart-recovery.test.ts` (RED).
- `src/openclaw/__tests__/dispatch-notification.test.ts` — extended assertions for new `dispatcherAgentId` / `pluginId` / `capturedAt` fields on the subscription delivery (RED until schema/impl changes land in Wave 1).

**Files created:** 3-4 test files. No new production files.

### Wave 1 — Schema promotion + invocation-context-store durability
- `src/schemas/subscription.ts` — add formally-typed `OpenClawChatDelivery` Zod subtype (see §4), still `passthrough()`-compatible with `SubscriptionDelivery`.
- `src/openclaw/dispatch-notification.ts` — plumb `dispatcherAgentId` (from `captured.actor`), `capturedAt`, `pluginId` into the `delivery` payload when present.
- `src/openclaw/tool-invocation-context.ts` — bump TTL default from 1h → 24h; verify `clearSessionRoute` is wired to `session_end` (already is at `adapter.ts:72-73`).
- `src/ipc/chat-delivery-queue.ts` — add optional `timeoutMs` to `enqueueAndAwait`; reject `done` after timeout with `kind: "timeout"`.

**Files modified:** 4. Wave 0 tests for WAKE-02 + timeout go GREEN.

### Wave 2 — Platform path hardening + sub-agent fallback (stretch)
- `src/openclaw/chat-message-sender.ts` — when `parseSessionKey` returns `undefined` AND no explicit `delivery.channel`, throw a typed `NoPlatformError` (new).
- `src/openclaw/openclaw-chat-delivery.ts` — catch `NoPlatformError` in the notifier; for subagent sessions, if the subscription has a captured `dispatcherAgentId`, swap to `agent-callback` kind behavior (create a fallback agent-callback subscription OR synthesize a one-shot callback).
- `src/daemon/daemon.ts` — if Wave 0 adopted F7, add notifier-startup recovery pass that re-fires on unnotified terminal subscriptions.

**Files modified:** 2-3. WAKE-06 + F7 tests go GREEN.

### Wave 3 — Observability + human-verification UAT
- Structured log assertions on the wake-up path (pino logs with `{ subscriptionId, taskId, toStatus, target, platform }`) — likely no new log statements, just document the existing ones.
- Human UAT matrix:
  - A. Dispatch from Telegram group → completion → assert wake-up message arrived in the same group.
  - B. Dispatch from a Telegram topic (threadId) → wake-up lands in the correct topic.
  - C. Kill the plugin mid-dispatch → restart → verify the subscription is still there and the next attach receives the wake-up.
  - D. Kill the daemon after transition but before plugin long-poll drains → restart daemon → verify recovery pass re-fires (Wave 2 dependent).
  - E. (stretch) Subagent dispatch → completion → verify fallback to agent-callback kind in subscription.json.

**Files created:** 1 UAT doc. Nothing merges with the code base beyond notes.

### Files list reference

**Create (likely):**
- `tests/integration/wake-up-dispatcher.test.ts`
- `tests/integration/wake-up-restart-recovery.test.ts` (conditional)
- `src/daemon/__tests__/bug-NNN-dispatcher-wake-up-on-completion.test.ts`

**Modify:**
- `src/schemas/subscription.ts`
- `src/openclaw/dispatch-notification.ts`
- `src/openclaw/tool-invocation-context.ts`
- `src/ipc/chat-delivery-queue.ts`
- `src/openclaw/openclaw-chat-delivery.ts`
- `src/openclaw/chat-message-sender.ts`
- `src/daemon/daemon.ts` (conditional, only for F7 recovery pass)
- `src/openclaw/__tests__/dispatch-notification.test.ts` (extend)
- `src/openclaw/__tests__/tool-invocation-context.test.ts` (extend)
- `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` (extend)
- `src/ipc/__tests__/chat-delivery-queue.test.ts` (extend)

---

## Open Design Questions (Answer to Question 11)

### Q1. **Should wake-up be a chat-message (today) or a session-resume primitive (new)?**

**Options:**
- (A) Chat-message only — today's `openclaw-chat` kind with enriched delivery payload. Telegram works; subagent falls back to agent-callback kind.
- (B) Introduce a second kind `openclaw-session-wake` that calls a new OpenClaw API (not yet verified to exist) to resume the session.

**Recommendation (HIGH confidence):** **(A) for Phase 44, defer (B).** Rationale: (B) depends on an unverified OpenClaw plugin-sdk surface. Shipping the Telegram case via (A) is the promised scope. Document (B) as a follow-up phase.

**Planner must lock this.**

### Q2. **TTL for captured session route — disable, bump, or refresh-on-message?**

**Options:**
- (A) Keep 1-hour TTL, do nothing. Accept F1.
- (B) Bump to 24-hours, accept memory cost.
- (C) No TTL; clean up only on `session_end` event.

**Recommendation (MEDIUM confidence):** **(C) with LRU cap.** The `session_end` hook already clears routes (`adapter.ts:72-73`), so leaking is bounded by sessions that crash without emitting `session_end`. The LRU cap (`maxSessionRoutes`, default 2048, at `tool-invocation-context.ts:25`) already protects against unbounded growth. Remove the time-based TTL entirely; the hook-based one is more faithful to OpenClaw's actual session lifecycle.

### Q3. **Daemon restart recovery — should F7 be in-scope?**

**Options:**
- (A) Yes — add a startup pass in the notifier that scans for active subscriptions on terminal tasks and re-enqueues their wake-ups.
- (B) No — accept that daemon crashes during the tight window between transition and plugin ACK lose the wake-up. Plugin restarts are already handled (subscription is durable; plugin-side `chat-delivery-poller` resumes long-polling on reconnect).

**Recommendation (LOW confidence; user must decide):** **(A)** — consistent with PROJECT.md's "tasks never get dropped" core value, extended to wake-ups. But the implementation adds complexity, and the window is small (crash within seconds). Planner/user should decide based on how load-bearing wake-up reliability is for 999.4's use case.

### Q4. **Is the subscription auto-registered on every `aof_dispatch`, or opt-in?**

**Recommendation (HIGH confidence):** **Auto-register (today's behavior) when `OpenClawToolInvocationContextStore` has a route.** Explicit opt-out via `notifyOnCompletion: false`. Do not change this.

### Q5. **Does the notifier's `done` promise need a timeout?**

**Recommendation (HIGH confidence):** **YES, 60s.** Critical for F8/F10 resilience. This is the highest-value hardening item in the phase.

### Q6. **Should `dispatcherAgentId` replace `subscriberId` on completion-delivery subscriptions?**

Today `subscriberId = "notify:openclaw-chat"` (a tag, not an identity) (`src/tools/project-tools.ts:256`). The real dispatcher agent is dropped.

**Recommendation (MEDIUM confidence):** **Store `dispatcherAgentId` separately in the delivery payload; keep `subscriberId` as the tag.** `subscriberId` is used for existing dedupe (`aof_task_subscribe` dedup in `subscription-tools.ts:87`) and reusing it for dispatcher identity would conflate two concepts.

---

## Runtime State Inventory

Phase 44 is not a rename/refactor/migration — **section SKIPPED.**

---

## Environment Availability

Phase 44 depends on tools already confirmed in-tree per Phase 43. No external tools introduced.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Vitest | All tests | ✓ (existing) | per `package.json` | — |
| Node 22+ | All | ✓ (CLAUDE.md) | | — |
| OpenClaw gateway | Human-UAT only | ✓ per user install | | UAT becomes optional |
| Telegram outbound adapter | WAKE-01 manual UAT | ✓ per OpenClaw config | | UAT = skip |

No missing dependencies.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Notification policy / dedupe | Custom dedupe cache on the notifier | `TaskSubscription.notifiedStatuses` array (already persistent on-disk) | Already handles per-status dedupe across daemon restart. |
| Long-poll transport | Second WebSocket / SSE surface | Existing `GET /v1/deliveries/wait` + `POST /v1/deliveries/{id}/result` | Phase 43 shipped this; same pattern as spawn. |
| Subscription storage | Postgres / Redis / in-memory cache | `subscriptions.json` colocated with task file via `SubscriptionStore` | Durable, crash-safe via `write-file-atomic`, survives restart. |
| ACK correlation | New UUID scheme | `ChatDeliveryRequest.id = randomUUID()` in queue | Already implemented. |
| Message rendering | Templating library | `renderMessage` in `openclaw-chat-delivery.ts:153-180` | Already renders task status, outcome, blockers, notes. |
| Plugin↔daemon IPC | New socket / new auth | Existing `daemon.sock` + same-uid trust boundary | Phase 43 verified D-05/D-08. |

**Key insight:** Phase 44 is 80% schema + identity-plumbing and 20% hardening (timeout + recovery). No new subsystems. The biggest temptation will be to build a `SessionResumeQueue` or an `OpenClawSessionWakeNotifier`. Don't — the chat-delivery queue and notifier handle it.

---

## Common Pitfalls

### Pitfall 1: Confusing "plugin route capture drops" with "subscription delivery drops"
- **What goes wrong:** Debugging a missing wake-up, assuming the subscription is bogus when actually the pre-subscription plugin-side capture never attached.
- **How to avoid:** The audit trail is in two places — in-memory `OpenClawToolInvocationContextStore` (plugin, ephemeral) and persistent `subscriptions.json` (daemon, durable). Always check `subscriptions.json` first; if it has `delivery.sessionKey`, the route was captured. If not, capture failed upstream.

### Pitfall 2: `parseSessionKey` silently failing on subagent sessionKeys
- **What goes wrong:** Dispatch from a `runEmbeddedPiAgent` child session. Captured sessionKey is `agent:X:subagent:Y`. Looks fine in the subscription. Completion fires. `sendChatDelivery` throws. Wake-up lost.
- **How to avoid:** `parseSessionKey` requires ≥5 parts; subagent sessionKeys have 4. Make the failure visible in the subscription (WAKE-06 / Q1).

### Pitfall 3: CLAUDE.md's chain-blocks-on-plugin-ACK trap
- **What goes wrong:** A slow/broken plugin holds the notifier's `messageTool.send()` open, which holds the EventLogger callback open, which holds subsequent `log()` calls. [CITED: CLAUDE.md §Fragile]
- **How to avoid:** Phase 44 MUST add the `ChatDeliveryQueue.enqueueAndAwait` timeout (Q5). Without it, every wake-up is a potential stall.

### Pitfall 4: Zombie agents re-running old plugin code
- **What goes wrong:** After deploying Phase 44, zombie `openclaw-agent` processes (from before the deploy) continue running pre-44 plugin code with old capture logic. Wake-ups appear to work in fresh sessions but fail mysteriously in pre-existing agent processes.
- **How to avoid:** `ps -eo pid,lstart,command | grep openclaw-agent`; kill any agent process that pre-dates the deploy. Or reboot. [CITED: CLAUDE.md §Zombie agent caveat]

### Pitfall 5: EventLogger callback exceptions swallowed
- **What goes wrong:** Notifier throws; EventLogger catches via `console.warn` (`events/logger.ts:77`). Other subsystems consuming the same event stream don't know. **Symptom:** wake-up fails silently with a warning in logs but no structured event.
- **How to avoid:** Inside `OpenClawChatDeliveryNotifier.handleEvent`, wrap every subscription delivery in try/catch (already done at `openclaw-chat-delivery.ts:79-81`). Ensure error paths always call `subscriptionStore.appendAttempt({success: false, error})`. Today's code does this correctly; just preserve it in Phase 44 changes.

---

## Code Examples

### Capturing identity at dispatch time (today's code, for reference)

```ts
// src/openclaw/dispatch-notification.ts:35-51
const delivery: Record<string, unknown> = {
  ...(captured
    ? {
        target: captured.replyTarget,
        sessionKey: captured.sessionKey,
        sessionId: captured.sessionId,
        channel: captured.channel,
        threadId: captured.threadId,
      }
    : {}),
  ...explicitRest,
  kind: kind ?? OPENCLAW_CHAT_DELIVERY_KIND,
};
```

### Proposed Phase 44 extension (new fields promoted)

```ts
// Phase 44 addition — same helper, enriched payload
const delivery: Record<string, unknown> = {
  ...(captured
    ? {
        target: captured.replyTarget,
        sessionKey: captured.sessionKey,
        sessionId: captured.sessionId,
        channel: captured.channel,
        threadId: captured.threadId,
        dispatcherAgentId: captured.actor,          // NEW
        capturedAt: captured.capturedAt,            // NEW
        pluginId: "openclaw",                       // NEW (from InvokeToolRequest envelope)
      }
    : {}),
  ...explicitRest,
  kind: kind ?? OPENCLAW_CHAT_DELIVERY_KIND,
};
```

### Proposed timeout on `enqueueAndAwait` (Wave 1)

```ts
// src/ipc/chat-delivery-queue.ts — Phase 44 addition
const DEFAULT_TIMEOUT_MS = 60_000;

enqueueAndAwait(partial: Omit<ChatDeliveryRequest, "id">, opts?: { timeoutMs?: number }): { id: string; done: Promise<void> } {
  const id = randomUUID();
  const full: ChatDeliveryRequest = { id, ...partial };
  this.pending.set(id, full);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (this.waiters.has(id)) {
        this.waiters.delete(id);
        this.pending.delete(id);
        this.claimed.delete(id);
        const err = new Error(`chat delivery timed out after ${timeoutMs}ms`);
        (err as Error & { kind?: string }).kind = "timeout";
        reject(err);
      }
    }, timeoutMs);

    this.waiters.set(id, {
      resolve: () => { clearTimeout(timer); resolve(); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });

  this.emit("enqueue", full);
  return { id, done };
}
```

---

## State of the Art (project-local)

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| In-process `AOFService` in OpenClaw plugin; direct store writes | Daemon owns `AOFService`; plugin is thin IPC bridge | Phase 43 (v1.15.0) | Subscription writes always go through the daemon — no dual-writer risk. |
| Per-platform OpenClaw APIs (`runtime.channel.telegram.sendMessageTelegram`) | Unified outbound adapter (`runtime.channel.outbound.loadAdapter(platform).sendText`) | Recent OpenClaw plugin-sdk | Phase 44 benefits: Telegram-specific logic is gone; any platform that registers an outbound adapter works. |
| `AOF_CALLBACK_DEPTH` env mutation for callback depth | Callback depth in IPC envelope | Phase 43 D-06 | No new env reads introduced by Phase 44. |

**Deprecated / outdated:**
- `MatrixNotifier` in `matrix-notifier.ts` is effectively vestigial — used only as the `MatrixMessageTool` interface for the queue-backed tool. The `MatrixNotifier` class implementation (sending directly) is dead code in the daemon-driven architecture. Not blocking Phase 44 but worth flagging.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `runtime.channel.outbound.loadAdapter("telegram")` works in production | §3, §Validation Architecture | [ASSUMED: inferred from `chat-message-sender.ts` comments + existing e2e test with stub]. If the real OpenClaw instance doesn't expose `outbound.loadAdapter`, Telegram wake-ups silently fail. **Validate via human UAT (matrix item A).** |
| A2 | No `runtime.agent.resumeSession` exists in OpenClaw plugin-sdk | §3, §11 Q1 | [ASSUMED: `OpenClawAgentRuntime` in `src/openclaw/types.ts` doesn't declare it; our type subset is minimal but the check was grep-based against existing TS source]. If it DOES exist, the stretch case could skip option A and go straight to real session-resume. Ask user. |
| A3 | Today's e2e test (`chat-delivery-e2e.test.ts`) actually exercises every layer minus the real Telegram API | §1 | [VERIFIED by reading test file header] |
| A4 | Phase 43's thin-bridge setup is fully operational on the user's box | §7 | [CITED: 43-VERIFICATION.md status="human_needed", but STATE.md and commit log suggest operational deployment]. Phase 44 work assumes the daemon.sock IPC is live. |
| A5 | `DEFAULT_ROUTE_TTL_MS = 1h` is actually being hit in practice, causing real wake-up losses | §5 Case 1 | [ASSUMED: not directly observed]. Might not be the user's reported problem; the actual problem could be non-Telegram dispatch (subagent case, §3). **Ask user which gap they've seen.** |
| A6 | `subscriberId` vs. `dispatcherAgentId` are legitimately orthogonal concepts | §11 Q6 | [ASSUMED: reasoning about semantic scope]. User may prefer consolidation. |
| A7 | Backlog 999.4 will use `SubscriptionDelivery` schema verbatim, not fork | §4 | [ASSUMED: reading 999.4's ROADMAP entry + current schema extensibility]. If 999.4 ultimately designs its own schema, Phase 44's compatibility layer was premature. Flag in discuss-phase. |
| A8 | The 60s timeout default on `enqueueAndAwait` is appropriate | §11 Q5 | [ASSUMED: rule-of-thumb 2× the 25s server keepalive + 30s client timeout]. Could be tuned. |

---

## Open Questions (RESOLVED)

> All four items closed by Phase 44 discuss-phase decisions (D-44-GOAL, D-44-PRIMITIVE, D-44-PARTITION-SCOPE, D-44-AGENT-CALLBACK-FALLBACK). Retained here for historical traceability. If a future phase re-opens any of these, add a new sibling section rather than editing in place.

1. **Which specific wake-up gap has the user seen fail in production?**
   - What we know: the one-sentence STATE.md scope says "Telegram-bound sessions actually resume" is in-scope, which implies the user has seen Telegram sessions FAIL to resume. But Phase 43's e2e test suggests they should work.
   - What's unclear: is the failure (a) TTL expiry (§5 Case 1), (b) a subagent case that looks Telegram-like but fails silently (§3 row 3), (c) a daemon-crash / late-transition race, or (d) something else?
   - Recommendation: the discuss-phase MUST clarify this with the user. It changes which RED test Wave 0 leads with.
   - **RESOLVED (D-44-GOAL + D-44-RECOVERY):** Phase 44 treats the failure surface as a union, not a single case. The locked goal ("dispatching session receives a wake-up on its captured channel") plus D-44-RECOVERY (boot-time replay of unnotified terminals) covers (a) TTL expiry, (c) daemon-crash / late-transition race, and (d) other transient losses in one sweep. (b) subagent case is handled separately by D-44-AGENT-CALLBACK-FALLBACK. Wave 0 leads with the chain of three RED tests from Plan 02 (integration, subagent fallback, recovery) — no single "which gap first" ordering is required.

2. **Does OpenClaw expose any session-resume / session-inbox API?**
   - What we know: `OpenClawAgentRuntime` in our type subset declares `runEmbeddedPiAgent`, `resolveAgentWorkspaceDir`, `resolveAgentDir`, `resolveAgentTimeoutMs`, `ensureAgentWorkspace`, and `session.resolveSessionFilePath`. The last suggests OpenClaw tracks session files — but `resolveSessionFilePath` reads a location; it doesn't offer a write/append/kick primitive.
   - What's unclear: does `runtime.agent.session` expose anything else in newer builds?
   - Recommendation: Phase 44 planner or discuss-phase should `grep -rn "runtime.agent.session" ~/.openclaw/...` on the user's install to verify what's actually available.
   - **RESOLVED (D-44-PRIMITIVE):** Phase 44 scope is locked to the existing chat-message primitive (`runtime.channel.outbound.loadAdapter(platform).sendText`). Any new session-resume / session-inbox API surface is explicitly OUT of Phase 44 scope and deferred to a follow-up phase. §11 Q1 records the rationale (shipping the Telegram case now via the verified primitive; not gating on an unverified OpenClaw plugin-sdk surface).

3. **How should the subscription expose "couldn't deliver — here's why" to the calling agent?**
   - What we know: `TaskSubscription.failureReason` + `attempts[].error` record failure, but the **dispatcher is an agent that might not read subscriptions.json** — it reads tool-call responses.
   - What's unclear: is there a tool (`aof_subscription_status` or similar) the dispatcher should poll? Or is the contract "you dispatched, the daemon tried, if you didn't get a message, you check via `aof_task_get`"?
   - Recommendation: add a `aof_task_get` response field surfacing "last wake-up attempt status" for the dispatcher's convenience. Low-cost addition.
   - **RESOLVED (D-44-OBSERVABILITY):** Phase 44 exposes failure surface via structured log events (`wake-up.attempted`, `wake-up.delivered`, `wake-up.timed-out`, `wake-up.fallback`, `wake-up.recovery-replay`) plus the existing `TaskSubscription.attempts[]` ledger. A new `aof_task_get`-facing "last wake-up attempt" field is explicitly deferred — 999.4 owns that surface. Dispatcher agents that need the signal today read subscriptions.json or the log stream.

4. **Should Phase 44 care about "multiple agents dispatch the SAME task" or is dispatch always unique per task?**
   - What we know: `aofDispatch` creates a new task each call with a freshly minted `TASK-NNN` ID. Two agents dispatching the "same logical task" get two different task IDs.
   - But: `aof_task_subscribe` allows N agents to subscribe to M existing tasks. In principle N dispatchers could subscribe after-the-fact to a shared task.
   - Recommendation: Phase 44 scope is explicitly about the dispatcher that CREATED the task, not N arbitrary subscribers. Confirm with user; today's `subscriberId = "notify:openclaw-chat"` tag already makes the "N subscribers" case degenerate.
   - **RESOLVED (D-44-PARTITION-SCOPE + D-44-IDENTITY):** Phase 44 scope is ONE subscription per dispatched task, keyed by the single `dispatcherAgentId` captured at `aof_dispatch` time. Multi-dispatcher fan-out (N subscribers -> M tasks) is explicitly a 999.4 concern; Phase 44 preserves the `subscriberId = "notify:openclaw-chat"` tag for today's dedupe semantics and adds `dispatcherAgentId` orthogonally in the delivery payload (§11 Q6).

---

## Security Domain

> Phase 44's `security_enforcement` disposition: project config doesn't exist (`.planning/config.json` absent). Treating as enabled per default.

### Applicable ASVS categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no (inherited from Phase 43 — same-uid socket perms) | — |
| V3 Session Management | **yes** (sessionKey is session identity material) | Use existing `OpenClawToolInvocationContextStore` bounded LRU + `session_end` cleanup. |
| V4 Access Control | no (no new ACL surface; 999.4 will reopen) | — |
| V5 Input Validation | **yes** (new `SubscriptionDelivery` fields need Zod validation) | Zod schemas in `src/schemas/subscription.ts`. |
| V6 Cryptography | no | — |

### Known threat patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Session-key impersonation (malicious agent dispatches with forged sessionKey → wake-up lands in someone else's Telegram) | Spoofing | **Partial mitigation today:** `OpenClawToolInvocationContextStore.captureToolCall` only uses the PLUGIN-CAPTURED route from its own `before_tool_call` event. An agent passing an explicit `notifyOnCompletion: { sessionKey: "agent:someone_else:..." }` **would** be written verbatim onto the subscription (`dispatch-notification.ts:28-29` uses the explicit object verbatim). This is an existing issue, not Phase 44's, but Phase 44 shouldn't make it worse. Flag for hardening: validate that an explicit `sessionKey` matches one of the agent's recently-captured routes. |
| Subscription payload poisoning (arbitrary fields in `delivery` stored without validation) | Tampering | Today's `SubscriptionDelivery` is `.passthrough()` — any field persists. Phase 44 adding formal Zod fields is a minor hardening — UNKNOWN fields still pass through, so 999.4 can extend, but known fields are validated. |
| Unbounded queue growth (malicious agent triggers thousands of dispatches → memory DoS via `ChatDeliveryQueue`) | DoS | Accepted same-uid trust boundary (Phase 43 D-08). Not newly opened by Phase 44. |

---

## Sources

### Primary (HIGH confidence)
- `CLAUDE.md` (entire) — Fragile section, CLI hazards, zombie agents, vitest orphans.
- `CODE_MAP.md` (entire) — execution model post-Phase-43, chat-delivery pipeline documentation.
- `.planning/phases/43-thin-plugin-daemon-authority/43-CONTEXT.md` — D-05 through D-14 decisions.
- `.planning/phases/43-thin-plugin-daemon-authority/43-VERIFICATION.md` — verified artifact list.
- `src/openclaw/openclaw-chat-delivery.ts` (204 LOC) — the notifier.
- `src/openclaw/tool-invocation-context.ts` (287 LOC) — the capture store.
- `src/openclaw/dispatch-notification.ts` (52 LOC) — the pre-handler merge.
- `src/openclaw/chat-message-sender.ts` (162 LOC) — the platform dispatch.
- `src/openclaw/chat-delivery-poller.ts` (112 LOC) — the long-poll loop.
- `src/ipc/chat-delivery-queue.ts` (121 LOC) — the queue.
- `src/ipc/routes/delivery-wait.ts` (77 LOC), `delivery-result.ts` (104 LOC).
- `src/ipc/schemas.ts` (210 LOC) — `ChatDeliveryRequest` + `ChatDeliveryResultPost` schemas.
- `src/daemon/daemon.ts` (310 LOC) — notifier wiring at `logger.addOnEvent`.
- `src/schemas/subscription.ts` (92 LOC) — `TaskSubscription` + `SubscriptionDelivery`.
- `src/store/subscription-store.ts` (271 LOC) — CRUD + append-attempt + persistence.
- `src/tools/project-tools.ts` (286 LOC) — `aofDispatch` subscription registration.
- `src/events/logger.ts` (253 LOC) — `addOnEvent` + callback fan-out.
- `src/openclaw/adapter.ts` (150 LOC) — the thin-bridge plugin entry.
- `src/openclaw/types.ts` (90 LOC) — `OpenClawAgentRuntime` surface.
- `src/daemon/__tests__/chat-delivery-e2e.test.ts` — end-to-end regression evidence.
- `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` — 8 notifier unit tests.
- `src/openclaw/__tests__/tool-invocation-context.test.ts` — capture semantics (sessionKey formats).

### Secondary (MEDIUM confidence)
- `.planning/ROADMAP.md` L167-175 (Phase 44 entry) + L198-208 (999.4 entry).
- `.planning/STATE.md` L59 (Phase 44 scope line).

### Tertiary (LOW confidence)
- External OpenClaw plugin-sdk surface — inferred from in-tree `OpenClawApi` type declarations only. Not directly verified against the user's installed OpenClaw version.

---

## Metadata

**Confidence breakdown:**
- Existing pipeline archaeology (what code runs today): **HIGH** — every claim is file:line-backed.
- Subscription schema design: **HIGH** — all precedents in Phase 43 to lean on.
- Stretch case (subagent session wake-up): **MEDIUM** — depends on unverified OpenClaw APIs; fallback design is sound.
- Which specific bug the user actually wants fixed: **MEDIUM** — needs discuss-phase clarification.
- CLI wake-up viability: **LOW** — not expected to ship in Phase 44 anyway.

**Research date:** 2026-04-24
**Valid until:** 2026-05-24 (30 days — pipeline is stable post-Phase-43, but OpenClaw plugin-sdk cadence is rapid; re-verify if user's gateway version changes).
