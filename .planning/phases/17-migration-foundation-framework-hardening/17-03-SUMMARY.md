---
phase: 17-migration-foundation-framework-hardening
plan: 03
subsystem: store, installer
tags: [gate-to-dag, migration, backup, getByPrefix, lazy-migration]

# Dependency graph
requires:
  - phase: 16-migration-safety-net
    provides: gate-to-DAG migration function (migrateGateToDAG)
provides:
  - getByPrefix() with gate-to-DAG lazy migration consistent with get() and list()
  - installer backup scope including Projects/ directory
affects: [18-dag-as-default, 19-verification, 20-release]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "All task-loading methods apply gate-to-DAG lazy migration consistently"

key-files:
  created: []
  modified:
    - src/store/task-store.ts
    - scripts/install.sh

key-decisions:
  - "Replicated exact same migration pattern from get() into getByPrefix() for consistency"

patterns-established:
  - "Every task-loading method (get, getByPrefix, list) must apply gate-to-DAG migration"

requirements-completed: [BUGF-01, BUGF-02]

# Metrics
duration: 4min
completed: 2026-03-04
---

# Phase 17 Plan 03: Bug Fixes Summary

**getByPrefix() gate-to-DAG migration parity with get()/list(), and installer backup scope expanded to include Projects/**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-04T00:39:38Z
- **Completed:** 2026-03-04T00:43:41Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Fixed format divergence where `bd get --prefix` returned stale gate-format tasks while `bd get` and `bd list` returned DAG-format
- Ensured Projects/ directory is backed up and restored during installer upgrades across all 3 backup/restore loops

## Task Commits

Each task was committed atomically:

1. **Task 1: Add gate-to-DAG migration to getByPrefix()** - `2ecb79e` (fix)
2. **Task 2: Expand installer backup scope to include Projects/** - `a08a324` (fix)

## Files Created/Modified
- `src/store/task-store.ts` - Added lazy gate-to-DAG migration block to getByPrefix() matching get() and list()
- `scripts/install.sh` - Added Projects to all 3 backup/restore directory loops

## Decisions Made
- Replicated exact same migration pattern from get() into getByPrefix() for maximum consistency and minimal risk

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All three task-loading methods (get, getByPrefix, list) now apply gate-to-DAG migration consistently
- Installer backup scope is complete for project data preservation
- Ready for phase 18 (DAG-as-Default) with confidence that all access paths return consistent DAG-format tasks

## Self-Check: PASSED

- FOUND: src/store/task-store.ts
- FOUND: scripts/install.sh
- FOUND: 17-03-SUMMARY.md
- FOUND: commit 2ecb79e
- FOUND: commit a08a324

---
*Phase: 17-migration-foundation-framework-hardening*
*Completed: 2026-03-04*
