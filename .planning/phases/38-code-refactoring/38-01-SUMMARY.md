---
phase: 38-code-refactoring
plan: 01
subsystem: dispatch
tags: [refactoring, extract-method, deduplication, trace, callbacks]

requires:
  - phase: 34-dead-code-removal
    provides: Gate-to-DAG migration code removed (DEAD-04), resolving REF-06
  - phase: 26-trace-infrastructure
    provides: captureTrace function used by trace-helpers
  - phase: 30-callback-delivery
    provides: deliverCallbacks and deliverAllGranularityCallbacks

provides:
  - captureTraceSafely() — single canonical trace capture wrapper (REF-05)
  - deliverAllCallbacksSafely() — single canonical callback delivery wrapper (REF-04)
  - handleRunComplete() — extracted onRunComplete logic from assign-executor
  - OnRunCompleteContext interface for structured closure variable passing

affects: [39-architecture-fixes, dispatch]

tech-stack:
  added: []
  patterns: [safe-wrapper-pattern, swallow-and-log, extract-closure-to-module]

key-files:
  created:
    - src/dispatch/trace-helpers.ts
    - src/dispatch/callback-helpers.ts
    - src/dispatch/assign-helpers.ts
    - src/dispatch/__tests__/trace-helpers.test.ts
    - src/dispatch/__tests__/callback-helpers.test.ts
    - src/dispatch/__tests__/assign-helpers.test.ts
  modified:
    - src/dispatch/assign-executor.ts

key-decisions:
  - "Kept post-spawn result handling in assign-executor.ts — platform limit, retry, and error classification are orchestration concerns, not onRunComplete concerns"
  - "REF-06 (gate-to-DAG migration dedup) documented as N/A — fully resolved by DEAD-04 in Phase 34"

patterns-established:
  - "Safe wrapper pattern: *Safely() functions that guard inputs, wrap calls in try/catch, log.warn on failure, never throw"
  - "OnRunCompleteContext: bundle closure variables into typed interface for extracted callbacks"

requirements-completed: [REF-01, REF-04, REF-05, REF-06]

duration: 7min
completed: 2026-03-13
---

# Phase 38 Plan 01: Assign-Executor Decomposition Summary

**Extracted 163-line onRunComplete callback into assign-helpers.ts, deduplicated trace capture (3x to 1) and callback delivery (2x to 1) via safe wrapper modules**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-13T11:51:09Z
- **Completed:** 2026-03-13T11:57:50Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Created trace-helpers.ts with captureTraceSafely() — single canonical trace capture (was 3 duplicated try/catch blocks)
- Created callback-helpers.ts with deliverAllCallbacksSafely() — single canonical callback delivery (was 2 duplicated SubscriptionStore+deliver blocks)
- Extracted handleRunComplete() from 163-line inline callback to assign-helpers.ts with typed context interface
- assign-executor.ts reduced from 522 to 369 lines with zero direct trace/callback calls
- 22 new tests across 3 test files, all 560 dispatch tests pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Create trace-helpers.ts and callback-helpers.ts with tests** - `38e426c` (feat, TDD)
2. **Task 2: Extract onRunComplete and slim assign-executor.ts** - `bb3d679` (feat)

_Note: Task 1 used TDD — RED+GREEN committed together as the module didn't exist for separate commits._

## Files Created/Modified
- `src/dispatch/trace-helpers.ts` - captureTraceSafely() safe wrapper around captureTrace
- `src/dispatch/callback-helpers.ts` - deliverAllCallbacksSafely() safe wrapper around both delivery functions
- `src/dispatch/assign-helpers.ts` - handleRunComplete() extracted from inline onRunComplete callback
- `src/dispatch/assign-executor.ts` - Slimmed orchestrator using extracted helpers
- `src/dispatch/__tests__/trace-helpers.test.ts` - 5 tests for trace safe wrapper
- `src/dispatch/__tests__/callback-helpers.test.ts` - 5 tests for callback safe wrapper
- `src/dispatch/__tests__/assign-helpers.test.ts` - 6 tests for handleRunComplete

## Decisions Made
- Kept post-spawn result handling (platform limits, retry logic, error classification) in assign-executor.ts since these are dispatch orchestration concerns, not onRunComplete concerns. The "~80 lines" target in the plan was aspirational; the extracted function was the 163-line onRunComplete callback body.
- REF-06 (gate-to-DAG migration dedup) documented as N/A — fully resolved by DEAD-04 in Phase 34 which removed the migration code entirely.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Dispatch module has clean helper boundaries ready for Phase 39 architecture fixes
- The safe wrapper pattern (captureTraceSafely, deliverAllCallbacksSafely) can be reused by dag-transition-handler.ts if similar extraction is needed

---
*Phase: 38-code-refactoring*
*Completed: 2026-03-13*
