# Phase 44: Deliver completion-notification wake-ups to dispatching agent sessions — Pattern Map

**Mapped:** 2026-04-24
**Files analyzed:** 13 (10 modify, 3+ create)
**Analogs found:** 13 / 13

> Phase 44 is 80% schema + identity plumbing and 20% hardening. Every file has a strong in-tree analog — in several cases the analog IS the file being modified. The primary job is to enrich an already-wired chat-delivery pipeline, not to invent new subsystems.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/schemas/subscription.ts` | schema | CRUD (shape contract) | same file (extend the existing `SubscriptionDelivery` with a discriminated `OpenClawChatDelivery` refinement) | self (extend) |
| `src/openclaw/dispatch-notification.ts` | pre-IPC transform (identity-capture plumbing) | request-response | same file | self (extend) |
| `src/openclaw/tool-invocation-context.ts` | in-memory identity store (TTL/lifecycle) | event-driven | same file | self (extend) |
| `src/ipc/chat-delivery-queue.ts` | event-driven queue with ack-awaiter | pub-sub + request-response | same file; also `src/ipc/spawn-queue.ts` for queue-with-timeout patterns | self + sibling |
| `src/openclaw/openclaw-chat-delivery.ts` | delivery notifier (EventLogger callback) | event-driven | same file + `src/dispatch/callback-delivery.ts` for recovery semantics | self + sibling |
| `src/openclaw/chat-message-sender.ts` | platform-send transport (plugin-side) | request-response | same file | self (extend) |
| `src/daemon/daemon.ts` | wiring/bootstrap (notifier + recovery-pass) | startup | same file at `daemon.ts:192-196`; recovery pass borrows from `retryPendingDeliveries` in `src/dispatch/callback-delivery.ts:87-132` | self + cross-module |
| `src/tools/project-tools.ts` | tool handler (subscription creation on dispatch) | CRUD | same file at `project-tools.ts:253-265` | self (review-only — may not need edits) |
| `tests/integration/wake-up-dispatcher.test.ts` (NEW) | integration test | event-driven E2E | `src/daemon/__tests__/chat-delivery-e2e.test.ts` | exact |
| `tests/integration/wake-up-restart-recovery.test.ts` (NEW, conditional) | integration test (restart survival) | event-driven E2E | `tests/integration/daemon-restart-midpoll.test.ts` | exact |
| `src/daemon/__tests__/bug-NNN-dispatcher-wake-up-on-completion.test.ts` (NEW) | regression anchor | event-driven E2E | `src/daemon/__tests__/chat-delivery-e2e.test.ts` | exact |
| `src/daemon/__tests__/chat-delivery-queue-timeout.test.ts` (NEW) OR extend `src/ipc/__tests__/chat-delivery-queue.test.ts` | unit test (queue timeout) | unit | `src/ipc/__tests__/chat-delivery-queue.test.ts` | self (extend) |
| `src/openclaw/__tests__/dispatch-notification.test.ts` (NEW) | unit test (merge logic) | unit | `src/openclaw/__tests__/tool-invocation-context.test.ts` (closest analog — same module family) | role-match |

---

## Pattern Assignments

### `src/schemas/subscription.ts` (schema, CRUD)

**Analog:** self — extend the existing `SubscriptionDelivery` definition in place. Preserve `passthrough()` so 999.4 and other plugin kinds stay extensible.

**Existing shape** (`src/schemas/subscription.ts:36-39`):
```ts
export const SubscriptionDelivery = z.object({
  kind: z.string().min(1).describe("Delivery kind; core handles 'agent-callback', plugins register others"),
}).passthrough();
export type SubscriptionDelivery = z.infer<typeof SubscriptionDelivery>;
```

**Core-schema-extension pattern to follow** (same file, how `TaskSubscriptionAttempt` is typed then nested inside `TaskSubscription` at lines 48-56):
```ts
export const TaskSubscriptionAttempt = z.object({
  attemptedAt: z.string().datetime().describe("ISO-8601 timestamp when the attempt started"),
  success: z.boolean().describe("Whether the attempt delivered successfully"),
  toStatus: z.string().optional().describe("Status transition that triggered this attempt..."),
  error: z.object({
    kind: z.string().optional().describe("Machine-readable error class (e.g. 'send-failed', 'not-found')"),
    message: z.string().describe("Human-readable failure reason"),
  }).optional().describe("Failure details; absent when success is true"),
});
```

**Phase 44 extension (new code to write):**
- Define `OpenClawChatDelivery` as a Zod object living near `OPENCLAW_CHAT_DELIVERY_KIND` (currently in `src/openclaw/openclaw-chat-delivery.ts:25`). Prefer a new file `src/openclaw/subscription-delivery.ts` so the plugin-idiom schema stays plugin-colocated (parallels how `OpenClawNotificationRecipient` lives in `tool-invocation-context.ts:8-17`).
- Carry fields: `sessionKey?`, `sessionId?`, `channel?`, `threadId?`, `target?`, `dispatcherAgentId?`, `capturedAt?`, `pluginId?`, `wakeUpMode?` — exact enumeration from RESEARCH §Subscription-Registration Shape.
- DO NOT break `SubscriptionDelivery.passthrough()` — known fields get formal Zod types, unknown fields keep flowing through. This preserves the 999.4-compatibility promise.

**Descriptor convention to mirror** (every field on `TaskSubscription` carries `.describe(...)` — see lines 61-74). New fields MUST carry `.describe()` strings; the planner hook `npm run docs:generate` enforces this.

---

### `src/openclaw/dispatch-notification.ts` (pre-IPC transform, request-response)

**Analog:** self — entire file is 52 LOC, the extension lives inside the single exported function.

**Existing core pattern** (`src/openclaw/dispatch-notification.ts:35-51`):
```ts
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
for (const k of Object.keys(delivery)) {
  if (delivery[k] === undefined) delete delivery[k];
}
return { ...params, notifyOnCompletion: delivery };
```

**Phase 44 extension** (from RESEARCH §Code Examples, lines 711-731):
```ts
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
        pluginId: "openclaw",                       // NEW
      }
    : {}),
  ...explicitRest,
  kind: kind ?? OPENCLAW_CHAT_DELIVERY_KIND,
};
```

**Precedence rule to preserve** (lines 25-33 — do not change): `raw === false` short-circuits, explicit object overrides per-field, and the guard `if (!explicit && !captured) return params` stays as-is. The new fields are ADDITIVE — never override an explicit caller value.

**Undefined-stripping pass** at lines 48-50 — the existing `for … if (delivery[k] === undefined) delete delivery[k]` loop already handles the case where `captured.actor` is missing. No new scaffolding needed.

---

### `src/openclaw/tool-invocation-context.ts` (in-memory identity store, event-driven)

**Analog:** self — TTL constant at line 24 is a one-line change; the surrounding storage + LRU + `pruneExpired` apparatus stays.

**Existing TTL pattern** (`src/openclaw/tool-invocation-context.ts:24-26`):
```ts
const DEFAULT_ROUTE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_SESSION_ROUTES = 2048;
const DEFAULT_MAX_TOOL_CALLS = 2048;
```

**Existing expiry logic** (lines 277-286) — reference for the semantic change (TTL → session-lifecycle):
```ts
private pruneExpired(): void {
  const now = this.now();
  for (const map of [this.bySessionKey, this.bySessionId, this.byToolCallId]) {
    for (const [key, entry] of map.entries()) {
      if (entry.expiresAt <= now) {
        map.delete(key);
      }
    }
  }
}
```

**Phase 44 change** (RESEARCH §11 Q2 recommendation):
- Bump `DEFAULT_ROUTE_TTL_MS` from `60 * 60 * 1000` → `24 * 60 * 60 * 1000` (24h). 1-line change.
- Verify `clearSessionRoute` already wires to the `session_end` event (CITED at `src/openclaw/adapter.ts:72-73` in RESEARCH §7). LRU cap at `maxSessionRoutes: 2048` remains the memory-bound backstop.
- Keep the existing `pruneExpired` / LRU machinery — it's correct, just with a different time horizon.

**Test contract to preserve** (`src/openclaw/__tests__/tool-invocation-context.test.ts:37-58`):
```ts
it("expires stale routes and tool calls after the configured TTL", () => {
  let now = 1_000;
  const store = new OpenClawToolInvocationContextStore({
    routeTtlMs: 100,
    now: () => now,
  });
  // … capture then advance time …
  now += 101;
  expect(store.consumeToolCall("tool-call-1")).toBeUndefined();
});
```
The `routeTtlMs` constructor option + injectable `now` remain the test seam. The existing test MUST keep passing unchanged — only the DEFAULT bumps.

---

### `src/ipc/chat-delivery-queue.ts` (event-driven queue with ack-awaiter, pub-sub + request-response)

**Analog:** self — and the corresponding timeout unit-test pattern is already in `src/ipc/__tests__/chat-delivery-queue.test.ts`.

**Existing enqueue-and-await pattern** (`src/ipc/chat-delivery-queue.ts:41-59`):
```ts
enqueueAndAwait(partial: Omit<ChatDeliveryRequest, "id">): {
  id: string;
  done: Promise<void>;
} {
  const id = randomUUID();
  const full: ChatDeliveryRequest = { id, ...partial };
  this.pending.set(id, full);

  const done = new Promise<void>((resolve, reject) => {
    this.waiters.set(id, { resolve, reject });
  });

  this.emit("enqueue", full);
  log.debug(
    { id, subscriptionId: full.subscriptionId, taskId: full.taskId },
    "chat delivery enqueued",
  );
  return { id, done };
}
```

**Existing deliverResult pattern** (lines 93-109) — the timeout MUST interact cleanly with this:
```ts
deliverResult(id: string, result: ChatDeliveryResultPost): void {
  const waiter = this.waiters.get(id);
  if (!waiter) {
    log.debug({ id }, "deliverResult: no waiter (already settled)");
    return;
  }
  this.waiters.delete(id);
  this.claimed.delete(id);
  if (result.success) {
    waiter.resolve();
  } else {
    const msg = result.error?.message ?? "plugin reported delivery failure";
    const err = new Error(msg);
    (err as Error & { kind?: string }).kind = result.error?.kind;
    waiter.reject(err);
  }
}
```

**Phase 44 extension** (exact shape per RESEARCH §Code Examples lines 735-766):
```ts
const DEFAULT_TIMEOUT_MS = 60_000;

enqueueAndAwait(
  partial: Omit<ChatDeliveryRequest, "id">,
  opts?: { timeoutMs?: number },
): { id: string; done: Promise<void> } {
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

**Error-tagging convention** (already used at line 106: `(err as Error & { kind?: string }).kind = result.error?.kind;`) — the timeout path MUST use `kind: "timeout"` so the notifier's existing `catch (err)` branch (`openclaw-chat-delivery.ts:125-138`) writes the correct `error.kind` into `attempts[]`.

**Idempotency rule** (`deliverResult` is a no-op on unknown ids, line 95-98): after a timeout fires, a late plugin POST to `/v1/deliveries/{id}/result` hits `this.waiters.get(id) === undefined` → no-op. Correct. Don't regress this.

---

### `src/openclaw/openclaw-chat-delivery.ts` (delivery notifier, event-driven)

**Analog:** self for the main edit — add a typed try/catch fallback for `NoPlatformError`. For the F7 recovery pass, the analog is `retryPendingDeliveries` in `src/dispatch/callback-delivery.ts:87-132`.

**Existing try/catch error-recording pattern** (`src/openclaw/openclaw-chat-delivery.ts:104-140`):
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
  if (TERMINAL_STATUSES.has(toStatus)) {
    await subscriptionStore.update(task.frontmatter.id, sub.id, {
      status: "delivered",
      deliveredAt: new Date().toISOString(),
    });
  }
} catch (err) {
  const failureMessage = err instanceof Error ? err.message : String(err);
  const kind =
    err && typeof err === "object" && "kind" in err && typeof (err as { kind: unknown }).kind === "string"
      ? ((err as { kind: string }).kind)
      : undefined;
  await subscriptionStore.appendAttempt(task.frontmatter.id, sub.id, {
    attemptedAt,
    success: false,
    toStatus,
    error: {
      ...(kind !== undefined ? { kind } : {}),
      message: failureMessage,
    },
  });
  log.error({ err, target, taskId: task.frontmatter.id }, "messageTool.send failed");
}
```

**Phase 44 addition — subagent fallback** (Wave 2, stretch): wrap an additional catch branch around the `catch (err)` for `err.kind === "no-platform"` (thrown by the new `NoPlatformError` in `chat-message-sender.ts`) that:
1. Creates (or swaps kind to) an agent-callback subscription using the captured `dispatcherAgentId`.
2. Records the fallback attempt with `error.kind = "fallback-to-agent-callback"`.
3. Returns cleanly so the outer try continues.

The existing `subscriptionStore.appendAttempt({success: false, error: {kind, message}})` is the audit-trail contract; the fallback must write TWO entries — one recording the fallback trigger, one recording the subsequent agent-callback outcome.

**Recovery-pass pattern to borrow** (`src/dispatch/callback-delivery.ts:87-132`):
```ts
export async function retryPendingDeliveries(opts: DeliverCallbacksOptions): Promise<void> {
  const { taskId, store, subscriptionStore, logger } = opts;

  const task = await store.get(taskId);
  if (!task || !TERMINAL_STATUSES.has(task.frontmatter.status)) {
    return;
  }

  const activeSubs = await subscriptionStore.list(taskId, { status: "active" });
  const retryCandidates = activeSubs.filter(
    (s) => s.deliveryAttempts < MAX_DELIVERY_ATTEMPTS && resolveDeliveryKind(s) === "agent-callback",
  );
  // … iterate and re-fire …
}
```

Phase 44's notifier-startup recovery pass (if F7 is in-scope, Wave 2) mirrors this shape but filters on `resolveDeliveryKind(s) === OPENCLAW_CHAT_DELIVERY_KIND` and `!notifiedStatuses.includes(task.frontmatter.status)` for terminal tasks. Add it as a method on `OpenClawChatDeliveryNotifier` (e.g. `replayUnnotifiedTerminals()`), invoked once from `startAofDaemon` after the `logger.addOnEvent(...)` wire-up.

---

### `src/openclaw/chat-message-sender.ts` (platform-send transport, request-response)

**Analog:** self.

**Existing no-platform throw** (`src/openclaw/chat-message-sender.ts:101-107`):
```ts
const parsed = parseSessionKey(req.delivery.sessionKey);
const platform = req.delivery.channel ?? parsed?.platform;
if (!platform) {
  throw new Error(
    `cannot resolve platform for delivery (sessionKey=${req.delivery.sessionKey ?? "<none>"}, channel=<none>)`,
  );
}
```

**Phase 44 change — typed error class** (Wave 2, to enable notifier fallback):
```ts
// at top of file
export class NoPlatformError extends Error {
  readonly kind = "no-platform" as const;
  constructor(public readonly sessionKey: string | undefined) {
    super(
      `cannot resolve platform for delivery (sessionKey=${sessionKey ?? "<none>"}, channel=<none>)`,
    );
    this.name = "NoPlatformError";
  }
}
```

**Error-tagging convention to mirror** — every thrown `Error` in this file needs a discriminable `.kind` so `OpenClawChatDeliveryNotifier`'s catch branch (lines 125-129) propagates the kind into `attempts[].error.kind`. See lines 98, 104-106, 110-113, 134, 147 for existing throw sites. Keep them plain `Error` for now; only the `no-platform` case gets the typed class because it's the only one Phase 44's notifier fallback needs to introspect.

**`parseSessionKey` invariant** (`src/openclaw/chat-message-sender.ts:64-80`):
```ts
export function parseSessionKey(key: string | undefined): ParsedSessionKey | undefined {
  if (!key) return undefined;
  const parts = key.split(":");
  if (parts.length < 5 || parts[0] !== "agent") return undefined;
  // …
}
```
DO NOT extend `parseSessionKey` to handle 4-part subagent sessionKeys (`agent:X:subagent:Y`). The 5-part requirement is load-bearing — a 4-part match would synthesize a bogus `platform = "subagent"` and call `loadAdapter("subagent")`. The correct fix is the NoPlatformError → notifier-fallback path.

---

### `src/daemon/daemon.ts` (wiring/bootstrap)

**Analog:** self — the existing notifier-wire-up block at lines 147-196.

**Existing wiring pattern** (`src/daemon/daemon.ts:192-196`):
```ts
const chatNotifier = new OpenClawChatDeliveryNotifier({
  resolveStoreForTask,
  messageTool: queueBackedMessageTool,
});
logger.addOnEvent((event) => chatNotifier.handleEvent(event));
```

**Existing queue-backed tool shim** (lines 147-191) — this is the bridge between the notifier (`MatrixMessageTool.send`) and `ChatDeliveryQueue.enqueueAndAwait`. Do NOT rewrite it. The Phase 44 timeout applies inside `enqueueAndAwait` itself so this shim is unaffected.

**Phase 44 addition — F7 recovery pass** (Wave 2, conditional on D-44-RECOVERY decision):
```ts
// after logger.addOnEvent(...) on line 196
if (opts.replayUnnotifiedTerminalsOnStartup ?? true) {
  await chatNotifier.replayUnnotifiedTerminals?.(store).catch((err) => {
    log.warn({ err }, "chat-delivery recovery pass failed on startup");
  });
}
```
The `log.warn` + `.catch` idiom matches the existing bootstrap's tolerance-for-partial-failure (see the `setShuttingDown(false)` reset on line 73 and the PID file recovery at lines 78-89 — both are "don't crash the daemon on bootstrap-time edge cases").

---

### `src/tools/project-tools.ts` (tool handler, CRUD) — REVIEW-ONLY

**Analog:** self.

**Existing subscription-creation pattern** (`src/tools/project-tools.ts:253-265`):
```ts
let notificationSubscriptionId: string | undefined;
if (completionDelivery) {
  const deliverySubscriberId =
    completionDelivery.subscriberId ?? `notify:${completionDelivery.kind}`;
  const subscriptionStore = createSubscriptionStore(ctx.store);
  const sub = await subscriptionStore.create(
    readyTask.frontmatter.id,
    deliverySubscriberId,
    "completion",
    completionDelivery,
  );
  notificationSubscriptionId = sub.id;
}
```

**Phase 44 verdict** — per RESEARCH §11 Q6 recommendation: **do NOT change `subscriberId`**. Keep it as the `notify:${kind}` tag; persist `dispatcherAgentId` on the `delivery` payload instead. This file likely needs no edits in Phase 44 — the enrichment happens BEFORE the IPC hop inside `mergeDispatchNotificationRecipient`, so by the time `completionDelivery` reaches this handler, it already carries the new fields via `passthrough()`.

**Planner watch-item:** if `completionDelivery` is strict-Zod-parsed anywhere between the IPC boundary and `subscriptionStore.create`, that parse site MUST use the Phase-44-extended schema. Grep the call path for `SubscriptionDelivery.parse(` before assuming the passthrough path is clean.

---

### `tests/integration/wake-up-dispatcher.test.ts` (NEW, integration RED test)

**Analog:** `src/daemon/__tests__/chat-delivery-e2e.test.ts` (exact shape match).

**Imports pattern to copy** (`chat-delivery-e2e.test.ts:20-36`):
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../store/task-store.js";
import { EventLogger } from "../../events/logger.js";
import { SubscriptionStore } from "../../store/subscription-store.js";
import { ChatDeliveryQueue } from "../../ipc/chat-delivery-queue.js";
import { attachIpcRoutes } from "../../ipc/server-attach.js";
import { DaemonIpcClient } from "../../openclaw/daemon-ipc-client.js";
import { OpenClawChatDeliveryNotifier, OPENCLAW_CHAT_DELIVERY_KIND } from "../../openclaw/openclaw-chat-delivery.js";
import { sendChatDelivery } from "../../openclaw/chat-message-sender.js";
import { createLogger } from "../../logging/index.js";
```

**Harness setup pattern to copy** (lines 49-115) — tmpdir + real FilesystemTaskStore + real EventLogger + real ChatDeliveryQueue + real attachIpcRoutes + real Unix socket HTTP server. The shim that wires the notifier to the queue (`queueBackedMessageTool` at lines 67-88) is identical to production `daemon.ts:147-191`; keep the duplication — the e2e test's value is proving the production wiring works without `startAofDaemon` overhead.

**Integration-test env gate pattern** (from `tests/integration/daemon-restart-midpoll.test.ts`):
```ts
const SHOULD_RUN = process.env.AOF_INTEGRATION === "1";
// … later:
describe.skipIf(!SHOULD_RUN)("wake-up-dispatcher", () => { … });
```

**Wake-up-specific RED assertion** (Case 1 from RESEARCH §5 — TTL drop):
```ts
it("RED: dispatcher loses route when >1h elapses between capture and dispatch", async () => {
  // 1. captureToolCall with clock at t=0
  // 2. advance store's now() to t = 65 min
  // 3. consumeToolCall → undefined today, should NOT be after Phase 44 TTL bump
  // 4. assert subscription has no sessionKey → no wake-up fires
});
```

Use `OpenClawToolInvocationContextStore({ now: () => mockTime })` — same seam as `tool-invocation-context.test.ts:37-58`.

---

### `tests/integration/wake-up-restart-recovery.test.ts` (NEW, conditional)

**Analog:** `tests/integration/daemon-restart-midpoll.test.ts` (exact).

**Restart-pattern to copy** (from `daemon-restart-midpoll.test.ts`):
```ts
import { startTestDaemon, type TestDaemon } from "./helpers/daemon-harness.js";
// beforeEach: startTestDaemon → assert wiring → stop → startTestDaemon (same socketPath)
// assert the reconnected plugin receives the queued wake-up
```

This test is ONLY landed if the planner locks D-44-RECOVERY in scope (RESEARCH §11 Q3). Otherwise skip — an `NOTFOUND` F7 is acceptable per the research's Recommendation (LOW confidence).

---

### `src/daemon/__tests__/bug-NNN-dispatcher-wake-up-on-completion.test.ts` (NEW regression anchor)

**Analog:** `src/daemon/__tests__/chat-delivery-e2e.test.ts`.

**Regression-naming convention** (CLAUDE.md): `bug-NNN-description.test.ts`. The `NNN` gets assigned by the BUG registry when the specific failure is locked during planning — per 44-VALIDATION.md line 59, this happens at plan-time, not research-time.

**Test shape** (copy from `chat-delivery-e2e.test.ts` and simplify): the regression's job is to **lock** the one specific wake-up gap that motivated Phase 44. Today's e2e test already proves the happy path. This file proves the bug's failing case stays failing until the fix lands, then stays green afterwards.

---

### `src/daemon/__tests__/chat-delivery-queue-timeout.test.ts` (NEW) OR extend existing

**Analog:** `src/ipc/__tests__/chat-delivery-queue.test.ts` (extend in place).

**Existing queue-test pattern to extend** (`src/ipc/__tests__/chat-delivery-queue.test.ts:31-53`):
```ts
it("enqueueAndAwait generates an id, emits 'enqueue', returns a pending promise", async () => {
  const q = new ChatDeliveryQueue();
  let emittedId: string | undefined;
  q.on("enqueue", (req: ChatDeliveryRequest) => {
    emittedId = req.id;
  });

  const { id, done } = q.enqueueAndAwait(partial());

  expect(id).toBeTypeOf("string");
  // …
  q.deliverResult(id, { success: true });
  await done;
  expect(settled).toBe(true);
});
```

**Phase 44 RED test to add** (Wave 0):
```ts
it("enqueueAndAwait rejects done with kind='timeout' after timeoutMs elapses without deliverResult", async () => {
  const q = new ChatDeliveryQueue();
  const { done } = q.enqueueAndAwait(partial(), { timeoutMs: 10 });
  await expect(done).rejects.toMatchObject({
    kind: "timeout",
    message: expect.stringContaining("timed out"),
  });
});

it("late deliverResult after timeout is idempotent (no-op, no throw)", async () => {
  const q = new ChatDeliveryQueue();
  const { id, done } = q.enqueueAndAwait(partial(), { timeoutMs: 10 });
  await expect(done).rejects.toThrow();
  expect(() => q.deliverResult(id, { success: true })).not.toThrow();
});
```

**Recommendation:** Extend the existing file, don't create a new one. The 7 existing tests + 2 new tests belong in the same describe block.

---

### `src/openclaw/__tests__/dispatch-notification.test.ts` (NEW unit test)

**Analog:** `src/openclaw/__tests__/tool-invocation-context.test.ts` (same module family, same test conventions).

**Imports + minimal-store pattern to copy** (`tool-invocation-context.test.ts:1-3`):
```ts
import { describe, expect, it } from "vitest";
import { OpenClawToolInvocationContextStore } from "../tool-invocation-context.js";
```

**Test shape to follow** (each test constructs a fresh store + calls the target function — no mocking framework, no fixtures):
```ts
describe("mergeDispatchNotificationRecipient", () => {
  it("returns params unchanged when notifyOnCompletion === false", () => {
    const store = new OpenClawToolInvocationContextStore();
    const params = { someArg: 1, notifyOnCompletion: false };
    expect(mergeDispatchNotificationRecipient(params, "tc-1", store)).toBe(params);
  });

  it("populates dispatcherAgentId/capturedAt/pluginId from captured route (Phase 44)", () => {
    const store = new OpenClawToolInvocationContextStore();
    store.captureToolCall({
      name: "aof_dispatch",
      id: "tc-1",
      sessionKey: "agent:main:telegram:group:42",
      agentId: "main",
    });
    const out = mergeDispatchNotificationRecipient({}, "tc-1", store);
    expect(out.notifyOnCompletion).toMatchObject({
      kind: "openclaw-chat",
      sessionKey: "agent:main:telegram:group:42",
      dispatcherAgentId: "main",
      capturedAt: expect.any(String),
      pluginId: "openclaw",
    });
  });

  it("explicit caller object overrides per-field (preserves existing precedence)", () => { … });
  it("drops undefined fields from the delivery payload", () => { … });
});
```

**What NOT to do:** do NOT import/mock the IPC client, the daemon, or the subscription store. This is a PURE unit test of the transform function — same style as `tool-invocation-context.test.ts`.

---

## Shared Patterns

### Logger pattern (all production files)
**Source:** `createLogger` from `src/logging/index.js`, module-scoped constant.

```ts
import { createLogger } from "../logging/index.js";
const log = createLogger("component-name");
// …
log.debug({ subscriptionId, taskId }, "chat delivery enqueued");
log.error({ err, taskId }, "messageTool.send failed");
```
**Apply to:** every production file modified in Phase 44. NEVER `console.*` in core modules (CLAUDE.md §Conventions).
**Reference sites:** `chat-delivery-queue.ts:24`, `openclaw-chat-delivery.ts:23`, `chat-message-sender.ts:29`, `daemon.ts:27`.

### Error-kind tagging for ack-awaitable rejections
**Source:** `src/ipc/chat-delivery-queue.ts:104-107`.

```ts
const err = new Error(msg);
(err as Error & { kind?: string }).kind = result.error?.kind;
waiter.reject(err);
```

**Apply to:** every new throw site that needs to be distinguishable in the notifier's `catch (err)` branch. The consumer at `openclaw-chat-delivery.ts:125-129` extracts `.kind` via duck-typing; preserve that contract.

### Zod descriptor + z.infer type pairing (schema changes)
**Source:** `src/schemas/subscription.ts` end-to-end.

```ts
export const Foo = z.object({
  field: z.string().describe("Human-readable docs surface for this field"),
}).passthrough();
export type Foo = z.infer<typeof Foo>;
```
**Apply to:** `OpenClawChatDelivery` addition. Every field carries `.describe()`. `z.infer` is the type alias. Never define `interface` alongside a Zod schema — Zod is source of truth (CLAUDE.md §Conventions).

### Subscription dedupe via `notifiedStatuses` (the no-double-fire contract)
**Source:** `src/openclaw/openclaw-chat-delivery.ts:62-65` (filter) + `:117` (mark).

```ts
const chatSubs = active.filter(
  (s) => resolveDeliveryKind(s) === OPENCLAW_CHAT_DELIVERY_KIND
    && !s.notifiedStatuses.includes(to),
);
// …
await subscriptionStore.markStatusNotified(task.frontmatter.id, sub.id, toStatus);
```
**Apply to:** any recovery-pass / fallback code path that fires a wake-up. The ledger is the persistent dedupe — don't add an in-memory cache alongside it. `TaskSubscription.notifiedStatuses` (schema line 73) is the source of truth.

### `try/catch → appendAttempt` audit trail
**Source:** `src/openclaw/openclaw-chat-delivery.ts:104-140`.

Every delivery outcome — success OR failure — MUST produce a `subscriptionStore.appendAttempt(...)` call. Mirror the success/failure branches verbatim when adding new delivery code paths (subagent fallback, recovery pass). Never swallow a delivery error without writing an attempt record; the audit trail is load-bearing for diagnostics AND for the retry logic in `callback-delivery.ts:retryPendingDeliveries`.

### Integration-test env gate
**Source:** `tests/integration/daemon-restart-midpoll.test.ts`.

```ts
const SHOULD_RUN = process.env.AOF_INTEGRATION === "1";
// …
describe.skipIf(!SHOULD_RUN)("…", () => { … });
```
**Apply to:** every new file under `tests/integration/`. Never run these in the default unit-test sweep.

### Vitest-mock-logger for notifier unit tests
**Source:** `src/openclaw/__tests__/openclaw-chat-delivery.test.ts:13-15`.

```ts
vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() }),
}));
```
**Apply to:** any new notifier unit test. Integration/E2E tests use real `createLogger`.

### Docstring-on-export convention
**Source:** `src/openclaw/dispatch-notification.ts:1-14`, `src/openclaw/openclaw-chat-delivery.ts:1-12`, `src/ipc/chat-delivery-queue.ts:1-17`.

Every module-level export carries a multi-line JSDoc block explaining the plugin-vs-core boundary, the precedence rules, and the `@module` tag. Phase 44 additions (`OpenClawChatDelivery`, `NoPlatformError`, `replayUnnotifiedTerminals`) MUST follow this pattern — docs generation depends on it.

---

## No Analog Found

No files fall into this bucket. Every Phase 44 file either extends an existing file or has a direct analog in the test-harness ecosystem (`chat-delivery-e2e.test.ts`, `daemon-restart-midpoll.test.ts`, `chat-delivery-queue.test.ts`, `tool-invocation-context.test.ts`).

---

## Metadata

**Analog search scope:**
- `src/openclaw/`
- `src/ipc/`
- `src/dispatch/`
- `src/daemon/`
- `src/schemas/`
- `src/tools/`
- `src/events/`
- `src/store/`
- `tests/integration/`

**Files scanned:** 18 production + 9 test files.

**Files read (non-overlapping ranges):**
- `src/openclaw/dispatch-notification.ts` (full, 52 LOC)
- `src/openclaw/tool-invocation-context.ts` (full, 287 LOC)
- `src/ipc/chat-delivery-queue.ts` (full, 121 LOC)
- `src/openclaw/openclaw-chat-delivery.ts` (full, 204 LOC)
- `src/openclaw/chat-message-sender.ts` (full, 162 LOC)
- `src/events/notifier.ts` (full, 147 LOC — review only; not extended by Phase 44, the "notifier" here is `OpenClawChatDeliveryNotifier`, not `NotificationService`)
- `src/schemas/subscription.ts` (full, 92 LOC)
- `src/tools/project-tools.ts` (240-286, the dispatch subscription block)
- `src/daemon/daemon.ts` (1-90 + 140-220, bootstrap + notifier wiring)
- `src/dispatch/callback-delivery.ts` (80-160, recovery-pattern analog)
- `src/ipc/schemas.ts` (1-80, IPC envelope)
- `src/ipc/__tests__/chat-delivery-queue.test.ts` (full, 125 LOC)
- `src/openclaw/__tests__/tool-invocation-context.test.ts` (1-60)
- `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` (1-100)
- `src/daemon/__tests__/chat-delivery-e2e.test.ts` (1-120)
- `tests/integration/daemon-restart-midpoll.test.ts` (1-30)

**Pattern extraction date:** 2026-04-24

**Load-bearing observations for the planner:**
1. **`src/events/notifier.ts` is NOT the notifier Phase 44 touches.** That file's `NotificationService` is a legacy dedupe router that `startAofDaemon` does NOT register by default (RESEARCH §1 step 3). The Phase-44 notifier is `OpenClawChatDeliveryNotifier` in `src/openclaw/openclaw-chat-delivery.ts`. Don't let the name collision confuse plan authoring.
2. **No new IPC routes.** Phase 44 re-uses `/v1/deliveries/wait` + `/v1/deliveries/{id}/result` unchanged (RESEARCH §7).
3. **The schema field promotion is purely additive** (`passthrough()` stays). 999.4-compatibility comes "for free" if this rule is honored.
4. **The biggest risk is the timeout change in `chat-delivery-queue.ts`** — it interacts with the existing `deliverResult` idempotency contract and with the plugin long-poll's client-side 30s timeout (RESEARCH §1 step 8). The 60s default is deliberate; don't tune it down without understanding why.
