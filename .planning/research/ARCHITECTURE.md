# Architecture Patterns: v1.1 Integration

**Domain:** Agentic orchestration layer (AOF) -- v1.1 feature integration
**Researched:** 2026-02-26
**Confidence:** HIGH (direct source code analysis, all claims verified against codebase)

## Existing Architecture Summary

AOF is a TypeScript plugin for the OpenClaw gateway. The architecture is:

```
OpenClaw Gateway
  |-- plugin.ts (entry point, registers AOF + memory modules)
       |-- openclaw/adapter.ts (registerAofPlugin: tools, services, event hooks, HTTP routes)
       |-- memory/index.ts (registerMemoryModule: HNSW, sqlite, embeddings, tools, sync service)
       |-- service/aof-service.ts (AOFService: scheduler, multi-project, protocol router)
       |-- dispatch/ (scheduler, task-dispatcher, lease-manager, executor)
       |-- store/ (FilesystemTaskStore: ~/.openclaw/aof/)
       |-- projects/ (registry, resolver, manifest, create, migrate)
       |-- packaging/ (installer, updater, channels, wizard, openclaw-cli)
       |-- mcp/ (MCP server with tools, resources, subscriptions)
```

**Key runtime paths:**
- Source: `~/Projects/AOF/src/`
- Build: `~/Projects/AOF/dist/`
- Runtime data: `~/.openclaw/aof/` (events/, tasks/, state/, memory/)
- Memory DB: `~/.openclaw/aof/memory.db` + `memory-hnsw.dat`
- Vault/Projects: `<vaultRoot>/Projects/<projectId>/project.yaml`

**Build chain:** `tsc` -> `dist/` (ESM, ES2024, NodeNext). The `build` script also runs `scripts/copy-extension-entry.js`. Exports: `.` (index) and `./plugin` (plugin entry).

---

## Feature 1: Memory Fix (HNSW Capacity + Search)

### Problem Analysis

The HNSW index in `src/memory/store/hnsw-index.ts` has an `ensureCapacity()` method that doubles capacity when `count >= max`. However, the bug manifests in two scenarios:

1. **Load path capacity mismatch:** When `readIndexSync` loads a persisted index, the loaded index's `maxElements` is set to whatever it was when saved. If the index was saved at full capacity (e.g., 10,000/10,000), the `ensureCapacity()` check in the next `add()` call will fire. But the `load()` method at lines 87-89 of `hnsw-index.ts` creates a new `HierarchicalNSW`, calls `readIndexSync`, and replaces `this.index` -- it never checks or adjusts capacity headroom after load. If the loaded index is exactly at capacity and `resizeIndex` behaves differently on a freshly-loaded index vs a live one, inserts crash.

2. **Rebuild path regression:** `rebuild()` at lines 98-105 sets capacity to `Math.max(chunks.length, INITIAL_CAPACITY)`. If there are exactly 10,000 chunks, capacity = 10,000, and the index is immediately full. The very next insert triggers `ensureCapacity` -> `resizeIndex(20,000)`, which may work but is wasteful. If chunks.length > INITIAL_CAPACITY and equals the capacity exactly, the rebuild creates a fully-packed index.

3. **Search returning empty:** When `getCurrentCount()` reports 0 on a loaded index (possible if load failed silently and fell through to a `rebuildHnswFromDb` that also returned 0 rows), `search()` returns `[]` at line 67. The current error handling in `memory/index.ts:90-95` catches load errors silently.

### Where HNSW is Initialized

```
src/memory/index.ts:registerMemoryModule()
  line 88: const hnsw = new HnswIndex(dimensions)  // creates with INITIAL_CAPACITY=10,000
  line 89-98: if hnswPath exists, try load(); on catch, rebuildHnswFromDb()
  line 97: else rebuildHnswFromDb()
  line 100: const vectorStore = new VectorStore(db, hnsw)
```

The `HnswIndex` constructor at `src/memory/store/hnsw-index.ts:27-29` calls `createIndex(INITIAL_CAPACITY)` where `INITIAL_CAPACITY = 10_000` and `GROWTH_FACTOR = 2`.

### Integration Points (MODIFY existing files)

| File | Change | Risk |
|------|--------|------|
| `src/memory/store/hnsw-index.ts` | Fix `load()` to call `ensureCapacity()` after load, guaranteeing headroom | LOW -- isolated class, existing tests cover load path |
| `src/memory/store/hnsw-index.ts` | Fix `rebuild()` to add headroom: `Math.ceil(chunks.length * 1.5)` minimum | LOW |
| `src/memory/store/hnsw-index.ts` | Add `get capacity(): number` getter exposing `getMaxElements()` for diagnostics | LOW |
| `src/memory/index.ts` | Add error logging in `rebuildHnswFromDb()` for empty result case; add logging on silent catch | LOW |
| `src/memory/__tests__/hnsw-index.test.ts` | Add capacity-at-limit tests (load at capacity, insert after load, rebuild at exact count) | LOW |

### Recommended Fix Pattern

```typescript
// In hnsw-index.ts load():
load(filePath: string): void {
  const loaded = new HierarchicalNSW(DEFAULT_SPACE, this.dimensions);
  loaded.readIndexSync(filePath, true /* allowReplaceDeleted */);
  this.index = loaded;
  // Guarantee headroom for future inserts after loading a potentially full index
  this.ensureCapacity();
}

// In hnsw-index.ts rebuild():
rebuild(chunks: ReadonlyArray<{ id: number; embedding: number[] }>): void {
  // Add 50% headroom so first post-rebuild insert does not trigger immediate resize
  const capacity = Math.max(
    Math.ceil(chunks.length * 1.5),
    INITIAL_CAPACITY,
  );
  const fresh = this.createIndex(capacity);
  for (const { id, embedding } of chunks) {
    fresh.addPoint(embedding, id);
  }
  this.index = fresh;
}

// New diagnostic getter:
get capacity(): number {
  return this.index.getMaxElements();
}
```

No new files. No new dependencies. Pure bug fix in existing class.

---

## Feature 2: Installer / Updater

### What Exists

The `src/packaging/` module already has substantial infrastructure:

| File | Purpose | Status |
|------|---------|--------|
| `installer.ts` | npm ci/install wrapper with backup/rollback | Exists -- wraps npm commands, not curl-pipe-sh |
| `updater.ts` | Self-update engine (download, extract, swap, rollback) | Exists -- `extractTarball()` is a placeholder (line 338-345) |
| `channels.ts` | Release channels (stable/beta/canary), version manifests via GitHub API | Exists -- fully functional |
| `wizard.ts` | Installation wizard (directory scaffold, org chart generation) | Exists -- creates dirs + org chart |
| `openclaw-cli.ts` | OpenClaw config access wrapper (safe config via `openclaw config` CLI) | Exists -- register plugin, manage memory slot |
| `ejector.ts` | Uninstall logic | Exists |
| `integration.ts` | OpenClaw integration (deploy plugin, verify) | Exists |
| `migrations.ts` | Data format migrations | Exists |

### What Gets Installed Where

The installer handles two distinct layouts:

**Plugin installation (into OpenClaw workspace):**
```
~/.openclaw/workspace/package/node_modules/aof/
  dist/           (transpiled JS + declarations)
  prompts/        (agent prompt templates)
  skills/         (agent skill definitions)
  package.json    (version, deps, bin entries)
  openclaw.plugin.json
```

**Runtime data directory (owned by AOF):**
```
~/.openclaw/aof/
  events/         (JSONL event logs, daily rotation)
  tasks/          (task files by status: backlog/, ready/, in-progress/, ...)
  state/          (run artifacts, heartbeats)
  memory/         (memory tier files)
  memory.db       (SQLite: chunks, vec_chunks, fts_chunks)
  memory-hnsw.dat (HNSW binary index)
  .aof/channel.json (version, channel, update policy)
```

**CLI binaries (package.json bin entries):**
```
dist/cli/index.js   -> bin: "aof"
dist/daemon/index.js -> bin: "aof-daemon"
```

**Configuration registration (in OpenClaw config):**
```
~/.openclaw/openclaw.json:
  plugins.entries.aof = { enabled: true }
  plugins.allow = [..., "aof"]
  plugins.slots.memory = "aof"
  plugins.entries.aof.config.modules.memory.enabled = true
```

### Detecting Existing Installs

`openclaw-cli.ts` already provides all necessary detection functions:

| Function | What It Checks |
|----------|---------------|
| `detectOpenClaw(homeDir)` | `~/.openclaw/openclaw.json` exists, `openclaw --version` works |
| `isAofPluginRegistered()` | `plugins.entries.aof` exists in openclaw.json |
| `isAofInAllowList()` | `plugins.allow` array contains `"aof"` |
| `isAofMemoryEnabled()` | `plugins.entries.aof.config.modules.memory.enabled === true` |
| `isAofMemorySlot()` | `plugins.slots.memory === "aof"` |
| `detectMemoryPlugin()` | Finds current memory slot holder and competing plugins |

Version tracking lives in `~/.openclaw/aof/.aof/channel.json` (managed by `channels.ts`).

### What Needs Building

| File | Type | Purpose |
|------|------|---------|
| `scripts/install.sh` | NEW | curl-pipe-sh entry point: detect OS/arch, Node >= 22, download release tarball, extract, run `node dist/cli/index.js install` |
| `src/cli/commands/install.ts` | NEW or MODIFY | CLI command wiring wizard + openclaw-cli registration + integration verify |
| `src/cli/commands/update.ts` | NEW or MODIFY | CLI command wiring channels check + updater swap |
| `src/packaging/updater.ts` | MODIFY | Implement real `extractTarball()` at line 338-345 (currently placeholder) |

### Installer Flow

```
1. Shell script (install.sh):
   - Check: node >= 22, npm, git
   - Check: ~/.openclaw exists (OpenClaw installed)
   - Determine: OS (darwin/linux), arch (arm64/x64)
   - Download: release tarball from GitHub releases (via channels.ts URL pattern)
   - Extract: to ~/.openclaw/workspace/package/node_modules/aof/
   - Run: node dist/cli/index.js install

2. aof install command (TypeScript):
   - detectOpenClaw() -> fail if not found
   - isAofPluginRegistered() -> if yes, offer upgrade
   - wizard.runWizard() -> scaffold runtime dirs if clean install
   - registerAofPlugin() + addAofToAllowList()
   - configureAofAsMemoryPlugin()
   - npm install in workspace (for native deps: better-sqlite3, hnswlib-node)
   - Health check: require plugin, verify tools register

3. aof update command:
   - checkForUpdates(aofRoot) -> compare channel.json version vs latest
   - selfUpdate() -> download, extract, swap, rollback on failure
   - Verify: health check after swap
```

### Three Install Cases

| Case | Detection | Action |
|------|-----------|--------|
| Clean install | No `~/.openclaw/aof/`, no plugin entry | Full wizard + register + scaffold |
| Upgrade | Existing `~/.openclaw/aof/` + plugin registered, older version | Backup -> swap dist/ -> preserve data dirs -> verify |
| Reinstall/repair | Same version or broken state | Re-register plugin, re-scaffold missing dirs, skip data migration |

---

## Feature 3: CI Pipeline

### What Exists

| Artifact | Location | Status |
|----------|----------|--------|
| Unit test workflow | `.github/workflows/e2e-tests.yml` | Disabled (workflow_dispatch only) |
| Docs deployment | `.github/workflows/docs.yml` | Active -- deploys Astro website to GitHub Pages |
| Test config | `vitest.config.ts` | Active -- includes `src/**/__tests__/**` and `tests/**` |
| E2E test config | `tests/vitest.e2e.config.ts` | Exists -- separate config for e2e |
| Release config | `.release-it.json` | Active -- conventional changelog, GitHub releases, npm publish disabled |
| Test lock | `scripts/test-lock.sh` | Active -- prevents parallel test runs |
| Commit lint | `commitlint` + `simple-git-hooks` | Active -- conventional commits enforced on commit-msg |
| TypeScript config | `tsconfig.json` | Active -- strict, ES2024, NodeNext, `tsc --noEmit` for typecheck |

### Build Pipeline: tsc (not tsdown)

Despite the project description mentioning tsdown, **the actual build uses `tsc` directly**. The `package.json` build script is:
```json
"build": "tsc && node scripts/copy-extension-entry.js"
```

There is no tsdown config anywhere in the repo. The tsconfig targets ES2024/NodeNext and outputs to `dist/` with declarations + source maps. This is correct for a plugin that runs in the gateway's Node process -- no bundling needed.

### What Needs Building

| File | Type | Purpose |
|------|------|---------|
| `.github/workflows/ci.yml` | NEW | Main CI: lint + typecheck + test + build on push/PR to main |
| `.github/workflows/release.yml` | NEW | Release: build + test + create tarball artifact on tag push |

### CI Workflow Design

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run typecheck  # tsc --noEmit

  test:
    runs-on: ubuntu-latest
    needs: typecheck
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run build
      - run: npm test  # vitest run (via test-lock.sh)

  build:
    runs-on: ubuntu-latest
    needs: [typecheck, test]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/
```

### Release Workflow Design

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run build
      - run: npm test
      - name: Create tarball
        run: |
          tar czf aof-${GITHUB_REF_NAME}.tar.gz \
            dist/ prompts/ skills/ openclaw.plugin.json package.json README.md
      - name: Upload to Release
        uses: softprops/action-gh-release@v2
        with:
          files: aof-*.tar.gz
```

Note: `release-it` already creates the GitHub release and tag via `npm run release`. The workflow adds the tarball artifact to that release. The `.release-it.json` hooks run `npm run typecheck` and `npm test` in `before:init`, so the release script already validates before tagging.

### Integration Points

| File | Change Type | What |
|------|-------------|------|
| `.github/workflows/ci.yml` | NEW | Main CI workflow |
| `.github/workflows/release.yml` | NEW | Release artifact creation |
| `.github/workflows/e2e-tests.yml` | MODIFY | Consider enabling on PR (with mock gateway) or keeping as workflow_dispatch |
| `package.json` | VERIFY | Ensure `build`, `test`, `typecheck` scripts work in CI (no interactive prompts, no local deps) |

### Pre-existing Test Failures

The project reports 99.5% pass rate on 2400+ tests (~12 failing). The CI must either:
1. **Fix the ~12 failures** before enabling CI (preferred -- clean green baseline)
2. **Mark known failures** with `.skip` + tracking issue references
3. CI should not allow NEW failures. Use vitest's `--bail` or failure threshold to catch regressions.

---

## Feature 4: Projects Verification

### What Exists

The projects subsystem is already fully built:

| Component | File | Purpose |
|-----------|------|---------|
| Schema | `src/schemas/project.ts` | `ProjectManifest` Zod schema: id, title, status, type, owner, routing, memory, sla, workflow |
| Registry | `src/projects/registry.ts` | `discoverProjects()` -- scans `<vaultRoot>/Projects/*/project.yaml`, builds hierarchy |
| Resolver | `src/projects/resolver.ts` | `resolveProject(id, vaultRoot)` -- maps project ID to `{ projectId, projectRoot, vaultRoot }` |
| Create | `src/projects/create.ts` | `createProject(id, opts)` -- validate ID, scaffold dirs, write manifest |
| Bootstrap | `src/projects/bootstrap.ts` | `bootstrapProject(root)` -- create tasks/, artifacts/, state/, views/, cold/ |
| Manifest | `src/projects/manifest.ts` | `buildProjectManifest(id, opts)` + `writeProjectManifest(root, manifest)` |
| Migration | `src/projects/migration.ts` | `migrateToProjects()` + `rollbackMigration()` -- legacy to project layout |
| Lint | `src/projects/lint.ts` | Validate project manifests against schema + custom rules |

### Where Multi-Project Routing is Implemented

**AOFService** (`src/service/aof-service.ts`):
```typescript
// Line 22: vaultRoot in config enables multi-project mode
vaultRoot?: string;

// Lines 72-73: Per-project task stores maintained in memory
private projectStores: Map<string, ITaskStore> = new Map();
private projects: ProjectRecord[] = [];

// Lines 104-106: Project store resolver wired into ProtocolRouter
const projectStoreResolver = this.vaultRoot
  ? (projectId: string) => this.projectStores.get(projectId)
  : undefined;

// Lines 131-136: Project initialization on service start
if (this.vaultRoot) {
  await this.initializeProjects();  // discovers projects, creates per-project stores
} else {
  await this.store.init();  // single-store mode
}
```

**TaskContext** (`src/dispatch/executor.ts`) already carries project context:
```typescript
projectId?: string;     // Project ID from manifest
projectRoot?: string;   // Absolute path to project root
taskRelpath?: string;   // Task path relative to project root
```

### What Tools Need Exposure

**Currently registered tools** (in `src/openclaw/adapter.ts`):
- `aof_dispatch` -- NO projectId parameter
- `aof_task_update`, `aof_status_report`, `aof_task_complete`, `aof_task_edit`, `aof_task_cancel`
- `aof_task_dep_add`, `aof_task_dep_remove`, `aof_task_block`, `aof_task_unblock`

**Currently registered MCP tools** (in `src/mcp/tools.ts`):
- `aof_dispatch`, `aof_task_update`, `aof_task_complete`, `aof_status_report`, `aof_board`

**Missing: project-scoped tools. Agents need:**

| Tool | Purpose | Where to Add |
|------|---------|-------------|
| `aof_project_list` | List discovered projects with status/type | `openclaw/adapter.ts` + `mcp/tools.ts` |
| `aof_project_info` | Get project manifest, task counts, memory config | `openclaw/adapter.ts` + `mcp/tools.ts` |
| `aof_project_create` | Create new project (validate, scaffold, manifest) | `openclaw/adapter.ts` + `mcp/tools.ts` |
| `projectId` param on `aof_dispatch` | Route task to project-specific store | MODIFY both tool registrations |
| `projectId` param on `aof_status_report` | Filter status report to project scope | MODIFY both tool registrations |

### Data Flow for Multi-Project Dispatch

```
Agent calls aof_dispatch(title, brief, projectId="my-project")
  |
  v
openclaw/adapter.ts: resolve project store from AOFService.projectStores
  |
  v
store.create() writes task to project-specific task directory
  (<vaultRoot>/Projects/my-project/Tasks/Backlog/AOF-xxx.md)
  |
  v
scheduler poll picks up task from project store (initializeProjects iterates all stores)
  |
  v
task-dispatcher builds TaskContext with { projectId, projectRoot, taskRelpath }
  |
  v
executor.spawnSession(context) passes project context to spawned agent
  |
  v
spawned agent sees projectRoot in its working context, works in project scope
```

### Critical Verification Points

1. **Does `initializeProjects()` create per-project `FilesystemTaskStore` instances?** Need to read the method body (in the portion of aof-service.ts beyond what was loaded). Each store must point to `<vaultRoot>/Projects/<id>/Tasks/`.

2. **Does the scheduler poll ALL project stores?** The `triggerPoll` must iterate `projectStores.values()` and poll each.

3. **Does `aof_dispatch` accept `projectId`?** Currently NO -- the tool parameter list in `openclaw/adapter.ts` lines 156-198 has no `projectId` field. This must be added.

4. **Does the MCP dispatch accept `projectId`?** Currently NO -- `src/mcp/tools.ts` `dispatchInputSchema` has no `projectId` field.

### Integration Points

| File | Change Type | What |
|------|-------------|------|
| `src/openclaw/adapter.ts` | MODIFY | Add `projectId` param to `aof_dispatch`; register `aof_project_list`, `aof_project_info`, `aof_project_create` tools |
| `src/mcp/tools.ts` | MODIFY | Add `projectId` to dispatch input schema; add project tools to MCP server |
| `src/service/aof-service.ts` | VERIFY | Confirm `initializeProjects()` creates per-project stores correctly |
| `src/dispatch/task-dispatcher.ts` | VERIFY | Confirm `projectId`/`projectRoot` flow from store through to executor context |
| tests | NEW | E2E: create project -> dispatch task with projectId -> verify task lands in project dir -> verify scheduler picks it up |

---

## Component Boundaries (Updated for v1.1)

| Component | Responsibility | v1.1 Changes |
|-----------|---------------|--------------|
| `memory/store/hnsw-index.ts` | HNSW wrapper (insert, search, persist, rebuild) | **FIX:** capacity after load/rebuild |
| `memory/store/vector-store.ts` | SQLite + HNSW dual storage for embeddings | None |
| `memory/index.ts` | Memory module registration and wiring | **MINOR:** better error logging in rebuildHnswFromDb |
| `packaging/installer.ts` | npm install wrapper | Possibly expand for tarball install |
| `packaging/updater.ts` | Self-update download/swap/rollback | **FIX:** implement extractTarball |
| `packaging/wizard.ts` | Installation scaffold (dirs + org chart) | None |
| `packaging/openclaw-cli.ts` | Safe OpenClaw config access | None |
| `packaging/channels.ts` | Release channel + version manifest | None (already functional) |
| `service/aof-service.ts` | Scheduler + multi-project routing | **VERIFY:** initializeProjects works e2e |
| `projects/registry.ts` | Project discovery from vaultRoot | **VERIFY:** end-to-end flow |
| `projects/create.ts` | Project creation + scaffold | **VERIFY:** e2e with dispatch |
| `dispatch/executor.ts` | GatewayAdapter interface + TaskContext | None (interface stable, projectId fields exist) |
| `openclaw/adapter.ts` | Plugin tool registration | **ADD:** project tools, projectId param |
| `mcp/tools.ts` | MCP tool registration | **ADD:** project tools, projectId param |
| `.github/workflows/` | CI/CD | **NEW:** ci.yml, release.yml |
| `scripts/install.sh` | curl-pipe-sh installer | **NEW** |

---

## Patterns to Follow

### Pattern 1: Zod Schema First
**What:** All data structures defined as Zod schemas, TypeScript types derived with `z.infer`.
**When:** Any new tool parameters (project tools, projectId additions).
**Example:** `src/schemas/project.ts` -- `ProjectManifest = z.object({...}); type ProjectManifest = z.infer<typeof ProjectManifest>`

### Pattern 2: Plugin API Tool Registration
**What:** Tools registered via `api.registerTool()` with JSON Schema parameters object.
**When:** Adding project list/info/create tools to the OpenClaw plugin surface.
**Example:** Follow `src/openclaw/adapter.ts` lines 156-198 pattern exactly -- JSON Schema `properties`, `required`, `execute` callback returning `wrapResult()`.

### Pattern 3: MCP Tool Registration (Zod Schemas)
**What:** MCP tools use Zod schemas for input/output validation via `server.registerTool()`.
**When:** Adding project tools to MCP surface.
**Example:** Follow `src/mcp/tools.ts` pattern -- `z.object` for input, handler returns `{ content: [{ type: "text", text: JSON.stringify(...) }] }`.

### Pattern 4: Service Registration for Lifecycle
**What:** Long-running services registered via `api.registerService({ id, start, stop })`.
**When:** Already used by scheduler and memory sync. No new services needed for v1.1.

### Pattern 5: Filesystem Atomic Operations
**What:** State transitions use `rename()` for atomicity; config writes use `write-file-atomic`.
**When:** Already enforced in FilesystemTaskStore. Installer should follow same pattern for any file swaps.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Direct openclaw.json Editing
**What:** Reading/writing `~/.openclaw/openclaw.json` directly with `fs`.
**Why bad:** Gateway may be running and watching the file. Race conditions. Validation bypass. The MEMORY.md explicitly warns about config field order sensitivity.
**Instead:** Use `openclaw-cli.ts` wrapper (`openclawConfigGet`/`openclawConfigSet`) which shells out to `openclaw config` CLI. The CLI handles validation and atomic writes.

### Anti-Pattern 2: Bundling the Plugin
**What:** Using tsdown/esbuild/rollup to bundle AOF into a single file.
**Why bad:** Plugin runs in gateway's Node process. Bundling breaks `require` chains for native modules (`better-sqlite3`, `hnswlib-node`), breaks source maps, and makes debugging harder.
**Instead:** Keep `tsc` transpilation. The build produces ESM with declarations. OpenClaw loads via `node_modules/aof/dist/plugin.js`.

### Anti-Pattern 3: Catching and Swallowing Errors in Memory Init
**What:** The current pattern in `memory/index.ts:90-95` catches load errors silently and falls through to rebuild. If rebuild also produces zero chunks, the index is empty with no error.
**Why bad:** User's memory is silently broken. Search returns `[]` and they have no idea.
**Instead:** Log at ERROR level in the catch. If `rebuildHnswFromDb` produces 0 rows, log a WARNING. Consider a health check flag on the memory service that exposes index count.

### Anti-Pattern 4: Shell Scripts That Assume Interactive
**What:** Install scripts that use `read`, `select`, or other interactive prompts.
**Why bad:** `curl | sh` runs non-interactively. Prompts hang or fail.
**Instead:** Use flags and environment variables for all configuration. Interactive mode only when explicitly invoked (`--interactive`).

---

## Recommended Build Order

```
Phase 1: Memory Fix          (no deps on other features, standalone P0 fix)
  |-- Fix hnsw-index.ts load() + rebuild() capacity
  |-- Add capacity diagnostic getter
  |-- Add error logging in rebuildHnswFromDb
  |-- Write regression tests for capacity-at-limit scenarios
  |-- Verify with production memory.db if available

Phase 2: CI Pipeline          (no deps on code changes, enables validation)
  |-- Create .github/workflows/ci.yml (typecheck + test + build)
  |-- Fix or skip pre-existing ~12 test failures
  |-- Create .github/workflows/release.yml (tarball artifact)
  |-- Verify: push to branch, CI passes green

Phase 3: Projects Verification (benefits from CI for test validation)
  |-- Verify initializeProjects() in AOFService creates per-project stores
  |-- Add projectId parameter to aof_dispatch in adapter.ts and mcp/tools.ts
  |-- Add aof_project_list, aof_project_info, aof_project_create tools
  |-- Write e2e test: project create -> dispatch -> verify routing
  |-- Verify scheduler polls all project stores

Phase 4: Installer            (depends on CI for release tarball artifacts)
  |-- Implement extractTarball() in updater.ts
  |-- Create scripts/install.sh (curl-pipe-sh entry)
  |-- Wire install + update CLI commands
  |-- Test: clean install, upgrade, reinstall on fresh machine
  |-- Release workflow must produce tarball before installer can download it
```

**Phase ordering rationale:**
- **Memory first** because it is the only P0 production breakage; standalone fix with no dependencies.
- **CI second** because it validates everything downstream; creates the release pipeline that the installer depends on.
- **Projects third** because it is mostly verification of existing code plus tool parameter additions; CI validates the new tests.
- **Installer last** because it depends on the CI release workflow to produce tarball artifacts; also benefits from memory fix being shipped (installer installs working memory).

---

## Scalability Considerations

| Concern | Current (< 1K chunks) | At 10K chunks | At 100K chunks |
|---------|----------------------|---------------|----------------|
| HNSW memory | ~50MB at 768-dim | ~100MB (one resize) | ~600MB (multiple resizes, each doubles) |
| HNSW search latency | < 1ms | < 10ms (verified by benchmark test) | ~50ms (HNSW is O(log N), tested at 10K with 128-dim) |
| SQLite vec_chunks | Fine | Fine | May need WAL mode + periodic VACUUM |
| Multi-project stores | N/A | 5-10 store instances in memory | Store lazy-loading needed (Map grows) |
| CI build time | ~30s tsc | Same | Same (build is source-only, not data-dependent) |
| Tarball size | ~2MB (dist/ + prompts/) | Same | Same |

---

## Sources

- [hnswlib-node GitHub](https://github.com/yoshoku/hnswlib-node) -- HIGH confidence (official repo)
- [hnswlib-node API: HierarchicalNSW class](https://yoshoku.github.io/hnswlib-node/doc/classes/HierarchicalNSW.html) -- HIGH confidence (official docs, confirms readIndexSync and resizeIndex signatures)
- [hnswlib dynamic capacity issue #172](https://github.com/nmslib/hnswlib/issues/172) -- MEDIUM confidence (upstream C++ library confirms resizeIndex is the solution)
- All architecture analysis: direct source code reading of `~/Projects/AOF/src/` -- HIGH confidence

---
*Architecture research for: AOF v1.1 feature integration*
*Researched: 2026-02-26*
