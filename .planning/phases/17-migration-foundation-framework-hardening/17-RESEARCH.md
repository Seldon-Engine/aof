# Phase 17: Migration Foundation & Framework Hardening - Research

**Researched:** 2026-03-03
**Domain:** Data migration framework, YAML comment-preserving writes, snapshot-based rollback, schema versioning
**Confidence:** HIGH

## Summary

Phase 17 hardens the existing migration framework (`src/packaging/migrations.ts`) and implements three concrete migrations for the v1.2-to-v1.3 upgrade path. The codebase already has a working migration runner with up/down lifecycle, version comparison, and history tracking via `.aof/migrations.json`. What's missing: (1) snapshot/restore wrapping around the runner, (2) in-progress detection via marker file, (3) atomic writes inside migration `up()` functions, (4) comment-preserving YAML edits via `parseDocument()`, and (5) the three actual migration implementations (defaultWorkflow, gate-to-DAG batch, version metadata).

The existing code provides strong foundations. `write-file-atomic` 7.0.0 is already installed and used pervasively. The `yaml` 2.8.2 library includes `parseDocument()` with `setIn()` and `toString()` for comment-preserving round-trips. The gate-to-DAG per-task converter (`src/migration/gate-to-dag.ts`) is fully functional and can be reused for the batch migration. The `setup.ts` `getAllMigrations()` function returns `[]` and is the exact integration point. The `ProjectManifest` schema already has `workflowTemplates` as an optional field, and `defaultWorkflow` needs to be added to it.

**Primary recommendation:** Wrap `runMigrations()` in setup.ts with snapshot-create/restore logic, implement three migration files using `write-file-atomic` + `parseDocument()`, wire them into `getAllMigrations()`, and fix the two bugs (getByPrefix, installer backup scope).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Full data directory snapshot (`~/.openclaw/aof/` tree) before any migration runs
- Auto-restore on any migration failure -- no user prompt, just error message explaining what happened and that data was restored
- Keep last 2 snapshots (current + one previous) for "realized something's wrong after second upgrade" scenario
- Store snapshots inside the data directory (`.aof/snapshots/`) with nesting exclusion
- All-or-nothing approach: run all migrations sequentially; if ANY fails, restore the full snapshot entirely
- Re-running the installer retries all migrations from scratch (snapshot provides clean state)
- Each migration MUST be idempotent -- checks if its work is already done before acting (belt-and-suspenders with snapshot)
- In-progress detection via marker file: write `.aof/migration-in-progress` before starting, remove after success; if marker exists on next run, log warning that previous migration was interrupted
- Console output during upgrade for visibility (e.g., "checkmark 001-default-workflow-template applied") -- no separate log file
- Eagerly convert ALL tasks across ALL status directories including in-progress (snapshot provides rollback safety)
- Keep lazy gate-to-DAG migration in task-store.ts as safety net alongside batch
- For defaultWorkflow migration (CONF-01): pick the first template in `workflowTemplates` if defined; if no templates exist, skip -- project stays bare-task
- Multi-project support: migration discovers all project.yaml files under the data directory and migrates each independently
- `.aof/channel.json` contains: `version`, `previousVersion` (null for fresh), `upgradedAt`/`installedAt` timestamp, `channel` ('stable')
- Written for BOTH fresh installs and upgrades -- consistent metadata file regardless of install path
- Fresh installs: `{ version, channel, installedAt }` (no previousVersion)
- Upgrades: `{ version, previousVersion, channel, upgradedAt }`

### Claude's Discretion
- Exact snapshot implementation (cp -r, tar, or filesystem-level copy)
- Migration file naming convention details
- Error message formatting and wording
- `getByPrefix()` fix implementation approach (shared `ensureMigrated()` helper vs inline)
- Installer backup scope fix implementation (exclusion-based vs full-directory approach for BUGF-02)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| MIGR-01 | Migration framework uses atomic writes (write-file-atomic) for all file mutations | `write-file-atomic` 7.0.0 already in node_modules; import pattern: `import writeFileAtomic from "write-file-atomic"` -- use in all migration `up()` functions |
| MIGR-02 | Migration framework tracks in-progress state so interrupted migrations can be detected and resumed | Marker file `.aof/migration-in-progress` pattern; write before starting, remove after success; check on startup |
| MIGR-03 | Pre-migration snapshot captures full data directory before any migration runs, restores on failure | Snapshot to `.aof/snapshots/<timestamp>/`; `cp -r` with nesting exclusion for `.aof/snapshots/` dir itself |
| MIGR-04 | YAML config modifications preserve user comments and formatting (parseDocument API) | `yaml` 2.8.2 `parseDocument()` + `doc.setIn()` + `doc.toString()` for comment-preserving round-trip |
| MIGR-05 | `schemaVersion` relaxed from `z.literal(1)` to support version 2 for migration versioning | Two schemas: `src/schemas/config.ts` line 66 (`AofConfig`) and `src/schemas/task.ts` line 93 (`TaskFrontmatter`) and `src/schemas/org-chart.ts` line 313 (`OrgChart`) |
| CONF-01 | Migration 001 adds `defaultWorkflow` field to project.yaml pointing to a sensible workflow template | New field on `ProjectManifest` schema; uses `parseDocument()` to add field preserving comments; picks first key from `workflowTemplates` or skips |
| CONF-02 | Migration 002 batch-converts all gate-based tasks to DAG workflows eagerly | Reuse `migrateGateToDAG()` from `src/migration/gate-to-dag.ts`; walk all status dirs in all projects; write back with `write-file-atomic` |
| CONF-03 | Migration 003 writes version metadata to `.aof/channel.json` | JSON write with `write-file-atomic`; schema: `{ version, previousVersion?, channel, upgradedAt/installedAt }` |
| CONF-04 | Migrations wired into `setup.ts` `getAllMigrations()` and run automatically | Replace empty `[]` return in `getAllMigrations()` with three Migration objects; add snapshot wrapper around `runMigrations()` call |
| BUGF-01 | `getByPrefix()` in task-store runs gate-to-DAG migration | `getByPrefix()` at line 276 of task-store.ts currently returns raw parsed task without gate-to-DAG migration; needs same logic as `get()` and `list()` |
| BUGF-02 | Installer backup scope includes `Projects/` directory tree | `install.sh` line 284 only backs up flat dirs `tasks events memory state data logs`; needs to add `Projects` to the backup list |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `write-file-atomic` | 7.0.0 | Atomic file writes in migration `up()` | Already used across 20+ source files; prevents partial writes on crash |
| `yaml` | 2.8.2 | Comment-preserving YAML round-trips via `parseDocument()` | Already in dependencies; only Node.js YAML library with AST-level editing |
| `zod` | (existing) | Schema validation for `schemaVersion` relaxation | Already used for all schemas in the project |
| `node:fs/promises` | Node 22+ | Directory copying for snapshots, file reads | Standard Node.js API; `cp` with `{recursive: true}` available since Node 16.7 |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:fs/promises.cp` | Node 22+ | Recursive directory copy for snapshot creation | Snapshot create/restore -- avoids spawning `cp -r` shell process |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `node:fs.cp` for snapshots | Shell `cp -r` via `child_process` | `node:fs.cp` is pure Node.js, no shell escaping issues, but slightly slower for very large trees |
| `node:fs.cp` for snapshots | `tar` archive | Tar saves space but is slower to restore; `cp -r` is simpler and fast for small data dirs |
| Custom marker file | SQLite-backed state | Overkill -- a single file presence/absence is atomic and trivially detectable |

**Installation:**
```bash
# No new dependencies needed -- all libraries already in node_modules
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── packaging/
│   ├── migrations.ts          # Existing framework (enhance with snapshot logic)
│   ├── migrations/            # NEW: Individual migration files
│   │   ├── 001-default-workflow-template.ts
│   │   ├── 002-gate-to-dag-batch.ts
│   │   └── 003-version-metadata.ts
│   └── snapshot.ts            # NEW: Snapshot create/restore/prune
├── cli/commands/
│   └── setup.ts               # Wire migrations + snapshot wrapper
├── migration/
│   └── gate-to-dag.ts         # Existing per-task converter (reused)
├── store/
│   └── task-store.ts          # Fix getByPrefix()
├── schemas/
│   ├── config.ts              # Relax schemaVersion
│   ├── task.ts                # Relax schemaVersion
│   ├── org-chart.ts           # Relax schemaVersion
│   └── project.ts             # Add defaultWorkflow field
└── scripts/
    └── install.sh             # Fix backup scope
```

### Pattern 1: Snapshot Create/Restore
**What:** Full directory snapshot before migrations; auto-restore on failure
**When to use:** Wrapping `runMigrations()` in setup.ts
**Example:**
```typescript
// Source: CONTEXT.md decisions + codebase patterns
import { cp, mkdir, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const SNAPSHOT_DIR = ".aof/snapshots";
const MAX_SNAPSHOTS = 2;

async function createSnapshot(aofRoot: string): Promise<string> {
  const snapshotBase = join(aofRoot, SNAPSHOT_DIR);
  const name = `snapshot-${Date.now()}`;
  const snapshotPath = join(snapshotBase, name);
  await mkdir(snapshotPath, { recursive: true });

  // Copy everything EXCEPT .aof/snapshots/ itself
  const entries = await readdir(aofRoot, { withFileTypes: true });
  for (const entry of entries) {
    const src = join(aofRoot, entry.name);
    const dest = join(snapshotPath, entry.name);
    if (entry.name === ".aof") {
      // Copy .aof but exclude snapshots/
      await mkdir(dest, { recursive: true });
      const aofEntries = await readdir(src, { withFileTypes: true });
      for (const ae of aofEntries) {
        if (ae.name === "snapshots") continue;
        await cp(join(src, ae.name), join(dest, ae.name), { recursive: true });
      }
    } else {
      await cp(src, dest, { recursive: true });
    }
  }
  return snapshotPath;
}

async function restoreSnapshot(aofRoot: string, snapshotPath: string): Promise<void> {
  // Remove everything except .aof/snapshots/
  // Then copy snapshot contents back to aofRoot
}
```

### Pattern 2: Comment-Preserving YAML Modification
**What:** Edit YAML files without destroying user comments or formatting
**When to use:** Migration 001 (adding defaultWorkflow to project.yaml)
**Example:**
```typescript
// Source: yaml 2.8.2 API -- parseDocument + setIn + toString
import { parseDocument } from "yaml";
import { readFile } from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";

async function addDefaultWorkflow(projectYamlPath: string): Promise<void> {
  const raw = await readFile(projectYamlPath, "utf-8");
  const doc = parseDocument(raw);

  // Check if already has defaultWorkflow (idempotent)
  if (doc.getIn(["defaultWorkflow"])) return;

  // Check if workflowTemplates exist
  const templates = doc.getIn(["workflowTemplates"]);
  if (!templates || typeof templates !== "object") return; // Skip -- no templates

  // Pick first template name
  const templateMap = doc.get("workflowTemplates", true);
  if (templateMap && "items" in templateMap) {
    const firstKey = templateMap.items[0]?.key;
    if (firstKey) {
      doc.setIn(["defaultWorkflow"], String(firstKey));
      await writeFileAtomic(projectYamlPath, doc.toString());
    }
  }
}
```

### Pattern 3: Idempotent Migration with Console Output
**What:** Each migration checks if work is already done before acting
**When to use:** All three migration `up()` functions
**Example:**
```typescript
// Source: Existing migration interface + CONTEXT.md decisions
import type { Migration, MigrationContext } from "../migrations.js";

const migration: Migration = {
  id: "001-default-workflow-template",
  version: "1.3.0",
  description: "Add defaultWorkflow field to project manifests",
  up: async (ctx: MigrationContext) => {
    // Discover all project.yaml files
    const projects = await discoverProjectYamlFiles(ctx.aofRoot);

    for (const projectPath of projects) {
      // Idempotent: skip if already has defaultWorkflow
      await addDefaultWorkflowIfMissing(projectPath);
    }

    console.log("  \x1b[32m✓\x1b[0m 001-default-workflow-template applied");
  },
};
```

### Pattern 4: Migration Marker File
**What:** Write marker before migrations start, remove after success
**When to use:** In the snapshot-wrapped migration runner in setup.ts
**Example:**
```typescript
import { writeFile, unlink, access } from "node:fs/promises";
import { join } from "node:path";

const MARKER = ".aof/migration-in-progress";

async function markerExists(aofRoot: string): Promise<boolean> {
  try {
    await access(join(aofRoot, MARKER));
    return true;
  } catch {
    return false;
  }
}

async function writeMarker(aofRoot: string): Promise<void> {
  await writeFile(join(aofRoot, MARKER), new Date().toISOString(), "utf-8");
}

async function removeMarker(aofRoot: string): Promise<void> {
  try {
    await unlink(join(aofRoot, MARKER));
  } catch { /* ignore if doesn't exist */ }
}
```

### Pattern 5: Schema Version Relaxation
**What:** Change `z.literal(1)` to accept versions 1 and 2
**When to use:** MIGR-05 in config.ts, task.ts, org-chart.ts
**Example:**
```typescript
// Before:
schemaVersion: z.literal(1),

// After:
schemaVersion: z.union([z.literal(1), z.literal(2)]),
```

### Anti-Patterns to Avoid
- **Inline YAML string manipulation:** Never use regex/string replacement to edit YAML -- use `parseDocument()` API. String manipulation destroys comments and can corrupt structure.
- **Non-atomic writes in migrations:** Always use `write-file-atomic` (or `writeFileAtomic`), never raw `writeFile`. A crash during a raw write can produce a truncated file.
- **Migration state in memory only:** Always use the marker file on disk. In-memory-only state is lost on crash.
- **Migrating tasks through the store API:** The batch migration should read/write task files directly (via `readFile`/`writeFileAtomic`), NOT through `FilesystemTaskStore` methods. The store has side effects (lazy migration, event logging) that interfere with batch operations.
- **Snapshot of only data dirs:** The snapshot must capture the FULL data directory tree. Partial snapshots (only `tasks/`, `events/`) miss project.yaml, channel.json, and other config files that migrations modify.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic file writes | Custom temp-file-then-rename | `write-file-atomic` 7.0.0 | Already in deps; handles race conditions, permissions, cleanup on failure |
| Comment-preserving YAML | Regex-based YAML editing | `yaml` `parseDocument()` API | Only reliable approach; regex breaks on multi-line values, anchors, flow style |
| Gate-to-DAG conversion | New converter for batch migration | Existing `migrateGateToDAG()` | Already tested and proven; handles all edge cases (conditions, in-flight, etc.) |
| Directory copying | Shell `cp -r` via exec | `node:fs/promises.cp()` | Pure Node.js, no shell injection risk, available in Node 22+ |
| Version comparison | Custom semver parser | Existing `compareVersions()` in migrations.ts | Already tested; handles major.minor.patch correctly |

**Key insight:** The codebase already has 80% of the building blocks. The work is primarily composition (wiring existing pieces together) and three specific migration implementations.

## Common Pitfalls

### Pitfall 1: Snapshot Nesting
**What goes wrong:** Snapshot directory is inside the data directory, so snapshots contain snapshots recursively, growing exponentially.
**Why it happens:** Using `cp -r` on the entire data dir without excluding the snapshot directory.
**How to avoid:** When creating snapshots, explicitly skip the `.aof/snapshots/` subdirectory. The code must iterate entries and exclude `snapshots` when copying `.aof/`.
**Warning signs:** Snapshot size grows with each migration run; second snapshot is 2x the first.

### Pitfall 2: parseDocument Returns AST Nodes, Not Plain Values
**What goes wrong:** `doc.getIn(["workflowTemplates"])` returns a YAML `YAMLMap` node, not a plain JavaScript object. Comparison operators and property access don't work as expected.
**Why it happens:** `parseDocument()` produces a Document with AST nodes, not plain values. To get plain values, pass `true` as the second argument (`keepScalar: false` is default, but collections need `.toJSON()` or `.items` access).
**How to avoid:** Use `doc.get("key", true)` to get the node with scalar wrapper intact, then access `.items` for maps. Or use `doc.toJS()` for the full plain object when you need to inspect values (but edits must go through `doc.setIn()`).
**Warning signs:** `typeof templates === "object"` is true but `Object.keys(templates)` throws; template lookups fail silently.

### Pitfall 3: Migration History Recorded Before Snapshot Restore
**What goes wrong:** Migration 001 runs and records to `.aof/migrations.json`. Migration 002 fails. Snapshot restores the OLD `.aof/migrations.json`. Next run: migration 001 runs AGAIN (because history was restored to pre-001 state).
**Why it happens:** The all-or-nothing snapshot restore overwrites migration history too.
**How to avoid:** This is actually the DESIRED behavior per the user's decision: "Re-running the installer retries all migrations from scratch (snapshot provides clean state)." Combined with idempotency, this is safe. Each migration checks if work is done before acting. But the migration itself must also be recorded again -- which `runMigrations()` handles automatically.
**Warning signs:** None -- this is by design. But migration `up()` functions MUST be idempotent.

### Pitfall 4: getByPrefix Gate Migration Writing Back While Batch Already Converted
**What goes wrong:** The lazy gate-to-DAG migration in `getByPrefix()` tries to write back a file that was already batch-converted, creating a no-op write or, worse, overwriting with stale data.
**Why it happens:** The lazy migration checks for `gate` field and absence of `workflow` field. After batch conversion, tasks will have `workflow` and no `gate`, so the lazy migration becomes a no-op naturally.
**How to avoid:** The existing guard (`if ((task.frontmatter as any).gate && !task.frontmatter.workflow)`) is sufficient. The batch migration removes `gate` and adds `workflow`, so the lazy path is never triggered post-migration.
**Warning signs:** None if batch migration correctly clears gate fields.

### Pitfall 5: Project Discovery During Migration
**What goes wrong:** Migration discovers `project.yaml` files but misses projects in non-standard locations, or finds test fixtures.
**Why it happens:** Walking the filesystem broadly can pick up unexpected files.
**How to avoid:** Use the established project structure: `<vaultRoot>/Projects/<projectId>/project.yaml`. Glob specifically for this pattern. The `discoverProjects()` function in `src/projects/registry.ts` already does this -- but it validates schemas strictly. For migration, use a looser discovery: find all `project.yaml` under `Projects/*/`.
**Warning signs:** Migration reports "0 projects migrated" when projects exist; or migrates test fixture files.

### Pitfall 6: SchemaVersion Relaxation Breaking Existing Validation
**What goes wrong:** Changing `z.literal(1)` to `z.union([z.literal(1), z.literal(2)])` causes no issues for validation. But if any code does `=== 1` checks on parsed schemaVersion, those might fail for version 2 tasks.
**Why it happens:** Hard-coded comparisons against literal 1.
**How to avoid:** Search for all `schemaVersion` usages (61 files found) and verify none do equality checks that would break. Most are in test files that explicitly set `schemaVersion: 1` -- these should continue to work since union accepts 1.
**Warning signs:** Tests fail with "expected 1, received 2" or Zod validation errors on version 2 tasks.

## Code Examples

### Example 1: Discovering Project YAML Files for Migration
```typescript
// Walk the vault to find all project.yaml files
import { readdir, access } from "node:fs/promises";
import { join } from "node:path";

async function discoverProjectYamlFiles(aofRoot: string): Promise<string[]> {
  const projectsDir = join(aofRoot, "Projects");
  const results: string[] = [];

  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(projectsDir, entry.name, "project.yaml");
      try {
        await access(manifestPath);
        results.push(manifestPath);
      } catch {
        // No project.yaml in this directory, skip
      }
    }
  } catch {
    // Projects/ doesn't exist (pre-projects install), skip
  }

  return results;
}
```

### Example 2: Batch Gate-to-DAG Migration
```typescript
// Reuse existing migrateGateToDAG for batch conversion
import { readFile, readdir, stat } from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";
import { parseTaskFile, serializeTask } from "../../store/task-parser.js";
import { migrateGateToDAG, WorkflowConfig } from "../../migration/gate-to-dag.js";

const STATUS_DIRS = ["backlog", "ready", "in-progress", "blocked", "review", "done", "cancelled", "deadletter"];

async function batchConvertGateToDag(
  projectRoot: string,
  workflowConfig: WorkflowConfig | undefined
): Promise<number> {
  const tasksDir = join(projectRoot, "tasks");
  let converted = 0;

  for (const status of STATUS_DIRS) {
    const dir = join(tasksDir, status);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch { continue; }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const filePath = join(dir, entry);
      const s = await stat(filePath);
      if (!s.isFile()) continue;

      const raw = await readFile(filePath, "utf-8");
      const task = parseTaskFile(raw, filePath);

      // Skip if no gate fields (already migrated or bare task)
      if (!(task.frontmatter as any).gate || task.frontmatter.workflow) continue;

      migrateGateToDAG(task, workflowConfig);

      if (task.frontmatter.workflow) {
        await writeFileAtomic(filePath, serializeTask(task));
        converted++;
      }
    }
  }

  return converted;
}
```

### Example 3: channel.json Version Metadata
```typescript
import writeFileAtomic from "write-file-atomic";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

interface ChannelMetadata {
  version: string;
  previousVersion?: string | null;
  channel: string;
  installedAt?: string;
  upgradedAt?: string;
}

async function writeChannelMetadata(
  aofRoot: string,
  version: string,
  channel: string = "stable"
): Promise<void> {
  const channelPath = join(aofRoot, ".aof", "channel.json");
  const now = new Date().toISOString();

  let metadata: ChannelMetadata;

  try {
    const existing = JSON.parse(await readFile(channelPath, "utf-8"));
    // Upgrade: carry forward previous version
    metadata = {
      version,
      previousVersion: existing.version ?? null,
      channel,
      upgradedAt: now,
    };
  } catch {
    // Fresh install or first migration
    metadata = {
      version,
      channel,
      installedAt: now,
    };
  }

  await writeFileAtomic(channelPath, JSON.stringify(metadata, null, 2) + "\n");
}
```

### Example 4: install.sh Backup Fix (BUGF-02)
```bash
# Current (line 284):
for dir in tasks events memory state data logs; do

# Fixed -- add Projects:
for dir in tasks events memory state data logs Projects; do
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Gate-based workflows | DAG-based workflows | v1.2 (Phase 10-16) | All gate tasks must be migrated to DAG format |
| Single project (flat vault) | Multi-project with Projects/ dir | v1.1 (Phase 7) | Migrations must discover and handle multiple projects |
| No schema versioning | `schemaVersion: 1` on all schemas | v1.1 (Phase 4) | Provides upgrade path; needs relaxation to accept version 2 |
| No migration framework | `runMigrations()` framework | v1.2 (Phase 15) | Framework exists but has no actual migrations registered yet |
| Raw `writeFile` in some paths | `write-file-atomic` everywhere | v1.1 (Phase 5) | Consistent pattern; migrations must follow |

**Deprecated/outdated:**
- `WorkflowConfig` (gate-based): Deprecated since v1.2, kept for backward compatibility during migration period. `WorkflowDefinition` (DAG) replaces it.
- `workflow.gates` in project.yaml: Replaced by `workflowTemplates` record. The old `workflow` field with gates array is the legacy format that migration 002 converts away from.

## Open Questions

1. **defaultWorkflow field: Schema addition needed?**
   - What we know: `ProjectManifest` schema in `src/schemas/project.ts` does not have `defaultWorkflow`. It needs to be added as an optional string field (template name reference).
   - What's unclear: Should it be added to the Zod schema in this phase, or deferred to Phase 18 (DAG-as-Default)?
   - Recommendation: Add the schema field now (Phase 17) since migration 001 writes it. Phase 18 consumes it. The field must exist in the schema for `ProjectManifest.parse()` not to strip it.

2. **Snapshot storage: cp vs tar**
   - What we know: User left this to Claude's discretion. `cp -r` (via `node:fs/promises.cp`) is simpler and faster to restore. `tar` saves disk space.
   - What's unclear: Typical data directory size. For small installs (< 100MB), cp is fine.
   - Recommendation: Use `node:fs/promises.cp()` with `{ recursive: true }`. Simpler code, instant restore (no decompression), and AOF data dirs are typically small. The 2-snapshot limit caps storage overhead.

3. **schemaVersion: Which schemas get version 2?**
   - What we know: Three schemas have `schemaVersion: z.literal(1)`: AofConfig, TaskFrontmatter, OrgChart. The requirement says "schemaVersion relaxed to support version 2."
   - What's unclear: Do all three schemas bump to version 2, or only one? Migration 003 writes version metadata but doesn't change task or config schemas.
   - Recommendation: Relax all three to `z.union([z.literal(1), z.literal(2)])` for forward compatibility, but only write `schemaVersion: 2` in newly created items post-v1.3. Existing items stay at version 1 (they work because the union accepts both).

## Sources

### Primary (HIGH confidence)
- Codebase inspection: `src/packaging/migrations.ts` -- migration framework with up/down lifecycle, version comparison, history tracking
- Codebase inspection: `src/migration/gate-to-dag.ts` -- per-task gate-to-DAG converter
- Codebase inspection: `src/store/task-store.ts` -- lazy migration in `get()` and `list()`, missing in `getByPrefix()`
- Codebase inspection: `src/cli/commands/setup.ts` -- `getAllMigrations()` returns `[]`, `runSetup()` orchestration
- Codebase inspection: `src/schemas/project.ts` -- `ProjectManifest` with `workflowTemplates` but no `defaultWorkflow`
- Codebase inspection: `src/schemas/config.ts`, `task.ts`, `org-chart.ts` -- `schemaVersion: z.literal(1)` in all three
- Codebase inspection: `scripts/install.sh` -- backup scope at line 284 missing `Projects/`
- `write-file-atomic` 7.0.0 verified in `node_modules/write-file-atomic/package.json`
- `yaml` 2.8.2 verified in `node_modules/yaml/package.json`; `parseDocument`, `setIn`, `toString` confirmed in type declarations

### Secondary (MEDIUM confidence)
- [yaml npm package docs](https://eemeli.org/yaml/v1/) -- parseDocument API for comment-preserving round-trips
- [yaml GitHub parsing docs](https://github.com/eemeli/yaml/blob/main/docs/07_parsing_yaml.md) -- setIn, getIn, toString usage

### Tertiary (LOW confidence)
- None -- all findings verified against codebase

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already in node_modules, verified versions, established import patterns
- Architecture: HIGH -- migration framework exists, integration points identified, patterns from codebase
- Pitfalls: HIGH -- identified from code inspection (snapshot nesting, AST nodes, history restore, schema checks)

**Research date:** 2026-03-03
**Valid until:** 2026-04-03 (stable -- core libraries unlikely to change)
