---
phase: 16-integration-wiring-fixes
plan: 01
subsystem: integration
tags: [protocol-router, gate-migration, dag-workflow, wiring]

# Dependency graph
requires:
  - phase: 12-scheduler-wiring
    provides: "ProtocolRouter executor/spawnTimeoutMs interface fields"
  - phase: 15-migration-and-documentation
    provides: "migrateGateToDAG function with workflowConfig parameter"
provides:
  - "ProtocolRouter receives executor and spawnTimeoutMs from AOFService"
  - "task-store get() and list() pass workflowConfig to migrateGateToDAG"
affects: [scheduler, protocol-router, gate-migration, task-store]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Lazy-load workflow config (loaded once per list() call, only when gate tasks found)"
    - "Conditional write-back (only persist migration if it actually succeeded)"

key-files:
  created:
    - src/service/__tests__/aof-service-router-wiring.test.ts
  modified:
    - src/service/aof-service.ts
    - src/store/task-store.ts

key-decisions:
  - "spawnTimeoutMs added to AOFServiceConfig (not reusing SchedulerConfig value) since ProtocolRouter is built separately"
  - "loadWorkflowConfig uses dynamic import for yaml parser to avoid new top-level import"
  - "Only write back migrated task if workflow field was actually set (guards no-config case)"
  - "Lazy-load pattern in list() loads config once before loop, not per-task"

patterns-established:
  - "Conditional write-back: only persist lazy migration when it succeeds"
  - "Lazy-load config: expensive IO deferred until gate task actually found"

requirements-completed: [EXEC-03, SAFE-05]

# Metrics
duration: 5min
completed: 2026-03-03
---

# Phase 16 Plan 01: Integration Wiring Fixes Summary

**Forward executor/spawnTimeoutMs to ProtocolRouter and pass workflowConfig to migrateGateToDAG, closing EXEC-03 and SAFE-05 integration gaps**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-03T20:37:03Z
- **Completed:** 2026-03-03T20:42:03Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- ProtocolRouter now receives executor and spawnTimeoutMs from AOFService, enabling immediate hop dispatch on session end (not just poll-cycle fallback)
- task-store get() and list() now load project.yaml workflow config and pass it to migrateGateToDAG, enabling gate-format tasks to actually migrate to DAG format on load
- Added 4 new tests verifying executor/spawnTimeoutMs wiring with TDD (red-green)
- All 2754 existing tests continue to pass (27 pre-existing E2E gate test failures unrelated to this change)

## Task Commits

Each task was committed atomically:

1. **Task 1: Forward executor and spawnTimeoutMs to ProtocolRouter** (TDD)
   - `e9ea269` test(16-01): add failing tests for executor/spawnTimeoutMs ProtocolRouter wiring
   - `ed35467` feat(16-01): forward executor and spawnTimeoutMs to ProtocolRouter
2. **Task 2: Pass workflowConfig to migrateGateToDAG in task-store** - `964b227` (feat)

## Files Created/Modified
- `src/service/aof-service.ts` - Added spawnTimeoutMs to config, forwarded executor and spawnTimeoutMs to ProtocolRouter constructor
- `src/store/task-store.ts` - Added loadWorkflowConfig() helper, updated get() and list() to pass workflowConfig to migrateGateToDAG
- `src/service/__tests__/aof-service-router-wiring.test.ts` - 4 tests verifying ProtocolRouter wiring

## Decisions Made
- spawnTimeoutMs added to AOFServiceConfig rather than reusing SchedulerConfig, since ProtocolRouter is constructed separately from the scheduler config object
- loadWorkflowConfig() uses dynamic `import("yaml")` to avoid adding a new top-level import (yaml is already a transitive dependency)
- Conditional write-back: only persist migrated task file when migration actually succeeds (workflow field is set), preventing unnecessary writes when workflowConfig is unavailable
- Lazy-load pattern in list(): workflow config loaded at most once per call, and only if a gate task is found

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Both EXEC-03 and SAFE-05 integration gaps are closed
- Phase 16 is complete (single plan)
- v1.2 milestone audit gaps fully addressed

## Self-Check: PASSED

All files exist, all commits verified, all wiring patterns confirmed in source.

---
*Phase: 16-integration-wiring-fixes*
*Completed: 2026-03-03*
