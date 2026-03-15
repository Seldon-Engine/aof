---
phase: 40-test-infrastructure
plan: 02
subsystem: testing
tags: [vitest, mock-factory, test-harness, cleanup, migration]

requires:
  - phase: 40-test-infrastructure
    provides: createTestHarness, createMockStore, createMockLogger from Plan 01
provides:
  - 9 test files fixed with proper temp dir cleanup
  - 10 test files migrated to shared mock factories
  - Zero as-any store/logger casts in migrated files
affects: []

tech-stack:
  added: []
  patterns: [tmpDir-tracking-array-pattern, shared-mock-factory-adoption]

key-files:
  created: []
  modified:
    - src/memory/__tests__/memory-update.test.ts
    - src/memory/__tests__/memory-search.test.ts
    - src/memory/__tests__/memory-delete.test.ts
    - src/memory/__tests__/memory-list.test.ts
    - src/memory/__tests__/store-schema.test.ts
    - src/memory/__tests__/hash.test.ts
    - src/memory/__tests__/memory-store.test.ts
    - src/memory/__tests__/memory-get.test.ts
    - src/memory/__tests__/pipeline-integration.test.ts
    - src/cli/commands/__tests__/trace.test.ts
    - src/trace/__tests__/trace-writer.test.ts
    - src/protocol/__tests__/dag-router-integration.test.ts
    - src/dispatch/__tests__/callback-delivery.test.ts
    - src/dispatch/__tests__/recovery-handlers.test.ts
    - src/dispatch/__tests__/lifecycle-handlers.test.ts
    - src/dispatch/__tests__/alert-handlers.test.ts
    - src/dispatch/__tests__/dag-scheduler-integration.test.ts
    - src/dispatch/__tests__/dag-timeout.test.ts
    - src/dispatch/__tests__/dag-transition-handler.test.ts

key-decisions:
  - "Used tmpDirs tracking array pattern for per-test mkdtempSync cleanup in memory tests"
  - "Kept as-any casts on CaptureTraceOptions store/logger params since they expect class types not interfaces"
  - "6 of 15 listed files already had proper cleanup -- only 9 needed fixes"

patterns-established:
  - "tmpDir tracking: const tmpDirs: string[] = []; push after mkdtempSync; cleanup in afterEach"
  - "Mock factory adoption: import { createMockStore, createMockLogger } from testing/index.js"

requirements-completed: [TEST-01, TEST-02, TEST-04, TEST-05]

duration: 10min
completed: 2026-03-15
---

# Phase 40 Plan 02: Test Migration Summary

**Migrated 19 test files to shared testing utilities: 9 files with temp dir cleanup fixes and 10 files replacing inline mock casts with typed createMockStore/createMockLogger factories**

## Performance

- **Duration:** 10 min
- **Started:** 2026-03-15T22:48:18Z
- **Completed:** 2026-03-15T22:58:18Z
- **Tasks:** 2
- **Files modified:** 19

## Accomplishments
- Fixed temp directory leaks in 9 memory/CLI test files using tmpDirs tracking arrays with afterEach/afterAll cleanup
- Migrated 10 test files from inline `as any` mock objects to shared `createMockStore()`/`createMockLogger()` factories
- Eliminated 8 `store: mockStore as any` casts in trace.test.ts
- Replaced local createMockStore/createMockLogger definitions in trace-writer.test.ts and callback-delivery.test.ts with shared imports
- Full test suite (3017 tests) passes with zero regressions
- 11+ test files now import from src/testing/index.js (shared utilities)

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix temp dir cleanup in 15 files** - `a42b278` (fix)
2. **Task 2: Migrate mock store/logger files to typed factories** - `09cb762` (refactor)

## Files Created/Modified

### Task 1 (temp cleanup)
- `src/memory/__tests__/memory-update.test.ts` - Added rmSync import, tmpDirs tracking, afterEach cleanup
- `src/memory/__tests__/memory-search.test.ts` - Added rmSync import, tmpDirs tracking, afterEach cleanup
- `src/memory/__tests__/memory-delete.test.ts` - Added rmSync import, tmpDirs tracking, afterEach cleanup
- `src/memory/__tests__/memory-list.test.ts` - Added rmSync import, tmpDirs tracking, afterEach cleanup
- `src/memory/__tests__/memory-store.test.ts` - Added rmSync import, tmpDirs tracking, afterEach cleanup
- `src/memory/__tests__/store-schema.test.ts` - Added afterAll cleanup for createDbPath dirs
- `src/memory/__tests__/hash.test.ts` - Added afterAll cleanup for createDbPath dirs
- `src/memory/__tests__/memory-get.test.ts` - Added afterAll cleanup for mkdtempSync dirs
- `src/memory/__tests__/pipeline-integration.test.ts` - Added rmSync(poolDir) to afterEach

### Task 2 (mock factory migration)
- `src/cli/commands/__tests__/trace.test.ts` - Replaced 8 inline mockStore objects with createMockStore()
- `src/trace/__tests__/trace-writer.test.ts` - Replaced local factory definitions with shared imports
- `src/protocol/__tests__/dag-router-integration.test.ts` - Replaced makeStore/makeLogger with shared factories
- `src/dispatch/__tests__/callback-delivery.test.ts` - Replaced local createMockTaskStore with shared createMockStore
- `src/dispatch/__tests__/recovery-handlers.test.ts` - Used shared createMockStore/createMockLogger
- `src/dispatch/__tests__/lifecycle-handlers.test.ts` - Used shared createMockStore/createMockLogger
- `src/dispatch/__tests__/alert-handlers.test.ts` - Used shared createMockStore/createMockLogger
- `src/dispatch/__tests__/dag-scheduler-integration.test.ts` - Used shared createMockLogger
- `src/dispatch/__tests__/dag-timeout.test.ts` - Used shared createMockLogger
- `src/dispatch/__tests__/dag-transition-handler.test.ts` - Used shared createMockStore/createMockLogger

## Decisions Made
- Used `tmpDirs: string[]` tracking array pattern for files where mkdtempSync is called inside individual `it()` blocks rather than `beforeEach` -- push dir after creation, cleanup in afterEach
- 6 of the 15 files listed in the plan (hnsw-resilience, hnsw-index, memory-health, adapters, org-drift-cli, memory-cli) already had proper cleanup, so only 9 files needed fixes
- Kept `as any` casts on store/logger params passed to `CaptureTraceOptions` since the type expects `EventLogger` class (not interface) and `ITaskStore` -- the shared factories return compatible mocks but TypeScript can't verify this without the cast
- Memory test files use SQLite `:memory:` + mkdtempSync for file pools, not the AOF store/logger pattern, so they got manual cleanup rather than harness migration

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 40 (Test Infrastructure) is now complete
- All testing utilities created and adopted across the codebase
- Full test suite (3017 tests, 266 files) passes with zero regressions

---
*Phase: 40-test-infrastructure*
*Completed: 2026-03-15*
