---
phase: 44
plan: 05
subsystem: ipc / chat-delivery-queue
tags: [phase-44, wake-up, timeout, hardening, chat-delivery-queue, D-44-TIMEOUT]
requirements: [D-44-TIMEOUT]
dependency_graph:
  requires:
    - "Phase 44 Plan 01 (Task 2 RED tests for timeout behavior)"
  provides:
    - "ChatDeliveryQueue.enqueueAndAwait with bounded 60s default timeout"
    - "kind='timeout' error tagging on the rejection path"
  affects:
    - "src/daemon/daemon.ts queueBackedMessageTool (lines 147-191) — default call path picks up timeout automatically"
    - "src/openclaw/openclaw-chat-delivery.ts catch branch — existing duck-typed `.kind` extraction now surfaces timeout attempts in the subscription audit trail"
tech_stack:
  added: []
  patterns:
    - "Existing `(err as Error & { kind?: string }).kind = \"...\"` duck-type tagging convention (chat-delivery-queue.ts:106) extended to the timeout path"
    - "`Number.isFinite(timeoutMs) && timeoutMs > 0` opt-out gate — parity with sibling `src/ipc/spawn-queue.ts` timeout pattern"
key_files:
  created: []
  modified:
    - "src/ipc/chat-delivery-queue.ts"
decisions:
  - "Infinity and 0 both opt out of the timer (no-timer semantic). Tests that want `no timeout happens` assertions can pass `{ timeoutMs: Infinity }` without racing real time."
  - "DEFAULT_TIMEOUT_MS stays a module-level const rather than a constructor option — YAGNI avoidance, matches how `tool-invocation-context.ts` ships `DEFAULT_ROUTE_TTL_MS` at module scope."
  - "`deliverResult` was NOT modified. Its existing `if (!waiter) return` idempotency guard makes a late plugin POST after timeout a safe no-op — adding branch logic there would've been a regression risk for zero benefit."
metrics:
  duration: "~5 min"
  completed: "2026-04-24"
---

# Phase 44 Plan 05: ChatDeliveryQueue 60s default ack timeout — Summary

Added a bounded-timeout contract to `ChatDeliveryQueue.enqueueAndAwait` so the EventLogger callback chain can no longer stall indefinitely on a broken or slow plugin. Mitigates CLAUDE.md's "chain blocks on plugin ACK" fragility warning.

## What landed

- **`DEFAULT_TIMEOUT_MS = 60_000`** declared at module scope with a JSDoc block citing CLAUDE.md's fragility warning and D-44-TIMEOUT as motivation.
- **`enqueueAndAwait` signature**: `(partial, opts?: { timeoutMs?: number }) → { id, done }`. When `opts.timeoutMs` is undefined the default applies; `Infinity` or `0` disables the timer.
- **Timeout firing path**: on elapse, evict `id` from `this.waiters`, `this.pending`, and `this.claimed`; construct `Error("chat delivery timed out after ${timeoutMs}ms")`; duck-tag `.kind = "timeout"`; reject the `done` promise.
- **Timer cleanup**: both the wrapped `resolve` and `reject` paths invoked by the unchanged `deliverResult` method `clearTimeout(timer)` before forwarding — no dangling `setTimeout` handles on the happy path or plugin-reported failure path.
- **`log.debug` payload** now includes `timeoutMs` for observability.

## Waiter-type widening

**Not needed.** The existing `Waiter` interface at the top of the file already typed `reject: (err: Error) => void`, so the wrapper `reject: (e: Error) => { ... reject(e) }` typechecks cleanly. The plan's task 8 contingency did not fire.

## `npm test` regression check — 60s boundaries

**No test in the suite needed to opt out via `{ timeoutMs: Infinity }`.** The only integration scenario that exercises the default path is `src/daemon/__tests__/chat-delivery-e2e.test.ts`, which completes in ~1s — well inside the 60s window. All 2 tests in that file remain GREEN.

The 19 `npm test` failures that remain are **all pre-existing red tests unrelated to this plan**, verified by stashing my change and re-running on the base commit:
- **17 failures** in `src/commands/__tests__/memory-cli.test.ts` + `src/commands/__tests__/org-drift-cli.test.ts` — CLI suites, fail identically on the base commit `b96e3b3`. Unrelated to D-44-TIMEOUT.
- **1 failure** in `src/daemon/__tests__/notifier-recovery-on-restart.test.ts` — Phase 44 D-44-RECOVERY RED test from a different plan.
- **1 failure** in `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` (subagent fallback) — Phase 44 D-44-FALLBACK RED test from a different plan.

Zero new regressions. Zero tests needed to raise their timeout.

## `deliverResult` confirmation

**`deliverResult` was NOT modified.** The existing `if (!waiter) return;` guard at lines 95-98 covers the late-ACK-after-timeout path, because the timer firing deletes `id` from `this.waiters` before rejecting. Plan 01 Task 2's idempotency RED test ("deliverResult after timeout fires is idempotent no-op") passes against the unchanged method body.

## Acceptance criteria

| Criterion | Status |
|-----------|--------|
| `npx vitest run src/ipc/__tests__/chat-delivery-queue.test.ts` ≥10 passing | GREEN — 11/11 |
| `grep -q 'DEFAULT_TIMEOUT_MS = 60_000' src/ipc/chat-delivery-queue.ts` | GREEN |
| `grep -q 'kind = "timeout"' src/ipc/chat-delivery-queue.ts` | GREEN |
| `grep -q 'clearTimeout' src/ipc/chat-delivery-queue.ts` | GREEN |
| `grep -q 'Number.isFinite' src/ipc/chat-delivery-queue.ts` | GREEN |
| `deliverResult` unchanged (still calls `waiter.resolve` + `waiter.reject`) | GREEN |
| Plan 01 Task 2 timeout RED tests GREEN | 3/3 |
| 7 pre-existing queue tests still GREEN | 8/8 (one was split on the way in) |
| `npx vitest run src/daemon/__tests__/chat-delivery-e2e.test.ts` | GREEN — 2/2 |
| `npm run typecheck` | GREEN (exit 0) |
| `npm test` introduces no new failures | GREEN (19 failures are all pre-existing or from other Phase-44 plans) |
| Exactly one file changed | `src/ipc/chat-delivery-queue.ts` (1 file, +49/−4) |

## Deviations from Plan

None — plan executed exactly as written. The `Waiter` reject-type was already `(err: Error) => void`, so the contingent "widen if needed" action in step 8 didn't need to fire. No test needed to opt out of the 60s default.

## Commit

- `f4abaa4` — `feat(44-05): bound chat-delivery queue with 60s default ack timeout`

## Self-Check: PASSED

- `src/ipc/chat-delivery-queue.ts` — FOUND (modified, committed)
- Commit `f4abaa4` — FOUND in `git log`
- SUMMARY.md — about to be committed in the final metadata commit
