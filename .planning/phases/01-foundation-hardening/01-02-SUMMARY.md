---
phase: 01-foundation-hardening
plan: 02
subsystem: dispatch
tags: [retry, backoff, jitter, deadletter, rate-limit, error-classification, observability]

# Dependency graph
requires:
  - phase: none
    provides: "Existing scheduler-helpers.ts and failure-tracker.ts from initial implementation"
provides:
  - "Three-way error classification (transient/permanent/rate_limited) in classifySpawnError()"
  - "Jittered exponential backoff via computeRetryBackoffMs() with injectable randomness"
  - "Enhanced task.deadlettered event with full failure chain in payload"
  - "task.deadlettered canonical event type (backward compat with task.deadletter)"
affects: [04-self-healing, observability, circuit-breaker]

# Tech tracking
tech-stack:
  added: []
  patterns: [injectable-randomness-for-test-determinism, failure-chain-event-payload]

key-files:
  created: []
  modified:
    - src/dispatch/scheduler-helpers.ts
    - src/dispatch/failure-tracker.ts
    - src/dispatch/__tests__/spawn-failure-recovery.test.ts
    - src/dispatch/__tests__/deadletter.test.ts
    - src/dispatch/__tests__/deadletter-integration.test.ts

key-decisions:
  - "rate_limited classification distinct from transient for observability, but retry behavior identical until Phase 4 circuit breaker (HEAL-03)"
  - "Default jitter factor 25% (+/-) with injectable jitterFn for deterministic tests"
  - "task.deadlettered is canonical event type; task.deadletter kept in schema for backward compat"
  - "Failure chain includes failureHistory sub-object: dispatchFailures, retryCount, lastError, lastBlockedAt, lastDispatchFailureAt"

patterns-established:
  - "Injectable randomness: jitterFn parameter on computeRetryBackoffMs for test determinism"
  - "Failure chain logging: deadletter events carry full diagnostic history for ops debugging"
  - "Three-way error classification: transient/permanent/rate_limited enables future circuit-breaker integration"

requirements-completed: [FOUND-04]

# Metrics
duration: 5min
completed: 2026-02-26
---

# Phase 1 Plan 2: Failure Classification and Dead-Letter Enhancement Summary

**Three-way error classification (transient/permanent/rate_limited) with jittered backoff and full failure chain in task.deadlettered events**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-26T00:36:48Z
- **Completed:** 2026-02-26T00:41:56Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Extended classifySpawnError() to distinguish rate-limit errors (429, throttled, quota exceeded) as "rate_limited" -- separate from generic transient for observability and future circuit-breaker
- Added jitter (+/-25% default) to computeRetryBackoffMs() preventing thundering herd on concurrent retries, with injectable jitterFn for deterministic test assertions
- Enhanced transitionToDeadletter() to emit task.deadlettered event with full failure chain: dispatchFailures, retryCount, lastError, lastBlockedAt, errorClass, agent, and failureHistory sub-object
- Console deadletter alerts now include retryCount and errorClass for faster ops triage

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend error classification with rate-limit patterns and jittered backoff** - `0df1a6e` (feat)
2. **Task 2: Enhance dead-letter events with failure chain and comprehensive tests** - `34f4736` (feat)

## Files Created/Modified
- `src/dispatch/scheduler-helpers.ts` - Added RATE_LIMIT_PATTERNS, extended classifySpawnError() return type to include "rate_limited", replaced computeRetryBackoffMs() with jitter-enhanced version
- `src/dispatch/failure-tracker.ts` - Enhanced transitionToDeadletter() with full failure chain payload and task.deadlettered event type
- `src/dispatch/__tests__/spawn-failure-recovery.test.ts` - Updated rate-limit classification test, added jitter behavior tests, adjusted backdate timings for jitter
- `src/dispatch/__tests__/deadletter.test.ts` - Updated event type assertions, added 4 new tests for failure chain, permanent error classification, console output, and missing metadata graceful handling
- `src/dispatch/__tests__/deadletter-integration.test.ts` - Updated event type assertions from task.deadletter to task.deadlettered

## Decisions Made
- rate_limited is treated identically to transient for retry logic; the classification exists purely for observability and the Phase 4 circuit-breaker (HEAL-03) that will throttle dispatches to rate-limited providers
- Used injectable jitterFn (defaults to Math.random) rather than seeded PRNG -- simpler, sufficient for test determinism
- task.deadlettered chosen as canonical event type per user decision; task.deadletter remains in schema for backward compatibility with existing event queries
- Failure chain uses lastFailureReason parameter as fallback when task metadata.lastError is missing, ensuring graceful degradation

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed existing test expecting "transient" for rate-limit errors**
- **Found during:** Task 1 (error classification)
- **Issue:** Existing test `classifies rate limit as transient` expected "transient" but now returns "rate_limited"
- **Fix:** Updated test to expect "rate_limited" and added comprehensive rate-limit pattern coverage tests
- **Files modified:** src/dispatch/__tests__/spawn-failure-recovery.test.ts
- **Verification:** All tests pass
- **Committed in:** 0df1a6e (Task 1 commit)

**2. [Rule 1 - Bug] Fixed existing backoff tests assuming exact values without jitter**
- **Found during:** Task 1 (jitter implementation)
- **Issue:** Existing computeRetryBackoffMs tests used .toBe(60_000) etc., which fails with jitter
- **Fix:** Updated to use jitterFactor: 0 for base value tests, added separate jitter behavior tests
- **Files modified:** src/dispatch/__tests__/spawn-failure-recovery.test.ts
- **Verification:** All tests pass
- **Committed in:** 0df1a6e (Task 1 commit)

**3. [Rule 1 - Bug] Fixed e2e test backdate timings insufficient with jitter**
- **Found during:** Task 1 (jitter implementation)
- **Issue:** shouldAllowSpawnFailedRequeue test backdated 200s for retryCount=1, but max jitter backoff is 225s
- **Fix:** Increased backdate to 240s (retryCount=1) and 700s (retryCount=2) to exceed maximum jitter
- **Files modified:** src/dispatch/__tests__/spawn-failure-recovery.test.ts
- **Verification:** E2E test passes reliably
- **Committed in:** 0df1a6e (Task 1 commit)

---

**Total deviations:** 3 auto-fixed (3 bugs -- all test adjustments required by jitter introduction)
**Impact on plan:** All auto-fixes necessary for correctness. No scope creep -- tests needed updating to reflect the new jitter behavior.

## Issues Encountered
None -- task.deadlettered was already in the event schema (likely from Plan 01-01 partial work), so no schema modification was needed.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Rate-limit classification ready for Phase 4 circuit-breaker integration (HEAL-03)
- Failure chain logging provides the diagnostic data needed for Phase 4 self-healing recovery decisions
- All 77 dispatch tests pass (48 directly related + 29 scheduler regression tests)

## Self-Check: PASSED

- All 6 files verified present
- Commit 0df1a6e verified (Task 1)
- Commit 34f4736 verified (Task 2)
- TypeScript compiles cleanly (npx tsc --noEmit)
- 77/77 dispatch tests pass

---
*Phase: 01-foundation-hardening*
*Completed: 2026-02-26*
