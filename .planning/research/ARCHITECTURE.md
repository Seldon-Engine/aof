# Architecture Patterns: Seamless Upgrade Integration (v1.3)

**Domain:** Upgrade path, config migration, DAG-as-default, release pipeline for AOF
**Researched:** 2026-03-03
**Confidence:** HIGH (direct source code analysis of all integration points)

## Executive Summary

AOF v1.2 shipped per-task workflow DAGs but left them as opt-in. The migration from gates to DAGs is lazy (on-load in task-store.ts) and the migration registry in setup.ts returns an empty array. v1.3 must make DAGs the default for new tasks, formalize the upgrade path from pre-v1.2, cut a release, and add smoke tests that validate the entire flow.

The architecture challenge is that the upgrade surface area is split across three layers that must coordinate:

1. **Shell layer** (install.sh): detects existing install, backs up data dirs, extracts tarball, calls Node.js setup
2. **Node.js setup layer** (setup.ts): branches on fresh/upgrade/legacy, runs migration registry, wires OpenClaw plugin
3. **Runtime layer** (task-store.ts): lazy gate-to-DAG migration on individual task load

This document maps every integration point, specifies exactly where new code goes, what modifications existing code needs, and provides a dependency-ordered build sequence.

---

## 1. Current Architecture (As-Is State)

### 1.1 Install/Upgrade Flow

```
User runs: curl -fsSL <url>/install.sh | sh
  |
  +-- parse_args()                    # --prefix, --version, --channel
  +-- check_prerequisites()           # Node >= 22, tar, curl/wget
  +-- detect_existing_install()       # .version file -> upgrade, ~/.openclaw/aof -> legacy
  +-- determine_version()             # GitHub API /releases/latest
  +-- download_tarball()              # GitHub Releases tarball
  +-- extract_and_install()           # tar -xzf + npm ci + data backup/restore
  +-- run_node_setup()                # node dist/cli/index.js setup --auto [--upgrade] [--legacy]
  +-- write_version_file()            # echo $VERSION > .version
  +-- print_summary()
```

### 1.2 Node.js Setup Flow (setup.ts)

```
runSetup(opts)
  |
  +-- if (legacy)  -> migrateLegacyData()     # cp ~/.openclaw/aof/* -> dataDir
  +-- if (upgrade || legacy) -> runMigrations()  # getAllMigrations() -> EMPTY ARRAY
  +-- if (fresh)   -> runWizard()              # scaffold dirs + org chart + .gitignore
  +-- wireOpenClawPlugin()                      # register plugin, configure memory, set paths
```

**Critical observation:** `getAllMigrations()` returns `[]`. No formal migrations have ever run. The entire gate-to-DAG conversion is lazy (on-load in task-store.ts get/list).

### 1.3 Lazy Gate-to-DAG Migration (task-store.ts)

Both `get()` and `list()` contain identical logic:

```typescript
// Lazy gate-to-DAG migration: convert on load, write back atomically
if ((task.frontmatter as any).gate && !task.frontmatter.workflow) {
  const workflowConfig = await this.loadWorkflowConfig();
  migrateGateToDAG(task, workflowConfig);
  if (task.frontmatter.workflow) {
    await writeFileAtomic(filePath, serializeTask(task));
  }
}
```

This reads `project.yaml` for the gate definitions, converts to DAG hops, and writes back atomically. It is idempotent (skip if workflow already set) but:
- Requires project.yaml to still have the old `workflow.gates` config
- Silently skips tasks without gate fields (no-op, which is correct)
- Occurs on every load cycle, adding overhead until all tasks are converted

### 1.4 Task Creation Path

```
store.create(opts)
  |
  +-- opts.workflow? -> validateDAG() + initializeWorkflowState()
  +-- TaskFrontmatter.parse({ ..., workflow: resolvedWorkflow })
  +-- writeFileAtomic(filePath, serializeTask(task))
```

Tasks are created with workflow **only if** `opts.workflow` is explicitly provided. Without it, tasks are "taskless" (no workflow field at all). The scheduler handles both: taskless tasks dispatch directly, workflow tasks go through DAG hop dispatch.

### 1.5 Release Pipeline

```
Git tag v* push -> .github/workflows/release.yml
  |
  +-- npm ci + typecheck + build + test
  +-- node scripts/build-tarball.mjs $VERSION
  |     +-- stages: dist/, prompts/, skills/, index.ts, openclaw.plugin.json, package.json, package-lock.json
  |     +-- strips dev-only fields from package.json
  |     +-- tar -czf aof-$VERSION.tar.gz
  +-- softprops/action-gh-release (upload tarball + changelog)
```

### 1.6 Version Tracking

Three separate version sources exist:
- `.version` file (written by install.sh, read by install.sh for upgrade detection)
- `package.json` version field (canonical, read by setup.ts `readPackageVersion()`)
- `.aof/channel.json` version field (written by updater.ts, read by channels.ts for update checks)

### 1.7 Existing Backup/Rollback Mechanisms

**install.sh backup:**
- On upgrade: copies `tasks/events/memory/state/data/logs` + `memory.db/memory-hnsw.dat/.version` to `.aof-backup/backup-<timestamp>/`
- On extract failure: restores from backup
- After extract: restores data dirs from backup (tarball may overwrite)

**updater.ts rollback:**
- `selfUpdate()`: backup before update, rollback on failure
- `rollbackUpdate()`: restore from backup path, then delete backup
- `preservePaths` default: `["config", "data", "tasks", "events"]`

**channels.ts rollback:**
- `createBackup()`: copies specified paths to `.aof-backup/backup-<timestamp>/`
- `rollback()`: restores from backup, deletes backup

---

## 2. Integration Analysis: Where Each Feature Belongs

### 2.1 Config Migration: Migration Registry (Not Lazy)

**Question:** Where should config migration live -- migration registry vs setup command vs lazy on-load?

**Answer:** In the **migration registry** (`getAllMigrations()` in setup.ts), not in the lazy task-store path.

**Rationale:**

| Approach | Pros | Cons |
|----------|------|------|
| **Migration registry** (in setup.ts) | Runs once at upgrade time; has access to full filesystem; can transform project.yaml, org chart, and metadata files; tracked in migrations.json history; reversible via `down()` | Requires setup command to be run |
| **Lazy on-load** (in task-store.ts) | Automatic, no setup required | Only sees individual tasks; cannot transform project config; runs on every load; no history; not reversible |
| **Setup command inline** (hardcoded in runSetup) | Simple | Not version-tracked; not reversible; not testable in isolation |

**The migration registry is the correct home because:**

1. Config migration touches `project.yaml` (converting `workflow` to `workflowTemplates`, or adding a default template) -- this is project-level, not task-level.
2. The migration framework already supports `up()/down()`, version constraints, idempotency (skip if applied), and history tracking via `.aof/migrations.json`.
3. The lazy gate-to-DAG migration in task-store.ts was appropriate for v1.2 (gradual conversion during normal operation) but is not appropriate for v1.3's goal of a clean cutover.
4. `install.sh` already calls `node dist/cli/index.js setup --auto --upgrade` which runs `runMigrations()`. The plumbing is wired; it just needs actual migrations.

**Specific migrations to register:**

```typescript
function getAllMigrations(): Migration[] {
  return [
    {
      id: "001-default-workflow-template",
      version: "1.3.0",
      description: "Add default workflow template to project.yaml if none exists",
      up: async (ctx) => { /* read project.yaml, add workflowTemplates if missing */ },
      down: async (ctx) => { /* remove workflowTemplates added by this migration */ },
    },
    {
      id: "002-deprecate-gate-config",
      version: "1.3.0",
      description: "Convert workflow.gates to workflowTemplates, remove deprecated workflow field",
      up: async (ctx) => { /* transform project.yaml */ },
      down: async (ctx) => { /* restore workflow.gates from backup */ },
    },
    {
      id: "003-version-metadata",
      version: "1.3.0",
      description: "Write .aof/channel.json with version info for update tracking",
      up: async (ctx) => { /* ensure .aof/channel.json has version and channel */ },
    },
  ];
}
```

**Relationship to lazy migration:** The lazy gate-to-DAG migration in task-store.ts can remain for tasks that have not been loaded since v1.2. It handles the per-task conversion. The registry migration handles the project-level config. They are complementary.

### 2.2 DAG-as-Default: Default Workflow at Task Creation

**Question:** How to make workflows default without breaking taskless workflows?

**Answer:** Make DAG workflows **opt-out** instead of opt-in, using a project-level default template.

**Current state:**
- `store.create()` accepts optional `workflow` parameter
- Without it, tasks have no workflow field
- Scheduler handles both: taskless tasks dispatch directly, workflow tasks go through DAG hops

**Proposed integration point:** The `store.create()` method, with a project manifest lookup.

**Architecture:**

```
store.create(opts)
  |
  +-- opts.workflow provided?
  |     YES -> use it (existing behavior, unchanged)
  |     NO  -> opts.skipDefaultWorkflow?
  |             YES -> create taskless (existing behavior)
  |             NO  -> loadDefaultTemplate()
  |                     -> found? -> apply it
  |                     -> not found? -> create taskless (graceful degradation)
  +-- ... rest of create flow unchanged
```

**Key decisions:**

1. **Default template source:** `project.yaml` `workflowTemplates` with a reserved key like `"default"`. Migration 001 adds this.

2. **Opt-out mechanism:** A `skipDefaultWorkflow: true` flag on `store.create()`. This preserves backward compatibility for:
   - Quick one-off tasks (`aof task create "quick fix" --no-workflow`)
   - Subtasks that don't need full DAG pipelines
   - Tests that create simple tasks

3. **No hardcoded workflow in code:** The default workflow is defined in `project.yaml`, not hardcoded. Different projects can have different defaults.

4. **CLI integration:** The `bd create` / `aof task create` command adds `--no-workflow` flag. Without flag, it resolves the default template from project.yaml and passes it to `store.create()`.

5. **Scheduler unchanged:** The scheduler already handles both workflow and taskless tasks. No changes needed to dispatch logic.

**What constitutes a "default" template:**

```yaml
# project.yaml
workflowTemplates:
  default:
    name: default
    hops:
      - id: execute
        role: "${routing.role}"   # Dynamic: uses task's routing.role
        dependsOn: []
      - id: review
        role: "${routing.team}-lead"  # Dynamic: team lead reviews
        dependsOn: [execute]
        canReject: true
        rejectionStrategy: origin
```

Note: Dynamic role resolution would require either:
- A. Template variable substitution at task creation time (adds complexity)
- B. Literal roles in the template, with the understanding that projects customize their default

**Recommendation:** Option B (literal roles). Keep it simple. The project owner defines a default template with real role names from their org chart. Variable substitution is a v2 feature.

### 2.3 Smoke Tests: Position in Release Pipeline

**Question:** Where do smoke tests fit in the release pipeline?

**Answer:** Smoke tests run **after build, before release upload** in the GitHub Actions release workflow, AND as a standalone test suite runnable locally.

**Current release pipeline steps:**
1. Checkout
2. Setup Node.js 22
3. npm ci
4. Typecheck
5. Build
6. Test (unit tests)
7. Extract version
8. Generate changelog
9. Build release tarball
10. Upload tarball to GitHub Release

**Proposed insertion:**

```yaml
# After step 9 (build tarball), before step 10 (upload):
- name: Smoke test - fresh install
  run: |
    mkdir -p /tmp/aof-smoke-fresh
    tar -xzf aof-${{ steps.version.outputs.version }}.tar.gz -C /tmp/aof-smoke-fresh
    cd /tmp/aof-smoke-fresh && npm ci --production
    node dist/cli/index.js setup --auto --data-dir /tmp/aof-smoke-fresh
    node dist/cli/index.js --version

- name: Smoke test - upgrade from fixture
  run: |
    node scripts/smoke-upgrade.mjs ${{ steps.version.outputs.version }}
```

**Smoke test categories:**

| Category | What it validates | Runs in |
|----------|-------------------|---------|
| Fresh install | Tarball extracts, npm ci works, setup scaffolds dirs, OpenClaw plugin detection | CI release + local |
| Upgrade | Pre-v1.2 fixture -> v1.3, migrations apply, data preserved, taskless tasks still work | CI release + local |
| DAG default | New task gets default workflow, task with --no-workflow stays taskless | CI release + local |
| Rollback | Upgrade, then rollback restores previous state | Local only (too slow for CI) |
| Config migration | project.yaml transforms correctly (gates -> templates) | Unit test (fast) |

**Test fixture strategy:**

Create `tests/fixtures/upgrade/` containing:
- `pre-v1.2/` -- simulated pre-v1.2 install (tasks with gate fields, project.yaml with workflow.gates)
- `v1.2-clean/` -- v1.2 install with DAG tasks and templates
- Each fixture includes: `.version`, `project.yaml`, `org/org-chart.yaml`, sample tasks in `tasks/<status>/`

**Smoke test implementation:** A Node.js script (not shell) because:
- Can use the actual migration framework
- Can assert on task file contents (Zod parsing)
- Can run setup programmatically via `runSetup()`
- Integrates with vitest for local runs

### 2.4 Rollback with Filesystem-Based State

**Question:** How does rollback work with filesystem-based state?

**Answer:** Filesystem-based state makes rollback simpler than database-based systems, but the v1.3 migration story requires explicit backup/restore around migrations.

**Current rollback mechanisms (3 independent implementations):**

1. **install.sh** (shell-level): copies data dirs to `.aof-backup/`, restores on failure
2. **updater.ts** (selfUpdate): preserves paths, restores on health check failure
3. **channels.ts** (rollback): backup + restore for update channel management

**Problem:** These are all "binary rollback" -- restore everything or nothing. There is no per-migration rollback. If migration 002 fails after 001 succeeded, the system has partial state.

**Proposed rollback architecture:**

```
Level 1: Pre-migration snapshot (NEW)
  - Before ANY migration runs, copy entire data dir to .aof-backup/pre-migration-<timestamp>/
  - If ANY migration fails, restore from snapshot
  - This is the "nuclear option" -- guaranteed clean rollback

Level 2: Per-migration down() (EXISTS in framework, needs implementations)
  - Each migration provides a down() function
  - runMigrations(direction: "down") reverses applied migrations
  - Used for intentional rollback (user wants to go back to v1.2)

Level 3: install.sh data preservation (EXISTS, unchanged)
  - Shell-level backup of data dirs during tarball extraction
  - Handles the "new code, old data" scenario

Level 4: Task-level idempotency (EXISTS)
  - Lazy gate-to-DAG migration is idempotent
  - Tasks that were already converted are untouched
  - Tasks that were not converted are converted on next load
```

**Integration points:**

1. **setup.ts modification:** Before calling `runMigrations()`, snapshot the data dir:

```typescript
if (upgrade || legacy) {
  // NEW: Pre-migration snapshot
  const snapshotPath = await createPreMigrationSnapshot(dataDir);
  try {
    const result = await runMigrations({ ... });
    say(`Migrations: ${result.applied.length} applied`);
  } catch (e) {
    warn(`Migration failed, restoring from snapshot...`);
    await restoreFromSnapshot(snapshotPath, dataDir);
    throw e;
  }
}
```

2. **Version tracking after migration:** After successful migration, update `.aof/channel.json` with the new version. This ensures `checkForUpdates()` knows the current version.

3. **Rollback CLI command:** A new `aof system rollback` command that:
   - Lists available backups in `.aof-backup/`
   - Restores from a selected backup
   - Re-runs migrations for the restored version

### 2.5 Build Order (Dependency Graph)

**Question:** What is the right build order considering dependencies?

**Analysis of dependencies:**

```
                     +-----------------------+
                     |  project.yaml schema  |  (schemas/project.ts)
                     |  + default template   |
                     +-----------+-----------+
                                 |
              +------------------+-------------------+
              |                                      |
   +----------v-----------+           +--------------v-----------+
   | Migration 001:       |           | Migration 002:           |
   | Add default template |           | Convert gates->templates |
   +----------+-----------+           +--------------+-----------+
              |                                      |
              +------------------+-------------------+
                                 |
                     +-----------v-----------+
                     | Migration framework   |  (setup.ts getAllMigrations)
                     | wiring + rollback     |
                     +-----------+-----------+
                                 |
              +------------------+-------------------+
              |                                      |
   +----------v-----------+           +--------------v-----------+
   | store.create()       |           | Smoke tests              |
   | default workflow     |           | (needs migrations + store)|
   +----------+-----------+           +--------------+-----------+
              |                                      |
              +------------------+-------------------+
                                 |
                     +-----------v-----------+
                     | CLI: --no-workflow    |
                     | flag + template       |
                     | resolution default    |
                     +-----------+-----------+
                                 |
                     +-----------v-----------+
                     | Release pipeline      |
                     | (smoke test step)     |
                     +-----------+-----------+
                                 |
                     +-----------v-----------+
                     | Documentation +       |
                     | upgrade guide         |
                     +-----------+-----------+
                                 |
                     +-----------v-----------+
                     | Tag + cut release     |
                     +------------------------+
```

---

## 3. Component Boundaries: New vs. Modified

### 3.1 New Components

| Component | Path | Purpose |
|-----------|------|---------|
| Migration: default-workflow-template | `src/packaging/migrations/001-default-workflow-template.ts` | Adds default workflowTemplate to project.yaml |
| Migration: deprecate-gate-config | `src/packaging/migrations/002-deprecate-gate-config.ts` | Converts workflow.gates -> workflowTemplates |
| Migration: version-metadata | `src/packaging/migrations/003-version-metadata.ts` | Writes .aof/channel.json with version + channel |
| Pre-migration snapshot | `src/packaging/snapshot.ts` | Full data dir backup before migrations |
| Smoke test: fresh install | `tests/smoke/fresh-install.test.ts` | End-to-end fresh install validation |
| Smoke test: upgrade | `tests/smoke/upgrade.test.ts` | Pre-v1.2 fixture -> v1.3 upgrade validation |
| Smoke test: DAG default | `tests/smoke/dag-default.test.ts` | Default workflow assignment validation |
| Upgrade fixtures | `tests/fixtures/upgrade/pre-v1.2/` | Simulated pre-v1.2 install for testing |
| Upgrade fixtures | `tests/fixtures/upgrade/v1.2-clean/` | Simulated v1.2 install for testing |
| CI smoke step | `.github/workflows/release.yml` (new step) | Smoke test before release upload |

### 3.2 Modified Components

| Component | Path | Change | Risk |
|-----------|------|--------|------|
| `setup.ts` | `src/cli/commands/setup.ts` | Populate `getAllMigrations()`, add pre-migration snapshot | LOW -- additive, existing flow preserved |
| `store.create()` | `src/store/task-store.ts` | Load default template from project.yaml when no workflow provided | MEDIUM -- must handle missing template gracefully |
| Task CLI | `src/cli/commands/task.ts` | Add `--no-workflow` flag | LOW -- additive flag |
| `build-tarball.mjs` | `scripts/build-tarball.mjs` | Include migration files and fixtures in tarball | LOW |
| `release.yml` | `.github/workflows/release.yml` | Add smoke test step after tarball build | LOW |
| `project.ts` schema | `src/schemas/project.ts` | Add `defaultWorkflow` field or convention for "default" template key | LOW -- additive |
| `workflow.ts` | `src/schemas/workflow.ts` | Update deprecation notice with removal timeline | LOW -- comment only |

### 3.3 Unchanged Components (Explicitly)

| Component | Why Unchanged |
|-----------|---------------|
| `scheduler.ts` | Already handles both workflow and taskless tasks |
| `dag-evaluator.ts` | Pure function, no upgrade concerns |
| `dag-transition-handler.ts` | Works with whatever workflow state is on the task |
| `gate-to-dag.ts` | Lazy migration stays as-is (complementary to registry migration) |
| `task-store.ts` lazy migration | Stays for edge cases (tasks never loaded during upgrade) |
| `install.sh` shell script | Already has upgrade detection + data backup |
| `updater.ts` | Self-update engine, separate from install-time upgrade |
| `channels.ts` | Channel management, no changes needed |

---

## 4. Data Flow Changes

### 4.1 Upgrade Data Flow (New)

```
install.sh detects upgrade (.version exists)
  |
  +-- backup data dirs to .aof-backup/
  +-- extract tarball (overwrite code, preserve data)
  +-- restore data dirs from backup
  +-- run_node_setup --upgrade
      |
      +-- runSetup(upgrade: true)
          |
          +-- createPreMigrationSnapshot(dataDir)       # NEW: full snapshot
          +-- runMigrations(getAllMigrations(), "1.3.0")
          |     |
          |     +-- 001: read project.yaml
          |     |     +-- if no workflowTemplates -> add default template
          |     |     +-- write project.yaml
          |     |
          |     +-- 002: read project.yaml
          |     |     +-- if workflow.gates exists -> convert to workflowTemplates entry
          |     |     +-- remove workflow.gates field
          |     |     +-- write project.yaml
          |     |
          |     +-- 003: write .aof/channel.json with version + channel
          |
          +-- wireOpenClawPlugin()
  |
  +-- write_version_file()
```

### 4.2 Task Creation Data Flow (Modified)

```
aof task create "My Task" --routing.role backend
  |
  +-- store.create({ title, routing, ... })
      |
      +-- workflow provided?  NO
      +-- skipDefaultWorkflow? NO (default)
      +-- loadDefaultTemplate(projectRoot)       # NEW
      |     +-- read project.yaml
      |     +-- look up workflowTemplates["default"]
      |     +-- found? -> validateDAG() -> return definition
      |     +-- not found? -> return undefined (taskless)
      |
      +-- template found? -> initializeWorkflowState()
      |                   -> resolvedWorkflow = { definition, state, templateName: "default" }
      +-- TaskFrontmatter.parse({ ..., workflow: resolvedWorkflow })
      +-- writeFileAtomic()
```

### 4.3 Release Data Flow (Modified)

```
git push tag v1.3.0
  |
  +-- release.yml
      +-- npm ci + typecheck + build + test
      +-- build-tarball.mjs v1.3.0
      +-- smoke-test-fresh-install                  # NEW
      |     +-- extract tarball to temp dir
      |     +-- npm ci --production
      |     +-- node setup --auto
      |     +-- assert: dirs created, org chart valid
      |
      +-- smoke-test-upgrade                        # NEW
      |     +-- copy pre-v1.2 fixture to temp dir
      |     +-- write .version with old version
      |     +-- extract tarball over fixture
      |     +-- node setup --auto --upgrade
      |     +-- assert: migrations applied, tasks preserved, default template added
      |
      +-- softprops/action-gh-release (upload if smoke tests pass)
```

---

## 5. Patterns to Follow

### Pattern 1: Migration as Idempotent Transform

**What:** Each migration reads current state, transforms only if needed, writes atomically.

**When:** Every migration in the registry.

**Example:**
```typescript
const migration001: Migration = {
  id: "001-default-workflow-template",
  version: "1.3.0",
  description: "Add default workflow template to project.yaml if none exists",
  up: async (ctx) => {
    const manifestPath = join(ctx.aofRoot, "project.yaml");
    const yaml = await readFile(manifestPath, "utf-8");
    const manifest = parse(yaml);

    // Idempotent: skip if already has workflowTemplates with "default"
    if (manifest.workflowTemplates?.default) return;

    // Add default template
    manifest.workflowTemplates = manifest.workflowTemplates ?? {};
    manifest.workflowTemplates.default = {
      name: "default",
      hops: [
        { id: "execute", role: "executor", dependsOn: [] },
        { id: "review", role: "reviewer", dependsOn: ["execute"], canReject: true },
      ],
    };

    await writeFile(manifestPath, stringify(manifest), "utf-8");
  },
  down: async (ctx) => {
    // Only remove if it matches what we added (don't remove user modifications)
    const manifestPath = join(ctx.aofRoot, "project.yaml");
    const yaml = await readFile(manifestPath, "utf-8");
    const manifest = parse(yaml);

    if (manifest.workflowTemplates?.default?.name === "default") {
      delete manifest.workflowTemplates.default;
      if (Object.keys(manifest.workflowTemplates).length === 0) {
        delete manifest.workflowTemplates;
      }
      await writeFile(manifestPath, stringify(manifest), "utf-8");
    }
  },
};
```

### Pattern 2: Graceful Degradation for Default Workflow

**What:** If the default template cannot be loaded (no project.yaml, no default template), create a taskless task instead of failing.

**When:** `store.create()` without explicit workflow.

**Example:**
```typescript
// In store.create(), after resolving opts.workflow:
if (!resolvedWorkflow && !opts.skipDefaultWorkflow) {
  try {
    const defaultDef = await this.loadDefaultWorkflowTemplate();
    if (defaultDef) {
      const dagErrors = validateDAG(defaultDef);
      if (dagErrors.length === 0) {
        const state = initializeWorkflowState(defaultDef);
        resolvedWorkflow = { definition: defaultDef, state, templateName: "default" };
      }
    }
  } catch {
    // Graceful degradation: create taskless task
  }
}
```

### Pattern 3: Snapshot-Restore for Migration Safety

**What:** Full data dir snapshot before any migrations run. Restore on any failure.

**When:** During `runSetup()` upgrade path.

**Example:**
```typescript
async function createPreMigrationSnapshot(dataDir: string): Promise<string> {
  const snapshotDir = join(dataDir, ".aof-backup", `pre-migration-${Date.now()}`);
  await mkdir(snapshotDir, { recursive: true });

  const dataPaths = ["tasks", "events", "memory", "state", "data", "project.yaml", "org"];
  for (const p of dataPaths) {
    const src = join(dataDir, p);
    try {
      await access(src);
      await cp(src, join(snapshotDir, p), { recursive: true });
    } catch { /* skip missing */ }
  }

  return snapshotDir;
}
```

### Pattern 4: Fixture-Based Smoke Tests

**What:** Use pre-built filesystem fixtures representing specific install states, run actual migration/setup code against them, assert outcomes.

**When:** Smoke tests for upgrade paths.

**Example:**
```typescript
describe("upgrade from pre-v1.2", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aof-smoke-"));
    // Copy fixture to temp dir
    await cp("tests/fixtures/upgrade/pre-v1.2", tempDir, { recursive: true });
    // Write .version to simulate existing install
    await writeFile(join(tempDir, ".version"), "1.1.0");
  });

  it("applies migrations and preserves tasks", async () => {
    await runSetup({
      dataDir: tempDir,
      auto: true,
      upgrade: true,
      legacy: false,
      template: "minimal",
    });

    // Assert migrations applied
    const history = await getMigrationHistory(tempDir);
    expect(history.migrations.length).toBeGreaterThan(0);

    // Assert tasks preserved
    const tasks = await readdir(join(tempDir, "tasks", "backlog"));
    expect(tasks.length).toBeGreaterThan(0);

    // Assert default template added
    const yaml = await readFile(join(tempDir, "project.yaml"), "utf-8");
    const manifest = parse(yaml);
    expect(manifest.workflowTemplates?.default).toBeDefined();
  });
});
```

---

## 6. Anti-Patterns to Avoid

### Anti-Pattern 1: Hardcoding Default Workflow in Code

**What:** Defining the default workflow shape inside `store.create()` or `task-store.ts`.

**Why bad:** Different projects need different defaults. Hardcoded workflows cannot be customized without code changes. Violates the project.yaml-as-config principle.

**Instead:** Default workflow lives in `project.yaml` under `workflowTemplates.default`. Code reads it at task creation time.

### Anti-Pattern 2: Removing Lazy Migration Before Registry Migration Exists

**What:** Deleting the lazy gate-to-DAG code in task-store.ts before formal migrations handle all conversion cases.

**Why bad:** Some tasks may never have been loaded since v1.2. Without the lazy migration, they would fail schema validation (gate + workflow mutual exclusivity check).

**Instead:** Keep both. The registry migration handles project config; the lazy migration handles individual tasks. Remove the lazy migration in v1.4 after one full release cycle with registry migrations.

### Anti-Pattern 3: Running Smoke Tests Against Live Install

**What:** Smoke tests that modify `~/.aof` or any real installation directory.

**Why bad:** Destructive, non-reproducible, CI will not have an existing install.

**Instead:** All smoke tests operate in temporary directories with copied fixtures. Never touch real install paths.

### Anti-Pattern 4: Breaking Taskless Task Creation

**What:** Making workflow a required field or failing if no default template exists.

**Why bad:** Breaks backward compatibility. Some users may not want workflows. Some tests create simple tasks.

**Instead:** Default workflow is a convenience, not a requirement. `store.create()` without workflow and with `skipDefaultWorkflow: true` must always work. Missing default template falls back to taskless.

---

## 7. Scalability and Edge Cases

### Edge Cases in Upgrade Path

| Scenario | Current Behavior | v1.3 Behavior |
|----------|------------------|---------------|
| Pre-v1.2 install with gate tasks | Tasks converted lazily on load | Migrations transform project.yaml; lazy migration still converts individual tasks |
| v1.2 install with DAG tasks | No migration needed | Migration 001 adds default template if missing; existing templates preserved |
| Install with no project.yaml | Wizard creates minimal scaffold | Migration skips (no file to transform); default template added only if project.yaml exists |
| Install with custom workflowTemplates | Templates preserved | Migration 001 skips if "default" already exists; 002 only transforms workflow.gates |
| Interrupted migration | Partial state | Pre-migration snapshot restores clean state |
| Multiple upgrades (v1.1 -> v1.2 -> v1.3) | Never tested | Migration registry handles: already-applied migrations skipped |
| Migration from legacy (~/.openclaw/aof) | migrateLegacyData copies files | Legacy flow runs first, then migrations; migration history starts fresh |

### Task Store Compatibility Matrix

| Task Type | workflow field | gate field | Behavior |
|-----------|---------------|------------|----------|
| Taskless (pre-v1.2, no gates) | absent | absent | Works as-is, no workflow dispatch |
| Gate task (pre-v1.2) | absent | present | Lazy migration converts to DAG on load |
| DAG task (v1.2+) | present | absent | Works as-is |
| New task (v1.3, default) | present (from template) | absent | Default workflow from project.yaml |
| New task (v1.3, explicit) | present (from opts) | absent | Explicit workflow, same as v1.2 |
| New task (v1.3, --no-workflow) | absent | absent | Taskless, same as pre-v1.2 |

---

## 8. Recommended Build Order

### Phase 1: Foundation (No Dependencies)

**1A. Migration implementations**
- Write `001-default-workflow-template.ts`
- Write `002-deprecate-gate-config.ts`
- Write `003-version-metadata.ts`
- Unit test each migration in isolation with temp dirs

**1B. Pre-migration snapshot**
- Write `snapshot.ts` with `createPreMigrationSnapshot()` and `restoreFromSnapshot()`
- Unit test snapshot/restore round-trip

**1C. Upgrade test fixtures**
- Create `tests/fixtures/upgrade/pre-v1.2/` with sample project.yaml (has workflow.gates), sample gate tasks
- Create `tests/fixtures/upgrade/v1.2-clean/` with sample project.yaml (has workflowTemplates), sample DAG tasks

### Phase 2: Migration Wiring (Depends on Phase 1)

**2A. Wire migrations into setup.ts**
- Populate `getAllMigrations()` with the three migrations
- Add pre-migration snapshot before `runMigrations()`
- Add snapshot restore in catch block
- Test: full upgrade flow with fixtures

**2B. store.create() default workflow**
- Add `loadDefaultWorkflowTemplate()` method to `FilesystemTaskStore`
- Modify `create()` to load default template when no workflow provided
- Add `skipDefaultWorkflow` option
- Test: create with default, create with explicit, create with skip

### Phase 3: CLI + Smoke Tests (Depends on Phase 2)

**3A. CLI changes**
- Add `--no-workflow` flag to task create command
- Default: resolve default template; with flag: skip

**3B. Smoke tests**
- Fresh install smoke test
- Upgrade smoke test (pre-v1.2 -> v1.3)
- DAG default smoke test
- Rollback smoke test

### Phase 4: Release Pipeline (Depends on Phase 3)

**4A. Release workflow update**
- Add smoke test steps to `release.yml` after tarball build
- Build tarball must include migration files

**4B. Documentation**
- Upgrade guide (what users need to know)
- Migration reference (what each migration does)

### Phase 5: Cut Release (Depends on Phase 4)

**5A. Version bump + tag**
- Update package.json version to 1.3.0
- Git tag v1.3.0
- Release pipeline runs, smoke tests pass, tarball published

### Phase Dependency Summary

```
Phase 1A ----+
Phase 1B ----+--> Phase 2A --> Phase 3A --> Phase 4A --> Phase 5
Phase 1C ----+                 Phase 3B --> Phase 4B
                  Phase 2B --> Phase 3A
                               Phase 3B
```

Phases 1A, 1B, and 1C are independent and can run in parallel. Phase 2A requires all of Phase 1. Phase 2B requires Phase 1A (needs the migrations for project.yaml transform to know what default template looks like). Phases 3A and 3B can partially overlap. Phase 4 requires Phase 3. Phase 5 requires Phase 4.

---

## 9. Integration Points Summary

| Integration Point | Source File | Change Type | Complexity |
|-------------------|-------------|-------------|------------|
| `getAllMigrations()` | `src/cli/commands/setup.ts` | Populate with 3 migrations | Medium |
| Pre-migration snapshot | `src/cli/commands/setup.ts` | Add snapshot/restore around runMigrations | Low |
| Default workflow loading | `src/store/task-store.ts` | Add `loadDefaultWorkflowTemplate()`, modify `create()` | Medium |
| `--no-workflow` flag | `src/cli/commands/task.ts` | Add flag, pass to store.create | Low |
| Smoke test step | `.github/workflows/release.yml` | New steps after tarball build | Low |
| Tarball contents | `scripts/build-tarball.mjs` | Ensure migration files included (already in dist/) | None (verify) |
| Migration 001 | `src/packaging/migrations/001-*.ts` (new) | Transform project.yaml | Medium |
| Migration 002 | `src/packaging/migrations/002-*.ts` (new) | Transform project.yaml gates | Medium |
| Migration 003 | `src/packaging/migrations/003-*.ts` (new) | Write version metadata | Low |
| Test fixtures | `tests/fixtures/upgrade/*` (new) | Static files, no logic | Low |
| Smoke tests | `tests/smoke/*.test.ts` (new) | End-to-end validation | Medium |

---

## 10. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Migration corrupts project.yaml | HIGH | Pre-migration snapshot + restore on failure; idempotent migrations |
| Default workflow breaks existing projects without org chart roles | MEDIUM | Graceful degradation (taskless if template fails); migration only adds template, doesn't force use |
| Smoke tests flaky in CI | LOW | Use deterministic fixtures, no network deps, temp dirs with cleanup |
| install.sh backup doesn't cover project.yaml | MEDIUM | install.sh backs up data dirs but NOT project.yaml; add to backup list |
| Lazy migration and registry migration interact badly | LOW | They are complementary: registry handles config, lazy handles tasks; both are idempotent |
| Version tracking inconsistency (.version vs channel.json vs package.json) | MEDIUM | Migration 003 synchronizes; document the canonical source (package.json) |

---

## Sources

- Direct source code analysis of `/Users/xavier/Projects/aof/src/`
- `src/cli/commands/setup.ts` -- setup orchestrator
- `src/packaging/migrations.ts` -- migration framework
- `src/store/task-store.ts` -- task store with lazy migration
- `src/migration/gate-to-dag.ts` -- gate-to-DAG conversion
- `src/dispatch/scheduler.ts` -- scheduler poll cycle
- `src/schemas/project.ts` -- project manifest schema
- `src/schemas/workflow-dag.ts` -- DAG workflow schema
- `src/schemas/workflow.ts` -- deprecated gate workflow schema
- `src/packaging/updater.ts` -- self-update engine
- `src/packaging/channels.ts` -- channel management
- `scripts/install.sh` -- shell installer
- `scripts/build-tarball.mjs` -- tarball builder
- `.github/workflows/release.yml` -- release pipeline
- `.github/workflows/ci.yml` -- CI pipeline
- Confidence: HIGH -- all findings based on direct code inspection, no external sources needed
