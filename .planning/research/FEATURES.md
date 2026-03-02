# Feature Landscape: AOF v1.1 Stabilization & Ship

**Domain:** Multi-agent orchestration -- stabilization milestone (memory fix, installer, CI, project verification)
**Researched:** 2026-02-26
**Confidence:** HIGH (all four areas examined against existing codebase + ecosystem evidence)

## Context

This is a SUBSEQUENT MILESTONE. AOF v1.0 shipped with a working scheduler, daemon, gateway adapter, and memory medallion pipeline. v1.1 focuses on four specific areas: fixing the broken HNSW memory subsystem, creating an installer/updater for external users, adding CI with release automation, and verifying multi-project task routing end-to-end.

Existing codebase already has:
- `HnswIndex` class with `resizeIndex` via `ensureCapacity()` (src/memory/store/hnsw-index.ts)
- `VectorStore` with dual search paths: HNSW and sqlite-vec fallback (src/memory/store/vector-store.ts)
- `HybridSearchEngine` combining vector + BM25 with tier boosts (src/memory/store/hybrid-search.ts)
- Packaging subsystem: `installer.ts`, `updater.ts`, `wizard.ts`, `channels.ts` (src/packaging/)
- Release tooling: release-it + @release-it/conventional-changelog, commitlint, simple-git-hooks
- Projects subsystem: registry, resolver, manifest, lint, bootstrap, migration (src/projects/)
- Project-scoped tools: project-tools.ts, MCP tool definitions (src/tools/)

---

## Table Stakes

Features users expect for a stabilization release. Missing these means v1.1 does not achieve its goal.

### 1. HNSW Index Dynamic Capacity (Memory Fix)

| Aspect | Detail |
|--------|--------|
| Why Expected | Memory subsystem is P0 broken -- inserts crash, search returns empty. AOF cannot function without working memory. |
| Complexity | MEDIUM |
| Depends On | Existing `HnswIndex`, `VectorStore`, `HybridSearchEngine`, sqlite-vec fallback |

**What the ecosystem does:**

The `hnswlib-node` v3.x `HierarchicalNSW` class provides `resizeIndex(newMaxElements)` which reallocates the internal graph structure to accommodate more elements. This is NOT a full rebuild -- it extends the capacity in-place. The existing `HnswIndex.ensureCapacity()` already calls `this.index.resizeIndex(max * GROWTH_FACTOR)` when count >= max. The GROWTH_FACTOR is 2x.

**Expected behavior for dynamic capacity:**
- **Pre-allocation**: Start with `INITIAL_CAPACITY` (currently 10,000). This is adequate for most single-agent memory pools. For multi-agent setups with heavy indexing, this may need to be configurable.
- **Growth**: `resizeIndex()` is called automatically before addPoint when at capacity. Cost is O(n) memory reallocation but no graph rebuild -- connections are preserved. This is already implemented correctly.
- **Rebuild from SQLite**: The `rebuild()` method creates a fresh index from `{id, embedding}[]` pairs fetched from SQLite. Use this for corruption recovery. Cost is O(n*log(n)) for full graph construction.
- **Persistence**: `save()`/`load()` round-trip the index to disk. On load, `readIndexSync` with `allowReplaceDeleted: true` preserves the ability to insert into deleted slots.
- **Deleted element handling**: `markDelete()` soft-deletes, `addPoint(vec, id, true)` reuses deleted slots. Over time, many deletions without rebuild leads to graph degradation -- search quality drops as deleted nodes create "holes" in the navigation graph.

**What's actually broken (based on PROJECT.md + codebase analysis):**
The issue states "HNSW index capacity exceeded, search returns empty, inserts crash." Given the code already has `ensureCapacity()`, the likely failure modes are:
1. **SQLite-HNSW sync desync**: Chunk IDs in SQLite don't match labels in HNSW index (e.g., after crash mid-insert, or after index file corruption/loss without rebuild)
2. **Loaded index capacity mismatch**: When loading a saved index, `readIndexSync` restores the index with its original maxElements. If current count equals that max, subsequent inserts fail because `ensureCapacity` checks `getCurrentCount() >= getMaxElements()` AFTER load, but if the condition is exactly at boundary, the first insert after load may race.
3. **Search on empty index after failed load**: If the `.dat` file is missing/corrupt, `load()` throws, leaving the constructor's empty 10k-capacity index. But if the calling code catches the error silently and proceeds, search on an empty HNSW returns `[]` while SQLite has real data.

**Table stakes fix checklist:**
- Verify HNSW-SQLite sync on startup (rebuild from SQLite if HNSW file missing/corrupt)
- Ensure `ensureCapacity()` fires before every `addPoint`, including after load
- Add health check: count of HNSW labels vs count of vec_chunks rows
- Log capacity events (resize, rebuild) to JSONL event system
- Make `INITIAL_CAPACITY` configurable via plugin config
- Integration test: insert 10,001 vectors, search succeeds, save/load/search still works

**Confidence:** HIGH -- hnswlib-node API verified from type definitions at `node_modules/hnswlib-node/lib/index.d.ts`, codebase examined directly.

---

### 2. Installer Shell Script (curl | sh)

| Aspect | Detail |
|--------|--------|
| Why Expected | v1.1 goal is "installable by others." Without this, only the author can run AOF. |
| Complexity | MEDIUM |
| Depends On | Existing `wizard.ts`, `installer.ts`, `updater.ts`, `channels.ts` in src/packaging/ |

**What good CLI installers do (pattern analysis from nvm, Homebrew, Volta, Deno, Bun):**

1. **Detection phase** (before any writes):
   - Check OS (macOS vs Linux) and architecture (arm64 vs x64)
   - Check Node.js version >= 22.0.0 (AOF's engine requirement)
   - Check for existing installation (offer upgrade vs fresh install)
   - Check for OpenClaw gateway at `~/.openclaw/` (AOF is an OpenClaw plugin)
   - Display what will happen, ask for confirmation (unless `--yes` flag)

2. **Download phase**:
   - Fetch tarball from GitHub Release (use channels: stable/beta/canary -- already in `channels.ts`)
   - Verify integrity (SHA256 checksum at minimum, GPG signature is a differentiator)
   - Show progress indicator

3. **Install phase**:
   - Extract to target directory (AOF project root)
   - Run `npm ci` for dependencies (already in `installer.ts`)
   - Create directory structure (tasks/, events/, org/ -- already in `wizard.ts`)
   - Generate minimal org chart from template (already in `wizard.ts`)
   - Wire up as OpenClaw plugin (copy to `~/.openclaw/extensions/aof/` or symlink)
   - Register CLI commands (`aof`, `aof-daemon`)

4. **Verification phase**:
   - Health check: org chart valid, directory structure intact (already in `wizard.ts`)
   - Plugin detection: verify OpenClaw sees AOF
   - Print success message with next steps

5. **Idempotency**:
   - Running installer twice does not corrupt state
   - Existing tasks/, events/, memory/ are preserved on update
   - `--force` flag for complete reinstall

**What already exists vs what's missing:**

| Component | Status | Gap |
|-----------|--------|-----|
| `wizard.ts` | Creates dirs, org chart, health check | Needs shell script wrapper, Node version check, OpenClaw plugin wiring |
| `installer.ts` | npm ci/install with backup | Needs to be callable from shell script, not just TypeScript |
| `updater.ts` | Download, extract, backup, rollback | `extractTarball()` is a placeholder stub -- not implemented |
| `channels.ts` | stable/beta/canary with GitHub API | Repo URL is placeholder `"aof/aof"` -- needs real repo path |
| Shell entry point | MISSING | Need `install.sh` that bootstraps without Node (chicken-and-egg: need Node to install AOF, but AOF needs Node) |

**The chicken-and-egg problem:**
AOF is a Node.js project requiring Node >= 22. The installer must handle the case where Node is not installed. Two viable approaches:
- **Approach A (recommended)**: Require Node as a prerequisite. Detect, fail with clear instructions if missing. This is what most Node.js tools do (ESLint, Prettier, etc.).
- **Approach B**: Bundle a Node binary (like Volta/Bun do). This is a much larger scope.

Approach A is correct for v1.1. The shell script's job is: check prerequisites, fetch release, extract, run `node installer.js`, report results.

**Confidence:** HIGH -- examined existing packaging code, compared against nvm/Homebrew/Volta patterns.

---

### 3. CI Pipeline with Changelog and Release Automation

| Aspect | Detail |
|--------|--------|
| Why Expected | No CI means no confidence in releases. Pre-existing test failures (0.5% of 2400+) accumulate. Changelog communicates value. |
| Complexity | LOW-MEDIUM |
| Depends On | Existing release-it config, commitlint, simple-git-hooks, GitHub repo at demerzel-ops/aof |

**What the existing tooling already provides:**

AOF has a well-configured release pipeline that just needs CI wiring:

- **Commit conventions**: commitlint with `@commitlint/config-conventional` enforces `feat:`, `fix:`, `perf:`, etc.
- **Git hooks**: `simple-git-hooks` runs commitlint on commit-msg
- **Release automation**: `release-it` with `@release-it/conventional-changelog` plugin
  - Generates GitHub Releases with categorized changelogs (Features, Bug Fixes, Performance, Refactor, Tests, etc.)
  - Tags with `v${version}`, pushes tags
  - Runs `npm run typecheck` and `npm test` as pre-release hooks
  - Does NOT publish to npm (`"npm": { "publish": false }`)
- **Existing workflows**: `docs.yml` (unknown trigger), `e2e-tests.yml` (manual trigger only, disabled)

**What's missing for a full CI pipeline:**

| Component | Status | What to Build |
|-----------|--------|---------------|
| Unit test workflow | MISSING | On push/PR: checkout, Node 22, npm ci, typecheck, test |
| Build verification | MISSING | Verify `npm run build` succeeds, TypeScript compiles cleanly |
| Release workflow | MISSING | On tag push or manual: run release-it, create GitHub Release with changelog |
| CHANGELOG.md generation | NOT ENABLED | release-it config has `"infile": false` -- change to `"infile": "CHANGELOG.md"` to persist changelog |
| Pre-existing test fixes | NEEDED | ~12 test failures (0.5% of 2400+) must be fixed or acknowledged to get CI green |
| E2E workflow | EXISTS (disabled) | Keep disabled for now -- requires running OpenClaw instance |

**Standard CI workflow structure for TypeScript projects:**

```yaml
# .github/workflows/ci.yml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [22.x]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
      - run: npm test
```

```yaml
# .github/workflows/release.yml
on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Release type (patch, minor, major)'
        required: true
        default: 'patch'

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for changelog
      - uses: actions/setup-node@v4
        with:
          node-version: 22.x
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run release:${{ inputs.version }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Semantic versioning convention for AOF:**
- `fix:` = patch (0.1.0 -> 0.1.1)
- `feat:` = minor (0.1.0 -> 0.2.0)
- `feat!:` or `BREAKING CHANGE:` = major (0.1.0 -> 1.0.0)

Currently at 0.1.0. The v1.1 milestone will likely produce 0.2.0 (features added).

**Confidence:** HIGH -- release-it config and package.json examined directly, standard GitHub Actions patterns well-documented.

---

### 4. Multi-Project Task Routing Verification

| Aspect | Detail |
|--------|--------|
| Why Expected | Project primitive exists in code but has never been verified end-to-end. Tasks must route to correct projects, tools must expose project-scoped data. |
| Complexity | MEDIUM |
| Depends On | Existing projects subsystem (registry, resolver, manifest, lint, bootstrap, migration), task store, dispatcher, MCP tools |

**What project isolation means in AOF's architecture:**

Based on codebase examination, the project system works as follows:

1. **Project discovery** (`registry.ts`): Scans `<vaultRoot>/Projects/` for directories containing `project.yaml`. Validates manifests via Zod schema. Builds parent/child hierarchy.

2. **Project resolution** (`resolver.ts`): Maps project IDs to filesystem paths. Defaults to `_inbox` when no project specified. Uses `AOF_ROOT` env var or `~/Projects/AOF`.

3. **Project manifest** (`schemas/project.ts`): Defines per-project config including:
   - `routing.intake.default` -- where new tasks land (default: "Tasks/Backlog")
   - `routing.mailboxes.enabled` -- whether agents can receive mailbox messages
   - `memory.tiers` -- bronze/silver/gold memory tier mapping to cold/warm
   - `memory.allowIndex` / `memory.denyIndex` -- which paths get indexed
   - `sla` -- per-project SLA with violation policy
   - `workflow` -- per-project workflow configuration
   - `owner.team` / `owner.lead` -- org chart integration
   - `participants` -- which agents can work on this project

4. **Task dispatch** (`project-tools.ts`): Creates tasks via `ctx.store.create()` -- but does NOT appear to pass project ID to the task store. This is a gap.

5. **Tool exposure** (`tools/*.ts`): MCP tools are registered globally. No per-project tool filtering is visible in the codebase.

**What "end-to-end verification" means:**

The following must work:
- Create project with manifest -> project appears in registry
- Create task scoped to project -> task lands in project's task directory
- Dispatcher routes task -> only agents in project's `participants` or `owner.team` receive it
- Memory search respects project's `memory.denyIndex` paths
- Tools exposed to an agent session are filtered by project context
- Project lint catches misconfiguration (task in wrong project, missing dirs)

**What multi-project tool isolation looks like in practice:**

The MCP agent orchestration ecosystem (as of 2026) converges on a pattern:
- **Namespaced tool definitions**: Each project exposes tools prefixed with project scope. Agent sees `aof.project-x.create-task` not just `aof.create-task`.
- **Context injection**: When an agent session is spawned for a project, the tool context includes the project ID. All tool calls are implicitly scoped.
- **File isolation**: Agents working on project A cannot read/write files in project B's directory tree.

For AOF specifically, the pragmatic approach (matching existing architecture) is **context injection**: the `ToolContext` object (already defined in `aof-tools.ts`) gets a `projectId` field, and tools use it to scope operations.

**Confidence:** MEDIUM-HIGH -- codebase examined, but actual dispatcher behavior with projects not tested. The gap between "code exists" and "code works end-to-end" is the whole point of this verification feature.

---

## Differentiators

Features that set v1.1 apart. Not required for the milestone, but valuable if achievable.

| Feature | Value Proposition | Complexity | Depends On | Notes |
|---------|-------------------|------------|------------|-------|
| **HNSW health dashboard in CLI** | `aof memory health` shows index count vs SQLite count, fragmentation %, last rebuild time. Makes invisible memory state visible. | LOW | Memory fix (table stakes #1) | No other orchestrator surfaces vector index health. Adds confidence that memory is working. |
| **Installer with OpenClaw auto-detection** | Installer detects running OpenClaw gateway, auto-configures plugin wiring without user intervention. | LOW | Already in `wizard.ts` detectOpenClaw() | Existing code detects; gap is auto-wiring the plugin.json into gateway config. |
| **Changelog in GitHub Releases** | Each release has a categorized, human-readable changelog generated from conventional commits. | LOW | CI pipeline (table stakes #3) | Already configured in release-it; just needs `"infile": "CHANGELOG.md"` and CI trigger. |
| **Project template scaffolding** | `aof project create --template swe` generates project directory with task dirs, artifact tiers, memory config, and starter org chart entries. | LOW | Projects subsystem (table stakes #4) | `buildProjectManifest` exists; gap is CLI command + directory creation. |
| **Memory rebuild CLI command** | `aof memory rebuild` forces full HNSW rebuild from SQLite, with progress output. Recovery tool for when index is corrupt but SQLite data is intact. | LOW | Memory fix (table stakes #1) | `HnswIndex.rebuild()` exists; gap is CLI wiring + progress feedback. |

---

## Anti-Features

Features that seem related to v1.1 but should NOT be built.

| Anti-Feature | Why Requested | Why Avoid | What to Do Instead |
|--------------|---------------|-----------|-------------------|
| **Autoupdate mechanism** | "Installer should keep AOF updated automatically" | Explicitly deferred to v2 in PROJECT.md. Auto-updates that break running daemons are dangerous. | Manual update via `aof update` command that checks channels.ts for new versions. User runs it explicitly. |
| **Memory search reranker** | "Search quality could be better with cross-encoder reranking" | Explicitly deferred to v1.2 in PROJECT.md. Adds @huggingface/transformers dependency (~22MB model). Complexity disproportionate to v1.1 scope. | Already wired as optional in config schema with `"enabled": false` default. Ship v1.1 with BM25+vector hybrid; enable reranker later. |
| **Memory tier auto-compaction** | "Old memories should automatically compact/archive" | Explicitly deferred to v2. Compaction during active operations risks data loss. | Manual curation via existing medallion pipeline (generate, audit, curate). |
| **npm publish** | "Publish AOF to npm registry" | release-it config explicitly sets `"npm": { "publish": false }`. AOF is an OpenClaw plugin, not a standalone npm package. Distribution is via GitHub Releases + installer. | GitHub Releases with tarball assets. Installer fetches from GitHub API. |
| **Multi-platform native binaries** | "Compile to standalone binary like Bun/Deno" | Requires pkg/nexe/bun compile toolchain. hnswlib-node has native N-API bindings that can't trivially cross-compile. | Require Node.js >= 22 as prerequisite. Shell installer validates this. |
| **OpenClaw version compatibility checks** | "Warn if gateway version is incompatible" | Explicitly deferred to v2 in PROJECT.md. Requires understanding gateway versioning scheme. | peerDependencies in package.json already specifies `"openclaw": ">=2026.2.0"`. npm warns on mismatch. |
| **Visual project dashboard** | "Show project status in a web UI" | Explicitly out of scope (no UI/dashboard for v1). | `aof project list` CLI command + JSONL events. Pipe to jq for custom views. |

---

## Feature Dependencies

```
[HNSW Memory Fix]
    requires -> [hnswlib-node resizeIndex API] (verified: exists in v3.x)
    requires -> [sqlite-vec as fallback search path] (exists)
    requires -> [VectorStore dual-path search] (exists)
    enables -> [Memory health CLI command] (differentiator)
    enables -> [Memory rebuild CLI command] (differentiator)
    enables -> [Project memory isolation verification]

[Installer/Updater Shell Script]
    requires -> [Node.js >= 22 on target machine] (prerequisite, not built)
    requires -> [wizard.ts directory scaffolding] (exists)
    requires -> [channels.ts GitHub API version check] (exists, needs real repo URL)
    requires -> [updater.ts tarball extraction] (STUB -- needs implementation)
    requires -> [GitHub Release with tarball assets] (needs CI pipeline)
    enables -> [External users can install AOF]

[CI Pipeline]
    requires -> [Pre-existing test failures fixed] (~12 tests, 0.5% fail rate)
    requires -> [commitlint + conventional commits] (exists, enforced by git hooks)
    requires -> [release-it config] (exists, well-configured)
    enables -> [Automated changelog generation]
    enables -> [GitHub Releases with tarballs] (needed by installer)
    enables -> [Installer can fetch from releases]

[Project Routing Verification]
    requires -> [Project registry discovery] (exists)
    requires -> [Task store project scoping] (GAP -- tasks not project-scoped)
    requires -> [ToolContext project injection] (GAP -- no projectId in context)
    requires -> [Memory fix working] (can't verify project memory isolation without working memory)
    requires -> [Dispatcher project awareness] (GAP -- dispatcher doesn't filter by project)
    enables -> [Multi-project deployments work]
```

### Dependency Notes

- **CI pipeline enables installer**: The installer fetches from GitHub Releases. Without CI creating releases, the installer has nothing to download. CI must be built first (or concurrently with manual releases).
- **Memory fix enables project verification**: Project memory isolation depends on working HNSW. Can't verify project-scoped memory without a functioning index.
- **Project verification has the most gaps**: The projects subsystem has extensive scaffolding (registry, resolver, manifest, lint) but the actual dispatch integration is thin. The `project-tools.ts` dispatch function does not pass project ID. The tool context has no project scoping.
- **Test failures block CI**: 0.5% failure rate means CI will fail on every push. Must fix or skip known failures before CI is useful.

---

## MVP Recommendation

### Phase Ordering (based on dependencies):

**Phase 1: Memory Fix + Test Stabilization** (parallel tracks)
- Fix HNSW capacity/sync issues
- Fix ~12 pre-existing test failures to get clean test suite
- Rationale: Memory is P0, tests are gate for CI

**Phase 2: CI Pipeline**
- Add GitHub Actions workflows (ci.yml + release.yml)
- Enable CHANGELOG.md generation
- Create first automated release
- Rationale: Enables installer (needs release artifacts) and establishes quality gate

**Phase 3: Installer**
- Write `install.sh` shell script
- Fix `extractTarball()` stub in updater.ts
- Fix repo URL placeholder in channels.ts
- Wire OpenClaw plugin integration
- Rationale: Depends on CI creating release tarballs

**Phase 4: Project Routing Verification**
- Add `projectId` to `ToolContext`
- Wire project scoping into task store
- Add dispatcher project filtering
- Integration tests for end-to-end flow
- Rationale: Depends on working memory, has the most gaps to fill

### Prioritize (must have for v1.1):
1. HNSW memory fix -- without this AOF is broken
2. Pre-existing test fixes -- gate for CI
3. CI pipeline with changelog -- establishes release infrastructure
4. Installer shell script -- makes AOF installable by others
5. Project routing verification -- proves multi-project works

### Defer if time-constrained:
- Memory rebuild CLI command (can rebuild programmatically, CLI is UX polish)
- Project template scaffolding (can create project.yaml manually)
- HNSW health dashboard (can inspect SQLite directly)

---

## Sources

- [hnswlib-node type definitions](/Users/xavier/Projects/AOF/node_modules/hnswlib-node/lib/index.d.ts) -- HIGH confidence (verified API: resizeIndex, markDelete, addPoint replaceDeleted)
- [nmslib/hnswlib issue #39: resizing incremental index](https://github.com/nmslib/hnswlib/issues/39) -- HIGH confidence (maintainer confirms resize behavior)
- [Enhancing HNSW for Real-Time Updates](https://arxiv.org/html/2407.07871v2) -- MEDIUM confidence (academic, addresses graph degradation from deletions)
- [SHINE: Scalable HNSW in Disaggregated Memory](https://arxiv.org/html/2507.17647v1) -- LOW confidence (academic, different architecture but validates scaling concerns)
- [release-it/conventional-changelog](https://github.com/release-it/conventional-changelog) -- HIGH confidence (official plugin docs)
- [conventional-changelog preset types](https://github.com/conventional-changelog/conventional-changelog) -- HIGH confidence (official)
- [Changelog Generation in GitHub Actions](https://oneuptime.com/blog/post/2025-12-20-changelog-generation-github-actions/view) -- MEDIUM confidence (community guide)
- [semantic-release GitHub Actions recipe](https://semantic-release.gitbook.io/semantic-release/recipes/ci-configurations/github-actions) -- HIGH confidence (official docs)
- [nvm install.sh](https://github.com/nvm-sh/nvm) -- HIGH confidence (reference implementation for curl|sh pattern)
- [Node.js CLI Apps Best Practices](https://github.com/lirantal/nodejs-cli-apps-best-practices) -- HIGH confidence (maintained community resource)
- [MCP-Driven Agent Orchestration Patterns](https://techcommunity.microsoft.com/blog/azuredevcommunityblog/orchestrating-multi-agent-intelligence-mcp-driven-patterns-in-agent-framework/4462150) -- MEDIUM confidence (Microsoft patterns)
- [LangChain Multi-agent docs](https://docs.langchain.com/oss/python/langchain/multi-agent) -- MEDIUM confidence (different ecosystem but patterns apply)
- [Azure AI Agent Design Patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns) -- MEDIUM confidence (architecture patterns for isolation)
- [jpicklyk/task-orchestrator MCP server](https://github.com/jpicklyk/task-orchestrator) -- MEDIUM confidence (comparable project, validates task-per-project pattern)

---
*Feature research for: AOF v1.1 Stabilization & Ship*
*Researched: 2026-02-26*
