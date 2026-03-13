---
phase: 39-architecture-fixes
plan: 03
subsystem: store
tags: [store-abstraction, encapsulation, write-file-atomic, serialize-task]

requires:
  - phase: 39-architecture-fixes (plan 01)
    provides: "Barrel re-exports and circular dependency fixes"
  - phase: 39-architecture-fixes (plan 02)
    provides: "TaskStoreHooks moved to interfaces.ts, module layering fixes"
provides:
  - "ITaskStore.save() and saveToPath() methods for centralized task persistence"
  - "All dispatch/protocol/service modules route through store abstraction"
  - "serializeTask removed from store barrel exports"
affects: [store, dispatch, protocol, service]

tech-stack:
  added: []
  patterns:
    - "Store encapsulation: all task persistence goes through ITaskStore.save()"
    - "saveToPath for non-canonical writes (session copies, metadata files)"

key-files:
  created: []
  modified:
    - src/store/interfaces.ts
    - src/store/task-store.ts
    - src/store/index.ts
    - src/dispatch/assign-executor.ts
    - src/dispatch/assign-helpers.ts
    - src/dispatch/lifecycle-handlers.ts
    - src/dispatch/failure-tracker.ts
    - src/dispatch/dag-transition-handler.ts
    - src/dispatch/escalation.ts
    - src/dispatch/scheduler.ts
    - src/protocol/router.ts
    - src/service/aof-service.ts
    - src/permissions/task-permissions.ts

key-decisions:
  - "save() computes canonical path from task.path or status directory -- callers no longer compute paths"
  - "persistWorkflowState in dag-transition-handler now receives store as parameter instead of calling writeFileAtomic directly"
  - "PermissionAwareTaskStore delegates save/saveToPath directly without permission checks (internal persistence ops)"

patterns-established:
  - "ITaskStore.save(task): canonical persistence through the store abstraction"
  - "ITaskStore.saveToPath(task, path): explicit-path persistence for non-standard locations"

requirements-completed: [ARCH-02]

duration: 10min
completed: 2026-03-13
---

# Phase 39 Plan 03: Store Abstraction Enforcement Summary

**Routed all 14 serializeTask+writeFileAtomic bypass sites through ITaskStore.save()/saveToPath(), then restricted barrel exports**

## Performance

- **Duration:** 10 min
- **Started:** 2026-03-13T21:05:36Z
- **Completed:** 2026-03-13T21:16:31Z
- **Tasks:** 2
- **Files modified:** 15

## Accomplishments
- Added save() and saveToPath() methods to ITaskStore interface and FilesystemTaskStore implementation
- Migrated all 14 bypass sites across 9 files (dispatch, protocol, service) to use store.save()
- Removed serializeTask from store barrel exports, enforcing encapsulation
- Zero circular dependencies, zero type errors, all 2998 tests pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Add save/saveToPath to ITaskStore and implement in FilesystemTaskStore** - `b61944b` (feat)
2. **Task 2: Migrate all 14 bypass sites and restrict barrel exports** - `e6ff49a` (feat)

## Files Created/Modified
- `src/store/interfaces.ts` - Added save() and saveToPath() to ITaskStore
- `src/store/task-store.ts` - Implemented save() and saveToPath() in FilesystemTaskStore
- `src/store/index.ts` - Removed serializeTask from barrel exports
- `src/dispatch/assign-executor.ts` - 3 bypass sites replaced with store.save()
- `src/dispatch/assign-helpers.ts` - 1 bypass site replaced with store.save()
- `src/dispatch/lifecycle-handlers.ts` - 2 bypass sites replaced with store.save()
- `src/dispatch/failure-tracker.ts` - 2 bypass sites replaced with store.save()
- `src/dispatch/dag-transition-handler.ts` - persistWorkflowState refactored to use store.save()
- `src/dispatch/escalation.ts` - 1 bypass site replaced with store.save()
- `src/dispatch/scheduler.ts` - Removed unused serializeTask and writeFileAtomic imports
- `src/protocol/router.ts` - 1 bypass site (handoff request) replaced with store.save()
- `src/service/aof-service.ts` - 1 bypass site (startup reconciliation) replaced with store.save()
- `src/permissions/task-permissions.ts` - Added save/saveToPath to PermissionAwareTaskStore
- `src/dispatch/__tests__/dag-transition-handler.test.ts` - Updated mock store and assertions
- `src/dispatch/__tests__/dag-timeout.test.ts` - Updated mock store with save/saveToPath
- `src/dispatch/__tests__/lifecycle-handlers.test.ts` - Updated mock store with save/saveToPath
- `src/dispatch/__tests__/assign-helpers.test.ts` - Updated mock store with save/saveToPath

## Decisions Made
- save() computes canonical path from task.path or status directory -- callers no longer compute paths
- persistWorkflowState in dag-transition-handler now receives store as parameter instead of calling writeFileAtomic directly
- PermissionAwareTaskStore delegates save/saveToPath directly without permission checks (internal persistence ops)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] PermissionAwareTaskStore missing save/saveToPath methods**
- **Found during:** Task 2 (tsc --noEmit revealed type errors)
- **Issue:** PermissionAwareTaskStore implements ITaskStore but was missing the new save/saveToPath methods
- **Fix:** Added delegating save() and saveToPath() methods that pass through to underlying store
- **Files modified:** src/permissions/task-permissions.ts
- **Verification:** tsc --noEmit passes with zero errors
- **Committed in:** e6ff49a (Task 2 commit)

**2. [Rule 1 - Bug] Test mock stores missing save/saveToPath methods**
- **Found during:** Task 2 (vitest run showed 34 test failures)
- **Issue:** 4 test files had mock stores that didn't include save/saveToPath, causing runtime errors
- **Fix:** Added save and saveToPath mock functions to makeStore helpers in all 4 test files
- **Files modified:** 4 test files in src/dispatch/__tests__/
- **Verification:** All 2998 tests pass
- **Committed in:** e6ff49a (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both auto-fixes necessary for correctness. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 39 (Architecture Fixes) is now complete -- all 3 plans executed
- Store abstraction fully enforced: no production code outside store/ directly serializes tasks
- Ready for Phase 40 (Test Infrastructure) or release

---
*Phase: 39-architecture-fixes*
*Completed: 2026-03-13*
