---
phase: 25-completion-enforcement
plan: 01
subsystem: dispatch
tags: [enforcement, completion, deadletter, events, dag]

# Dependency graph
requires:
  - phase: 24-budget-gate
    provides: failure-tracker and deadletter infrastructure
provides:
  - "completion.enforcement event type in EventType enum"
  - "Top-level enforcement in onRunComplete callback (assign-executor.ts)"
  - "DAG hop enforcement via onRunComplete callback (dag-transition-handler.ts)"
  - "Enforcement metadata (enforcementReason, enforcementAt) stored on tasks"
  - "3-strike deadletter policy for enforcement failures"
affects: [26-trace-infrastructure, 27-trace-cli]

# Tech tracking
tech-stack:
  added: []
  patterns: ["enforcement-on-exit: block task when agent exits without calling aof_task_complete"]

key-files:
  created:
    - src/dispatch/__tests__/completion-enforcement.test.ts
    - src/dispatch/__tests__/dag-completion-enforcement.test.ts
  modified:
    - src/schemas/event.ts
    - src/dispatch/assign-executor.ts
    - src/dispatch/dag-transition-handler.ts

key-decisions:
  - "Block-only enforcement, no warn mode -- agents that skip aof_task_complete are always blocked"
  - "Enforcement metadata stored directly on task (enforcementReason, enforcementAt) for next retry agent visibility"
  - "Both success and failure branches in onRunComplete are enforcement events -- any agent exit without aof_task_complete is an enforcement action"

patterns-established:
  - "onRunComplete enforcement: every spawnSession call should include onRunComplete to detect agents that exit without completing"
  - "Enforcement metadata on task: enforcementReason and enforcementAt fields store context for retry agents"

requirements-completed: [ENFC-01, ENFC-02, ENFC-03, ENFC-04]

# Metrics
duration: 8min
completed: 2026-03-07
---

# Phase 25 Plan 01: Completion Enforcement Summary

**Hard enforcement for agents that exit without calling aof_task_complete -- tasks blocked and tracked as dispatch failures instead of silently auto-completed, with deadletter after 3 strikes**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-07T19:55:43Z
- **Completed:** 2026-03-07T20:03:20Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Replaced auto-completion fallback with hard enforcement for top-level tasks -- agents that exit without aof_task_complete are blocked, not auto-completed
- Added DAG hop enforcement via onRunComplete callback -- hop agents that exit without completion trigger failure tracking on parent task
- New completion.enforcement event type emitted on every enforcement action with full diagnostic context
- Enforcement metadata (enforcementReason, enforcementAt) stored on task for next retry agent
- 3-strike deadletter policy via existing failure-tracker infrastructure

## Task Commits

Each task was committed atomically:

1. **Task 1: Top-level enforcement (RED)** - `cfbfd07` (test)
2. **Task 1: Top-level enforcement (GREEN)** - `d900b8c` (feat)
3. **Task 2: DAG hop enforcement (RED)** - `63e114d` (test)
4. **Task 2: DAG hop enforcement (GREEN)** - `0c4e90c` (feat)

## Files Created/Modified
- `src/schemas/event.ts` - Added completion.enforcement to EventType enum
- `src/dispatch/assign-executor.ts` - Replaced auto-complete fallback with enforcement logic in onRunComplete
- `src/dispatch/dag-transition-handler.ts` - Added onRunComplete callback with enforcement for DAG hops
- `src/dispatch/__tests__/completion-enforcement.test.ts` - 8 tests for top-level enforcement
- `src/dispatch/__tests__/dag-completion-enforcement.test.ts` - 5 tests for DAG hop enforcement

## Decisions Made
- Block-only enforcement (no warn mode) per user decision -- ENFC-02 configurable warn/block dropped
- Both success and failure branches trigger enforcement -- any exit without aof_task_complete is treated the same
- dispatch.fallback event type retained in schema for backward compatibility but no longer emitted
- Enforcement metadata stored directly in task frontmatter metadata object, not in a separate structure

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed test task ID format**
- **Found during:** Task 1 (RED phase)
- **Issue:** Test task IDs used "TASK-ENF-001" format which doesn't match TaskId regex `TASK-YYYY-MM-DD-NNN`
- **Fix:** Changed all test IDs to `TASK-2026-03-07-1XX` format
- **Files modified:** src/dispatch/__tests__/completion-enforcement.test.ts
- **Verification:** All tests pass with corrected IDs

**2. [Rule 1 - Bug] Fixed DAG test workflow fixture format**
- **Found during:** Task 2 (RED phase)
- **Issue:** DAG test fixture missing required `workflow.definition.name` and `workflow.state.status` fields
- **Fix:** Added `name: test-workflow` and `status: running` to test fixture YAML
- **Files modified:** src/dispatch/__tests__/dag-completion-enforcement.test.ts
- **Verification:** Tasks parse correctly, all tests pass

**3. [Rule 1 - Bug] Fixed HopStatus enum value in test**
- **Found during:** Task 2 (GREEN phase)
- **Issue:** Test used "completed" instead of "complete" for hop status (enum uses "complete")
- **Fix:** Changed to correct enum value "complete"
- **Files modified:** src/dispatch/__tests__/dag-completion-enforcement.test.ts
- **Verification:** No more parse warnings, test passes correctly

---

**Total deviations:** 3 auto-fixed (3 bugs in test fixtures)
**Impact on plan:** All fixes were test setup corrections, no scope change.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- completion.enforcement event is now emitted and available for trace infrastructure (Phase 26)
- Enforcement metadata on tasks provides diagnostic context for `aof trace` CLI (Phase 27)
- dispatch.fallback retained in schema for backward compatibility but not emitted

## Self-Check: PASSED

All 6 files verified present. All 4 task commits verified in git log.

---
*Phase: 25-completion-enforcement*
*Completed: 2026-03-07*
