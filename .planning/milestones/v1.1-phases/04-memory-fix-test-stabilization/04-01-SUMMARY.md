---
phase: 04-memory-fix-test-stabilization
plan: 01
subsystem: memory
tags: [hnsw, hnswlib-node, sqlite, vector-store, crash-safety, mutex, parity-check]

# Dependency graph
requires:
  - phase: none
    provides: n/a
provides:
  - Hardened HnswIndex with maxElements/dimensions getters, 1.5x rebuild headroom, resize logging
  - VectorStore save-after-write crash safety, rebuilding flag for sqlite-vec fallback
  - Startup HNSW-SQLite parity check with auto-rebuild on desync
  - memory_meta table for last_rebuild_time tracking
  - rebuildHnswFromDb exported for CLI rebuild command
  - 7 integration tests proving MEM-01 through MEM-04
affects: [04-02, 04-03]

# Tech tracking
tech-stack:
  added: []
  patterns: [save-after-write, startup-parity-check, mutex-for-async-coordination, rebuilding-fallback]

key-files:
  created:
    - src/memory/__tests__/hnsw-resilience.test.ts
  modified:
    - src/memory/store/hnsw-index.ts
    - src/memory/store/vector-store.ts
    - src/memory/index.ts

key-decisions:
  - "Kept HNSW growth factor at 2x (existing value adequate, no evidence for change)"
  - "Mutex class added to VectorStore but synchronous methods unchanged (all operations synchronous via better-sqlite3 and hnswlib-node)"
  - "rebuildHnswFromDb exported so CLI rebuild command (Plan 03) can reuse it"
  - "Freshly rebuilt index saved to disk immediately after rebuild for durability"

patterns-established:
  - "Save-after-write: every HNSW mutation persists to disk immediately"
  - "Startup parity check: count HNSW vs SQLite on every boot, rebuild on any mismatch"
  - "Rebuilding fallback: set rebuilding=true to route search through sqlite-vec during index reconstruction"

requirements-completed: [MEM-01, MEM-02, MEM-03, MEM-04]

# Metrics
duration: 5min
completed: 2026-02-26
---

# Phase 4 Plan 01: HNSW Hardening Summary

**Hardened HNSW index with auto-resize, save-after-write crash safety, startup parity check with auto-rebuild, and 7 integration tests proving resilience**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-26T15:04:15Z
- **Completed:** 2026-02-26T15:09:39Z
- **Tasks:** 3
- **Files modified:** 4 (3 modified, 1 created)

## Accomplishments
- HNSW inserts never crash regardless of index size -- auto-resize via ensureCapacity on every add
- Startup parity check catches all drift between HNSW and SQLite, triggers visible-warning rebuild
- Every write operation persists index to disk immediately (crash safety over performance)
- 7 integration tests prove: capacity overflow, load-then-insert resize, desync detection, rebuild from SQLite, save/load consistency, rebuilding-flag fallback

## Task Commits

Each task was committed atomically:

1. **Task 1: Harden HnswIndex and VectorStore** - `95cdc03` (feat)
2. **Task 2: Startup parity check and auto-rebuild** - `1adb41c` (feat)
3. **Task 3: Integration tests for HNSW resilience** - `a978fcc` (test)

## Files Created/Modified
- `src/memory/store/hnsw-index.ts` - Added maxElements/dimensions getters, 1.5x rebuild headroom, resize event logging callback
- `src/memory/store/vector-store.ts` - Added hnswPath, saveIndex(), Mutex class, rebuilding flag for sqlite-vec fallback
- `src/memory/index.ts` - Added startup parity check, auto-rebuild on desync/missing/corrupt, memory_meta table, exported rebuildHnswFromDb
- `src/memory/__tests__/hnsw-resilience.test.ts` - 7 integration tests covering MEM-01 through MEM-04

## Decisions Made
- Kept HNSW growth factor at 2x -- existing value is adequate, no evidence to change
- Added Mutex class for future async coordination but did not make synchronous methods async (all current HNSW/SQLite operations are synchronous)
- Exported `rebuildHnswFromDb` so the CLI rebuild command in Plan 03 can reuse it directly
- Saved freshly rebuilt index to disk immediately after rebuild (not just on service stop)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed test assertion for parity check rebuild**
- **Found during:** Task 3 (integration tests)
- **Issue:** Test assumed first inserted chunk would be nearest neighbor with `seededEmbedding(0)`, but with cosine distance among 20 similar seeded embeddings, the IDs were not predictable
- **Fix:** Used a clearly distinguishable target embedding `[1,0,0,0,0,0,0,0]` with all other chunks having orthogonal embedding `[0,0,0,0,0,0,0,1]`, making the assertion deterministic
- **Files modified:** `src/memory/__tests__/hnsw-resilience.test.ts`
- **Verification:** All 7 tests pass green
- **Committed in:** a978fcc (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 bug in test logic)
**Impact on plan:** Minor test fix, no scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- HNSW subsystem is hardened and tested, ready for CLI tooling (Plan 03: `aof memory health` and `aof memory rebuild`)
- `rebuildHnswFromDb` is exported and ready for CLI use
- `memory_meta` table is created and populated with `last_rebuild_time` for health reporting
- VectorStore `rebuilding` flag is ready for rebuild command to set during reconstruction
- Pre-existing test failures (Plan 02) can proceed independently

## Self-Check: PASSED

All files verified present. All 3 task commits verified in git log.

---
*Phase: 04-memory-fix-test-stabilization*
*Completed: 2026-02-26*
