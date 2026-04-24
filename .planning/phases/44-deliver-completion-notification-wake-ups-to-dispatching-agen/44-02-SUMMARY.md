---
phase: 44
plan: 02
subsystem: openclaw/chat-delivery
tags: [phase-44, wake-up, tests-red, e2e, recovery, agent-callback-fallback, observability]
requirements: [D-44-GOAL, D-44-AUTOREGISTER, D-44-RECOVERY, D-44-AGENT-CALLBACK-FALLBACK, D-44-OBSERVABILITY, D-44-PRIMITIVE]
dependency_graph:
  requires:
    - src/openclaw/openclaw-chat-delivery.ts (OpenClawChatDeliveryNotifier, OPENCLAW_CHAT_DELIVERY_KIND)
    - src/openclaw/dispatch-notification.ts (mergeDispatchNotificationRecipient)
    - src/openclaw/tool-invocation-context.ts (OpenClawToolInvocationContextStore)
    - src/openclaw/chat-message-sender.ts (parseSessionKey)
    - src/store/task-store.ts (FilesystemTaskStore.create/transition)
    - src/store/subscription-store.ts (SubscriptionStore ctor + get/list/create/markStatusNotified)
    - src/ipc/chat-delivery-queue.ts (ChatDeliveryQueue)
    - src/ipc/server-attach.ts (attachIpcRoutes)
    - src/openclaw/daemon-ipc-client.ts (DaemonIpcClient)
    - src/events/logger.ts (EventLogger.addOnEvent + logTransition)
  provides:
    - tests/integration/wake-up-dispatcher.test.ts — RED E2E anchor for dispatcher wake-up
    - src/openclaw/__tests__/openclaw-chat-delivery.test.ts — +1 RED test for subagent fallback
    - src/daemon/__tests__/notifier-recovery-on-restart.test.ts — RED anchor for recovery pass
  affects:
    - Plans 03, 04, 06, 07, 08 (each plan's GREEN criterion is "flips the relevant RED test from FAIL → PASS")
tech_stack:
  added: []
  patterns:
    - chat-delivery-e2e harness (tmpdir + FilesystemTaskStore + real ChatDeliveryQueue + real Unix-socket HTTP server)
    - integration-test env gate (`AOF_INTEGRATION=1` + `describe.skipIf(!SHOULD_RUN)`)
    - vitest createLogger mock pattern (ported from src/openclaw/__tests__/openclaw-chat-delivery.test.ts:13-15)
    - optional-chain probe for unimplemented methods (`notifier.replayUnnotifiedTerminals?.(store)` — no-op today, real call after Plan 08)
key_files:
  created:
    - tests/integration/wake-up-dispatcher.test.ts
    - src/daemon/__tests__/notifier-recovery-on-restart.test.ts
  modified:
    - src/openclaw/__tests__/openclaw-chat-delivery.test.ts (appended one new describe block, 8 pre-existing tests unchanged)
decisions:
  - "Task 1 uses the chat-delivery-e2e ordering idiom (walk transitions to `done` BEFORE creating the subscription; fire a single synthetic `logger.logTransition(review, done)` to trigger the notifier) — avoids subscription-file renames racing the atomic write-file-atomic tmpfile."
  - "Task 2 uses the existing fixture pattern with a real FilesystemTaskStore + SubscriptionStore, NOT the plan's proposed in-memory mocks. Real stores exercise the same persistence path Plan 06/07 will modify, giving us a more durable anchor."
  - "Task 3 tests 2 + 3 PASS vacuously today (optional-chain no-op). Both stay GREEN under the real Plan 08 implementation; only Test 1 flips RED → GREEN. That is correct per the plan's acceptance_criteria."
metrics:
  duration_minutes: 8
  tasks_completed: 3
  files_created: 2
  files_modified: 1
  completed_date: "2026-04-24"
---

# Phase 44 Plan 02: Integration + unit RED tests for dispatcher wake-ups Summary

Three RED tests now lock the cross-file behavioral contracts for Phase 44 Waves 2–3. Paired with Plan 01's unit RED tests, these four test files form the complete Phase 44 acceptance surface: flipping all four from RED to GREEN is the phase-gate.

## One-liner

Three RED tests (one integration E2E gated on `AOF_INTEGRATION=1`, one appended subagent-fallback unit test, one new daemon-level recovery-pass test) encode the Phase 44 dispatcher-wake-up contract that Plans 03–08 will satisfy.

## Exact failing test names

| # | Test file | Test name | Failure anchor | Plan that flips it GREEN |
|---|---|---|---|---|
| 1 | `tests/integration/wake-up-dispatcher.test.ts` | `"Phase 44 — dispatcher wake-up end-to-end (D-44-GOAL, D-44-AUTOREGISTER) > RED: dispatcher wake-up reaches captured Telegram-shaped route end-to-end (dispatcherAgentId=main, pluginId=openclaw, to=42)"` | `expect((final?.delivery as Record<string, unknown>).dispatcherAgentId).toBe("main")` → received `undefined` | Plan 03 (SubscriptionDelivery schema promotion) + Plan 04 (mergeDispatchNotificationRecipient capture enrichment). The E2E transport (Plan 07) must keep passing too. |
| 2 | `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` | `"OpenClawChatDeliveryNotifier — Phase 44 subagent fallback > records agent-callback-fallback attempt when delivery sessionKey is a subagent (4-part) key"` | `expect(lastAttempt.error?.kind).toBe("agent-callback-fallback")` → received `"no-platform"` | Plan 06 (notifier's `catch (err)` branch intercepts `kind: "no-platform"`, promotes to agent-callback fallback with `error.kind: "agent-callback-fallback"`, does not flip subscription to delivered). |
| 3 | `src/daemon/__tests__/notifier-recovery-on-restart.test.ts` | `"OpenClawChatDeliveryNotifier.replayUnnotifiedTerminals — Phase 44 D-44-RECOVERY > replays wake-up when task is terminal and subscription was not yet notified"` | `expect(sendSpy).toHaveBeenCalledTimes(1)` → received `0` (method is undefined, optional-chain no-op) | Plan 08 (`OpenClawChatDeliveryNotifier.replayUnnotifiedTerminals` implementation + `daemon.ts` bootstrap wiring per 44-PATTERNS.md §daemon.ts). |

The two PASS-by-no-op tests in the recovery file (tests 2 + 3) will continue to PASS under the real Plan 08 implementation — they encode the MUST-NOT-fire negative cases (already notified ledger entry, non-terminal task) that the real recovery pass must honor.

## Evidence — vitest exit codes

```
# Task 1 (integration, RED):
$ AOF_INTEGRATION=1 npx vitest run tests/integration/wake-up-dispatcher.test.ts --config tests/integration/vitest.config.ts
→ Test Files  1 failed (1)
→       Tests  1 failed (1)
→ EXIT: 1

# Task 1 skip-gate (no env var):
$ npx vitest run tests/integration/wake-up-dispatcher.test.ts --config tests/integration/vitest.config.ts
→ Test Files  1 skipped (1)
→       Tests  1 skipped (1)
→ EXIT: 0

# Task 2 (unit, 8 existing GREEN + 1 new RED):
$ npx vitest run src/openclaw/__tests__/openclaw-chat-delivery.test.ts
→ Test Files  1 failed (1)
→       Tests  1 failed | 8 passed (9)
→ EXIT: 1

# Task 3 (unit, 1 RED + 2 PASS-by-no-op):
$ npx vitest run src/daemon/__tests__/notifier-recovery-on-restart.test.ts
→ Test Files  1 failed (1)
→       Tests  1 failed | 2 passed (3)
→ EXIT: 1

# Combined unit verification (per plan's <verification> block):
$ npx vitest run src/openclaw/__tests__/openclaw-chat-delivery.test.ts \
                 src/daemon/__tests__/notifier-recovery-on-restart.test.ts
→ Test Files  2 failed (2)
→       Tests  2 failed | 10 passed (12)
→ EXIT: 1

# Typecheck (all tasks):
$ npm run typecheck
→ EXIT: 0
```

## Contracts each test encodes

### Task 1 — End-to-end dispatcher wake-up (tests/integration/wake-up-dispatcher.test.ts)

**Contract:** A captured `aof_dispatch` route carrying `sessionKey="agent:main:telegram:group:42"`, `agentId="main"`, `replyTarget="42"`, `channel="telegram"` flows through `mergeDispatchNotificationRecipient` into a subscription whose `delivery` payload carries the full wake-up identity: `sessionKey` + `dispatcherAgentId` + `pluginId`. On `done` transition, the notifier → queue → long-poll → plugin-side send pipeline calls `mockSendText({ to: "42", text: <contains task-id> })` exactly once, then the subscription persists to `status: "delivered"` with `notifiedStatuses: [..., "done"]` and `attempts[].success === true`.

**RED anchor today:** `dispatcherAgentId` and `pluginId` are not populated by `mergeDispatchNotificationRecipient` — Plan 03 lands the schema shape, Plan 04 lands the capture-enrichment call-site change.

**Turns GREEN at:** Plan 04 (capture enrichment) combined with Plan 03 (schema). Plans 07–08 must not regress it.

### Task 2 — Subagent sessionKey fallback (src/openclaw/__tests__/openclaw-chat-delivery.test.ts)

**Contract:** When a subscription's delivery sessionKey is a 4-part `agent:main:subagent:sid-42` — which `parseSessionKey` in `chat-message-sender.ts:64-80` cannot parse (5-part floor is load-bearing per 44-PATTERNS.md §chat-message-sender.ts) — the resulting `messageTool.send` rejection tagged `kind: "no-platform"` MUST be intercepted by the notifier's `catch` branch. The interception writes an `appendAttempt({success: false, error: {kind: "agent-callback-fallback", message: ...}})` entry AND leaves the subscription `status: "active"` (not `"delivered"`) because the real delivery routes through a follow-up agent-callback attempt rather than succeeding immediately.

**RED anchor today:** The current catch branch at `openclaw-chat-delivery.ts:125-138` propagates `err.kind` verbatim → `error.kind: "no-platform"`, not `"agent-callback-fallback"`.

**Turns GREEN at:** Plan 06 (typed `NoPlatformError` in chat-message-sender.ts) + Plan 07 (notifier catch-branch promotion).

### Task 3 — Notifier-startup recovery replay (src/daemon/__tests__/notifier-recovery-on-restart.test.ts)

**Contract:** `OpenClawChatDeliveryNotifier.replayUnnotifiedTerminals(store)` iterates terminal tasks, filters for active `OPENCLAW_CHAT_DELIVERY_KIND` subscriptions whose `notifiedStatuses` does NOT yet contain the task's current terminal status, and fires `messageTool.send` exactly once per such (task, subscription) pair. The persistent dedupe ledger (`notifiedStatuses`, schema line 73) is the source of truth — no in-memory cache. Terminal is `{done, cancelled, deadletter}` per `openclaw-chat-delivery.ts:28`.

**RED anchor today:** The method is undefined. My test's optional-chain probe `notifier.replayUnnotifiedTerminals?.(store)` no-ops, so `sendSpy` is called 0 times vs. expected 1.

**Turns GREEN at:** Plan 08 (`replayUnnotifiedTerminals` implementation mirroring `retryPendingDeliveries` at `src/dispatch/callback-delivery.ts:87-132`, plus bootstrap wire-up in `daemon.ts` per 44-PATTERNS.md).

## Commits

| Task | Hash | Subject |
|---|---|---|
| 1 | `8720547` | test(44-02): add RED integration test for dispatcher wake-up E2E |
| 2 | `9396dd6` | test(44-02): add RED test for subagent-sessionKey agent-callback-fallback |
| 3 | `8cc9dfb` | test(44-02): add RED test for notifier-startup recovery pass |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 – Bug] Task 1 initial transition chain was invalid**

- **Found during:** Task 1 first test run
- **Issue:** My first draft used `ready → in-progress → done`, which fails `isValidTransition`. The `done` status requires `review` in between per the task schema (same constraint the e2e reference test at `chat-delivery-e2e.test.ts:132-135` walks through).
- **Fix:** Inserted the `in-progress → review → done` hop. Then restructured further (see below).
- **Files modified:** tests/integration/wake-up-dispatcher.test.ts (same commit as task)

**2. [Rule 1 – Bug] Task 1 subscription-file race under transition-and-log interleaving**

- **Found during:** Task 1 second run (after fix #1)
- **Issue:** Creating the subscription at `ready/` and then driving transitions fires the EventLogger callback for each logTransition, and the notifier's internal `createSubscriptionStore` write races against `task.transition`'s directory rename. `write-file-atomic` tmpfile lands in the OLD directory just after rename → `ENOENT`.
- **Fix:** Adopted the chat-delivery-e2e.test.ts ordering: walk the full transition chain via `store.transition` FIRST (no logger calls), THEN create the subscription in the final (terminal) task dir, THEN fire a single synthetic `logger.logTransition("review", "done", ...)` to trigger the notifier. Matches the canonical analog harness pattern called out in 44-PATTERNS.md.
- **Files modified:** tests/integration/wake-up-dispatcher.test.ts (same commit as task)

**3. [Rule 2 – Missing critical functionality] Task 1 plugin-loop sendText parameter**

- **Found during:** Task 1 draft
- **Issue:** The plan's inline test body says `expect(mockSendText.mock.calls[0][0].to).toBe("42")`, but the plan did NOT specify how `mockSendText` gets invoked. My draft had a real `sendChatDelivery` path requiring a stub `OpenClawApi`, adding unnecessary surface.
- **Fix:** Built an inline plugin-loop that parses the Telegram-shaped sessionKey (splits on `:`, reads index 4) and calls `mockSendText({to: chatId, text: req.message})` directly. Same effect, fewer moving parts, still exercises the full IPC long-poll round-trip.
- **Files modified:** tests/integration/wake-up-dispatcher.test.ts

### Deferred items

None — all behavior is test-only; no production code touched.

## Known Stubs

None. All three test files exercise real or documented Phase-44-will-add APIs; stubs flagged explicitly in-line (Task 3's optional-chain probe is the only "method does not exist yet" call and is documented inline as the deliberate RED anchor).

## Threat Flags

None. All changes are test-only in tests/integration/ and src/*/__tests__/ — no new network endpoints, auth paths, file access, or schema changes.

## Verification checklist

- [x] All 3 tasks executed
- [x] Each task committed individually — commits 8720547, 9396dd6, 8cc9dfb
- [x] No modifications to STATE.md or ROADMAP.md
- [x] Integration test (Task 1) correctly gated on `AOF_INTEGRATION=1` via `describe.skipIf(!SHOULD_RUN)`
- [x] RED tests run and produce expected failures (exit 1 + cited assertion messages above)
- [x] `npx vitest run src/openclaw/__tests__/openclaw-chat-delivery.test.ts src/daemon/__tests__/notifier-recovery-on-restart.test.ts` → EXIT 1
- [x] `AOF_INTEGRATION=1 npx vitest run tests/integration/wake-up-dispatcher.test.ts --config tests/integration/vitest.config.ts` → EXIT 1
- [x] `npm run typecheck` → EXIT 0
- [x] `git status` clean — no dangling production source changes

## Self-Check: PASSED

All claimed artifacts verified on disk and in git:

- `tests/integration/wake-up-dispatcher.test.ts` → FOUND
- `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` → FOUND (9 `it(` blocks, includes 'agent-callback-fallback' + 'agent:main:subagent:sid-42')
- `src/daemon/__tests__/notifier-recovery-on-restart.test.ts` → FOUND (3 `it(` blocks, 8 `replayUnnotifiedTerminals` mentions)
- Commit 8720547 → FOUND in git log
- Commit 9396dd6 → FOUND in git log
- Commit 8cc9dfb → FOUND in git log
