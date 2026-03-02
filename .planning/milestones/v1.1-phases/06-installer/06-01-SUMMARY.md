---
phase: 06-installer
plan: 01
subsystem: packaging
tags: [tar, github-releases, self-update, tarball]

# Dependency graph
requires:
  - phase: 05-ci
    provides: Build tarball script and release workflow
provides:
  - Real GITHUB_REPO constant pointing to demerzel-ops/aof
  - Working extractTarball() using tar -xzf with error handling
  - Tarball includes package-lock.json for reproducible installs
affects: [06-installer plan 02, self-update flow, release pipeline]

# Tech tracking
tech-stack:
  added: []
  patterns: [execSync for shell tar with timeout and error wrapping]

key-files:
  created: []
  modified:
    - src/packaging/channels.ts
    - src/packaging/updater.ts
    - scripts/build-tarball.mjs
    - src/packaging/__tests__/updater.test.ts

key-decisions:
  - "Used execSync tar -xzf instead of tar npm library for zero-dependency extraction"
  - "60s timeout on tar extraction to handle large tarballs without hanging"

patterns-established:
  - "Shell command wrapping: execSync with stdio pipe, timeout, and descriptive error re-throw"

requirements-completed: [INST-02, INST-06]

# Metrics
duration: 2min
completed: 2026-02-26
---

# Phase 6 Plan 1: Packaging Stubs Fix Summary

**Fixed GITHUB_REPO placeholder to demerzel-ops/aof, implemented extractTarball() with tar -xzf, added package-lock.json to tarball**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-26T18:07:55Z
- **Completed:** 2026-02-26T18:10:23Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- GITHUB_REPO constant in channels.ts now resolves to the real repository (demerzel-ops/aof) instead of placeholder
- extractTarball() in updater.ts uses real `tar -xzf` via execSync with 60s timeout and error handling
- build-tarball.mjs includes package-lock.json so `npm ci` works after extraction
- All 10 updater tests pass (9 existing + 1 new extraction integration test)

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix GITHUB_REPO placeholder and implement extractTarball()** - `e4bd2a6` (feat)
2. **Task 2: Add package-lock.json to tarball and test extractTarball()** - `ff42e05` (feat)

## Files Created/Modified
- `src/packaging/channels.ts` - GITHUB_REPO constant changed from "aof/aof" to "demerzel-ops/aof"
- `src/packaging/updater.ts` - extractTarball() stub replaced with real tar -xzf implementation, added execSync import
- `scripts/build-tarball.mjs` - Added package-lock.json to required files array
- `src/packaging/__tests__/updater.test.ts` - Added extractTarball integration test, fixed existing tests to use real tarball data

## Decisions Made
- Used `execSync` with `tar -xzf` rather than a tar npm library -- zero dependency, macOS/Linux compatible, same approach used in build-tarball.mjs and installer.ts
- 60-second timeout on extraction to prevent hangs on corrupted or very large tarballs

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed existing selfUpdate tests using fake tarball data**
- **Found during:** Task 2 (test execution)
- **Issue:** Existing tests passed `Buffer.from("fake tarball data")` through mocked fetch. With real extractTarball(), tar fails on invalid archive data ("Unrecognized archive format")
- **Fix:** Added `createTestTarball()` helper that builds a real tar.gz with a minimal package.json, and `mockTarballResponse()` helper to wrap it in a ReadableStream. Replaced all 5 fake-data mock setups with real tarball data.
- **Files modified:** src/packaging/__tests__/updater.test.ts
- **Verification:** All 10 tests pass (5 previously failing now pass with real data)
- **Committed in:** ff42e05 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix)
**Impact on plan:** Necessary correction -- existing tests were written against the stub and needed real tarball data for the working implementation. No scope creep.

## Issues Encountered
None beyond the test fix documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All three packaging stubs are fixed; extractTarball() works end-to-end
- Plan 02 (installer) can proceed with real GitHub repo resolution, working tarball extraction, and reproducible npm ci installs
- The `extractTarball()` stub blocker documented in STATE.md is now resolved

## Self-Check: PASSED

- All 4 source files verified present on disk
- Commit e4bd2a6 verified in git log
- Commit ff42e05 verified in git log
- SUMMARY.md verified present at expected path

---
*Phase: 06-installer*
*Completed: 2026-02-26*
