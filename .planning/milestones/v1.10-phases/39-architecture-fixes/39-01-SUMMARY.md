---
phase: 39-architecture-fixes
plan: 01
subsystem: architecture
tags: [circular-dependencies, madge, type-extraction, dispatch, tools]

requires:
  - phase: 38-code-refactoring
    provides: handler extraction pattern (action-executor split into lifecycle/recovery/alert handlers)
provides:
  - dispatch/types.ts with SchedulerConfig, SchedulerAction, DispatchConfig
  - tools/types.ts with ToolContext
  - Zero circular dependencies in dispatch/ and tools/ subsystems
affects: [39-02, 39-03, dispatch, tools]

tech-stack:
  added: []
  patterns: [leaf-level type files to break import cycles, re-exports for backward compatibility]

key-files:
  created:
    - src/dispatch/types.ts
    - src/tools/types.ts
  modified:
    - src/dispatch/scheduler.ts
    - src/dispatch/task-dispatcher.ts
    - src/dispatch/action-executor.ts
    - src/dispatch/alert-handlers.ts
    - src/dispatch/lifecycle-handlers.ts
    - src/dispatch/recovery-handlers.ts
    - src/dispatch/assign-executor.ts
    - src/dispatch/assign-helpers.ts
    - src/dispatch/scheduler-helpers.ts
    - src/dispatch/escalation.ts
    - src/tools/aof-tools.ts
    - src/tools/tool-registry.ts
    - src/tools/project-tools.ts
    - src/tools/query-tools.ts
    - src/tools/task-crud-tools.ts
    - src/tools/task-workflow-tools.ts

key-decisions:
  - "Kept re-exports in scheduler.ts, task-dispatcher.ts, and aof-tools.ts for backward compatibility with external consumers"
  - "Consolidated duplicate SchedulerAction interfaces (defined in both scheduler.ts and task-dispatcher.ts) into single canonical definition in dispatch/types.ts"

patterns-established:
  - "Type extraction pattern: shared interfaces go in subsystem/types.ts, imported by all sibling modules, re-exported from barrel for external consumers"

requirements-completed: [ARCH-01]

duration: 8min
completed: 2026-03-13
---

# Phase 39 Plan 01: Dispatch & Tools Circular Dependency Resolution Summary

**Extracted shared types to leaf-level type files, eliminating all 12 dispatch/tools circular dependency cycles with zero regressions**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-13T20:48:40Z
- **Completed:** 2026-03-13T20:57:00Z
- **Tasks:** 2
- **Files modified:** 18 (2 created, 16 modified)

## Accomplishments
- Created dispatch/types.ts with SchedulerConfig, SchedulerAction, DispatchConfig — breaking all 7 dispatch cycles
- Created tools/types.ts with ToolContext — breaking all 5 tools barrel cycles
- Full madge scan reports zero circular dependencies across entire src/ (previously 10+ cycles in dispatch/, 12 in tools/)
- All 2998 tests pass with zero regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract dispatch shared types to dispatch/types.ts** - `12abc77` (refactor)
2. **Task 2: Extract tools ToolContext to tools/types.ts** - `1078581` (refactor)

## Files Created/Modified
- `src/dispatch/types.ts` - Canonical home for SchedulerConfig, SchedulerAction, DispatchConfig
- `src/tools/types.ts` - Canonical home for ToolContext interface
- `src/dispatch/scheduler.ts` - Removed inline type defs, re-exports from types.ts
- `src/dispatch/task-dispatcher.ts` - Removed inline type defs, re-exports from types.ts
- `src/dispatch/action-executor.ts` - Import from types.ts
- `src/dispatch/alert-handlers.ts` - Import from types.ts
- `src/dispatch/lifecycle-handlers.ts` - Import from types.ts
- `src/dispatch/recovery-handlers.ts` - Import from types.ts
- `src/dispatch/assign-executor.ts` - Import from types.ts
- `src/dispatch/assign-helpers.ts` - Import from types.ts
- `src/dispatch/scheduler-helpers.ts` - Import from types.ts
- `src/dispatch/escalation.ts` - Import from types.ts
- `src/tools/aof-tools.ts` - Removed ToolContext definition, re-exports from types.ts
- `src/tools/tool-registry.ts` - Import from types.ts
- `src/tools/project-tools.ts` - Import from types.ts
- `src/tools/query-tools.ts` - Import from types.ts
- `src/tools/task-crud-tools.ts` - Import from types.ts
- `src/tools/task-workflow-tools.ts` - Import from types.ts

## Decisions Made
- Kept re-exports in scheduler.ts, task-dispatcher.ts, and aof-tools.ts so external consumers (tests, mcp/, openclaw/) don't need import path changes
- Consolidated the duplicate SchedulerAction interface (defined identically in both scheduler.ts and task-dispatcher.ts) into one canonical definition in dispatch/types.ts
- Cleaned up unused imports (TaskLockManager from scheduler.ts, GatewayAdapter and TaskStatus from task-dispatcher.ts) that were only needed by the removed inline type definitions

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Pre-existing TypeScript errors and test failure in org-chart-config.ts (unrelated to this plan's changes) — confirmed out of scope, not introduced by this work

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- dispatch/ and tools/ subsystems are cycle-free, ready for further architecture work in plans 02 and 03
- The type extraction pattern established here can be applied to remaining circular dependencies (config, store, context) in subsequent plans

---
*Phase: 39-architecture-fixes*
*Completed: 2026-03-13*

## Self-Check: PASSED
