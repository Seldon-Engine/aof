# Project Research Summary

**Project:** AOF v1.1 Stabilization & Ship
**Domain:** TypeScript plugin for agentic orchestration — stabilization milestone
**Researched:** 2026-02-26
**Confidence:** HIGH

## Executive Summary

AOF v1.1 is a stabilization-and-ship milestone for an existing TypeScript agent orchestration plugin. The codebase is substantially built: scheduler, daemon, MCP tools, memory pipeline, packaging subsystem, and project routing scaffolding all exist. The v1.1 work is not greenfield development — it is finding and closing the gap between "code exists" and "code ships reliably." The four objectives are: fix a P0 HNSW memory crash, create a `curl | sh` installer, add CI with release automation, and verify multi-project task routing end-to-end.

The recommended approach follows a strict dependency order: memory first (standalone P0 fix with no upstream dependencies), CI second (creates the release pipeline that the installer depends on), project routing verification third (benefits from CI for test validation), and the installer last (depends on CI producing release tarball artifacts). This order is unambiguous and driven by hard technical dependencies, not priority opinion. Deviating from it — for instance, building the installer before CI creates release artifacts — produces an installer that has nothing to download.

The key risks are concentrated in two areas: data integrity and release mechanics. On the data side, the HNSW index and SQLite database can drift out of sync after crashes, and the update mechanism has a critical path where it can delete the live SQLite database while the daemon holds an open file descriptor. On the release side, `release-it` requires a full git history (`fetch-depth: 0` in CI) to generate accurate changelogs, and 11 pre-existing test failures must be resolved before CI can ever be green. None of these are novel problems — all have well-established mitigations documented in the research — but each must be addressed explicitly or it will resurface during the first public release.

## Key Findings

### Recommended Stack

The stack requires no changes. All four v1.1 features are delivered with the existing dependency tree (`hnswlib-node` 3.0.0, `better-sqlite3` 12.6.2, `sqlite-vec` 0.1.7-alpha.2, `release-it` 19.2.4, `vitest`, `tsc`). The work is three new files and modifications to five existing ones. The most important stack constraint is the Node.js version pin: Node 22.x is required everywhere — in the `engines` field, in CI, and in the installer's prerequisite check. Node 24 and 25 have documented `better-sqlite3` build failures due to V8 API changes, and this constraint must not be relaxed.

**Core technologies:**
- `hnswlib-node` 3.0.0: HNSW approximate nearest-neighbor index — already installed; `resizeIndex`/`getIdsList` APIs confirmed from installed type definitions; 3.0.0 is the latest release (no upgrade available)
- `better-sqlite3` 12.6.2: SQLite for chunk metadata, FTS, and vec search fallback — already installed; has prebuilt binaries for Node 22 ubuntu-latest; do NOT use Node 24/25
- `sqlite-vec` 0.1.7-alpha.2: Vector search fallback in SQLite — already installed; ships precompiled; do NOT replace HNSW with this (10x slower, alpha quality)
- `release-it` 19.2.4 + `@release-it/conventional-changelog`: changelog generation and GitHub Releases — already fully configured in `.release-it.json`; do NOT switch to release-please or semantic-release
- GitHub Actions: CI and release automation — already in use for docs workflow; no new CI platform needed
- POSIX sh (`#!/bin/sh`): curl-pipe-sh installer entry point — wider compatibility than bash; established pattern from nvm/pnpm

**New files to create (no new npm dependencies):**
- `scripts/install.sh` — POSIX shell curl-pipe-sh entry point
- `.github/workflows/ci.yml` — test on PR/push to main
- `.github/workflows/release.yml` — manual release automation with tarball artifact

**Existing files to modify:**
- `src/memory/store/hnsw-index.ts` — fix capacity handling in `load()` and `rebuild()`
- `src/memory/index.ts` — improve error logging in `rebuildHnswFromDb()`
- `src/packaging/updater.ts` — implement `extractTarball()` stub (currently placeholder)
- `src/openclaw/adapter.ts` + `src/mcp/tools.ts` — add `projectId` param and project tools

### Expected Features

The four table-stakes features for v1.1 are entirely internal-facing. No new user-visible feature is being added — this milestone makes existing features work correctly and makes the project installable by people other than the author.

**Must have (table stakes):**
- HNSW index dynamic capacity — P0 broken; inserts crash, search returns empty; AOF cannot function without working memory
- Installer shell script (`scripts/install.sh`) — v1.1 goal is "installable by others"; without this only the author can run AOF
- CI pipeline (ci.yml + release.yml) — no CI means no confidence in releases; also a prerequisite for installer tarball artifacts; blocked on fixing 11 pre-existing test failures first
- Multi-project task routing verification — project subsystem scaffolding exists but end-to-end dispatch has never been verified; three specific gaps identified: no `projectId` param on `aof_dispatch`, no pool filtering in HNSW search, dispatcher project awareness unconfirmed

**Should have (differentiators — achievable within v1.1):**
- HNSW health dashboard (`aof memory health`) — no other orchestrator surfaces vector index health; LOW complexity; enabled by memory fix
- Memory rebuild CLI command (`aof memory rebuild`) — `HnswIndex.rebuild()` exists, just needs CLI wiring; LOW complexity
- OpenClaw auto-detection in installer — `detectOpenClaw()` already exists in `openclaw-cli.ts`; LOW complexity
- Changelog in GitHub Releases — already configured in release-it; needs `"infile": "CHANGELOG.md"` and CI trigger

**Defer to v2+:**
- Auto-update mechanism — explicitly deferred in PROJECT.md; risk of breaking running daemons
- Memory search reranker — explicitly deferred to v1.2 in PROJECT.md
- Memory tier auto-compaction — explicitly deferred to v2
- npm publish — explicitly disabled in release-it config; AOF is a plugin, not a package
- Homebrew formula, multi-platform binaries, Windows/PowerShell support
- Visual project dashboard, OpenClaw version compatibility checks

### Architecture Approach

AOF is a TypeScript ESM plugin loaded into the OpenClaw gateway process. The build uses `tsc` (not a bundler) because native modules (`better-sqlite3`, `hnswlib-node`) cannot be reliably bundled. All v1.1 changes are surgical modifications to existing components — no new subsystems, no new service registrations, no new data stores. The HNSW fix is two method changes in one class. The CI pipeline is two YAML files. The installer adds one shell script plus implements the existing `extractTarball()` stub. The project routing work adds a `projectId` parameter to two tool registrations and adds pool filtering to one search method.

**Major components and v1.1 changes:**
1. `src/memory/store/hnsw-index.ts` — HNSW wrapper: **FIX** `load()` to call `ensureCapacity()` after loading persisted index; **FIX** `rebuild()` to use `Math.ceil(chunks.length * 1.5)` headroom minimum instead of exact count
2. `src/memory/index.ts` — Memory module registration: **IMPROVE** error logging in `rebuildHnswFromDb()` so silent failures surface to operators
3. `src/packaging/updater.ts` — Self-update engine: **IMPLEMENT** `extractTarball()` stub (currently placeholder at lines 338-345; entire update mechanism is broken without this)
4. `scripts/install.sh` — **NEW** curl-pipe-sh entry point: detect OS/arch, check Node >= 22, download release tarball, verify SHA256, extract, run `node dist/cli/index.js install`
5. `.github/workflows/ci.yml` — **NEW**: typecheck + test + build on push/PR to main; pin Node 22, ubuntu-22.04; cache npm
6. `.github/workflows/release.yml` — **NEW**: tarball artifact creation on tag push; `fetch-depth: 0` mandatory
7. `src/openclaw/adapter.ts` + `src/mcp/tools.ts` — **ADD** `projectId` param to `aof_dispatch`; **ADD** `aof_project_list`, `aof_project_info`, `aof_project_create` tools (Zod schemas, both surfaces)
8. `src/memory/store/vector-store.ts` or `hybrid-search.ts` — **ADD** pool filtering (`AND pool = ?`) to HNSW search path so project memory pools are actually isolated

**Patterns to follow:** Zod schema first for all new tool parameters; `api.registerTool()` with JSON Schema for OpenClaw tools; `server.registerTool()` with Zod for MCP tools; atomic `rename()` for all file writes; never read/write `openclaw.json` directly — use `openclaw-cli.ts` wrapper; do not bundle the plugin (use `tsc` only).

### Critical Pitfalls

1. **HNSW/SQLite drift causes silent memory corruption** — HNSW and SQLite have no transaction coordination; a crash between SQLite commit and HNSW add leaves stale entries that map to wrong chunks or return missing rows. After every rebuild, verify `hnsw.count === SELECT COUNT(*) FROM vec_chunks`. Treat SQLite as the authoritative source of truth; rebuild HNSW from it, never the reverse. Recovery: delete `.dat` file and restart — HNSW rebuilds from SQLite automatically.

2. **Update overwrites live memory.db while daemon holds it open** — The updater's `preservePaths` list (`["config", "data", "tasks", "events"]`) misses `memory.db`, `memory-hnsw.dat`, `state/`, and `.aof/`. On macOS, deleting an open file invalidates the fd immediately. Expand preservePaths to cover all runtime state; use an exclude-list approach (only replace `dist/`, `package.json`, `node_modules/`); gate update on daemon stop (`launchctl bootout` before, `launchctl bootstrap` after). Recovery cost: HIGH — deleted memory.db cannot be recovered without backups.

3. **curl | sh partial download executes truncated commands** — If the network drops mid-download, `sh` executes whatever was received. Wrap the entire installer in a function called at the end (standard nvm/Homebrew defense); use `set -euo pipefail`; verify tarball SHA256 before extraction. Provide download-first alternative: `curl -fsSL .../install.sh -o install.sh && sh install.sh`.

4. **CI native addon builds fail on GitHub Actions** — `better-sqlite3` and `hnswlib-node` require C++ compilation; failures occur when Node version doesn't match prebuilt binary ABI or build tools are absent. Pin `ubuntu-22.04` (not `ubuntu-latest`); pin `node-version: '22'`; build tools (`python3`, `make`, `g++`) are pre-installed on ubuntu-22.04; cache `node_modules` keyed by lockfile hash + OS + Node version.

5. **release-it generates empty changelog with shallow git clone and pre-existing test failures block CI** — `@release-it/conventional-changelog` needs full history; `actions/checkout@v4` defaults to `fetch-depth: 1`. Use `fetch-depth: 0` in the release workflow. Separately: 11 pre-existing test failures (in `runDaemonStep` and `OpenClawAdapter` suites) must be fixed or `.skip`-ped before CI can ever be green. CI must require 0 failures — no "expected failures" threshold.

## Implications for Roadmap

Based on research, the phase structure is unambiguous because of hard technical dependencies. Do not reorder.

### Phase 1: Memory Fix + Test Stabilization

**Rationale:** Memory is the only P0 production breakage — AOF cannot function without working HNSW. This is a standalone fix with no dependencies on any other v1.1 work. Test stabilization runs in parallel and is a prerequisite for Phase 2 CI being useful.

**Delivers:** A working memory subsystem (inserts no longer crash, search returns correct results, save/load round-trip is safe, `rebuildHnswFromDb` failures surface to logs) and a clean test suite (0 failures, known issues marked `.skip` with tracking comments referencing issue numbers).

**Addresses:** Table stakes feature: HNSW dynamic capacity. Enables differentiators: memory health dashboard, memory rebuild CLI command. Enables Phase 3 (project memory isolation depends on working HNSW + pool filtering).

**Avoids:**
- Pitfall 1 (HNSW/SQLite drift — add parity check after every rebuild; log drift warnings during search)
- Pitfall 2 (tombstone accumulation — add tombstone ratio tracking; trigger rebuild when >50% deleted)
- Pitfall 7 (startup blocked by rebuild — use sqlite-vec fallback immediately, rebuild HNSW asynchronously post-startup)
- Pitfall 10 (cross-project memory leakage — add `AND pool = ?` to SQL query in HNSW search path)
- Pitfall 11 (pre-existing test failures hide regressions — fix or `.skip` all 11 known failures before CI)

**Key implementation tasks:**
- Fix `hnsw-index.ts` `load()`: call `ensureCapacity()` after `readIndexSync` to guarantee headroom on a freshly-loaded index
- Fix `hnsw-index.ts` `rebuild()`: use `Math.max(Math.ceil(chunks.length * 1.5), INITIAL_CAPACITY)` instead of exact count
- Add post-rebuild parity check: `hnsw.count === SELECT COUNT(*) FROM vec_chunks`; log WARNING if they diverge
- Add diagnostic getter `get capacity(): number { return this.index.getMaxElements(); }`
- Add error logging in `memory/index.ts` `rebuildHnswFromDb()` — silent fallthrough currently masks broken state
- Add pool filtering to `searchWithHnsw()` SQL query
- Fix or `.skip` all 11 known test failures in `runDaemonStep` and `OpenClawAdapter` suites
- Add capacity edge-case tests: insert 10,001 vectors, search succeeds; save/load/search still works; rebuild at exact count

### Phase 2: CI Pipeline

**Rationale:** CI validates all subsequent work and creates the release artifacts that the installer depends on. Without CI creating a GitHub Release with a tarball, the installer has nothing to download. The Phase 1 test cleanup is a hard prerequisite — CI is useless if it starts red.

**Delivers:** Green CI on push/PR to main, automated release workflow that produces a tarball artifact on tag push, conventional commit changelog in GitHub Releases.

**Addresses:** Table stakes feature: CI pipeline with changelog. Enables table stakes feature: installer (by creating tarball artifacts). Enables differentiator: changelog in GitHub Releases.

**Avoids:**
- Pitfall 5 (native addon build failures — pin Node 22, ubuntu-22.04; cache `node_modules` keyed by lockfile hash + OS + Node version)
- Pitfall 6 (empty changelog from shallow clone — use `fetch-depth: 0` in release workflow; configure GitHub squash merge to use conventional commit format)
- Pitfall 11 (pre-existing failures — must be clean from Phase 1 before CI is enabled)

**Key implementation tasks:**
- Create `.github/workflows/ci.yml`: typecheck + test + build on push/PR to main; pin `ubuntu-22.04` (not `ubuntu-latest`) and Node 22; cache npm with lockfile hash
- Create `.github/workflows/release.yml`: triggered on tag push or `workflow_dispatch` with bump-type input; `fetch-depth: 0`; produces `aof-${version}.tar.gz` including `dist/`, `prompts/`, `skills/`, `openclaw.plugin.json`, `package.json`; attaches tarball to GitHub Release via `softprops/action-gh-release`
- Verify `npm run build`, `npm run typecheck`, `npm test` all work non-interactively in CI
- Optionally enable `"infile": "CHANGELOG.md"` in `.release-it.json` for persistent changelog
- Run `release-it --dry-run` before first real release to preview changelog and version bump

### Phase 3: Multi-Project Routing Verification

**Rationale:** The projects subsystem has the most code-exists-but-unverified gaps of any area in v1.1. Placing it here — after CI — means the new integration tests run in CI immediately and regressions are caught. Working memory (Phase 1) enables pool isolation verification. This phase closes three identified hard gaps in the tool registration layer.

**Delivers:** Verified end-to-end multi-project dispatch (create project → dispatch task with projectId → task lands in correct project directory → scheduler picks it up from project-specific store → spawned agent receives project context). Plus: pool-filtered memory search so projects do not leak memories across boundaries.

**Addresses:** Table stakes feature: multi-project task routing. Closes three identified gaps: missing `projectId` param on `aof_dispatch`, missing pool filtering in HNSW search path, unconfirmed dispatcher project-store wiring.

**Avoids:**
- Pitfall 9 (manifest ID mismatch silent failure — log all discovery errors at WARN on startup; add validation in `aof init` and `aof daemon start`)
- Pitfall 10 (memory pool leakage — pool filtering already addressed in Phase 1; verify here with integration tests)
- Pitfall 15 (lint report write fails — ensure `state/` directory exists before `writeLintReport()` calls `writeFile`)

**Key implementation tasks:**
- Add `projectId` parameter to `aof_dispatch` in both `src/openclaw/adapter.ts` and `src/mcp/tools.ts` (Zod schema first)
- Add project tools with Zod schemas, both OpenClaw and MCP surfaces: `aof_project_list`, `aof_project_info`, `aof_project_create`
- Read and verify `initializeProjects()` in `AOFService` — confirm it creates per-project `FilesystemTaskStore` instances pointing to `<vaultRoot>/Projects/<id>/Tasks/`
- Verify scheduler `triggerPoll` iterates all `projectStores.values()` not just the single default store
- Verify `task-dispatcher.ts` passes `projectId`/`projectRoot` from store through to `TaskContext`
- Add startup logging for project discovery errors (currently stored silently in `record.error`)
- Fix `src/projects/lint.ts` `writeLintReport()`: add `mkdir(join(record.path, "state"), { recursive: true })` before `writeFile`
- Write integration tests: create project → dispatch with projectId → verify task lands in project dir → verify scheduler picks it up → verify memory search respects pool

### Phase 4: Installer

**Rationale:** Last because it depends on Phase 2 (CI must produce release tarball artifacts before installer can download them) and benefits from Phase 1 being done (installer installs a working memory subsystem). The TypeScript packaging infrastructure is substantially complete — the two gaps are the shell entry point and the `extractTarball()` stub.

**Delivers:** A working `curl -fsSL https://raw.githubusercontent.com/demerzel-ops/aof/main/scripts/install.sh | sh` that installs AOF on a machine with Node >= 22 and OpenClaw already installed. Handles clean install, upgrade, and reinstall/repair cases. Running the installer twice does not corrupt state.

**Addresses:** Table stakes feature: curl-pipe-sh installer. Makes AOF installable by users other than the author.

**Avoids:**
- Pitfall 3 (update overwrites running daemon — expand `preservePaths` to `["config", "data", "tasks", "events", "state", "memory", ".aof"]`; gate update on daemon stop with `launchctl bootout`)
- Pitfall 4 (partial download executes — wrap entire installer in a function; `set -euo pipefail`; SHA256 checksum before extract)
- Pitfall 8 (memory DB not preserved — separate package directory from `~/.openclaw/aof/` data directory; never touch data dir during install)
- Pitfall 12 (migration not atomic — write `migrations.json` to temp file then `rename()`; record "in-progress" state before each migration)
- Pitfall 14 (extractTarball is a stub — implement before shipping; throw `new Error("extractTarball not implemented")` as interim guard)
- Pitfall 13 (execSync blocks event loop — use async `execFile` with streamed stdout/stderr for progress)

**Key implementation tasks:**
- Implement `extractTarball()` in `src/packaging/updater.ts` using `child_process.execFile("tar", ["-xzf", tarball, "-C", targetDir])` or the `tar` npm package
- Expand `preservePaths` in `selfUpdate()` to include all runtime state; prefer exclude-list over preserve-list
- Add daemon-running check to `selfUpdate()` — check PID file + process verification; stop daemon before update on macOS (`launchctl bootout`)
- Fix repo URL placeholder in `channels.ts` (currently `"aof/aof"`, needs `"demerzel-ops/aof"`)
- Create `scripts/install.sh`: POSIX sh, entire body wrapped in `install_aof() { ... }; install_aof`, `set -euo pipefail`, detect darwin/linux + arm64/x64, check `node --version >= 22`, download latest stable release tarball via GitHub API, verify SHA256, extract to `~/.openclaw/workspace/package/node_modules/aof/`, run `node dist/cli/index.js install`
- Use atomic file writes for `migrations.json`; add in-progress state tracking
- Test all three install cases on a fresh account: clean install, upgrade, reinstall/repair
- Test partial download defense: truncate the script mid-download and verify nothing executes

### Phase Ordering Rationale

- **Memory first** because it is the only P0 production breakage with no upstream dependencies. It is the most isolated change (two method fixes in one class file).
- **CI second** because it is the hard prerequisite for the installer (installer downloads release tarballs that CI creates) and provides immediate feedback on Phase 3 integration tests. Phase 1 test cleanup must be complete before CI goes live.
- **Projects third** because the code exists but has never been wired end-to-end; CI validates the new integration tests automatically; working memory (Phase 1) enables pool isolation verification.
- **Installer last** because it depends on CI artifacts (tarball), benefits from memory being fixed (ships working memory), and has the most complex operational concerns (daemon lifecycle, data preservation, macOS launchd).

### Research Flags

Phases with well-documented patterns (skip research-phase):

- **Phase 2 (CI Pipeline):** GitHub Actions for Node.js TypeScript projects is extremely well-documented. release-it is already fully configured in `.release-it.json`. The native addon build considerations are explicitly documented in PITFALLS.md with specific mitigations. No unknowns.
- **Phase 3 (Projects Verification):** Pattern is code reading and integration test writing against existing architecture. No novel external APIs. The architecture document has explicit file-level, method-level change instructions.

Phases that may benefit from targeted research during planning:

- **Phase 4 (Installer) — minor flag:** The `extractTarball()` implementation choice (Node.js `tar` npm package vs `child_process.execFile("tar", ...)`) is worth a targeted investigation. The `tar` package adds a dependency but gives progress events and cross-platform compatibility; `execFile` has zero new dependencies but less control and requires `tar` to be installed. Also: GPG signature verification for release tarballs should be explicitly scoped in or out in Phase 4 planning.
- **Phase 1 (Memory Fix) — minor flag:** The async HNSW rebuild on startup (start daemon with sqlite-vec fallback, rebuild HNSW in background, swap reference atomically) requires a concurrency design decision: should search queries during rebuild use the old (potentially corrupt) HNSW index or fall through to sqlite-vec? The sqlite-vec fallback path already exists; the question is the swap trigger and locking model.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All dependencies verified from installed `node_modules`; type definitions read directly; version constraints confirmed from issue trackers; no new dependencies needed |
| Features | HIGH | Codebase examined directly; gaps identified at file/line level; feature gaps verified against actual code not assumed; anti-features backed by explicit PROJECT.md deferrals |
| Architecture | HIGH | All claims verified against source code with file paths, line numbers, and method signatures cited; build chain confirmed (tsc, not tsdown, despite project description) |
| Pitfalls | HIGH | Root causes traced to specific file/line; test suite failure counts exact (11 failures, 13 pending, 2433 total as of 2026-02-26); recovery costs assessed |

**Overall confidence:** HIGH

### Gaps to Address

- **`initializeProjects()` internals unconfirmed:** The research notes the full method body was not loaded (the visible portion of `aof-service.ts` ends before the method implementation). Phase 3 planning must read this method completely before writing integration tests. If the method has gaps, Phase 3 becomes implementation work, not just verification.

- **`aof install` CLI command existence:** The architecture research calls for `src/cli/commands/install.ts` as "NEW or MODIFY" — the exact current state of the CLI command layer is not confirmed. Phase 4 planning should read the existing CLI command directory before scoping the install/update commands.

- **`channels.ts` repo URL placeholder:** Currently uses `"aof/aof"`. The real repo is `"demerzel-ops/aof"`. This must be confirmed and corrected before Phase 4 so the installer fetches from the correct GitHub Release URL.

- **Tombstone ratio trigger threshold:** The 50% threshold for HNSW rebuild is derived from academic research on graph degradation but has not been validated against AOF's actual workload patterns. Treat this as a configurable value in Phase 1 rather than hardcoding.

- **Memory pool isolation scope:** The research identifies that the HNSW search path lacks pool filtering, but the exact location of the fix (whether in `vector-store.ts`, `hybrid-search.ts`, or the search calling code) needs to be confirmed by reading those files during Phase 3 planning.

## Sources

### Primary (HIGH confidence)
- `node_modules/hnswlib-node/lib/index.d.ts` — confirmed `resizeIndex`, `getIdsList`, `getCurrentCount`, `getMaxElements`, `markDelete`, `addPoint` (replaceDeleted) API surface
- `src/memory/store/hnsw-index.ts`, `src/memory/index.ts` — root cause analysis for capacity and silent failure bugs at specific line numbers
- `src/packaging/updater.ts` — confirmed `extractTarball()` stub at lines 338-345; confirmed `preservePaths` gap
- `src/projects/registry.ts` — confirmed manifest ID mismatch behavior at lines 135-139
- `src/openclaw/adapter.ts`, `src/mcp/tools.ts` — confirmed missing `projectId` parameter in tool registrations
- `src/service/aof-service.ts` — confirmed `projectStores` map and `projectStoreResolver` wiring
- [hnswlib-node API documentation](https://yoshoku.github.io/hnswlib-node/doc/classes/HierarchicalNSW.html) — `resizeIndex`, `readIndexSync` signatures
- [better-sqlite3 Node.js 24+ build failures (issue #1411)](https://github.com/WiseLibs/better-sqlite3/issues/1411) — confirmed Node 22 pin requirement
- Test suite output: 2433 total, 2409 passed, 11 failed, 13 pending (as of 2026-02-26)

### Secondary (MEDIUM confidence)
- [hnswlib dynamic capacity issue #39](https://github.com/nmslib/hnswlib/issues/39) — resize behavior rationale from upstream C++ maintainer
- [hnswlib markDelete behavior (issue #275)](https://github.com/nmslib/hnswlib/issues/275) — markDelete does not remove graph edges
- [release-it/conventional-changelog issue #16](https://github.com/release-it/conventional-changelog/issues/16) — only reads last commit for version bump
- [nvm install script](https://github.com/nvm-sh/nvm) — reference for curl-pipe-sh function-wrapping pattern
- [pnpm install script](https://pnpm.io/installation) — POSIX sh pattern reference
- [GitHub Actions release automation guide (2026-02-02)](https://oneuptime.com/blog/post/2026-02-02-github-actions-release-automation/view) — workflow patterns
- [sqlite-vec maintenance status (issue #226)](https://github.com/asg017/sqlite-vec/issues/226) — maintainer confirmed limited bandwidth; validates keeping HNSW as primary

### Tertiary (LOW confidence, used for validation only)
- [Enhancing HNSW for Real-Time Updates (arxiv 2407.07871v2)](https://arxiv.org/html/2407.07871v2) — graph degradation from deletions; tombstone threshold recommendation needs validation against AOF workload
- [curl | sh partial execution attack](https://snakesecurity.org/blog/pipepunisher-exploiting-shell-install-scripts/) — partial download risk documentation

---
*Research completed: 2026-02-26*
*Ready for roadmap: yes*
