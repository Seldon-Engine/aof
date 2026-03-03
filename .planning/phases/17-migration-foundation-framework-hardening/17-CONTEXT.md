# Phase 17: Migration Foundation & Framework Hardening - Context

**Gathered:** 2026-03-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Harden the migration framework and implement all config/data migrations for the v1.2-to-v1.3 upgrade path. Users upgrading from pre-v1.2 or v1.2 installations get their config and task data migrated automatically, atomically, and safely -- with snapshot-based rollback on any failure. Covers requirements MIGR-01 through MIGR-05, CONF-01 through CONF-04, BUGF-01, BUGF-02.

</domain>

<decisions>
## Implementation Decisions

### Snapshot & rollback behavior
- Full data directory snapshot (`~/.openclaw/aof/` tree) before any migration runs
- Auto-restore on any migration failure -- no user prompt, just error message explaining what happened and that data was restored
- Keep last 2 snapshots (current + one previous) for "realized something's wrong after second upgrade" scenario
- Store snapshots inside the data directory (`.aof/snapshots/`) with nesting exclusion

### Migration failure & resume
- All-or-nothing approach: run all migrations sequentially; if ANY fails, restore the full snapshot entirely
- Re-running the installer retries all migrations from scratch (snapshot provides clean state)
- Each migration MUST be idempotent -- checks if its work is already done before acting (belt-and-suspenders with snapshot)
- In-progress detection via marker file: write `.aof/migration-in-progress` before starting, remove after success; if marker exists on next run, log warning that previous migration was interrupted
- Console output during upgrade for visibility (e.g., "✓ 001-default-workflow-template applied") -- no separate log file

### Gate-to-DAG batch scope
- Eagerly convert ALL tasks across ALL status directories including in-progress (snapshot provides rollback safety; gateway sessions are independent of task YAML)
- Keep lazy gate-to-DAG migration in task-store.ts as a safety net alongside batch (handles edge cases: manual file edits, restored from old backup)
- For defaultWorkflow migration (CONF-01): pick the first template in `workflowTemplates` if defined; if no templates exist, skip -- project stays bare-task
- Multi-project support: migration discovers all project.yaml files under the data directory and migrates each independently

### Version metadata
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

</decisions>

<specifics>
## Specific Ideas

No specific requirements -- open to standard approaches

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `runMigrations()` in `src/packaging/migrations.ts`: Full up/down lifecycle, version comparison, history tracking via `.aof/migrations.json`
- `getMigrationHistory()` / `recordMigration()` / `removeMigration()`: Migration history CRUD already built
- `migrateGateToDAG()` in `src/migration/gate-to-dag.ts`: Per-task gate-to-DAG conversion logic (reuse for batch migration)
- `write-file-atomic` 7.x: Already in node_modules, must be used in all migration `up()` functions (MIGR-01)
- `yaml` 2.8.2 with `parseDocument()` API: Already available for comment-preserving YAML modifications (MIGR-04)

### Established Patterns
- Migration interface: `{ id, version, description, up(ctx), down?(ctx) }` with `MigrationContext: { aofRoot, version }`
- Migration history: `.aof/migrations.json` with `{ migrations: [{ id, version, description, appliedAt }] }`
- `migrationRegistry` Map for registration, `registerMigration()` function
- Config manager (`src/config/manager.ts`) uses plain `stringifyYaml` -- must be bypassed for YAML migrations using `parseDocument()` API directly
- `schemaVersion: z.literal(1)` in config schema -- needs relaxation to support version 2

### Integration Points
- `getAllMigrations()` in `src/cli/commands/setup.ts` currently returns `[]` -- populate with three migration objects
- `runSetup()` in setup.ts orchestrates fresh/upgrade/legacy flows -- snapshot/restore wraps around `runMigrations()` call
- `getByPrefix()` in `src/store/task-store.ts` needs gate-to-DAG migration (same as `get()` and `list()`)
- `scripts/install.sh` backup list needs expansion to include `Projects/` directory tree

</code_context>

<deferred>
## Deferred Ideas

None -- discussion stayed within phase scope

</deferred>

---

*Phase: 17-migration-foundation-framework-hardening*
*Context gathered: 2026-03-03*
