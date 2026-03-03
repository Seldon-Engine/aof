---
phase: 10-dag-schema-foundation
plan: 01
subsystem: schemas
tags: [zod, dag, workflow, condition-dsl, graph-validation, kahns-algorithm]

# Dependency graph
requires: []
provides:
  - "Zod schemas for DAG workflows: ConditionExpr, Hop, WorkflowDefinition, HopStatus, HopState, WorkflowStatus, WorkflowState, TaskWorkflow"
  - "validateDAG() function with cycle detection (Kahn's algorithm), reachability (BFS), ID uniqueness, dangling ref detection, timeout format validation, escalateTo validation"
  - "initializeWorkflowState() pure helper for deriving initial execution state from definition"
affects: [11-evaluator, 12-scheduler, 13-safety-net, 14-templates, 15-migration]

# Tech tracking
tech-stack:
  added: []
  patterns: [recursive-discriminated-union-via-z-lazy, standalone-validation-function, map-based-hop-state]

key-files:
  created:
    - src/schemas/workflow-dag.ts
    - src/schemas/__tests__/workflow-dag.test.ts
  modified: []

key-decisions:
  - "ConditionExprType uses optional value for eq/neq to match z.unknown() inference behavior"
  - "validateDAG is standalone function (not in Zod superRefine) to avoid slow parse on every task load"
  - "Kahn's algorithm for cycle detection with BFS for reachability checking"
  - "Timeout format regex /^\\d+[mhd]$/ supports minutes, hours, days"

patterns-established:
  - "Recursive Zod schema via z.lazy() with explicit TypeScript type annotation for discriminated unions"
  - "Standalone validation function returning string[] for graph-level semantic checks (separate from Zod parse-time structural checks)"
  - "State initialization helper as pure function in schema module"

requirements-completed: [DAG-01, DAG-02, DAG-04, EXEC-08]

# Metrics
duration: 4min
completed: 2026-03-02
---

# Phase 10 Plan 01: DAG Schema Foundation Summary

**All Zod DAG schemas (14-operator ConditionExpr, Hop with 11 fields, 6-state HopStatus) plus validateDAG with Kahn's cycle detection and initializeWorkflowState helper -- 52 tests passing, zero type errors**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-03T03:10:50Z
- **Completed:** 2026-03-03T03:14:52Z
- **Tasks:** 1 (TDD: RED + GREEN + REFACTOR)
- **Files modified:** 2

## Accomplishments
- Complete Zod type system for DAG-based workflows: ConditionExpr (14 operators, recursive via z.lazy), Hop (11 fields with defaults), WorkflowDefinition, HopStatus (6 states), HopState, WorkflowStatus (4 states), WorkflowState, TaskWorkflow
- validateDAG() catches all structural errors: duplicate IDs, dangling dependsOn refs, no root hops, cycles (Kahn's algorithm), unreachable hops (BFS), invalid timeout format, empty escalateTo
- initializeWorkflowState() derives correct initial state: root hops as "ready", dependent hops as "pending", workflow status "pending"
- 52 comprehensive tests covering all schemas, validation cases, and edge cases

## Task Commits

Each task was committed atomically (TDD cycle):

1. **Task 1 RED: Failing tests for DAG schemas** - `15c8cf4` (test)
2. **Task 1 GREEN: Implement all schemas and functions** - `1acf14d` (feat)
3. **Task 1 REFACTOR: Fix ConditionExprType for z.unknown()** - `c8f5cef` (refactor)

## Files Created/Modified
- `src/schemas/workflow-dag.ts` - All DAG Zod schemas (ConditionExpr, Hop, WorkflowDefinition, HopStatus, HopState, WorkflowStatus, WorkflowState, TaskWorkflow), validateDAG(), initializeWorkflowState()
- `src/schemas/__tests__/workflow-dag.test.ts` - 52 unit tests covering schema parsing, validation, and state initialization

## Decisions Made
- **ConditionExprType optional value fields:** `z.unknown()` infers to optional in Zod's output type, so eq/neq value fields in ConditionExprType are marked optional to match. Runtime parsing still requires the fields.
- **Standalone validateDAG:** Kept graph validation out of Zod `.superRefine()` per RESEARCH.md Pitfall 3 -- avoids expensive cycle detection on every task parse/load.
- **Timeout regex `/^\d+[mhd]$/`:** Supports minutes (m), hours (h), and days (d) -- extends the existing workflow.ts pattern which only supported m and h.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed ConditionExprType to match Zod z.unknown() inference**
- **Found during:** Task 1 REFACTOR phase (tsc --noEmit)
- **Issue:** `z.unknown()` produces an optional field in Zod's output type, but ConditionExprType had `value: unknown` (required) for eq/neq operators, causing TypeScript error
- **Fix:** Changed eq/neq value fields to `value?: unknown` in ConditionExprType
- **Files modified:** src/schemas/workflow-dag.ts
- **Verification:** `npx tsc --noEmit` passes, all 52 tests still pass
- **Committed in:** c8f5cef

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Type alignment fix required for TypeScript compilation. No scope creep.

## Issues Encountered
None -- TDD cycle completed cleanly. All tests passed on first GREEN run.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All DAG schemas exported and ready for Plan 02 (TaskFrontmatter integration, index.ts barrel export, mutual exclusivity validation)
- validateDAG() ready for use at task creation time (Phase 12 scheduler integration)
- initializeWorkflowState() ready for use by task creation logic
- ConditionExpr schema ready for Phase 11 evaluator to consume

---
*Phase: 10-dag-schema-foundation*
*Completed: 2026-03-02*
