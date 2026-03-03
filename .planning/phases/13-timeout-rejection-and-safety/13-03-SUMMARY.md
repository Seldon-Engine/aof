---
phase: 13-timeout-rejection-and-safety
plan: 03
subsystem: dispatch
tags: [dag, rejection, cascade, circuit-breaker, evaluator, tdd]

requires:
  - phase: 13-timeout-rejection-and-safety
    provides: "HopState.rejectionCount, HopState.escalated, canReject/rejectionStrategy on Hop schema, dag.hop_rejected/dag.hop_rejection_cascade event types"
provides:
  - "Rejection cascade logic in evaluateDAG with origin and predecessors strategies"
  - "Circuit-breaker: fail hop after DEFAULT_MAX_REJECTIONS (3) and skip-cascade downstream"
  - "mapRunResultToHopEvent maps needs_review + canReject to rejected outcome"
  - "handleDAGHopCompletion logs dag.hop_rejected event with rejection details"
  - "DEFAULT_MAX_REJECTIONS constant exported from dispatch barrel"
affects: [14-workflow-templates, 15-migration]

tech-stack:
  added: []
  patterns: ["rejection cascade with two strategies (origin resets all, predecessors resets selective)", "circuit-breaker pattern for infinite rejection loop prevention"]

key-files:
  created: ["src/dispatch/__tests__/dag-rejection.test.ts"]
  modified: ["src/dispatch/dag-evaluator.ts", "src/dispatch/dag-transition-handler.ts", "src/dispatch/__tests__/dag-transition-handler.test.ts", "src/dispatch/index.ts"]

key-decisions:
  - "Rejection path short-circuits normal evaluateDAG pipeline (steps 2-4 replaced by rejection logic)"
  - "Origin strategy creates HopState with only status + rejectionCount (full clear of result/timestamps/agent)"
  - "readyHops after rejection includes root hops already set to ready by reset helpers (not just determineReadyHops output)"

patterns-established:
  - "Rejection cascade: origin resets all hops, predecessors resets only rejected + immediate dependsOn"
  - "Circuit-breaker pattern: rejectionCount >= DEFAULT_MAX_REJECTIONS triggers permanent failure"

requirements-completed: [SAFE-04]

duration: 10min
completed: 2026-03-03
---

# Phase 13 Plan 03: Rejection Cascade and Circuit Breaker Summary

**DAG rejection cascade with origin/predecessors strategies, circuit-breaker after 3 rejections, and needs_review-to-rejected mapping in transition handler**

## Performance

- **Duration:** 10 min
- **Started:** 2026-03-03T15:51:34Z
- **Completed:** 2026-03-03T16:02:23Z
- **Tasks:** 2 (TDD: RED + GREEN/REFACTOR)
- **Files modified:** 5

## Accomplishments
- Implemented rejection cascade in evaluateDAG with two strategies: origin (reset all hops) and predecessors (reset rejected hop + immediate dependsOn only)
- Added circuit-breaker behavior: hop fails permanently after 3 rejections, cascade-skips all downstream hops
- Extended mapRunResultToHopEvent to map needs_review + canReject=true to "rejected" outcome (canReject=false treats as "complete")
- Updated handleDAGHopCompletion to log dag.hop_rejected events with rejection notes, count, and strategy
- 17 new rejection evaluator tests + 2 new transition handler tests, all existing tests pass (61 total)

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Failing tests for rejection cascade and circuit-breaker** - `a1d35e7` (test)
2. **Task 2 (GREEN): Implement rejection cascade, circuit-breaker, and transition handler** - `21ae9ff` (feat)
3. **Task 2 (REFACTOR): Update doc comments and export constant** - `deac448` (refactor)

_Note: TDD plan with RED/GREEN/REFACTOR commits_

## Files Created/Modified
- `src/dispatch/__tests__/dag-rejection.test.ts` - 17 tests covering origin strategy, predecessors strategy, circuit-breaker, and edge cases (new)
- `src/dispatch/dag-evaluator.ts` - Added "rejected" to HopEvent outcome, DEFAULT_MAX_REJECTIONS constant, resetAllHopsForOrigin/resetPredecessorHops helpers, rejection path in evaluateDAG
- `src/dispatch/dag-transition-handler.ts` - Updated mapRunResultToHopEvent with hop definition parameter for canReject check, rejection event logging in handleDAGHopCompletion
- `src/dispatch/__tests__/dag-transition-handler.test.ts` - 2 new tests for needs_review mapping with/without canReject
- `src/dispatch/index.ts` - Export DEFAULT_MAX_REJECTIONS from barrel

## Decisions Made
- Rejection path short-circuits normal evaluateDAG pipeline: when outcome is "rejected", steps 2-4 (cascade skips, condition evaluation, readiness determination) are replaced by rejection-specific logic
- Origin strategy creates minimal HopState (only status + rejectionCount on rejected hop) to ensure complete cleanup of result/timestamps/agent/correlationId
- readyHops includes hops already set to "ready" by reset helpers (root hops), not just those found by determineReadyHops (which only considers pending-to-ready transitions)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All Phase 13 plans complete (01: schema safety, 02: timeout runtime, 03: rejection runtime)
- Rejection cascade integrates seamlessly with existing evaluateDAG pipeline and skip cascading
- Circuit-breaker reuses existing cascadeSkips for downstream propagation
- Phase 14 (workflow templates) and Phase 15 (migration) can proceed

## Self-Check: PASSED

All files verified present. All commit hashes verified in git log.

---
*Phase: 13-timeout-rejection-and-safety*
*Completed: 2026-03-03*
