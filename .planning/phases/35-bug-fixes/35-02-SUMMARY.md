---
phase: 35-bug-fixes
plan: 02
subsystem: dispatch
tags: [race-condition, toctou, lock-manager, scheduler, concurrency]

requires:
  - phase: none
    provides: existing TaskLockManager and ProtocolRouter lock integration
provides:
  - Shared InMemoryTaskLockManager between ProtocolRouter and scheduler
  - Per-task lock serialization for scheduler-initiated mutations
  - lockManager field on SchedulerConfig and DispatchConfig
affects: [dispatch, scheduler, aof-service]

tech-stack:
  added: []
  patterns: [per-task-lock-wrapping-for-scheduler-mutations]

key-files:
  created: []
  modified:
    - src/dispatch/scheduler.ts
    - src/dispatch/task-dispatcher.ts
    - src/dispatch/assign-executor.ts
    - src/dispatch/action-executor.ts
    - src/service/aof-service.ts
    - src/dispatch/__tests__/assign-executor.test.ts

key-decisions:
  - "Wrapped entire executeAssignAction body in withLock rather than individual call sites for cleaner code and complete coverage"
  - "Added lockManager to DispatchConfig (not just SchedulerConfig) since assign-executor uses DispatchConfig type"
  - "Also wrapped expire_lease handler in action-executor for complete scheduler mutation coverage"

patterns-established:
  - "Lock wrapping pattern: extract body to async closure, conditionally wrap with lockManager.withLock"

requirements-completed: [BUG-04]

duration: 6min
completed: 2026-03-12
---

# Phase 35 Plan 02: TOCTOU Race Condition Fix Summary

**Shared InMemoryTaskLockManager serializes scheduler-initiated task mutations through the same per-task locks used by ProtocolRouter**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-12T21:18:56Z
- **Completed:** 2026-03-12T21:25:11Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 6

## Accomplishments
- Shared InMemoryTaskLockManager instance created in AOFService, passed to both ProtocolRouter and schedulerConfig
- All scheduler-initiated task mutations (assign, expire_lease) wrapped in withLock for per-task serialization
- Backward compatible: no lockManager = no locking (existing tests unaffected)
- 3 new tests verify lockManager integration: acquireLease wrapping, spawn failure wrapping, backward compat

## Task Commits

Each task was committed atomically (TDD):

1. **Task 1 RED: Add failing lockManager tests** - `b983618` (test)
2. **Task 1 GREEN: Thread lockManager and wrap mutations** - `e896ec5` (feat)

## Files Created/Modified
- `src/dispatch/scheduler.ts` - Added lockManager field to SchedulerConfig interface
- `src/dispatch/task-dispatcher.ts` - Added lockManager field to DispatchConfig interface
- `src/dispatch/assign-executor.ts` - Wrapped executeAssignAction body in withLock closure
- `src/dispatch/action-executor.ts` - Wrapped expire_lease handler in withLock closure
- `src/service/aof-service.ts` - Creates shared InMemoryTaskLockManager, passes to ProtocolRouter and schedulerConfig
- `src/dispatch/__tests__/assign-executor.test.ts` - 3 new lockManager integration tests

## Decisions Made
- Wrapped entire executeAssignAction body in withLock rather than wrapping individual call sites -- cleaner and provides complete coverage of all mutations within the function
- Added lockManager to both DispatchConfig and SchedulerConfig since assign-executor references DispatchConfig type while action-executor references SchedulerConfig
- Wrapped expire_lease handler too (plan suggested checking it) since it also calls store.transition on specific taskIds

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TypeScript narrowing loss in closure**
- **Found during:** Task 1 GREEN (implementation)
- **Issue:** Moving function body into executeBody closure lost TypeScript's narrowing of `config.executor` from the early return guard
- **Fix:** Captured `config.executor` in a `const executor` before the closure, replaced all references inside
- **Files modified:** src/dispatch/assign-executor.ts
- **Verification:** `npx tsc --noEmit` passes with zero errors
- **Committed in:** e896ec5 (part of GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** TypeScript narrowing fix was mechanical and necessary for correctness. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- BUG-04 TOCTOU race condition mitigated
- All 2925 tests pass, zero regressions
- Ready for next plan in phase 35

---
*Phase: 35-bug-fixes*
*Completed: 2026-03-12*
