---
phase: 40-test-infrastructure
plan: 01
subsystem: testing
tags: [vitest, mock-factory, test-harness, coverage, tdd]

requires:
  - phase: 39-architecture-fixes
    provides: ITaskStore interface, EventLogger class, store abstraction
provides:
  - createTestHarness() and withTestProject() for integration test setup
  - createMockStore() typed ITaskStore mock factory with pre-seeding
  - createMockLogger() typed EventLogger mock factory
  - Expanded coverage config tracking all src/ modules
  - test:coverage npm script
affects: [40-02-PLAN, test-migration]

tech-stack:
  added: ["@vitest/coverage-v8"]
  patterns: [mock-factory-pattern, test-harness-pattern, barrel-re-export]

key-files:
  created:
    - src/testing/harness.ts
    - src/testing/mock-store.ts
    - src/testing/mock-logger.ts
    - src/testing/__tests__/harness.test.ts
    - src/testing/__tests__/mock-store.test.ts
    - src/testing/__tests__/mock-logger.test.ts
  modified:
    - src/testing/index.ts
    - vitest.config.ts
    - package.json

key-decisions:
  - "Used satisfies ITaskStore for compile-time mock completeness checking"
  - "Mock logger uses as-unknown cast since EventLogger has private fields"
  - "readTasks scans all status subdirectories matching FilesystemTaskStore layout"
  - "Added @vitest/coverage-v8 as dev dependency for coverage support"

patterns-established:
  - "Mock factory pattern: createMockX() returns fully typed mock with vi.fn() stubs"
  - "Test harness pattern: createTestHarness() for real store/logger in tmpDir"
  - "withTestProject for auto-cleanup integration test wrapper"

requirements-completed: [TEST-01, TEST-02, TEST-03, TEST-05]

duration: 6min
completed: 2026-03-15
---

# Phase 40 Plan 01: Test Infrastructure Utilities Summary

**Typed mock factories for ITaskStore/EventLogger, shared test harness with auto-cleanup, and expanded coverage config tracking all src/ modules**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-15T22:38:20Z
- **Completed:** 2026-03-15T22:44:30Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- createMockStore() returns fully typed ITaskStore with all 21 methods as vi.fn() stubs, with optional pre-seeding for get/list/getByPrefix/countByStatus
- createMockLogger() returns typed EventLogger mock with all 12 public methods as vi.fn() stubs
- createTestHarness() creates tmpDir with real FilesystemTaskStore and EventLogger, bound readEvents/readTasks helpers, and cleanup
- withTestProject() wraps harness with auto-cleanup even on throw
- Coverage config expanded from 6 hardcoded files to src/**/*.ts (excludes tests, testing utils, schemas, barrel files, types)
- Added test:coverage script and @vitest/coverage-v8 dependency

## Task Commits

Each task was committed atomically:

1. **Task 1: Create mock factories** - `a78bc2f` (feat)
2. **Task 2: Create test harness, update barrel, expand coverage config** - `caca733` (feat)

_Note: TDD tasks followed RED-GREEN flow (tests first, then implementation)_

## Files Created/Modified
- `src/testing/mock-store.ts` - MockTaskStore type and createMockStore factory
- `src/testing/mock-logger.ts` - MockEventLogger type and createMockLogger factory
- `src/testing/harness.ts` - TestHarness interface, createTestHarness, withTestProject
- `src/testing/index.ts` - Barrel re-exports all testing utilities
- `src/testing/__tests__/mock-store.test.ts` - 7 tests for mock store factory
- `src/testing/__tests__/mock-logger.test.ts` - 3 tests for mock logger factory
- `src/testing/__tests__/harness.test.ts` - 9 tests for harness and withTestProject
- `vitest.config.ts` - Expanded coverage include to src/**/*.ts
- `package.json` - Added test:coverage script, @vitest/coverage-v8 dev dependency
- `package-lock.json` - Lock file updated for new dependency

## Decisions Made
- Used `satisfies ITaskStore` on mock store return for compile-time completeness checking
- Mock logger uses `as unknown as MockEventLogger` cast since EventLogger is a class with private fields
- readTasks in harness scans all status subdirectories (backlog, ready, etc.) matching FilesystemTaskStore layout rather than reading flat tasksDir
- Added @vitest/coverage-v8 ^3.0.0 to match vitest ^3.0.0

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Task type usage in mock-store**
- **Found during:** Task 2 (typecheck verification)
- **Issue:** Mock store referenced t.id and t.status but Task type has frontmatter.id and frontmatter.status
- **Fix:** Changed to t.frontmatter.id and t.frontmatter.status in get/getByPrefix/countByStatus implementations
- **Files modified:** src/testing/mock-store.ts, src/testing/__tests__/mock-store.test.ts
- **Verification:** npx tsc --noEmit passes, all tests pass
- **Committed in:** caca733 (Task 2 commit)

**2. [Rule 1 - Bug] Fixed readTasks to scan status subdirectories**
- **Found during:** Task 2 (harness test failure)
- **Issue:** readTasksInDir reads files from a flat directory, but FilesystemTaskStore stores tasks in tasks/<status>/ subdirectories
- **Fix:** Created readAllTasks helper that iterates status subdirectories and calls readTasksInDir on each
- **Files modified:** src/testing/harness.ts
- **Verification:** harness readTasks test passes
- **Committed in:** caca733 (Task 2 commit)

**3. [Rule 3 - Blocking] Installed @vitest/coverage-v8 dependency**
- **Found during:** Task 2 (coverage verification)
- **Issue:** vitest --coverage requires @vitest/coverage-v8 provider which was not installed
- **Fix:** npm install --save-dev @vitest/coverage-v8@^3.0.0
- **Files modified:** package.json, package-lock.json
- **Verification:** npx vitest run --coverage produces coverage report
- **Committed in:** caca733 (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (2 bugs, 1 blocking)
**Impact on plan:** All auto-fixes necessary for correctness and functionality. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All testing utilities ready for Plan 02 (test migration) to adopt across all test files
- 19 new tests added for the testing infrastructure itself
- Full test suite (3017 tests) passes with no regressions

---
*Phase: 40-test-infrastructure*
*Completed: 2026-03-15*
