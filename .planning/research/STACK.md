# Technology Stack

**Project:** AOF v1.1 Stabilization & Ship
**Researched:** 2026-02-26
**Scope:** Stack additions/changes for memory HNSW fix, curl|sh installer, CI pipeline, project verification
**Confidence:** HIGH (no new dependencies needed; all changes use existing installed packages)

---

## Executive Decision: No New Dependencies

All four v1.1 features can be delivered with the existing dependency tree. This is the most important finding of this research. The problems are in AOF's wrapper code and missing workflow/script files, not in missing libraries.

```bash
# Nothing new to install.
npm ci   # verify clean state
```

---

## Area 1: Memory HNSW Fix/Scaling

### Existing Stack (retain as-is)

| Technology | Installed Version | Purpose |
|------------|-------------------|---------|
| hnswlib-node | 3.0.0 | HNSW approximate nearest-neighbor index |
| better-sqlite3 | 12.6.2 | SQLite bindings for chunk metadata + FTS |
| sqlite-vec | 0.1.7-alpha.2 | Vector search fallback in SQLite |

### Bug Analysis

The `HnswIndex` wrapper at `src/memory/store/hnsw-index.ts` has an `ensureCapacity()` method that calls `resizeIndex(max * GROWTH_FACTOR)` when `count >= max`. This is architecturally correct. The hnswlib-node 3.0.0 API confirmed from installed type definitions (`node_modules/hnswlib-node/lib/index.d.ts`):

```typescript
// Confirmed available in hnswlib-node 3.0.0:
resizeIndex(newMaxElements: number): void;  // grows capacity in-place
getCurrentCount(): number;                   // includes deleted elements in count
getMaxElements(): number;                    // current capacity ceiling
getIdsList(): number[];                      // live (non-deleted) IDs only
markDelete(label: number): void;
unmarkDelete(label: number): void;
```

**Root cause candidates (in order of likelihood):**

1. **Rebuild creates zero-headroom index.** `rebuild()` uses `Math.max(chunks.length, INITIAL_CAPACITY)` as capacity. If chunks.length > 10,000, capacity == count. The next `add()` hits `ensureCapacity()`, but if `getCurrentCount()` includes deleted-but-not-reclaimed elements from the old index, the count can exceed capacity before `ensureCapacity` checks.

2. **Load path loses capacity headroom.** `hnsw.load(filePath)` creates a new `HierarchicalNSW` with `readIndexSync()`. The loaded index preserves the maxElements from when it was saved. If saved at full capacity, the next insert races with resize.

3. **Deleted-element count inflation.** HNSW's `getCurrentCount()` counts all elements including marked-as-deleted. Over time with updates (mark-delete + add-with-replace), the internal count grows even though live element count is stable. Eventually count exceeds max without triggering resize (because count was already above max after load).

### Fix Approach (no new deps)

| Change | File | What |
|--------|------|------|
| Add headroom to rebuild | `hnsw-index.ts` | `rebuild()` uses `chunks.length * 1.5 + 1000` instead of exact count |
| Pre-check capacity on add | `hnsw-index.ts` | `ensureCapacity()` checks `count >= max - 1` (one slot of headroom) |
| Add compaction method | `hnsw-index.ts` | New `compact()` that rebuilds from `getIdsList()` + `getPoint()`, reclaiming deleted slots |
| Periodic HNSW save | `index.ts` | Save every N inserts (not just on shutdown), configurable via memory config |
| Rebuild on capacity error | `hnsw-index.ts` | Catch `addPoint` failure, trigger `rebuild()` from live IDs, retry insert |

**Key insight:** `getIdsList()` returns only live (non-deleted) IDs. Combined with `getPoint(label)` to retrieve vectors, this enables a clean rebuild that reclaims all deleted-element slots. This is the compaction strategy.

### What NOT to change

| Rejected Change | Why |
|-----------------|-----|
| Drop HNSW, use sqlite-vec only | sqlite-vec is alpha (0.1.7-alpha.2), maintainer has limited bandwidth per [issue #226](https://github.com/asg017/sqlite-vec/issues/226). HNSW is ~10x faster for search. |
| Switch to usearch/vectorlite | Bug is in AOF's wrapper, not in hnswlib-node. Library works correctly. |
| Add Qdrant/Milvus/Chroma | Violates filesystem-based constraint. Massive dependency for single-machine use. |
| Upgrade hnswlib-node | 3.0.0 is the latest version (released 2024-03-11, no newer release). |

**Confidence: HIGH** -- Verified API from installed type definitions. Bug is in wrapper code, not the library.

---

## Area 2: curl|sh Installer and Updater

### Existing Stack

AOF already has a substantial packaging module (`src/packaging/`):

| Module | File | Status |
|--------|------|--------|
| Dependency installer | `installer.ts` | Built -- npm ci/install wrapper with backup/rollback |
| Self-update engine | `updater.ts` | Built -- download, extract, validate, atomic swap, rollback |
| Setup wizard | `wizard.ts` | Built -- interactive setup |
| Gateway integration | `integration.ts` | Built -- OpenClaw plugin registration |
| Release channels | `channels.ts` | Built -- channel management |
| Data migrations | `migrations.ts` | Built -- schema migration framework |
| Plugin ejector | `ejector.ts` | Built -- plugin uninstall |
| **Shell installer** | **missing** | **NOT BUILT** -- the curl\|sh entry point |

The TypeScript machinery exists. What is missing is the POSIX shell script that serves as the entry point for `curl -fsSL https://get.aof.dev/install.sh | sh`.

### What to build

**One file: `scripts/install.sh`** -- A POSIX sh script (not bash) following established patterns from nvm and pnpm.

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Shell dialect | POSIX sh (`#!/bin/sh`) | Wider compatibility -- works on Alpine, minimal containers, older macOS |
| Distribution | GitHub Releases tarball (.tar.gz) | Already configured in `.release-it.json` (`github.release: true`) |
| Native modules | `npm ci` post-extract | better-sqlite3 and hnswlib-node require per-platform compilation |
| Node.js detection | `node --version` with major version check | Fail clearly if Node < 22 |
| Install location | `~/.openclaw/extensions/aof/` | Matches existing `deploy-plugin.sh` target |
| Update mode | `--update` flag on same script | Reuses all detection logic, calls existing TypeScript updater |
| Hosting URL | `https://raw.githubusercontent.com/demerzel-ops/aof/main/scripts/install.sh` | Free, no infrastructure needed |

### Script structure (reference)

```sh
#!/bin/sh
set -e

AOF_INSTALL_DIR="${AOF_INSTALL_DIR:-$HOME/.openclaw/extensions/aof}"
AOF_REPO="demerzel-ops/aof"

# 1. Detect OS/arch
detect_platform() { ... }

# 2. Check Node.js >= 22
check_node() {
  command -v node >/dev/null 2>&1 || { echo "Error: Node.js >= 22 required" >&2; exit 1; }
  NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
  [ "$NODE_MAJOR" -ge 22 ] || { echo "Error: Node.js >= 22 required (found v$NODE_MAJOR)" >&2; exit 1; }
}

# 3. Download latest release tarball
download_release() { ... }

# 4. Extract, npm ci, validate
install_aof() { ... }

# 5. Print next-steps
print_success() { ... }
```

### Reference implementations studied

- **nvm**: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash` -- platform detection, version validation, idempotent
- **pnpm**: `curl -fsSL https://get.pnpm.io/install.sh | sh` -- POSIX sh, graceful fallback

### What NOT to build

| Rejected | Why |
|----------|-----|
| Homebrew formula | Maintenance burden, out of v1.1 scope |
| npm global install (`npm i -g aof`) | Native modules cause cross-platform issues with global installs |
| Docker installer | Users run bare metal with OpenClaw |
| Auto-update mechanism | Deferred to v2 per PROJECT.md |
| Windows/PowerShell support | Not in current scope |

**Confidence: HIGH** -- Pattern is well-established, no novel technology. Existing `src/packaging/` provides the TypeScript backend.

---

## Area 3: CI Pipeline with Changelog and Release Automation

### Existing Stack

| Component | Status | Version |
|-----------|--------|---------|
| release-it | Installed & configured | 19.2.4 |
| @release-it/conventional-changelog | Installed & configured | 10.0.5 |
| @commitlint/cli | Installed & configured | 20.4.2 |
| @commitlint/config-conventional | Installed & configured | 20.4.2 |
| simple-git-hooks | Installed & configured | 2.13.1 |
| `.release-it.json` | Configured | conventional-commits preset, GitHub releases, npm publish disabled |
| `.github/workflows/e2e-tests.yml` | Exists (manual trigger only) | Disabled, needs activation |
| `.github/workflows/docs.yml` | Exists (active) | Deploys Astro docs on push to main |
| **CI test workflow** | **MISSING** | No workflow runs tests on PR/push |
| **Release workflow** | **MISSING** | release-it is manual only (`npm run release`) |

### What to build

**Two new workflow files** using GitHub Actions (already in use for docs):

#### `.github/workflows/ci.yml` -- Test on PR and push to main

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

#### `.github/workflows/release.yml` -- Manual release with bump type

```yaml
name: Release
on:
  workflow_dispatch:
    inputs:
      bump:
        description: 'Version bump type'
        type: choice
        options: [patch, minor, major]
        default: patch

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
      - run: npm run release:${{ inputs.bump }} -- --ci
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Technology decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| CI platform | GitHub Actions | Repo is on GitHub, docs workflow already uses Actions |
| Node.js version in CI | Pin 22.x | Matches `engines` field. Node 24/25 have [better-sqlite3 build failures](https://github.com/WiseLibs/better-sqlite3/issues/1411) due to V8 API changes. |
| Changelog generation | release-it + @release-it/conventional-changelog | Already installed and configured in `.release-it.json` |
| Commit convention | Conventional Commits | Already enforced via commitlint + simple-git-hooks |
| Release trigger | Manual `workflow_dispatch` | Intentional releases, not auto-deploy on merge |
| npm publish | Disabled | `npm.publish: false` in `.release-it.json` -- AOF is a plugin, not an npm package |
| Test matrix | Single (Node 22, ubuntu-latest) | Only one supported Node version per `engines` |

### Native module CI considerations

| Module | CI Behavior | Extra Setup Needed |
|--------|------------|-------------------|
| better-sqlite3 12.6.2 | Downloads prebuild binary via `prebuild-install` on Node 22 ubuntu-latest | None |
| hnswlib-node 3.0.0 | Compiles from C++ via `node-gyp` + `node-addon-api` | None (`build-essential` and `python3` are pre-installed on `ubuntu-latest`) |
| sqlite-vec 0.1.7-alpha.2 | Ships precompiled in npm package | None |

### Existing release-it configuration (retain as-is)

The `.release-it.json` is well-configured:
- Conventional commits preset with categorized sections (Features, Bug Fixes, Performance, etc.)
- `chore` and `ci` types hidden from changelog
- Pre-release hooks run `typecheck` and `test`
- GitHub Release enabled with proper token handling
- npm publish disabled
- Clean working directory required
- Tag format: `v${version}`

### What NOT to add

| Rejected | Why |
|----------|-----|
| release-please (Google) | Already using release-it with working config. Switching tools mid-project adds risk for zero benefit. |
| semantic-release | Same rationale. release-it is simpler and already configured. |
| Auto-release on merge | Intentional releases preferred per PROJECT.md. Manual workflow_dispatch. |
| CHANGELOG.md file | `.release-it.json` has `"infile": false`. Changelog goes to GitHub Release notes only. |
| Multi-version test matrix | Only Node 22 supported. No value in testing 20/24. |
| Code coverage reporting | Nice-to-have, not v1.1 scope. Can add Codecov later. |

**Confidence: HIGH** -- All tools already installed. CI is just two YAML workflow files.

---

## Area 4: Multi-Project Routing Verification

### Existing Stack

The projects subsystem is fully built. This area requires **verification tests only**, not new code or dependencies.

| Module | Path | What it does |
|--------|------|-------------|
| Registry | `src/projects/registry.ts` | Discovers projects from `vaultRoot/Projects/`, validates YAML manifests, builds parent/child hierarchy |
| Resolver | `src/projects/resolver.ts` | Resolves project IDs to filesystem paths, handles `_inbox` default |
| Bootstrap | `src/projects/bootstrap.ts` | Creates new project directory structures |
| Linting | `src/projects/lint.ts` + `lint-helpers.ts` | Validates project structure and manifests |
| Manifest | `src/projects/manifest.ts` | Builds and writes `project.yaml` |
| Migration | `src/projects/migration.ts` | Migrates existing data to project structure |
| Schema | `src/schemas/project.ts` | Zod schema for project manifests |
| CLI | `src/cli/commands/project.ts` | Project CRUD commands |
| Tools | `src/tools/project-tools.ts` | Task dispatch with project context |
| Multi-project polling | `src/service/aof-service.ts` | AOFService discovers and polls multiple project task stores |
| MCP adapter | `src/mcp/adapter.ts` | Tool exposure to agents |
| Existing tests | `src/service/__tests__/multi-project-polling.test.ts` | Unit tests for TASK-069 |

### What needs verification (tests, not new deps)

| Test | Type | Framework |
|------|------|-----------|
| Multi-project dispatch end-to-end | Integration test | vitest (existing) |
| Tool exposure includes project context | Integration test | vitest (existing) |
| Memory pool isolation across projects | Integration test | vitest (existing) |
| CLI project commands (`list`, `create`, `lint`) | CLI integration test | vitest (existing) |

### Technology decision

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Test framework | vitest (existing) | Already has 2400+ tests, no reason to change |
| Test location | `src/service/__tests__/` and `src/projects/__tests__/` | Follow existing patterns |
| New dependencies | None | All code and test infrastructure exists |

**Confidence: HIGH** -- Pure verification work. No stack changes.

---

## Complete Stack Summary for v1.1

### Dependencies: No Changes

```
Current package.json is correct as-is for all v1.1 work.
No npm install/add/remove needed.
```

### New Files to Create

| File | Type | Purpose |
|------|------|---------|
| `scripts/install.sh` | POSIX shell | curl\|sh installer entry point |
| `.github/workflows/ci.yml` | GitHub Actions YAML | Test on PR/push |
| `.github/workflows/release.yml` | GitHub Actions YAML | Manual release automation |

### Existing Files to Modify

| File | Change | Area |
|------|--------|------|
| `src/memory/store/hnsw-index.ts` | Fix capacity handling, add compaction | Memory |
| `src/memory/index.ts` | Fix rebuild headroom, periodic save | Memory |
| `.github/workflows/e2e-tests.yml` | Activate PR trigger (when ready) | CI |

### Existing Files to Add Tests For

| File | Test File | Area |
|------|-----------|------|
| `src/service/aof-service.ts` | New integration tests | Projects |
| `src/mcp/adapter.ts` | New integration tests | Projects |
| `src/memory/store/hnsw-index.ts` | Capacity edge-case tests | Memory |

---

## Version Compatibility (v1.1 relevant)

| Component | Pinned Version | CI Version | Notes |
|-----------|---------------|------------|-------|
| Node.js | >=22.0.0 (engines) | 22.x | Do NOT use 24/25 -- better-sqlite3 build failures |
| hnswlib-node | 3.0.0 | Same | Latest version, no upgrade available |
| better-sqlite3 | 12.6.2 | Same | Has prebuilds for Node 22 ubuntu-latest |
| sqlite-vec | 0.1.7-alpha.2 | Same | Ships precompiled, no compilation needed |
| release-it | 19.2.4 | Same | Used in release workflow |
| GitHub Actions runners | N/A | ubuntu-latest | Node 22 + build-essential pre-installed |

---

## Sources

### hnswlib-node (Memory)
- [HierarchicalNSW API documentation](https://yoshoku.github.io/hnswlib-node/doc/classes/HierarchicalNSW.html) -- HIGH confidence, confirmed `resizeIndex`, `getIdsList`, `getCurrentCount`, `getMaxElements`
- [hnswlib upstream resizing discussion (issue #39)](https://github.com/nmslib/hnswlib/issues/39) -- HIGH confidence, design rationale for resize behavior
- `node_modules/hnswlib-node/lib/index.d.ts` -- HIGH confidence, installed source of truth for API surface
- [hnswlib-node GitHub repository](https://github.com/yoshoku/hnswlib-node) -- MEDIUM confidence, 3.0.0 is latest release (2024-03-11)

### sqlite-vec (Memory)
- [sqlite-vec maintenance status (issue #226)](https://github.com/asg017/sqlite-vec/issues/226) -- HIGH confidence, maintainer confirmed limited bandwidth but "far from dead"

### CI/Release
- [better-sqlite3 Node.js 25 build failure (issue #1411)](https://github.com/WiseLibs/better-sqlite3/issues/1411) -- HIGH confidence, confirms need to pin Node 22 in CI
- [release-it GitHub repository](https://github.com/release-it/release-it) -- HIGH confidence, v19.2.4 is current
- [GitHub Actions release automation guide (2026)](https://oneuptime.com/blog/post/2026-02-02-github-actions-release-automation/view) -- MEDIUM confidence

### Installer Patterns
- [nvm install script](https://github.com/nvm-sh/nvm) -- HIGH confidence, well-established POSIX sh pattern
- [pnpm install script](https://pnpm.io/installation) -- HIGH confidence, another reference implementation
- [Node.js CLI best practices](https://github.com/lirantal/nodejs-cli-apps-best-practices) -- MEDIUM confidence

---
*Stack research for: AOF v1.1 Stabilization & Ship*
*Researched: 2026-02-26*
*Previous research (v1.0): 2026-02-25 -- retained items not repeated here*
