# Domain Pitfalls: v1.1 Stabilization & Ship

**Domain:** Adding memory scaling fix, installer/updater, CI pipeline, and multi-project verification to an existing TypeScript agent orchestration system
**Researched:** 2026-02-26
**Confidence:** HIGH (codebase inspection of all four subsystems + hnswlib-node behavior analysis + CI/release tooling research)

---

## Critical Pitfalls

Mistakes that cause data loss, broken releases, or require rewrites.

### Pitfall 1: HNSW Index Rebuild Loses Data When SQLite and HNSW Drift Apart

**What goes wrong:**
The `rebuildHnswFromDb()` function in `src/memory/index.ts` (lines 59-70) reads all rows from `vec_chunks` and calls `hnsw.rebuild()`. This is the recovery path when the `.dat` file is missing or corrupt. The pitfall: if a crash happens *between* a successful SQLite INSERT (inside the transaction in `VectorStore.insertChunk()`, line 172-193) and the subsequent `hnsw.add()` call (line 197), the SQLite row exists but the HNSW index doesn't have it. This is fine -- rebuild recovers it.

But the **real danger is the reverse**: `ensureCapacity()` calls `this.index.resizeIndex(max * GROWTH_FACTOR)` (line 129). If `resizeIndex` succeeds, `addPoint` is called, and then the SQLite transaction *fails* (disk full, WAL corruption, constraint violation), the HNSW index has a vector that SQLite doesn't. On the next `searchWithHnsw()`, HNSW returns an ID, the SQL lookup (`WHERE id IN (...)`) returns no row for it, and it's silently dropped from results. Worse: if chunk IDs are reused after a delete-and-reinsert cycle, HNSW might return a stale vector's ID that now maps to a *different* chunk in SQLite. The user gets the wrong memory content.

The current code adds to HNSW *outside* the SQLite transaction (line 197 is after the transaction closure on line 195), so there is no rollback coordination between the two stores.

**Why it happens:**
HNSW (via hnswlib-node) is a C++ data structure with no transaction semantics. It cannot participate in SQLite's transaction. The "add to HNSW after SQLite commit" pattern is the correct ordering (only add if commit succeeded), but there is no mechanism to detect or recover from partial failures in the other direction.

**Consequences:**
- Search returns wrong content (stale HNSW ID maps to new SQLite row).
- Search silently drops results (HNSW ID has no corresponding SQLite row).
- Memory corruption is invisible -- user stores information, searches succeed, but results are wrong.

**Prevention:**
1. After rebuild, verify HNSW count matches SQLite count: `SELECT COUNT(*) FROM vec_chunks` must equal `hnsw.count`. Log a warning and re-rebuild if they diverge.
2. In `searchWithHnsw()` (line 279-310), the existing code already handles missing rows by only returning rows found in SQLite. Add a metric: if `hits.length !== rows.length`, log a drift warning.
3. Add a `memory:verify` CLI command that compares HNSW state against SQLite and reports discrepancies.
4. On daemon shutdown (the `stop` handler at line 152), always save HNSW *after* ensuring SQLite WAL is checkpointed (`PRAGMA wal_checkpoint(TRUNCATE)`). This prevents the scenario where HNSW is saved with state that SQLite hasn't flushed to disk.

**Detection:**
- Search results contain empty or mismatched content.
- `hnsw.count` differs from `SELECT COUNT(*) FROM vec_chunks`.
- Event log shows `memory.search` events with fewer results than expected.

**Phase to address:** Memory subsystem fix (first priority -- data integrity).

---

### Pitfall 2: HNSW markDelete Accumulation Degrades Search Quality Over Time

**What goes wrong:**
The `HnswIndex.remove()` method (line 55-59) calls `markDelete()`, which flags a node in the HNSW graph as deleted but does not remove it from the graph structure. Over time, with many updates and deletes (which are delete + insert), the index accumulates "tombstones" -- deleted nodes that still occupy graph edges.

This is a known HNSW algorithm limitation documented in academic research: "After substantial sequences of delete, insert, and query operations, the current HNSW index manifests shortcomings where specific data points may become inaccessible" (the "unreachable points phenomenon"). The `update()` method (line 43-51) marks the old entry deleted then inserts with `replaceDeleted: true`, which reuses the slot but not the graph edges. After hundreds of update cycles, the graph topology degrades and nearest-neighbor accuracy drops silently.

The INITIAL_CAPACITY is 10,000 and GROWTH_FACTOR is 2 (lines 9-10). Once the index has been resized to 20,000+ capacity but only has 5,000 live entries (the rest deleted), memory usage is 4x what it should be, and search must traverse deleted nodes to find live ones.

**Why it happens:**
HNSW indexes are append-only graph structures by design. Deletion is O(1) (just flag it), but reclaiming the graph edges from deleted nodes requires a full rebuild. hnswlib provides no incremental garbage collection.

**Consequences:**
- Search recall drops from ~95% to ~70% after thousands of update cycles.
- Memory usage grows without bound (deleted nodes still consume RAM).
- P99 search latency increases as the graph becomes sparse.
- This is invisible in testing because tests use small indexes with few delete/update cycles.

**Prevention:**
1. Track a `tombstoneRatio = (maxElements - liveCount) / maxElements`. When it exceeds 0.5 (50% dead), trigger a rebuild from SQLite.
2. Add the rebuild-on-high-tombstone-ratio to the daemon's periodic maintenance cycle (alongside HNSW save).
3. The existing `rebuild()` method (line 98-105) is correct for this: read all live chunks from SQLite, rebuild fresh. Wire it into a scheduled maintenance task.
4. Log the tombstone ratio on every HNSW save so operators can see the trend.
5. In the performance test (hnsw-index.test.ts line 207-243), add a test that does 5000 insert/delete cycles then verifies recall is still above 90%.

**Detection:**
- Agents report "I searched memory but found nothing relevant" for topics that should have matches.
- HNSW `count` stays high even after bulk deletes.
- Search latency gradually increases over weeks of operation.

**Phase to address:** Memory subsystem fix (capacity planning).

---

### Pitfall 3: Installer Overwrites Running Daemon State

**What goes wrong:**
The `selfUpdate()` function in `src/packaging/updater.ts` (lines 59-189) removes the old installation contents and copies new files into `aofRoot`. The `preservePaths` default is `["config", "data", "tasks", "events"]` (line 64). Critically absent from this list:
- `daemon.pid` -- the PID file for the running daemon.
- `memory.db` and `memory-hnsw.dat` -- the SQLite database and HNSW index.
- `state/` -- scheduler state, lease files, heartbeat files.
- `.aof/migrations.json` -- migration history.

If a user runs `aof update` while the daemon is running (which they will, because the daemon is supposed to run always-on under launchd/systemd):
1. The update removes `daemon.pid` -- but the daemon process is still running.
2. The update removes `memory.db` -- the daemon has an open file descriptor, so SQLite might survive on Linux (file still accessible via fd), but on macOS HFS+ the file is *immediately deleted* and the fd becomes invalid.
3. After update, the user starts a "new" daemon -- now two daemons run, both claiming the same port and task store. File locks become critical.

**Why it happens:**
The updater was built as a standalone operation ("stop, update, restart") but there's no mechanism to stop the daemon before updating, and the `preservePaths` list doesn't cover all runtime state.

**Consequences:**
- Data loss: SQLite database deleted while daemon has it open.
- Dual daemon: old daemon still running, new daemon starts alongside it.
- State corruption: lease files, heartbeat files removed mid-operation.
- Migration history lost: updater doesn't know which migrations were applied.

**Prevention:**
1. **Gate the update on daemon stop.** `selfUpdate()` must check if the daemon is running (PID file + process verification) and refuse to proceed, or stop it automatically.
2. Expand `preservePaths` to include ALL runtime state: `["config", "data", "tasks", "events", "state", "memory", ".aof"]`. Better: use an exclude-list (only replace `src/`, `dist/`, `package.json`, `node_modules/`) instead of a preserve-list.
3. Add the SQLite database path to the preserve list explicitly: `memory.db`, `memory-hnsw.dat`.
4. After update, run pending migrations automatically (`runMigrations()` from `src/packaging/migrations.ts`).
5. On macOS, `launchctl bootout` the LaunchAgent before update, `launchctl bootstrap` after.

**Detection:**
- User reports "all my memories are gone" after update.
- Two daemon processes visible in `ps`.
- `aof daemon status` shows unexpected PID.

**Phase to address:** Installer/updater (must be solved before the first public update).

---

### Pitfall 4: curl | sh Installer Fails on Partial Download Without Error

**What goes wrong:**
A `curl | sh` installer streams the script directly into the shell. If the network connection drops mid-download, `sh` executes whatever it received -- which might be a truncated command. For example, if the script contains:

```bash
rm -rf /tmp/aof-staging
mkdir -p ~/.openclaw/aof
cp -R /tmp/aof-staging/* ~/.openclaw/aof/
```

And the download cuts off after `rm -rf /tmp/aof-staging`, the user's staging directory is deleted but nothing is copied. The shell exits 0 (the `rm` succeeded). The user thinks the install worked.

A more insidious variant: the server can detect when `curl` output is piped to `sh` (by timing the TCP read patterns) and could serve a different script to piped vs direct downloads. This is documented in security research.

**Why it happens:**
`curl | sh` doesn't buffer the entire script before execution. Shell executes lines as they arrive. There's no integrity check on the full script content.

**Consequences:**
- Partial installation appears to succeed (exit 0).
- Existing installation destroyed (cleanup ran but copy didn't).
- User's trust in the install mechanism is broken.

**Prevention:**
1. **Wrap the entire script in a function** that's called at the end. If download is interrupted, the function is never invoked. This is the standard defense used by Homebrew, rustup, and nvm:
   ```bash
   install_aof() {
     # all install logic here
   }
   install_aof
   ```
2. Include a checksum verification step early in the script that downloads the tarball, verifies its SHA256, then extracts.
3. Provide an alternative: `curl -fsSL https://aof.dev/install.sh -o install.sh && sh install.sh` -- download first, then execute.
4. Use `set -euo pipefail` at the top so any command failure aborts the script.
5. Add platform detection (macOS vs Linux, x86_64 vs arm64) at the start and fail fast with a clear message for unsupported platforms.

**Detection:**
- Users report `~/.openclaw/aof/` exists but is empty or missing key files.
- `aof --version` fails after "successful" install.

**Phase to address:** Installer (before any public distribution).

---

### Pitfall 5: CI Native Addon Builds Fail on GitHub Actions (better-sqlite3 + hnswlib-node)

**What goes wrong:**
AOF depends on two native Node.js addons:
- `better-sqlite3` -- requires C++ compilation via node-gyp.
- `hnswlib-node` -- requires C++ compilation with NAPI bindings.

On GitHub Actions (Ubuntu), `npm ci` triggers native compilation. This fails when:
1. Node.js version doesn't match prebuilt binary version (prebuild-install can't find a match, falls back to node-gyp compilation, which requires `python3`, `make`, `g++`).
2. Node.js major version upgrade changes V8 APIs -- better-sqlite3 v12+ has documented failures on Node 24 and 25 due to deprecated V8 APIs.
3. GitHub Actions' `ubuntu-latest` changes OS version (Ubuntu 22.04 -> 24.04) and the prebuild binaries are compiled for the old glibc.

This creates the "works on my Mac, fails in CI" problem that blocks every pull request.

**Why it happens:**
Native addons need to match the exact Node.js ABI version + OS + architecture. Prebuilt binaries are published for common combinations but not all. When `prebuild-install` falls back to compilation, build tools must be installed.

**Consequences:**
- CI is red on day one.
- Every Node.js version bump risks breaking CI.
- New contributors can't get tests passing.
- Release pipeline is blocked.

**Prevention:**
1. Pin Node.js version in CI to match development (Node 22 LTS -- not `latest`, not `lts/*`). Use exact version: `node-version: '22.13.1'`.
2. Install build tools in CI: `apt-get install -y python3 make g++` before `npm ci`.
3. Cache `node_modules` in CI keyed by `package-lock.json` hash + OS + Node version. This avoids recompiling native addons on every run.
4. Add a `postinstall` script that verifies native addons loaded: `node -e "require('better-sqlite3'); require('hnswlib-node')"`.
5. Test on both `ubuntu-latest` and `macos-latest` in the CI matrix, since the installer targets both platforms.
6. Pin `ubuntu-22.04` explicitly rather than `ubuntu-latest` to avoid surprise OS upgrades.

**Detection:**
- CI workflow fails at `npm ci` or `npm test` with C++ compilation errors.
- Tests pass locally but fail in CI with `Error: Cannot find module 'better-sqlite3'`.

**Phase to address:** CI pipeline (first step -- everything else depends on CI being green).

---

### Pitfall 6: release-it Only Reads Last Commit for Version Bump and Changelog

**What goes wrong:**
The `@release-it/conventional-changelog` plugin determines the version bump type (major/minor/patch) from commit messages between the last git tag and HEAD. But it has a documented issue: "only the last commit made has effect on version bump and written to changelog." If a developer squash-merges a PR, the individual `feat:` and `fix:` commits are lost -- only the merge commit message matters. If the merge commit says "Merge pull request #42" (no conventional commit prefix), the plugin:
1. Cannot determine bump type (defaults to patch or none).
2. Generates an empty changelog entry.
3. Creates a tag that doesn't reflect the actual changes.

Additionally, in GitHub Actions, `actions/checkout@v4` defaults to `fetch-depth: 1` (shallow clone). With only one commit visible, the plugin has no history to compute the diff between tags. It sees "one commit since last tag" and produces a minimal changelog.

**Why it happens:**
Conventional changelog tools assume linear history with conventional commit messages on every commit. Squash merges, rebase workflows, and shallow clones all violate this assumption.

**Consequences:**
- Changelog is empty or misleading.
- Version bumps don't reflect actual changes (breaking change shipped as patch).
- Git tag conflicts when the computed version matches an existing tag.
- Release process fails silently (exit 0, but wrong version published).

**Prevention:**
1. In the CI workflow, use `fetch-depth: 0` in `actions/checkout` to get full git history.
2. Configure squash merge commit message format in GitHub repo settings to use conventional commit format: `feat: PR title (#42)`.
3. Add a pre-release check that verifies the computed changelog is non-empty before tagging.
4. Use `release-it`'s `--dry-run` in CI to preview the changelog and version bump before actually releasing.
5. Add git tag conflict detection: before `release-it` runs, check `git tag -l "v${version}"` and abort if it exists.
6. Consider using `commit-and-tag-version` as an alternative that handles prerelease tag conflicts automatically.

**Detection:**
- Releases appear with empty changelogs.
- Version numbers skip unexpectedly (1.0.0 -> 1.0.1 when a `feat:` was expected to bump to 1.1.0).
- CI release job fails with "tag already exists."

**Phase to address:** CI pipeline (release automation).

---

## Moderate Pitfalls

### Pitfall 7: HNSW Rebuild During Startup Blocks Daemon for Minutes

**What goes wrong:**
`registerMemoryModule()` in `src/memory/index.ts` (lines 88-98) calls `rebuildHnswFromDb()` synchronously during plugin registration if the `.dat` file is missing or corrupt. For a database with 50,000+ chunks (not unreasonable after weeks of agent operation), this rebuild takes 30-60 seconds. During this time, the daemon's startup is blocked -- no health endpoint, no task polling, no agent dispatching. The OS supervisor (launchd/systemd) may interpret this as a failed start and kill the process, triggering an infinite restart loop.

**Prevention:**
1. Start the daemon *without* HNSW (fallback to `sqlite-vec` search, which the code already supports -- `searchWithSqliteVec()` on line 313).
2. Rebuild HNSW in the background after startup. Swap the index reference atomically when rebuild completes.
3. Set a startup timeout in the LaunchAgent plist that exceeds expected rebuild time (120s).
4. Log progress during rebuild: "Rebuilding HNSW index: 15000/50000 vectors..."

**Detection:**
- Daemon takes >30s to start.
- Health endpoint returns nothing for the first minute after `aof daemon start`.
- launchd logs show repeated start/kill cycles.

**Phase to address:** Memory subsystem fix.

---

### Pitfall 8: Installer Doesn't Detect or Preserve Existing Memory Database

**What goes wrong:**
The `install()` function in `src/packaging/installer.ts` runs `npm ci` in the target directory. If the AOF data directory (`~/.openclaw/aof/`) already exists with a `memory.db`, the installer doesn't know about it -- `preservePaths` in the installer refers to paths relative to the npm package directory, not the data directory. The installer and data directory are separate locations.

The real problem: the `curl | sh` installer might set up a fresh `~/.openclaw/aof/` directory, overwriting any existing configuration. The `selfUpdate()` in `updater.ts` preserves paths within `aofRoot`, but `aofRoot` might be the npm install location, not `~/.openclaw/aof/`.

**Prevention:**
1. During install, detect if `~/.openclaw/aof/` already exists. If it does, print: "Found existing AOF data at ~/.openclaw/aof/. Preserving configuration and memories."
2. Never touch the data directory during an npm package update. The installer should only modify the package directory (`~/Projects/AOF/` or wherever npm installs).
3. Add a `--clean` flag that explicitly opts into wiping existing data (with confirmation prompt).
4. Document the separation: package files vs runtime data vs configuration.

**Detection:**
- User reports "my memories disappeared" after reinstall.
- `memory.db` is missing but the chunks directory still exists.

**Phase to address:** Installer/updater.

---

### Pitfall 9: Project Routing Fails Silently When Manifest ID Doesn't Match Directory Name

**What goes wrong:**
In `src/projects/registry.ts` (lines 135-139), if `manifest.id !== dirName`, the project is loaded with an error but *no manifest*. Downstream code that checks `record.manifest` will skip this project entirely -- no routing, no tools, no memory pool. The user creates a project directory `my-project/`, writes `project.yaml` with `id: myproject` (missing hyphen), and the project silently doesn't exist in the system.

The error message is stored in `record.error` but nothing surfaces it to the user unless they run a lint command. Task dispatch to this project silently falls through to `_inbox` or is dropped.

**Prevention:**
1. On daemon startup, log all project discovery errors at WARN level -- not just store them in the record.
2. Add a `projects:validate` step to `aof init` and `aof daemon start` that checks for ID/directory mismatches.
3. Consider auto-fixing: if manifest ID doesn't match directory name and there's no other project with that ID, suggest the fix: "Project 'my-project' has manifest ID 'myproject'. Fix manifest or rename directory."
4. Add to the project linter (`src/projects/lint.ts`) a specific check that emits a prominent error for this case.

**Detection:**
- Agent dispatched to a project gets routed to `_inbox` instead.
- `aof projects list` shows the project with an error status that nobody reads.

**Phase to address:** Projects verification.

---

### Pitfall 10: Project Memory Pools Are Not Isolated -- State Leakage Between Projects

**What goes wrong:**
The memory module (`src/memory/index.ts`) creates a *single* `VectorStore` and `HybridSearchEngine` per daemon instance. All projects share the same SQLite database (`memory.db`). The `pool` field on chunks is meant to separate them, but search queries in `searchWithHnsw()` (line 279) search the ENTIRE HNSW index -- there is no pool filtering at the HNSW level. Pool filtering would need to happen after HNSW returns results, in the SQL step. But the current SQL (`WHERE id IN (...)`) doesn't filter by pool either.

This means: Agent A working on Project Alpha searches memory and gets results from Project Beta's memory pool. For a multi-tenant or multi-project setup, this is information leakage.

**Prevention:**
1. Add pool filtering to `searchWithHnsw()`: after HNSW returns candidate IDs, add `AND pool = ?` to the SQL query that hydrates the results.
2. Consider per-pool HNSW indexes (separate `.dat` files) for true isolation. This trades memory for correctness.
3. At minimum, add pool-scoped search to the `HybridSearchEngine`: `search(query, { pool: "project-alpha" })`.
4. Add a test that inserts chunks into two pools and verifies search only returns results from the queried pool.

**Detection:**
- Agent finds memories from a different project.
- Memory search returns irrelevant results that belong to another team/project context.

**Phase to address:** Projects verification (critical for multi-project correctness).

---

### Pitfall 11: CI Test Flakiness From Pre-existing Failures

**What goes wrong:**
The test suite currently has 11 failing tests and 13 pending tests (out of 2433). The failures are in:
- `runDaemonStep` (2 failures) -- daemon wizard tests.
- `OpenClawAdapter` (9 failures) -- gateway adapter tests.

If CI is set up to fail on *any* test failure, the pipeline will never be green. If CI is set up to tolerate some failures (e.g., `--passWithNoTests`), real regressions will be hidden in the noise.

**Prevention:**
1. Fix or skip the 11 known failures *before* enabling CI. Mark them with `it.skip` and a tracking comment: `// TODO(AOF-xxx): Fix after gateway adapter refactor`.
2. CI must require 0 failures (no "expected failures" threshold). Skipped tests are acceptable; failed tests are not.
3. Add a CI step that counts skipped tests and fails if the count *increases* (prevents test-skip creep).
4. Separate unit tests from integration tests in CI. Unit tests must be deterministic. Integration tests (which need a gateway) run on `workflow_dispatch` only (as the existing `e2e-tests.yml` already does).

**Detection:**
- CI is red from day one and nobody investigates because "those tests were already failing."
- A real regression is merged because it was hidden among the known failures.

**Phase to address:** CI pipeline (prerequisite -- clean baseline).

---

### Pitfall 12: Migration Framework Has No Atomicity Guarantee

**What goes wrong:**
`runMigrations()` in `src/packaging/migrations.ts` (lines 60-119) runs migrations sequentially. If migration 3 of 5 fails, migrations 1 and 2 have already been applied and recorded in `migrations.json`. The error is thrown, but the system is now in a partially migrated state. There is no transaction wrapping the batch of migrations, and the `down()` methods are optional (`down?: ...` on line 15) -- so there may be no way to reverse the partial application.

Worse: `recordMigration()` (lines 138-153) reads, modifies, and writes `migrations.json` as JSON with no file locking. If the daemon crashes during this write (which is a `writeFile`, not an atomic rename), the JSON file could be truncated/corrupt, losing the migration history entirely.

**Prevention:**
1. Use atomic file writes for `migrations.json`: write to a temp file, then `rename()` (which is atomic on POSIX).
2. Add a `--dry-run` flag to `runMigrations()` that validates all migrations can be applied without actually running them.
3. Consider wrapping multiple migrations in a SQLite transaction where possible (for database migrations).
4. Record migration state *before* each migration runs (as "in-progress"), then update to "applied" after. This lets recovery detect interrupted migrations.
5. Always provide `down()` methods for critical migrations (schema changes, data transformations).

**Detection:**
- Update fails partway and `aof` won't start because half the migrations were applied.
- `migrations.json` is empty or contains truncated JSON.

**Phase to address:** Installer/updater (migration integrity).

---

## Minor Pitfalls

### Pitfall 13: Installer Uses execSync Which Blocks Event Loop

**What goes wrong:**
`install()` in `src/packaging/installer.ts` (line 76-83) uses `execSync("npm ci", ...)`. On a slow network or with many dependencies, this blocks for 30+ seconds. If this runs during an update while the daemon is still handling requests, the event loop is frozen.

**Prevention:**
Use `child_process.execFile` with `{ shell: true }` (async). Stream stdout/stderr for progress indication.

**Phase to address:** Installer.

---

### Pitfall 14: extractTarball Is a Stub

**What goes wrong:**
`extractTarball()` in `src/packaging/updater.ts` (lines 338-345) contains only `await mkdir(targetDir, { recursive: true })` and a comment: "Placeholder: in real implementation, extract tarball to targetDir." If the updater is used before this is implemented, it will "succeed" but install an empty directory.

**Prevention:**
Either implement extraction (using Node.js `tar` package or `child_process.execFile("tar", ["-xzf", ...])`) or throw `new Error("extractTarball not implemented")` so it fails loudly.

**Phase to address:** Installer/updater (blocking -- the entire update mechanism doesn't work without this).

---

### Pitfall 15: Project Linter Writes Report to state/ That May Not Exist

**What goes wrong:**
`writeLintReport()` in `src/projects/lint.ts` (line 113) writes to `join(record.path, "state", "lint-report.md")`. If the project was just created or the `state/` directory doesn't exist (bootstrapping failed, or it's a legacy project), `writeFile` throws ENOENT. The lint result is computed but never persisted, and the error may propagate up and skip remaining projects.

**Prevention:**
Add `await mkdir(join(record.path, "state"), { recursive: true })` before `writeFile`. Or call `bootstrapProject()` as a prerequisite.

**Phase to address:** Projects verification.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Memory HNSW fix | Rebuild causes data loss (Pitfall 1) | Verify count parity between HNSW and SQLite after every rebuild |
| Memory HNSW fix | Tombstone accumulation (Pitfall 2) | Track tombstone ratio, trigger periodic rebuild when >50% |
| Memory HNSW fix | Startup blocked by rebuild (Pitfall 7) | Use sqlite-vec fallback, rebuild HNSW asynchronously post-startup |
| Memory HNSW fix | Cross-project memory leakage (Pitfall 10) | Add pool filtering to HNSW search path |
| Installer | Overwrites running daemon (Pitfall 3) | Gate update on daemon stop, expand preservePaths |
| Installer | Partial download executes (Pitfall 4) | Wrap script in function, use checksums |
| Installer | Memory DB not preserved (Pitfall 8) | Separate package dir from data dir, never touch ~/.openclaw/aof/ |
| Installer | extractTarball is a stub (Pitfall 14) | Implement before shipping |
| Installer | Migrations not atomic (Pitfall 12) | Atomic file writes, in-progress tracking |
| CI pipeline | Native addon build failures (Pitfall 5) | Pin Node version, install build tools, cache node_modules |
| CI pipeline | Changelog generation broken (Pitfall 6) | fetch-depth: 0, conventional commit enforcement |
| CI pipeline | Pre-existing test failures (Pitfall 11) | Fix or skip known failures before enabling CI |
| Projects | Manifest ID mismatch silent failure (Pitfall 9) | Log warnings on startup, validate in init |
| Projects | Memory pool leakage (Pitfall 10) | Pool-scoped HNSW search |
| Projects | Lint report write fails (Pitfall 15) | Ensure state/ exists before writing |

## Integration-Specific Gotchas

| Integration Point | Mistake | Correct Approach |
|-------------------|---------|------------------|
| HNSW + SQLite | Assuming they're always in sync | They drift. Always rebuild from SQLite as source of truth. Add parity checks. |
| HNSW resize + transaction | HNSW add outside SQLite transaction | Correct ordering (add after commit), but need drift detection for edge cases |
| Installer + launchd | Updating files while daemon runs | Stop daemon before update. On macOS: `launchctl bootout` first. |
| Installer + npm | Using `npm install` when lockfile exists | Use `npm ci` for reproducible installs. Fallback to `npm install` only when no lockfile. Already correct in code (line 62-68). |
| CI + native addons | Relying on prebuild binaries | They may not exist for your Node+OS combo. Always have build tools installed. |
| CI + changelog | Shallow clone | Conventional changelog needs full history. `fetch-depth: 0` is mandatory. |
| Project registry + routing | Assuming all discovered projects have valid manifests | Filter to `record.manifest !== undefined` before routing. Log the rest. |
| Project memory + search | Assuming pool field provides isolation | Pool is metadata only. HNSW search is global. Must add SQL filter. |
| Self-update + migration | Assuming migrations are idempotent | They may not be. Track in-progress state. Use down() for rollback. |

## "Looks Done But Isn't" Checklist (v1.1 specific)

- [ ] **HNSW capacity fix:** `ensureCapacity()` resizes the index -- but there is no parity check between HNSW and SQLite after resize. Verify: insert 10,001 items (exceeding INITIAL_CAPACITY), search confirms all items are findable.
- [ ] **HNSW persistence:** Save/load round-trips the index -- but `rebuildHnswFromDb()` is the only recovery path if the file is corrupt. Verify: corrupt the `.dat` file, restart daemon, confirm all memories are still searchable.
- [ ] **Installer preservePaths:** Lists "config, data, tasks, events" -- but misses memory.db, state/, .aof/. Verify: run update, confirm all runtime state survives.
- [ ] **extractTarball:** Is a stub (Pitfall 14). Verify: the update mechanism actually extracts files.
- [ ] **CI native builds:** Tests pass locally -- but native addons may fail to compile on GitHub Actions. Verify: CI runs `npm ci && npm test` successfully on ubuntu-22.04.
- [ ] **Changelog generation:** release-it is configured -- but shallow clone produces empty changelog. Verify: CI release produces a non-empty CHANGELOG.md entry.
- [ ] **Project routing:** Projects are discovered -- but memory search doesn't filter by pool. Verify: search within project A doesn't return project B's memories.
- [ ] **Project manifest validation:** Invalid projects get error records -- but errors are not surfaced to users. Verify: create a project with mismatched ID, confirm the user sees a warning.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| HNSW/SQLite drift (Pitfall 1) | LOW | Delete `.dat` file, restart daemon. HNSW rebuilds from SQLite automatically. |
| Tombstone degradation (Pitfall 2) | LOW | Force rebuild: delete `.dat` file and restart. Or add a `memory:rebuild` CLI command. |
| Update overwrites daemon state (Pitfall 3) | HIGH | If memory.db is lost, it's gone. Must restore from backup (if `createBackup()` ran) or from original markdown files via re-indexing. |
| Partial installer execution (Pitfall 4) | MEDIUM | Re-run installer. If data directory was corrupted, restore from backup or re-initialize. |
| CI native build failure (Pitfall 5) | LOW | Pin Node version, add build tools to CI config. No data loss. |
| Wrong version bump (Pitfall 6) | MEDIUM | Delete the wrong tag (`git tag -d v1.1.1 && git push origin :v1.1.1`), fix changelog, re-release. |
| Startup blocked by rebuild (Pitfall 7) | LOW | Wait. Or increase launchd timeout. Or delete `.dat` file and use sqlite-vec fallback. |
| Lost memory DB on reinstall (Pitfall 8) | HIGH | Re-index from source files. Curated memories (manually stored by agents) are lost permanently. |
| Manifest ID mismatch (Pitfall 9) | LOW | Edit `project.yaml` to match directory name. Re-run `aof projects lint`. |
| Memory pool leakage (Pitfall 10) | LOW | No data loss. Fix search query. Results were wrong but data is intact. |
| Pre-existing test failures hide regressions (Pitfall 11) | MEDIUM | Audit test history. May need to revert recent merges if a regression was hidden. |
| Partial migration (Pitfall 12) | HIGH | Manual intervention to determine which migrations applied. May need to manually edit migrations.json and re-run. |

## Sources

- Codebase inspection: `src/memory/store/hnsw-index.ts`, `src/memory/store/vector-store.ts`, `src/memory/index.ts`, `src/packaging/installer.ts`, `src/packaging/updater.ts`, `src/packaging/migrations.ts`, `src/projects/registry.ts`, `src/projects/resolver.ts`, `src/projects/lint.ts`
- [hnswlib markDelete unreachable points phenomenon](https://arxiv.org/html/2407.07871v2) -- academic research on HNSW deletion degradation
- [hnswlib markDelete behavior (GitHub issue #275)](https://github.com/nmslib/hnswlib/issues/275) -- markDelete does not remove graph edges
- [hnswlib resizeIndex (GitHub issue #39)](https://github.com/nmslib/hnswlib/issues/39) -- resize without save/reload
- [better-sqlite3 Node.js 24+ build failures (GitHub issue #1411)](https://github.com/WiseLibs/better-sqlite3/issues/1411) -- native addon compilation breaking changes
- [better-sqlite3 GitHub Actions install failure (GitHub issue #716)](https://github.com/WiseLibs/better-sqlite3/issues/716)
- [release-it/conventional-changelog only reads last commit (GitHub issue #16)](https://github.com/release-it/conventional-changelog/issues/16)
- [release-it changelog before version bump (GitHub issue #830)](https://github.com/release-it/release-it/issues/830)
- [curl | sh partial execution attack](https://snakesecurity.org/blog/pipepunisher-exploiting-shell-install-scripts/) -- PIPE abuse in shell installers
- [curl | sh server-side detection](https://www.lesinskis.com/dont-pipe-curl-into-bash.html) -- servers can detect piped execution
- [BetterCLI installer patterns](https://bettercli.org/design/distribution/self-executing-installer/) -- function-wrapping defense
- [launchd: daemon must not self-daemonize](https://www.launchd.info/) -- launchd process tracking requirements
- Test suite output: 2433 total, 2409 passed, 11 failed, 13 pending (as of 2026-02-26)

---
*Pitfalls research for: AOF v1.1 Stabilization & Ship*
*Researched: 2026-02-26*
*Supersedes: v1.0 pitfalls research from 2026-02-25 (those pitfalls remain valid; this document covers v1.1-specific additions)*
