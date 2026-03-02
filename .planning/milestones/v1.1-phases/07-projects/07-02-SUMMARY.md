---
phase: 07-projects
plan: 02
subsystem: memory
tags: [hnsw, sqlite, vector-store, project-isolation, per-project-memory, lazy-initialization]

# Dependency graph
requires:
  - phase: 04-memory-fix-test-stabilization
    provides: "Hardened VectorStore/HnswIndex with parity check, auto-resize, save-after-write"
provides:
  - Per-project memory store factory with lazy initialization (getProjectMemoryStore)
  - Project-aware memory tools (search, store, update, delete, list) with `project` parameter routing
  - saveAllProjectMemory() for graceful shutdown of all project HNSW indices
  - 6 isolation tests proving complete storage-level memory separation between projects
affects: [07-03]

# Tech tracking
tech-stack:
  added: []
  patterns: [per-project-memory-isolation, lazy-store-initialization, project-param-tool-routing]

key-files:
  created:
    - src/memory/project-memory.ts
    - src/memory/__tests__/project-memory.test.ts
  modified:
    - src/memory/index.ts

key-decisions:
  - "Inlined rebuildHnswFromDb in project-memory.ts to avoid circular dependency with index.ts"
  - "Lazy initialization (not eager) to avoid startup overhead for projects not using memory"
  - "Project root resolved as vaultRoot/Projects/<projectId> via resolve(dataDir, '..')"
  - "memory_get tool left unchanged (operates by chunk ID on global DB)"

patterns-established:
  - "Per-project memory: each project gets Projects/<id>/memory/memory.db + memory-hnsw.dat"
  - "Project tool routing: tools accept optional `project` param, delegate to project-scoped tool instance"
  - "Lazy store cache: Map<projectRoot, ProjectMemoryStore> initialized on first access"

requirements-completed: [PROJ-04]

# Metrics
duration: 4min
completed: 2026-02-26
---

# Phase 7 Plan 02: Per-Project Memory Isolation Summary

**Per-project memory isolation with separate SQLite DB + HNSW index per project, project-aware memory tools, and 6 isolation tests proving zero cross-contamination**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-26T21:31:05Z
- **Completed:** 2026-02-26T21:35:55Z
- **Tasks:** 2
- **Files modified:** 3 (2 created, 1 modified)

## Accomplishments
- Each project gets its own SQLite DB and HNSW index at Projects/<id>/memory/, completely isolated at the storage level
- All 5 memory tools (search, store, update, delete, list) accept optional `project` parameter for project-scoped operations
- Global memory continues to work unchanged when no `project` param is provided (full backward compatibility)
- Lazy initialization avoids startup overhead for projects that don't use memory
- Per-project memory inherits all Phase 4 hardening (parity check, auto-resize, save-after-write) via reused VectorStore/HnswIndex classes
- 6 isolation tests verify: separate instances, caching, data isolation, parity check, correct file paths, hybrid search engine isolation

## Task Commits

Each task was committed atomically:

1. **Task 1: Create per-project memory store factory** - `62ddcdd` (feat)
2. **Task 2: Register project memory tools and write isolation tests** - `000e198` (feat)

## Files Created/Modified
- `src/memory/project-memory.ts` - Per-project memory store factory with lazy init, parity check, HNSW rebuild, cache, saveAll/clearCache helpers
- `src/memory/index.ts` - Project-aware tool wrappers for all 5 memory tools, project memory exports, shutdown handler integration
- `src/memory/__tests__/project-memory.test.ts` - 6 isolation tests proving memory separation between projects

## Decisions Made
- Inlined `rebuildHnswFromDb` in project-memory.ts rather than creating a separate utility module, to avoid the circular dependency (project-memory -> index -> project-memory) cleanly with minimal file changes
- Lazy initialization chosen over eager to match research recommendation -- avoids startup overhead for projects that don't actively use memory
- Project root path resolved as `resolve(dataDir, "..") + /Projects/<projectId>` (heuristic that works when dataDir is the AOF data directory within the vault root)
- Left `memory_get` tool unchanged since it operates on raw chunk IDs and is not project-scoped

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed test code using non-existent VectorStore API**
- **Found during:** Task 2 (writing isolation tests)
- **Issue:** Plan's test code used `storeA.vectorStore.add()` and `storeA.vectorStore.count` which do not exist on VectorStore. The actual API is `insertChunk()` and count is on `hnsw.count`.
- **Fix:** Rewrote tests to use `vectorStore.insertChunk(makeChunkInput(...))` and `hnsw.count` for assertions
- **Files modified:** `src/memory/__tests__/project-memory.test.ts`
- **Verification:** All 6 tests pass
- **Committed in:** 000e198 (Task 2 commit)

**2. [Rule 1 - Bug] Fixed linter removing unused `resolve` import**
- **Found during:** Task 2 (updating index.ts)
- **Issue:** Initial edit approach was incremental, but a linter auto-stripped unused imports and reverted partial edits
- **Fix:** Rewrote index.ts completely with all changes atomically to prevent linter interference
- **Files modified:** `src/memory/index.ts`
- **Verification:** tsc --noEmit passes clean
- **Committed in:** 000e198 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 bugs -- 1 in plan's test code, 1 tooling interaction)
**Impact on plan:** Minor corrections, no scope creep. All plan objectives achieved.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Per-project memory isolation is complete, ready for integration tests in Plan 03
- The `getProjectMemoryStore` function can be called from any context with a project root path
- Project-aware tools automatically route based on `project` parameter

## Self-Check: PASSED

All files verified present. All 2 task commits verified in git log.

---
*Phase: 07-projects*
*Completed: 2026-02-26*
