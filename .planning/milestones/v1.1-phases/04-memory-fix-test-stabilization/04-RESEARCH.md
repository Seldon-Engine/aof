# Phase 4: Memory Fix & Test Stabilization - Research

**Researched:** 2026-02-26
**Domain:** HNSW vector index resilience, CLI tooling, test suite repair
**Confidence:** HIGH

## Summary

The memory subsystem's HNSW index (via `hnswlib-node@3.0.0`) crashes on insert when at capacity and returns empty results when the index file is corrupt or out of sync with SQLite. The core bug is documented in BUG-001: "Hnswlib Error: The number of elements exceeds the specified limit." Investigation of the codebase confirms the `HnswIndex` wrapper class has a correct `ensureCapacity()` method that resizes the index, but the production HNSW file shows 0 elements while SQLite has data — a complete drift scenario where the index became corrupt or was never rebuilt after an earlier failure.

The fix requires three layers: (1) hardening the HNSW index wrapper to handle all edge cases (load-then-add, rebuild capacity headroom, save-after-resize), (2) adding startup parity checks and auto-rebuild when drift is detected, and (3) providing operator tooling (`aof memory health` and `aof memory rebuild`) for diagnosis and manual repair. Additionally, 11 pre-existing test failures across 4 test files need fixing — all are caused by tests written against stale APIs (executor tests assume blocking dispatch, lifecycle tests mock removed functions).

**Primary recommendation:** Fix the HNSW-SQLite drift detection on startup (auto-rebuild from SQLite when counts mismatch), add capacity headroom after rebuild (`chunks.length * 1.5`), persist index to disk after every write, and update all stale test mocks to match the current fire-and-forget executor and installService daemon APIs.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- On startup, run HNSW-SQLite parity check (count comparison) every time — negligible cost, catches drift early
- If HNSW index is missing or corrupt: auto-rebuild from SQLite with a visible warning in daemon output (not silent, not fatal)
- If HNSW and SQLite are out of sync (any desync, regardless of magnitude): full rebuild from SQLite. SQLite is the source of truth. No incremental patching.
- When HNSW resizes due to capacity: log `memory.index.resized` event to JSONL AND print a debug-level line to daemon output (visible with -v)
- `aof memory health` outputs a human-readable table by default, with `--json` flag for scriptable output
- Health metrics: HNSW count, SQLite count, sync status (ok/desynced), fragmentation %, last rebuild time, PLUS per-pool breakdown showing counts per memory pool
- `aof memory rebuild` shows a progress bar during rebuild (X/Y chunks indexed), then a summary table with before/after stats at the end
- Rebuild requires confirmation prompt: "This will rebuild the HNSW index from SQLite (X chunks). Continue? [y/N]" — skippable with `--yes` flag
- During rebuild, memory searches fall back to sqlite-vec path (already exists in VectorStore dual-search). Lower quality but no blocking.
- Concurrent memory writes from multiple agents are allowed, protected by a mutex around HNSW operations
- HNSW index is loaded once on startup and held in memory permanently (no load-on-demand / unload-idle)
- Index is persisted to disk after every write operation — crash safety over performance
- Fix all ~12 pre-existing test failures properly — investigate root cause, fix the actual issue
- If fixing a test reveals a real code bug (not just a test issue): fix the bug too. Keep the codebase honest.
- Add new integration tests for the memory fix code (HNSW resize, rebuild, parity check, save/load cycle)
- Green bar: zero test failures. test.skip with clear justification is acceptable for platform-specific tests.

### Claude's Discretion
- HNSW growth factor (currently 2x) — Claude can adjust if research suggests a better multiplier
- Exact mutex implementation (Node.js is single-threaded but async operations need coordination)
- sqlite-vec fallback search quality tuning during rebuild
- Progress bar library choice for `aof memory rebuild`

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| MEM-01 | HNSW index resizes automatically when capacity is reached (no insert crashes) | `ensureCapacity()` exists but needs verification it fires on all code paths including post-load; need to persist index after resize; add resize event logging |
| MEM-02 | HNSW-SQLite parity check runs on startup, logs mismatches | `registerMemoryModule()` in `src/memory/index.ts` is the startup path; add count comparison between `hnsw.count` and `SELECT COUNT(*) FROM vec_chunks`; log via EventLogger |
| MEM-03 | HNSW index rebuilds from SQLite when index file is missing or corrupt | `rebuildHnswFromDb()` already exists in `src/memory/index.ts`; needs to be called when parity check fails (not just when file is missing/corrupt) |
| MEM-04 | Memory search returns correct results after index resize and after save/load cycle | Need integration tests: insert N chunks, resize, search; save, load, search again; verify results match |
| MEM-05 | `aof memory health` shows index count, SQLite count, fragmentation %, last rebuild time | New CLI subcommand in `src/cli/commands/memory.ts`; needs access to HNSW index and SQLite db from CLI context |
| MEM-06 | `aof memory rebuild` forces full HNSW rebuild from SQLite with progress output | New CLI subcommand; progress bar during rebuild, confirmation prompt, before/after summary |
| CI-02 | Pre-existing test failures (~12) are fixed so CI passes green | 11 failures across 4 files: `executor.test.ts` (4), `openclaw-executor-platform-limit.test.ts` (4), `openclaw-executor-http.test.ts` (1), `init-steps-lifecycle.test.ts` (2) |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| hnswlib-node | 3.0.0 | HNSW approximate nearest neighbor index | Already in project, wraps hnswlib C++ library, provides `resizeIndex()`, `getMaxElements()`, `getCurrentCount()` |
| better-sqlite3 | 12.6.2 | SQLite database (source of truth for chunks) | Already in project, synchronous API ideal for transaction safety |
| sqlite-vec | 0.1.7-alpha.2 | SQLite vector extension (fallback search) | Already in project, provides `vec_chunks` virtual table for `MATCH` queries |
| commander | 14.0.3 | CLI framework | Already in project, all existing commands use it |
| vitest | (project version) | Test framework | Already in project, 2400+ existing tests |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| cli-progress | 3.x | Terminal progress bar | For `aof memory rebuild` progress display during index reconstruction |
| @inquirer/prompts | (project version) | Interactive prompts | Already in project, for rebuild confirmation prompt |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| cli-progress | Simple `process.stdout.write` with `\r` | cli-progress handles terminal width, ETA calculation, and edge cases; worth the small dep for a good operator experience |
| cli-progress | ora (spinner) | Spinner is for indeterminate progress; rebuild has known total count so a progress bar is better |

**Installation:**
```bash
npm install cli-progress
npm install -D @types/cli-progress
```

## Architecture Patterns

### Relevant Project Structure
```
src/memory/
├── store/
│   ├── hnsw-index.ts          # HnswIndex wrapper (FIX: load + resize + persist)
│   ├── vector-store.ts        # VectorStore (dual HNSW/sqlite-vec search)
│   ├── schema.ts              # SQLite schema initialization
│   └── hybrid-search.ts       # HybridSearchEngine
├── index.ts                   # registerMemoryModule() — startup path (FIX: parity check)
├── tools/
│   ├── store.ts               # memory_store tool
│   ├── search.ts              # memory_search tool
│   └── indexing.ts            # indexMemoryChunks + IndexSyncService
└── __tests__/                 # Memory unit tests

src/cli/commands/
├── memory.ts                  # CLI memory subcommands (ADD: health, rebuild)

src/openclaw/
├── openclaw-executor.ts       # OpenClawAdapter (fire-and-forget dispatch)
├── executor.ts                # Re-export of openclaw-executor

src/cli/
├── init-steps-lifecycle.ts    # runDaemonStep (now uses installService, not daemonStart)
```

### Pattern 1: HNSW-SQLite Parity Check on Startup
**What:** Compare `hnsw.count` with `SELECT COUNT(*) FROM vec_chunks` on every startup. If mismatch, rebuild from SQLite.
**When to use:** Every time `registerMemoryModule()` runs.
**Key insight:** The loaded HNSW file preserves its original `maxElements` from when it was saved. After load, `getCurrentCount()` and `getMaxElements()` reflect the saved state. If the SQLite has more rows (e.g., index was saved before a write completed), the HNSW is out of sync.

```typescript
// In registerMemoryModule() after hnsw.load():
const hnswCount = hnsw.count;
const sqliteCount = db.prepare("SELECT COUNT(*) as c FROM vec_chunks").get().c;
if (hnswCount !== sqliteCount) {
  console.warn(`[AOF] HNSW-SQLite desync detected (HNSW: ${hnswCount}, SQLite: ${sqliteCount}). Rebuilding...`);
  rebuildHnswFromDb(db, hnsw);
}
```

### Pattern 2: Save-After-Write for Crash Safety
**What:** Persist the HNSW index to disk after every write operation (add/update/remove).
**When to use:** After every mutation in VectorStore methods.
**Key insight:** Currently the HNSW index is only saved when the `memory-index-sync` service stops. If the process crashes between a write and the next save, the index is lost. The user decided crash safety over performance.

```typescript
// In VectorStore.insertChunk(), after hnsw.add():
this.hnsw?.add(chunkId, input.embedding);
this.saveIndex(); // new method
```

### Pattern 3: Mutex for Async HNSW Operations
**What:** Wrap HNSW mutations in an async mutex so concurrent agent writes don't interleave.
**When to use:** Around all HNSW add/update/remove/rebuild operations.
**Key insight:** Node.js is single-threaded, but `await` points (e.g., embedding generation) can interleave. Two concurrent `memory_store` calls could both call `ensureCapacity()`, both see `count >= max`, and both try to resize — the second resize would be a no-op but the capacity check could race. A lightweight promise-based mutex prevents this.

```typescript
// Simple promise-based mutex (no library needed)
class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise(resolve => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }
}
```

### Pattern 4: Rebuild with Fallback Search
**What:** During rebuild, set a flag that tells VectorStore to use sqlite-vec instead of HNSW for search.
**When to use:** Between rebuild start and rebuild end.
**Key insight:** `VectorStore.search()` already has dual-path logic: `if (this.hnsw) { searchWithHnsw() } else { searchWithSqliteVec() }`. During rebuild, temporarily set `this.hnsw = null` (or use a `rebuilding` flag), then restore after rebuild completes.

### Anti-Patterns to Avoid
- **Incremental patching of HNSW index:** The user explicitly decided: any desync triggers full rebuild. Don't try to diff and patch.
- **Loading HNSW on demand:** The user decided the index stays in memory permanently. Don't implement lazy loading.
- **Silent auto-rebuild:** All rebuilds must produce visible output (warnings for auto-rebuild, progress for manual rebuild).
- **Custom progress bar:** Use a library; terminal progress bars have many edge cases (terminal width, pipe detection, Windows).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Terminal progress bar | Custom `\r` overwrites | cli-progress | Handles terminal width, pipe detection, ETA, and edge cases |
| Async mutex | Inline promise juggling | Simple `Mutex` class (shown above) | Pattern is well-understood, 15 lines of code, no library needed for this use case |
| HNSW index wrapper | Direct hnswlib-node calls | Existing `HnswIndex` class | Already abstracts capacity management, persistence, rebuild; just needs fixes |
| SQLite transaction safety | Manual BEGIN/COMMIT | better-sqlite3 `.transaction()` | Already used in VectorStore, handles rollback correctly |

**Key insight:** The existing codebase already has good abstractions. The fixes are surgical: harden `HnswIndex.load()`, add parity check in `registerMemoryModule()`, add save-after-write, and add CLI commands.

## Common Pitfalls

### Pitfall 1: HNSW Load Without Capacity Check
**What goes wrong:** After loading from disk, the HNSW index has `maxElements` equal to when it was saved. If saved at full capacity, the next `addPoint()` fails.
**Why it happens:** `readIndexSync()` restores the exact state including `maxElements`. The wrapper's `ensureCapacity()` only runs inside `add()`, which is called AFTER load — but if `ensureCapacity` check is `count >= max` (which it is), this actually works correctly.
**How to avoid:** The `ensureCapacity()` in the existing code handles this correctly for the `add()` path. The real issue is when the index file is corrupt or out of sync with SQLite (0 elements in HNSW, N elements in SQLite). The parity check on startup catches this.
**Warning signs:** `hnsw.count === 0` when SQLite has rows; empty search results.

### Pitfall 2: HNSW-SQLite Drift from Non-Transactional Writes
**What goes wrong:** `VectorStore.insertChunk()` runs SQLite insert in a transaction, then calls `this.hnsw?.add()` OUTSIDE the transaction. If the process crashes between the SQLite commit and the HNSW add, SQLite has a row that HNSW doesn't know about.
**Why it happens:** HNSW is an in-memory data structure with disk persistence — it can't participate in SQLite transactions.
**How to avoid:** The save-after-every-write approach minimizes the window. The parity check on startup catches any remaining drift.
**Warning signs:** Count mismatch between HNSW and SQLite after a crash.

### Pitfall 3: Test Mocks Against Stale APIs
**What goes wrong:** Tests mock functions that no longer exist or have changed behavior.
**Why it happens:** The executor was refactored from blocking to fire-and-forget, and the daemon step was refactored from `daemonStart` to `installService`. Tests weren't updated.
**How to avoid:** When fixing tests, read the actual source code first. Match mocks to current imports and return types.
**Warning signs:** `expected true to be false` errors where mock returns success but test expects failure.

### Pitfall 4: Rebuild Capacity = Exact Chunk Count
**What goes wrong:** `rebuild()` uses `Math.max(chunks.length, INITIAL_CAPACITY)` — if you have exactly 10,000 chunks, the capacity is 10,000 and the index is immediately full.
**Why it happens:** No headroom is added during rebuild.
**How to avoid:** Add headroom: `Math.max(Math.ceil(chunks.length * 1.5), INITIAL_CAPACITY)`.
**Warning signs:** Rebuild succeeds but the very next insert triggers a resize.

### Pitfall 5: Progress Bar on Non-TTY Output
**What goes wrong:** Progress bars break when output is piped or redirected.
**Why it happens:** ANSI escape codes and carriage returns don't work in non-TTY contexts.
**How to avoid:** Check `process.stdout.isTTY` before using progress bars; fall back to simple line-by-line output.
**Warning signs:** Garbled output in CI or log files.

## Code Examples

### HNSW Index Health Check (verified against codebase)
```typescript
// Source: src/memory/store/hnsw-index.ts API + src/memory/store/schema.ts
interface MemoryHealthReport {
  hnswCount: number;
  sqliteCount: number;
  syncStatus: "ok" | "desynced";
  fragmentationPct: number;
  lastRebuildTime: string | null;
  pools: Array<{ pool: string; count: number }>;
}

function getMemoryHealth(db: SqliteDb, hnsw: HnswIndex): MemoryHealthReport {
  const hnswCount = hnsw.count;
  const sqliteCount = (db.prepare("SELECT COUNT(*) as c FROM vec_chunks").get() as { c: number }).c;
  const pools = db.prepare("SELECT pool, COUNT(*) as count FROM chunks GROUP BY pool").all() as Array<{ pool: string; count: number }>;

  // Fragmentation: deleted slots in HNSW that waste space
  const maxElements = hnsw.maxElements; // Need to expose this getter
  const fragmentation = maxElements > 0 ? ((maxElements - hnswCount) / maxElements) * 100 : 0;

  return {
    hnswCount,
    sqliteCount,
    syncStatus: hnswCount === sqliteCount ? "ok" : "desynced",
    fragmentationPct: Math.round(fragmentation * 10) / 10,
    lastRebuildTime: null, // Track via metadata file or event log
    pools,
  };
}
```

### CLI Health Command Pattern (matches existing CLI structure)
```typescript
// Source: src/cli/commands/memory.ts pattern
memory
  .command("health")
  .description("Show memory index health metrics")
  .option("--json", "Output as JSON", false)
  .action(async (opts: { json: boolean }) => {
    const report = getMemoryHealth(db, hnsw);
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("Memory Health Report");
      console.log(`  HNSW count:      ${report.hnswCount}`);
      console.log(`  SQLite count:    ${report.sqliteCount}`);
      console.log(`  Sync status:     ${report.syncStatus}`);
      console.log(`  Fragmentation:   ${report.fragmentationPct}%`);
      console.log(`  Last rebuild:    ${report.lastRebuildTime ?? "never"}`);
      // per-pool breakdown...
    }
  });
```

### VectorStore Save-After-Write Pattern
```typescript
// Source: Extending src/memory/store/vector-store.ts
export class VectorStore {
  private readonly hnswPath: string | null;

  constructor(db: SqliteDb, hnsw: HnswIndex | null = null, hnswPath?: string) {
    // ...existing...
    this.hnswPath = hnswPath ?? null;
  }

  private saveIndex(): void {
    if (this.hnsw && this.hnswPath) {
      this.hnsw.save(this.hnswPath);
    }
  }

  insertChunk(input: VectorChunkInput): number {
    // ...existing SQLite transaction...
    const chunkId = insert();
    this.hnsw?.add(chunkId, input.embedding);
    this.saveIndex(); // NEW: crash safety
    return chunkId;
  }
}
```

## Test Failure Analysis

### Detailed Root Causes (11 failures, 4 files)

**File 1: `src/openclaw/__tests__/executor.test.ts`** (4 failures)
- Tests import `OpenClawAdapter` from `../executor.js` (re-export of `openclaw-executor.js`)
- Tests were written for the old **blocking** dispatch behavior: mock `runEmbeddedPiAgent` → call `spawnSession()` → assert on result
- The actual code now uses **fire-and-forget**: `spawnSession()` returns `{ success: true, sessionId }` immediately, agent runs in background
- **Failing tests and fixes:**
  - `spawns agent session successfully`: Expects `result.sessionId` to equal the agent's returned sessionId ("session-12345"), but actual returns a generated UUID. Fix: expect `success: true` and a UUID sessionId.
  - `handles spawn failure gracefully`: Mocks agent returning an error in `meta.error`, expects `success: false`. Actual: fire-and-forget returns `success: true`; errors are logged in background. Fix: update test to match fire-and-forget semantics.
  - `respects timeout option`: Expects `timeoutMs: 60000` in call params, but code does `Math.max(opts.timeoutMs, 300_000)`. Fix: either update test expectation to 300_000, or test with value > 300_000.
  - `handles API exceptions`: Mocks `mockRejectedValueOnce`, expects `success: false`. Actual: rejection happens in background. Fix: update to match fire-and-forget semantics.

**File 2: `src/openclaw/__tests__/openclaw-executor-platform-limit.test.ts`** (4 failures)
- Same root cause: tests expect **blocking** behavior from fire-and-forget `spawnSession()`
- Mocks `mockRejectedValueOnce` for `runEmbeddedPiAgent`, expects `success: false` + `platformLimit` parsing
- Actual: rejection happens in background; `spawnSession()` returns `success: true` for setup that doesn't throw
- **Fix:** Platform limit errors only surface if the `try` block in `spawnSession()` throws (setup errors like `ensureAgentWorkspace` failing). The `runEmbeddedPiAgent` errors happen in background. Either: (a) restructure tests to test background error handling, or (b) test platform limit parsing via a setup-stage error (e.g., make `resolveAgentWorkspaceDir` throw with a platform limit message).

**File 3: `src/openclaw/__tests__/openclaw-executor-http.test.ts`** (1 failure)
- `uses custom timeout from opts`: Passes `timeoutMs: 60_000`, expects it in call params
- Code: `Math.max(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)` where DEFAULT = 300_000
- **Fix:** Either test with `timeoutMs: 600_000` (above minimum), or update the test expectation to `300_000`.

**File 4: `src/cli/__tests__/init-steps-lifecycle.test.ts`** (2 failures)
- `11: PID file absent + user confirms → calls daemonStart, daemonRunning=true`: Mocks `daemonStart` from `../commands/daemon.js`, but actual code dynamically imports `installService` from `../daemon/service-file.js`. Mock never fires.
  - **Fix:** Mock `../daemon/service-file.js` with `installService` instead of `../commands/daemon.js` with `daemonStart`.
- `13: daemonStart throws → warning added, daemonRunning=false`: Expects `"Daemon start failed"` in warnings, but actual code says `"Daemon install failed"`.
  - **Fix:** Update expected string to match actual, and mock the correct module.

## Architecture Challenge: CLI Access to Runtime HNSW Index

The `aof memory health` and `aof memory rebuild` commands need access to the HNSW index and SQLite database. Currently:
- The HNSW index is constructed inside `registerMemoryModule()` which runs in the gateway plugin context
- The CLI (`src/cli/index.ts`) does NOT have access to the plugin runtime
- The SQLite database CAN be opened independently (just need the path)
- The HNSW file CAN be loaded independently (just need the path and dimensions)

**Approach:** The CLI commands open their own SQLite database and HNSW index file directly, independent of the daemon/gateway process. This avoids needing IPC with the running daemon.

```
aof memory health:
  1. Open SQLite at ~/.openclaw/aof/memory.db
  2. Load HNSW at ~/.openclaw/aof/memory-hnsw.dat
  3. Compare counts, compute fragmentation, query pools
  4. Output report

aof memory rebuild:
  1. Open SQLite at ~/.openclaw/aof/memory.db
  2. Read all embeddings from vec_chunks
  3. Build new HNSW index with progress bar
  4. Save to ~/.openclaw/aof/memory-hnsw.dat
  5. Output before/after summary
```

**Caveat:** If the daemon is running, it holds the HNSW index in memory. The CLI rebuild writes a new file, but the daemon still has the old one in memory. The next daemon restart will pick up the new file. This is acceptable per the user's decision (the daemon holds the index permanently in memory).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single HierarchicalNSW with fixed capacity | HnswIndex wrapper with auto-resize | Initial implementation (AOF-bm2) | Already in place |
| Blocking executor dispatch | Fire-and-forget via `void this.runAgentBackground()` | Pre-v1.1 refactor | Tests not updated (4 files failing) |
| `daemonStart()` for daemon management | `installService()` for OS-supervised daemon | Pre-v1.1 refactor | Lifecycle tests not updated (2 tests failing) |
| HNSW saved only on service stop | Needs save-after-write | Phase 4 (new) | Crash safety improvement |

## Open Questions

1. **Last rebuild time tracking**
   - What we know: No current mechanism tracks when the HNSW index was last rebuilt
   - What's unclear: Should this be stored in a metadata file, a SQLite table, or parsed from event logs?
   - Recommendation: Add a simple `memory_meta` table in SQLite with key-value pairs (e.g., `last_rebuild_time`). Simplest, no extra files.

2. **HNSW dimensions from CLI context**
   - What we know: Dimensions (768 or 1536) are configured in the plugin config, not available to CLI directly
   - What's unclear: How does the CLI know the embedding dimensions when loading the HNSW index?
   - Recommendation: Store dimensions in the HNSW metadata or derive from SQLite `vec_chunks` table (the embedding column has fixed dimensions). Alternatively, use `getNumDimensions()` on the loaded HNSW index (it's available after `readIndexSync`).

3. **Concurrent CLI rebuild vs running daemon**
   - What we know: CLI rebuild writes a new HNSW file; daemon holds the old one in memory
   - What's unclear: Should the CLI warn if the daemon is running?
   - Recommendation: Check PID file at `~/.openclaw/aof/daemon.pid`, warn if daemon is running but proceed anyway. The daemon will pick up the new file on next restart.

## Sources

### Primary (HIGH confidence)
- **Codebase inspection** — `src/memory/store/hnsw-index.ts`, `src/memory/store/vector-store.ts`, `src/memory/index.ts` (startup path), `src/cli/commands/memory.ts` (CLI structure)
- **hnswlib-node@3.0.0 API** — Verified methods via runtime inspection: `resizeIndex()`, `getMaxElements()`, `getCurrentCount()`, `getNumDimensions()`, `readIndexSync()`, `writeIndexSync()`
- **Live testing** — Confirmed: (1) loaded index preserves `maxElements` from save, (2) `resizeIndex()` works after load, (3) `ensureCapacity()` logic correctly triggers resize, (4) production HNSW file has 0 elements while SQLite has data

### Secondary (MEDIUM confidence)
- **Test failure analysis** — All 11 failures analyzed by running `npx vitest run` and reading test + source code. Root causes confirmed: API drift (blocking → fire-and-forget executor, daemonStart → installService)
- **BUG-001** in `bug-reports.md` — Documents the exact error and symptoms

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already in project, verified versions and APIs via runtime
- Architecture: HIGH — based on direct codebase inspection, tested HNSW behavior empirically
- Pitfalls: HIGH — verified HNSW load behavior, confirmed test failure root causes by running tests
- Test fixes: HIGH — exact root causes identified for all 11 failures with specific fix strategies

**Research date:** 2026-02-26
**Valid until:** 2026-03-26 (stable domain, no external dependency changes expected)
