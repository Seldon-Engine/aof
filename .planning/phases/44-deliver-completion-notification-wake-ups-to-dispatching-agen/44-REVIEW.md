---
phase: 44
status: issues_found
depth: standard
files_reviewed: 14
files_reviewed_list:
  - src/daemon/daemon.ts
  - src/ipc/chat-delivery-queue.ts
  - src/openclaw/chat-message-sender.ts
  - src/openclaw/dispatch-notification.ts
  - src/openclaw/index.ts
  - src/openclaw/openclaw-chat-delivery.ts
  - src/openclaw/subscription-delivery.ts
  - src/openclaw/tool-invocation-context.ts
  - src/daemon/__tests__/notifier-recovery-on-restart.test.ts
  - src/ipc/__tests__/chat-delivery-queue.test.ts
  - src/openclaw/__tests__/dispatch-notification.test.ts
  - src/openclaw/__tests__/openclaw-chat-delivery.test.ts
  - src/openclaw/__tests__/tool-invocation-context.test.ts
  - tests/integration/wake-up-dispatcher.test.ts
findings:
  critical: 0
  warning: 3
  info: 5
  total: 8
reviewed_at: 2026-04-24
---

# Phase 44: Code Review Report

**Reviewed:** 2026-04-24
**Depth:** standard
**Files Reviewed:** 14
**Status:** issues_found

## Summary

Phase 44 delivers completion-notification wake-ups to dispatching-agent sessions by promoting the delivery envelope to a Zod schema, tagging every capture with dispatcher identity, removing the 1h TTL that dropped long-running dispatch routes, adding a 60s bound on the plugin-ACK blocking call, and adding a boot-time replay pass that catches wake-ups lost to a daemon crash between `transition()` and plugin ACK. The overall architecture is sound — the fragile cross-process chain called out in CLAUDE.md is now defensively bounded, the `kind`-tagged error-propagation contract is honored on new throw sites (`NoPlatformError.kind = "no-platform"`, timeout tags `kind = "timeout"`), and the recovery pass is correctly idempotent through the pre-existing `notifiedStatuses` dedupe ledger.

No circular dependencies introduced (verified via `npx madge --circular --extensions ts src/`), no `console.*` usage in core modules, no `process.env` access outside `config/registry`, and the Zod-schema-as-source-of-truth convention is upheld (`OpenClawChatDelivery` replaces a hand-written interface; `z.infer` drives the `OpenClawChatDeliveryType` alias).

Findings below are quality + correctness concerns. The two warnings worth attention before shipping are the race between the recovery IIFE and the live notifier (WR-01) and the fact that the recovery IIFE fires BEFORE `service.start()` but is itself async fire-and-forget, so polling can begin while the replay is still walking projects (WR-02). The third warning (WR-03) is a subtle sessionKey-ambiguity issue in `parseSessionKey` for chatIds containing `:topic:` substrings.

## Warnings

### WR-01: Recovery pass can race with live `handleEvent` — double-fire risk across process restart with in-flight transitions

**File:** `src/daemon/daemon.ts:198-238` (and `src/openclaw/openclaw-chat-delivery.ts:250-321`)
**Issue:** The daemon first registers the live notifier (`logger.addOnEvent((event) => chatNotifier.handleEvent(event))` at line 198) and THEN kicks off the async recovery IIFE (lines 212-238). If the async replay is walking projects while a brand-new `task.transitioned` event fires for a task that is ALSO a candidate for replay, both paths race on the same `notifiedStatuses` ledger. Both `handleEvent` and `replayUnnotifiedTerminals` compute `candidates` from an in-memory `SubscriptionStore.list(...)` snapshot, then each independently calls `deliverOne` → `messageTool.send` → `appendAttempt` + `markStatusNotified`. Read-modify-write on `subscriptions.json` is NOT atomic across these two flows — `markStatusNotified` reads the file, checks `.includes(status)`, writes. If both flows race between the read and the write, both can pass the check and both can call `messageTool.send`, producing a duplicate wake-up.

In practice the window is small (only tasks that finished seconds before crash AND have another transition fire within the ~ms-to-seconds replay walk time), but the contract advertised in the recovery-method docstring — "Safe to call multiple times — each call observes the same `notifiedStatuses` ledger" — only holds for serial invocations, not for concurrent event + replay on the same subscription.

**Fix:** Two clean options:
1. **Register the live listener AFTER the replay finishes.** Move `logger.addOnEvent(...)` inside (or after awaiting) the IIFE. This means a transition that fires while the daemon boots is caught by the replay instead of the live path — acceptable because `replayUnnotifiedTerminals` is a superset of what `handleEvent` does for terminal statuses, and non-terminal transitions (`blocked`, `review`) that arrive during boot are still caught once the live listener attaches (they remain in `notifiedStatuses: []` so the replay would skip them anyway — they're non-terminal).
2. **Optimistic dedupe at the start of `deliverOne`.** Re-read the subscription after `messageTool.send` succeeds but before `appendAttempt`, and short-circuit if `notifiedStatuses` already contains `toStatus`. This is the more surgical fix but weaker — it only dedupes the persistent ledger write, not the actual `messageTool.send` call.

Option 1 is simpler and matches the invariant the docstring already claims.

```typescript
// daemon.ts — move the addOnEvent INSIDE the IIFE:
(async () => {
  try {
    await chatNotifier.replayUnnotifiedTerminals(store);
    const projects = await discoverProjects(opts.dataDir);
    for (const rec of projects) {
      try {
        const { store: projectStore } = await createProjectStore({ ... });
        await chatNotifier.replayUnnotifiedTerminals(projectStore);
      } catch (err) { log.warn({ err, projectId: rec.id }, "..."); }
    }
  } catch (err) { log.warn({ err }, "..."); }
  // Only start listening to new events once recovery has drained.
  logger.addOnEvent((event) => chatNotifier.handleEvent(event));
})().catch((err) => { log.warn({ err }, "wake-up recovery pass IIFE rejection"); });
```

---

### WR-02: Daemon starts polling before recovery replay completes — polling can dispatch on tasks whose wake-up replay has not yet fired

**File:** `src/daemon/daemon.ts:212-238, 301`
**Issue:** The recovery IIFE is fire-and-forget (intentional — T-44-10 mitigation). `service.start()` at line 301 begins the polling loop as soon as health-server wiring finishes — well before the IIFE has walked all projects. For a vault with many projects (each enumeration does an `await createProjectStore` + `store.list` per terminal status), the replay can easily take hundreds of ms to a few seconds. During that window the poller may already be picking up tasks, transitioning them, and — because of WR-01 — the live notifier may collide with the still-running replay on the same subscription.

This is related to but distinct from WR-01: even with WR-01 fixed (serial listener attach), polling still races with the replay on its own axis — a task that was `in-progress` at crash time may get picked up, transitioned to `done`, trigger a live event, AND match the replay's terminal-status scan (which enumerates by status-directory and will see the new `done` after the rename).

**Fix:** The simplest reliable fix is to sequence the IIFE with `service.start()`:

```typescript
// Option A — block start until replay finishes (small startup-latency cost, strongest correctness):
await chatNotifier.replayUnnotifiedTerminals(store);
const projects = await discoverProjects(opts.dataDir);
for (const rec of projects) { ... }
await service.start();

// Option B — keep IIFE fire-and-forget, but gate the live listener attach
// until replay completes (covers WR-01 + WR-02 together). See WR-01 fix.
```

If startup latency is the concern T-44-10 was mitigating, option B costs nothing (poller starts immediately, new transitions simply queue behind the replay-then-listen boundary) and is strictly safer than the current code.

---

### WR-03: `parseSessionKey` can mis-bind `threadId` when a chatId or chatType segment literally contains the token `topic`

**File:** `src/openclaw/chat-message-sender.ts:84-100`
**Issue:** The parser does `parts.indexOf("topic", 5)` to locate the optional `:topic:<topicId>` suffix. This is a linear scan starting at index 5, but it matches ANY part that happens to be literally the 7-character string `"topic"`. Per the docstring shape `agent:<agentId>:<platform>:<chatType>:<chatId>[:topic:<topicId>]`, parts[3] is `chatType`, parts[4] is `chatId`. If a platform in the wild ever produces a chatId like `"topic"` (e.g. Matrix room slugs, custom channel IDs, or agent-synthesized keys), the parser will silently treat the chatId as a threadId anchor. The 5-part minimum check (`parts.length < 5`) does not protect against this.

Low likelihood on today's platform set (Telegram chatIds are numeric, Matrix IDs start with `!`), but this is exactly the kind of silent-wrong-route bug that Phase 44 is trying to eliminate.

**Fix:** Anchor the topic suffix to the exact index where it would appear (index 5), not a free scan:

```typescript
let threadId: string | undefined;
// Suffix is LITERALLY at positions [5]="topic", [6]="<topicId>" when present.
if (parts.length >= 7 && parts[5] === "topic") {
  threadId = parts[6];
}
```

---

## Info

### IN-01: `queueBackedMessageTool.send` in `daemon.ts` should be extracted to a named factory for testability and diff-readability

**File:** `src/daemon/daemon.ts:149-193`
**Issue:** The 45-line inline object literal for `queueBackedMessageTool` lives inside `startAofDaemon`, which means the exact same shape has to be re-inlined in `tests/integration/wake-up-dispatcher.test.ts:162-191` (and will be again the next time another integration test needs it). The two copies have already drifted slightly (the integration test uses `OPENCLAW_CHAT_DELIVERY_KIND` as the `kind` value; the daemon inlines the string `"openclaw-chat"` at line 170). Extract to `src/ipc/queue-backed-message-tool.ts` exporting `createQueueBackedMessageTool(queue)` and reuse from both sites.

**Fix:**
```typescript
// src/ipc/queue-backed-message-tool.ts
export function createQueueBackedMessageTool(queue: ChatDeliveryQueue): MatrixMessageTool {
  return {
    async send(target, message, ctx) { ... };
  };
}
```

---

### IN-02: `replayUnnotifiedTerminals` caches `runResult` per task but `deliverOne` re-reads `store.get(taskId)` via `createSubscriptionStore` — minor redundancy

**File:** `src/openclaw/openclaw-chat-delivery.ts:250-321`
**Issue:** The replay fetches `readRunResult(store, taskId)` once per task (line 292), but the `createSubscriptionStore` wrapper at lines 323-330 resolves each subscription's task directory by calling `store.get(taskId)` again inside every `appendAttempt` / `markStatusNotified` / `update` call. For a task with 3 chat-kind subscriptions, that's 9 extra `store.get` calls during replay (3 methods × 3 subs). On `FilesystemTaskStore` each `get` is a read + YAML parse of the frontmatter — cheap individually, but the N-task × M-sub multiplier adds up on a crashed-daemon with many active subscriptions.

Not a correctness issue; flagging because the replay is specifically advertised as a bounded boot-time cost.

**Fix:** Pass a `taskDirResolver` that closes over the already-known `task.frontmatter.status` instead of round-tripping through `store.get` three times. Out-of-scope for this phase; a lightweight follow-up.

---

### IN-03: Recovery pass telemetry logs `replayed` count without the per-project breakdown

**File:** `src/openclaw/openclaw-chat-delivery.ts:320` + `src/daemon/daemon.ts:212-231`
**Issue:** `wakeLog.info({ replayed }, "wake-up.recovery-pass-complete")` fires once per call, so in a multi-project vault the daemon emits N separate "recovery-pass-complete" events (one per project) without a `projectId` dimension. Operators correlating the lifecycle will see N identical event names with only the count to disambiguate — and no aggregate roll-up. Add a `projectId` field to the telemetry and/or a single roll-up event at the end of the IIFE.

**Fix:**
```typescript
// openclaw-chat-delivery.ts: thread projectId through
async replayUnnotifiedTerminals(store: ITaskStore, projectId?: string): Promise<void> {
  ...
  wakeLog.info({ replayed, projectId }, "wake-up.recovery-pass-complete");
}

// daemon.ts: call with explicit projectId
await chatNotifier.replayUnnotifiedTerminals(store, null /* unscoped root */);
for (const rec of projects) {
  ...
  await chatNotifier.replayUnnotifiedTerminals(projectStore, rec.id);
}
```

---

### IN-04: Integration test doesn't assert `capturedAt` propagates end-to-end

**File:** `tests/integration/wake-up-dispatcher.test.ts:237-240`
**Issue:** The RED-anchor assertions check `dispatcherAgentId` and `pluginId` on the persisted subscription's `delivery`, but not `capturedAt`. Plan 03 + Plan 04 land all three fields as a unit; Phase 999.4 will read `capturedAt` for TTL decisions. A single extra line would lock the contract.

**Fix:**
```typescript
expect((final?.delivery as Record<string, unknown>).pluginId).toBe("openclaw");
expect(typeof (final?.delivery as Record<string, unknown>).capturedAt).toBe("string");
expect((final?.delivery as Record<string, unknown>).capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
```

---

### IN-05: `notifier-recovery-on-restart.test.ts` uses optional-chain-via-cast pattern that would silently pass if the method were removed

**File:** `src/daemon/__tests__/notifier-recovery-on-restart.test.ts:106-108, 145-147, 178-180`
**Issue:** The three test bodies call `(notifier as unknown as { replayUnnotifiedTerminals?: ... }).replayUnnotifiedTerminals?.(store)`. The docstring at line 104-105 explains this was deliberate for the RED state ("today the method doesn't exist, so this is a no-op"), but now that Plan 08 has landed the method and these tests are GREEN, the optional-chain cast is a foot-gun: if a future refactor accidentally renames/removes `replayUnnotifiedTerminals`, the test becomes a silent no-op and the `expect(sendSpy).toHaveBeenCalledTimes(1)` assertion passes vacuously only when the replay also fails to fire (this one fails, but the two `.not.toHaveBeenCalled()` tests below would pass silently). Replace with a direct method call now that the method exists.

**Fix:**
```typescript
// Before:
await (notifier as unknown as { replayUnnotifiedTerminals?: ... })
  .replayUnnotifiedTerminals?.(store);

// After:
await notifier.replayUnnotifiedTerminals(store);
```

Remove the RED-state docstring (lines 104-105, 145-146, 178-179) at the same time.

---

_Reviewed: 2026-04-24_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
