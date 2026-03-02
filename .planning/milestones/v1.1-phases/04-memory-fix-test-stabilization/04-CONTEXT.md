# Phase 4: Memory Fix & Test Stabilization - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Fix the broken HNSW memory subsystem (capacity crash, empty search results), add operator health and rebuild tooling via CLI, and get the full test suite to green. Requirements: MEM-01 through MEM-06, CI-02.

The HNSW index hit its capacity ceiling. Inserts crash with "Hnswlib Error: The number of elements exceeds the specified limit." Search returns empty results. The memory subsystem is functionally broken. This phase restores it, adds resilience against future drift, and provides operator tooling to diagnose and repair index health.

</domain>

<decisions>
## Implementation Decisions

### Recovery behavior
- On startup, run HNSW-SQLite parity check (count comparison) every time — negligible cost, catches drift early
- If HNSW index is missing or corrupt: auto-rebuild from SQLite with a visible warning in daemon output (not silent, not fatal)
- If HNSW and SQLite are out of sync (any desync, regardless of magnitude): full rebuild from SQLite. SQLite is the source of truth. No incremental patching.
- When HNSW resizes due to capacity: log `memory.index.resized` event to JSONL AND print a debug-level line to daemon output (visible with -v)

### Health & rebuild CLI
- `aof memory health` outputs a human-readable table by default, with `--json` flag for scriptable output
- Health metrics: HNSW count, SQLite count, sync status (ok/desynced), fragmentation %, last rebuild time, PLUS per-pool breakdown showing counts per memory pool
- `aof memory rebuild` shows a progress bar during rebuild (X/Y chunks indexed), then a summary table with before/after stats at the end
- Rebuild requires confirmation prompt: "This will rebuild the HNSW index from SQLite (X chunks). Continue? [y/N]" — skippable with `--yes` flag

### Concurrent access
- During rebuild, memory searches fall back to sqlite-vec path (already exists in VectorStore dual-search). Lower quality but no blocking.
- Concurrent memory writes from multiple agents are allowed, protected by a mutex around HNSW operations
- HNSW index is loaded once on startup and held in memory permanently (no load-on-demand / unload-idle)
- Index is persisted to disk after every write operation — crash safety over performance

### Test failure strategy
- Fix all ~12 pre-existing test failures properly — investigate root cause, fix the actual issue
- If fixing a test reveals a real code bug (not just a test issue): fix the bug too. Keep the codebase honest.
- Add new integration tests for the memory fix code (HNSW resize, rebuild, parity check, save/load cycle)
- Green bar: zero test failures. test.skip with clear justification is acceptable for platform-specific tests.

### Claude's Discretion
- HNSW growth factor (currently 2x) — Claude can adjust if research suggests a better multiplier
- Exact mutex implementation (Node.js is single-threaded but async operations need coordination)
- sqlite-vec fallback search quality tuning during rebuild
- Progress bar library choice for `aof memory rebuild`

</decisions>

<specifics>
## Specific Ideas

- BUG-001 in bug-reports.md documents the exact error: "Hnswlib Error: The number of elements exceeds the specified limit" on `memory_store`, and empty results from `memory_search`
- Research identified that `ensureCapacity()` exists but may not fire correctly after index load (load path skips capacity check)
- Research found HNSW/SQLite dual-store drift is the most dangerous pitfall — add() happens outside SQLite transaction
- Per-pool breakdown in health output maps to the existing memory pool concept (agents have pool assignments in org chart)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-memory-fix-test-stabilization*
*Context gathered: 2026-02-26*
