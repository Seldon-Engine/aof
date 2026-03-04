---
phase: 18-dag-as-default
plan: 01
subsystem: cli
tags: [commander, workflow, dag, defaultWorkflow, negatable-option]

# Dependency graph
requires:
  - phase: 17-migration-foundation
    provides: defaultWorkflow field in ProjectManifest schema and migration 001 that sets it
provides:
  - resolveDefaultWorkflow() function with graceful degradation
  - --no-workflow CLI option for bare task opt-out
  - Three-way workflow precedence logic in task create handler
affects: [19-verification, 20-release]

# Tech tracking
tech-stack:
  added: []
  patterns: [Commander --no-* negation for value options, graceful degradation for default resolution]

key-files:
  created: []
  modified:
    - src/cli/commands/task-create-workflow.ts
    - src/cli/commands/__tests__/task-create-workflow.test.ts
    - src/cli/commands/task.ts

key-decisions:
  - "resolveDefaultWorkflow returns undefined (never throws) for all failure cases -- graceful degradation"
  - "Stale defaultWorkflow references warn to stderr and fall back to bare task"
  - "Commander handles --workflow/--no-workflow conflict naturally (last flag wins)"
  - "Output annotates default workflows with (default) suffix for user clarity"

patterns-established:
  - "Graceful degradation pattern: default-resolution functions return undefined instead of throwing"
  - "Three-way precedence pattern: explicit > opt-out > auto-default > fallback"

requirements-completed: [DAGD-01, DAGD-02, DAGD-03]

# Metrics
duration: 5min
completed: 2026-03-04
---

# Phase 18 Plan 01: DAG-as-Default Summary

**Auto-attach defaultWorkflow on `bd create` with --no-workflow opt-out and graceful degradation for unconfigured projects**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-04T01:14:31Z
- **Completed:** 2026-03-04T01:19:53Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- resolveDefaultWorkflow() gracefully resolves project's default workflow template, returning undefined for all error cases
- --no-workflow flag opts out of default workflow attachment via Commander's built-in negation pattern
- Three-way precedence logic: --workflow > --no-workflow > defaultWorkflow > bare task
- Six new tests covering all default workflow resolution scenarios including stale references and invalid DAGs

## Task Commits

Each task was committed atomically:

1. **Task 1: Add resolveDefaultWorkflow function with tests (TDD RED)** - `ab6a7d2` (test)
2. **Task 1: Add resolveDefaultWorkflow function with tests (TDD GREEN)** - `fb21dca` (feat)
3. **Task 2: Wire --no-workflow option and three-way precedence** - `5f28d4e` (feat)

_Note: Task 1 followed TDD with RED and GREEN commits._

## Files Created/Modified
- `src/cli/commands/task-create-workflow.ts` - Added resolveDefaultWorkflow() with graceful degradation for missing manifest, field, template, and invalid DAG
- `src/cli/commands/__tests__/task-create-workflow.test.ts` - Added 6 tests for resolveDefaultWorkflow covering all precedence scenarios
- `src/cli/commands/task.ts` - Added --no-workflow option and three-way precedence logic with (default) output annotation

## Decisions Made
- resolveDefaultWorkflow wraps all manifest loading in try/catch and returns undefined on any error (graceful degradation for _inbox and unconfigured projects)
- Stale defaultWorkflow references emit console.error warning and fall back to bare task (not silent, not throwing)
- Commander handles --workflow and --no-workflow conflict naturally (last flag wins) -- no explicit conflict detection
- Workflow output line annotated with "(default)" suffix when auto-attached vs explicit

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Default workflow auto-attachment is complete and tested
- Ready for Phase 19 verification and Phase 20 release
- Pre-existing gate workflow test failures (28 tests in sdlc-workflow, gate-metrics, gate-transition, gate-validation) are unrelated to this phase -- confirmed by running tests before and after changes

## Self-Check: PASSED

All files exist, all commits verified (ab6a7d2, fb21dca, 5f28d4e).

---
*Phase: 18-dag-as-default*
*Completed: 2026-03-04*
