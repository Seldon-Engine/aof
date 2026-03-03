---
phase: 15-migration-and-documentation
plan: 01
subsystem: migration
tags: [gate-to-dag, lazy-migration, workflow, tdd]

requires:
  - phase: 10-workflow-schema
    provides: "WorkflowDefinition, Hop, ConditionExpr, validateDAG, initializeWorkflowState schemas"
  - phase: 14-templates-adhoc-artifacts
    provides: "TaskWorkflow on frontmatter, task-store create() with workflow support"
provides:
  - "migrateGateToDAG function converting gate-format tasks to DAG format on load"
  - "Task-store migration hooks in get() and list() with atomic write-back"
  - "Gate when-expression to JSON DSL condition converter"
affects: [15-02, 15-03, documentation, scheduler]

tech-stack:
  added: []
  patterns: ["lazy migration on load with atomic write-back", "string-to-DSL condition conversion with graceful fallback"]

key-files:
  created:
    - src/migration/gate-to-dag.ts
    - src/migration/__tests__/gate-to-dag.test.ts
    - docs/dev/workflow-dag-design.md
  modified:
    - src/store/task-store.ts

key-decisions:
  - "migrateGateToDAG mutates task in-place, caller handles persistence"
  - "Gate canReject maps to hop rejectionStrategy='origin' (conservative default)"
  - "Unparseable when expressions silently skip condition (hop always activates) with console.warn"
  - "Migration hooks in both get() and list() for complete coverage"

patterns-established:
  - "Lazy migration pattern: detect legacy format on load, convert, write back atomically"
  - "Condition conversion: pattern-match known gate expressions to JSON DSL, gracefully skip unknowns"

requirements-completed: [SAFE-05]

duration: 4min
completed: 2026-03-03
---

# Phase 15 Plan 01: Gate-to-DAG Migration Summary

**Lazy gate-to-DAG migration with TDD: converts legacy gate-format tasks to DAG workflow on load with in-flight position preservation**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-03T19:40:07Z
- **Completed:** 2026-03-03T19:44:05Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 4

## Accomplishments
- migrateGateToDAG converts gate-format tasks to valid DAG format with linear hop chains
- In-flight tasks preserve current position (complete/dispatched/ready/pending mapping)
- Gate fields cleared after conversion to avoid mutual exclusivity violation
- Simple gate `when` expressions converted to JSON DSL conditions; complex ones skipped with warning
- Task-store hooks trigger migration on load and write back atomically in both get() and list()
- 12 comprehensive tests covering all migration scenarios
- All 131 existing task-store tests continue to pass (backward compatibility)

## Task Commits

Each task was committed atomically:

1. **TDD RED+GREEN: Gate-to-DAG migration** - `75d3346` (feat: migration module + 12 tests)
2. **Task-store hooks** - `6ac97b2` (feat: migration hooks in get/list + doc fix)

_Note: TDD RED confirmed module-not-found failure, GREEN implemented and passed all 12 tests._

## Files Created/Modified
- `src/migration/gate-to-dag.ts` - Core migration logic: gate detection, hop conversion, position mapping, condition conversion
- `src/migration/__tests__/gate-to-dag.test.ts` - 12 tests covering all migration scenarios
- `src/store/task-store.ts` - Migration hooks in get() and list() load paths
- `docs/dev/workflow-dag-design.md` - Workflow DAG design doc placeholder (fixed broken link)

## Decisions Made
- migrateGateToDAG mutates task in-place (caller handles persistence) for simplicity
- Gate canReject=true maps to hop rejectionStrategy="origin" as conservative default
- Unparseable when expressions log warning and skip condition (hop always activates)
- Migration hooks added to both get() and list() for complete load-path coverage

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Created docs/dev/workflow-dag-design.md placeholder**
- **Found during:** Task 2 (task-store hook commit)
- **Issue:** Pre-existing broken link in docs/guide/workflow-dags.md referencing non-existent ../dev/workflow-dag-design.md caused pre-commit hook failure
- **Fix:** Created minimal placeholder document with architecture overview
- **Files modified:** docs/dev/workflow-dag-design.md
- **Verification:** `node scripts/check-docs.mjs` passes all checks
- **Committed in:** 6ac97b2 (part of task-store hook commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Auto-fix necessary to unblock commit. No scope creep.

## Issues Encountered
None beyond the pre-existing broken doc link addressed above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Migration module ready for 15-02 (documentation) and 15-03 to reference
- Gate evaluation code kept with deprecation markers as safety net (per user decision)
- Dual-mode evaluator remains as fallback during migration period

---
*Phase: 15-migration-and-documentation*
*Completed: 2026-03-03*
