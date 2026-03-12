---
phase: 35-bug-fixes
plan: 01
subsystem: dispatch, daemon, store
tags: [scheduler, task-stats, daemon-uptime, type-cleanup]

requires:
  - phase: none
    provides: n/a
provides:
  - "buildTaskStats with all 8 status fields including cancelled/deadletter"
  - "Correct daemon uptime reporting from function-scoped startTime"
  - "Clean UpdatePatch and TransitionOpts interfaces without dead blockers field"
affects: [scheduler, daemon, task-mutations]

tech-stack:
  added: []
  patterns: ["exhaustive status counting in buildTaskStats"]

key-files:
  created:
    - "src/dispatch/__tests__/scheduler-helpers.test.ts"
  modified:
    - "src/dispatch/scheduler-helpers.ts"
    - "src/dispatch/scheduler.ts"
    - "src/daemon/daemon.ts"
    - "src/daemon/__tests__/daemon.test.ts"
    - "src/store/task-mutations.ts"
    - "src/service/aof-service.ts"

key-decisions:
  - "Used TDD for buildTaskStats fix to ensure regression coverage before implementation"
  - "Used /status endpoint for daemon uptime regression test since /healthz is liveness-only"

patterns-established:
  - "buildTaskStats accounts for all 8 TaskStatus values exhaustively"

requirements-completed: [BUG-01, BUG-02, BUG-03]

duration: 7min
completed: 2026-03-12
---

# Phase 35 Plan 01: Scheduler Stats, Daemon StartTime, and Dead Code Removal Summary

**Fixed buildTaskStats to count cancelled/deadletter tasks (preventing false alerts), moved daemon startTime into function scope, and removed dead blockers fields from mutation interfaces**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-12T21:18:55Z
- **Completed:** 2026-03-12T21:25:51Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- buildTaskStats now returns all 8 status fields; alert logic correctly excludes cancelled/deadletter from active task count
- Daemon uptime now reflects actual startAofDaemon() call time, not module import time
- Removed dead blockers field from UpdatePatch and TransitionOpts interfaces
- Full regression test suite: 2925 tests passing

## Task Commits

Each task was committed atomically:

1. **Task 1 (TDD RED): Failing test for buildTaskStats** - `ccc8d1f` (test)
2. **Task 1 (TDD GREEN): Fix buildTaskStats and PollResult type** - `a978bd3` (feat)
3. **Task 2: Fix daemon startTime and remove blockers** - `7b3dd43` (fix)

_Note: Task 1 used TDD with separate RED and GREEN commits._

## Files Created/Modified
- `src/dispatch/__tests__/scheduler-helpers.test.ts` - New regression tests for buildTaskStats counting all 8 statuses
- `src/dispatch/scheduler-helpers.ts` - Added cancelled/deadletter fields to buildTaskStats
- `src/dispatch/scheduler.ts` - Updated PollResult.stats type, post-execution recalc, and alert logic
- `src/service/aof-service.ts` - Updated multi-project stats aggregation with cancelled/deadletter
- `src/daemon/daemon.ts` - Moved startTime from module scope to inside startAofDaemon()
- `src/daemon/__tests__/daemon.test.ts` - Added uptime regression test, updated makePollResult type
- `src/store/task-mutations.ts` - Removed blockers from UpdatePatch and TransitionOpts

## Decisions Made
- Used TDD for buildTaskStats fix to ensure regression coverage before implementation
- Used /status endpoint for daemon uptime regression test since /healthz is liveness-only

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated aof-service.ts stats aggregation**
- **Found during:** Task 1 (buildTaskStats fix)
- **Issue:** TypeScript compilation failed because aof-service.ts had a PollResult stats literal missing the new cancelled/deadletter fields
- **Fix:** Added cancelled: 0, deadletter: 0 to the stats initializer and aggregation loop in aof-service.ts
- **Files modified:** src/service/aof-service.ts
- **Verification:** npx tsc --noEmit passes cleanly
- **Committed in:** a978bd3 (Task 1 commit)

**2. [Rule 3 - Blocking] Updated daemon test makePollResult**
- **Found during:** Task 1 (buildTaskStats fix)
- **Issue:** PollResult type change required updating the daemon test's mock poll result to include new fields
- **Fix:** Added cancelled: 0, deadletter: 0 to makePollResult() in daemon.test.ts
- **Files modified:** src/daemon/__tests__/daemon.test.ts
- **Verification:** Daemon tests pass
- **Committed in:** a978bd3 (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both fixes were necessary consequences of the type change. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All three bugs (BUG-01, BUG-02, BUG-03) fixed with regression tests
- Full test suite passes (2925 tests, 0 failures)
- Ready for Phase 35 Plan 02

---
*Phase: 35-bug-fixes*
*Completed: 2026-03-12*
