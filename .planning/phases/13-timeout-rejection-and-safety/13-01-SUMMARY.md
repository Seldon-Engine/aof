---
phase: 13-timeout-rejection-and-safety
plan: 01
subsystem: schemas
tags: [zod, dag, validation, safety, event-types, duration-parser]

requires:
  - phase: 10-dag-schema
    provides: "ConditionExpr, HopState, validateDAG, WorkflowDefinition schemas"
  - phase: 12-scheduler-integration
    provides: "DAG event types in EventType enum"
provides:
  - "HopState with rejectionCount and escalated fields for timeout/rejection runtime"
  - "measureConditionComplexity and collectHopReferences validation functions"
  - "MAX_CONDITION_DEPTH=5, MAX_CONDITION_NODES=50 safety constants"
  - "4 new DAG safety event types (hop_timeout, hop_timeout_escalation, hop_rejected, hop_rejection_cascade)"
  - "parseDuration 'd' (days) unit support"
  - "dag.hop_timeout_escalation in ALWAYS_CRITICAL_EVENTS"
affects: [13-timeout-runtime, 13-rejection-runtime, 14-workflow-templates]

tech-stack:
  added: []
  patterns: ["condition tree walker for recursive depth/node measurement", "hop reference extraction from field paths and operators"]

key-files:
  created: ["src/dispatch/__tests__/duration-parser.test.ts"]
  modified: ["src/schemas/workflow-dag.ts", "src/schemas/event.ts", "src/dispatch/duration-parser.ts", "src/events/notification-policy/severity.ts", "src/schemas/index.ts", "src/schemas/__tests__/workflow-dag.test.ts", "src/events/__tests__/notification-policy.test.ts", "src/dispatch/__tests__/gate-timeout.test.ts"]

key-decisions:
  - "z.number().int().nonnegative() for rejectionCount (nonneg() is not valid Zod API)"
  - "measureConditionComplexity counts logical nodes (and/or/not) as nodes in totalNodes (6 for and(or(leaf,leaf),leaf,leaf), not 5 as originally estimated)"
  - "collectHopReferences uses regex /^hops\\.([^.]+)/ for field path extraction"

patterns-established:
  - "Condition tree walker pattern: recursive switch on op type with and/or/not branching"
  - "Hop reference extraction from both operator fields and dot-path field names"

requirements-completed: [SAFE-01]

duration: 7min
completed: 2026-03-03
---

# Phase 13 Plan 01: Schema Safety Extensions Summary

**HopState extended with rejectionCount/escalated, condition depth/reference validation in validateDAG, parseDuration days support, and 4 new DAG safety event types**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-03T15:40:06Z
- **Completed:** 2026-03-03T15:47:25Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- Extended HopState schema with `rejectionCount` (non-negative integer) and `escalated` (boolean) for timeout/rejection runtime support
- Added `measureConditionComplexity()` and `collectHopReferences()` functions with validateDAG integration (depth<=5, nodes<=50, valid hop refs)
- Extended parseDuration with "d" (days) unit alongside existing "m" and "h"
- Added 4 DAG safety event types and `dag.hop_timeout_escalation` to ALWAYS_CRITICAL_EVENTS
- Exported all new functions, types, and constants from barrel

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend HopState, event types, duration parser, severity** - `a1f92ee` (test) + `dab172b` (feat)
2. **Task 2: Condition complexity and hop reference validation** - `1856dae` (test) + `ddb126c` (feat)

_Note: TDD tasks have two commits each (test -> feat)_

## Files Created/Modified
- `src/schemas/workflow-dag.ts` - HopState extended, measureConditionComplexity, collectHopReferences, MAX_CONDITION_DEPTH/NODES, validateDAG condition checks
- `src/schemas/event.ts` - 4 new DAG safety event types added to EventType enum
- `src/dispatch/duration-parser.ts` - parseDuration supports "d" (days) unit
- `src/events/notification-policy/severity.ts` - dag.hop_timeout_escalation in ALWAYS_CRITICAL_EVENTS
- `src/schemas/index.ts` - Barrel exports for new functions, constants, and ConditionExprType
- `src/schemas/__tests__/workflow-dag.test.ts` - Tests for HopState extensions, EventType, measureConditionComplexity, collectHopReferences, validateDAG condition validation
- `src/dispatch/__tests__/duration-parser.test.ts` - Dedicated test file for parseDuration (new)
- `src/events/__tests__/notification-policy.test.ts` - dag.hop_timeout_escalation in ALWAYS_CRITICAL_EVENTS assertion
- `src/dispatch/__tests__/gate-timeout.test.ts` - Updated expectation for now-valid "1d" format

## Decisions Made
- Used `z.number().int().nonnegative()` (not `.nonneg()`) for rejectionCount Zod validation
- measureConditionComplexity counts all nodes including logical operators: `and(or(leaf,leaf),leaf,leaf)` = 6 nodes (corrected from plan's estimate of 5)
- collectHopReferences uses regex `^hops\.([^.]+)` to extract hop IDs from dot-path field names

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed gate-timeout test expecting "1d" to be invalid**
- **Found during:** Task 1 verification (full test suite)
- **Issue:** Existing gate-timeout.test.ts expected `parseDuration("1d")` to return `null`, but "d" is now a valid unit
- **Fix:** Updated test expectation to `expect(parseDuration("1d")).toBe(86400000)`
- **Files modified:** src/dispatch/__tests__/gate-timeout.test.ts
- **Verification:** Full test suite passes (2690 tests)
- **Committed in:** ddb126c (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix)
**Impact on plan:** Necessary correction to pre-existing test that conflicted with the new "d" unit support. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Schema extensions complete: Plans 02 (timeout) and 03 (rejection) can proceed in parallel
- HopState.rejectionCount and HopState.escalated are backward-compatible (both optional)
- All condition safety validation integrated into validateDAG
- No blockers for next plans

## Self-Check: PASSED

All 10 files verified present. All 4 commit hashes verified in git log.

---
*Phase: 13-timeout-rejection-and-safety*
*Completed: 2026-03-03*
