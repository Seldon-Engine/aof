# Feature Landscape: Seamless Upgrade and Release

**Domain:** CLI tool upgrade path, config migration, release pipeline, rollback safety
**Researched:** 2026-03-03
**Confidence:** HIGH (patterns derived from codebase inspection of existing installer/updater/migration modules plus well-established CLI upgrade practices from rustup, Terraform, Homebrew, Snyk CLI)

## Context

This is a SUBSEQUENT MILESTONE (v1.3). AOF v1.2 shipped per-task workflow DAGs with:
- `migrateGateToDAG()` lazy migration triggered on task read (converts gate fields to DAG workflow)
- Scheduler dual-path execution (gate and DAG evaluation independently)
- `workflowTemplates` optional field in project.yaml
- `bd create --workflow template-name` for explicit template selection
- Tag-triggered GitHub Actions release with tarball artifacts
- curl|sh installer with upgrade detection, data backup, and Node.js setup delegation

v1.3 must make this deployable with confidence: upgrades work end-to-end, DAGs become the default (not opt-in), the release is cut and installable, and users can roll back safely.

**Key existing infrastructure:**
- `src/packaging/migrations.ts` -- Migration framework with history tracking, up/down direction, version comparison
- `src/packaging/updater.ts` -- Self-update engine with backup, download, extract, health check, rollback
- `src/packaging/installer.ts` -- Dependency installer with backup and rollback
- `src/packaging/integration.ts` -- OpenClaw plugin registration with backup
- `src/packaging/channels.ts` -- Release channel management (stable/beta)
- `src/migration/gate-to-dag.ts` -- Lazy per-task gate-to-DAG conversion
- `scripts/install.sh` -- Shell installer with prerequisite checks, upgrade detection, data backup
- `src/daemon/health.ts` -- Health status with component checks (scheduler, store, eventLogger)
- `.github/workflows/release.yml` -- Tag-triggered CI with typecheck, build, test, tarball, changelog

---

## Table Stakes

Features users expect from a seamless CLI upgrade experience. Missing = users cannot upgrade with confidence.

### 1. Config Migration: Add `defaultWorkflow` to project.yaml

| Aspect | Detail |
|--------|--------|
| Why Expected | DAG-as-default requires project config to specify which workflow template applies to new tasks. Without this, "DAG-as-default" means nothing -- there is no mechanism to auto-attach a workflow. |
| Complexity | MEDIUM |
| Depends On | Existing `ProjectManifest` schema, existing `workflowTemplates`, existing migration framework |

**What the ecosystem does:**

Config migration in CLI tools follows an "additive merge" pattern:
- **Terraform**: Minor versions add new optional fields with defaults. Existing configs continue to work. The provider upgrade guide documents new fields and their default values.
- **ESLint**: The `@eslint/migrate-config` tool transforms old `.eslintrc` to `eslint.config.js`, preserving existing settings while adapting structure.
- **Airflow 2-to-3**: Backward compatibility layer keeps old config working while new config structure is available. Ruff rules auto-detect deprecated features.

The universal pattern: **new fields must have sensible defaults so existing configs work without modification, but the migration should proactively add them for explicitness.**

**What AOF must do:**

1. Add `defaultWorkflow` optional field to `ProjectManifest` schema (Zod). When present, `bd create` (without `--workflow`) auto-attaches this template to new tasks.
2. Write a migration (`001-add-default-workflow`) that:
   - Reads each project's `project.yaml`
   - If `workflowTemplates` exists and has exactly one template, sets `defaultWorkflow` to that template name
   - If `workflowTemplates` has multiple templates, leaves `defaultWorkflow` unset (user must choose)
   - If no `workflowTemplates` exist, skips (no workflows to default to)
   - If `workflow` (old gate format) exists but no `workflowTemplates`, converts the gate workflow to a DAG template first, then sets `defaultWorkflow`
3. The migration must preserve all existing fields in project.yaml (additive, not destructive).
4. The migration must handle YAML comments gracefully (use the `yaml` library's document model, not parse-then-stringify which drops comments).

**The "automatically leveraged" UX in practice:**
- Before v1.3: `bd create "Fix login bug"` creates a task with no workflow (bare task)
- After v1.3: `bd create "Fix login bug"` creates a task with the project's default workflow DAG attached, ready for multi-hop execution
- Override: `bd create "Fix login bug" --workflow custom-pipeline` still works
- Opt-out: `bd create "Fix login bug" --no-workflow` creates a bare task

**Confidence:** HIGH -- direct schema extension, well-understood additive migration pattern. The existing `resolveWorkflowTemplate()` in `task-create-workflow.ts` already handles template lookup.

---

### 2. Eager Gate-to-DAG Migration (Batch, Not Just Lazy)

| Aspect | Detail |
|--------|--------|
| Why Expected | The lazy migration (v1.2) converts tasks one-by-one on read. For v1.3, all tasks should be migrated proactively during upgrade so the gate code path can be deprecated. |
| Complexity | LOW |
| Depends On | Existing `migrateGateToDAG()`, existing migration framework |

**What the ecosystem does:**

Lazy migration is a transitional pattern. Production-grade upgrades batch-migrate:
- **Airflow**: Database migrations run at upgrade time via `airflow db upgrade`, not lazily.
- **Terraform**: State migrations run during `terraform init` after version change.

Lazy migration is a safety net; eager migration is the primary path.

**What AOF must do:**

1. Write a migration (`002-batch-gate-to-dag`) that:
   - Walks all task files in all status directories (backlog, ready, in-progress, review, done)
   - For each task with `gate` field and no `workflow` field, calls `migrateGateToDAG()`
   - Writes the migrated task atomically (existing pattern: `writeFileAtomic`)
   - Logs a count of migrated tasks
   - Skips deadletter tasks (they are historical, not active)
2. The lazy migration in `task-store.ts` remains as a safety net for tasks that somehow missed the batch migration (edge case: task file created between migration run and scheduler start).
3. Emit a migration event to JSONL event log for auditability.

**Confidence:** HIGH -- `migrateGateToDAG()` already works and is tested. Wrapping it in a batch walker is straightforward.

---

### 3. Project Manifest Migration (Gate Workflow to DAG Template)

| Aspect | Detail |
|--------|--------|
| Why Expected | Projects using old `workflow` field (gate format) need that converted to `workflowTemplates` with a DAG template. This is the project-level equivalent of task-level gate-to-DAG migration. |
| Complexity | MEDIUM |
| Depends On | Existing `WorkflowConfig` schema, existing `WorkflowDefinition` schema, existing migration framework |

**What AOF must do:**

1. Write a migration (`003-project-workflow-to-templates`) that:
   - Reads each project's `project.yaml`
   - If `workflow` exists (old gate format with `gates[]`):
     - Converts the gate sequence to a linear DAG (same logic as `migrateGateToDAG` but at the template level)
     - Creates a `workflowTemplates` entry with key derived from `workflow.name`
     - Sets `defaultWorkflow` to that template name
     - Removes the old `workflow` field (or marks it deprecated)
   - If `workflowTemplates` already exists, no conversion needed
   - Preserves all other project.yaml fields
2. The `WorkflowConfig.optional()` field in `ProjectManifest` should be marked as deprecated in code comments, with a Zod `.transform()` that emits a deprecation warning when parsed.

**Confidence:** HIGH -- the conversion logic is a subset of `migrateGateToDAG` (gates to hops without in-flight state tracking).

---

### 4. Upgrade Smoke Tests (Post-Install Verification)

| Aspect | Detail |
|--------|--------|
| Why Expected | After upgrade, users need confidence the new version actually works. "It installed" is not sufficient -- the system must prove it can schedule, dispatch, and track tasks. |
| Complexity | MEDIUM |
| Depends On | Existing health endpoint, existing task store, existing scheduler |

**What the ecosystem does:**

Post-install smoke tests are a standard pattern:
- **Snyk CLI**: Runs `snyk --version` and `snyk test` on a known fixture after install. Smoke tests verify the binary works, not just that it exists.
- **Homebrew**: `brew test` runs post-install tests defined in the formula.
- **Terraform**: `terraform validate` checks configuration syntax after version change.

The key insight from CircleCI's smoke testing guide: smoke tests should be fast (seconds, not minutes), test critical paths (not edge cases), and fail loudly with actionable errors.

**What AOF must do:**

Implement `bd smoke` (or `aof smoke`) command that runs a fast verification suite:

1. **Version check**: Verify `bd --version` returns expected version (catches broken binary/symlink)
2. **Schema validation**: Parse and validate all project.yaml files with current Zod schemas (catches schema migration failures)
3. **Task store integrity**: Count tasks by status, verify no corrupt task files (catches data directory damage)
4. **Org chart validation**: Lint org-chart.yaml (catches config drift from upgrade)
5. **Migration completeness**: Verify no tasks still have `gate` fields (catches incomplete migration)
6. **Daemon connectivity**: If daemon running, hit /healthz endpoint (catches daemon version mismatch)
7. **Workflow template validation**: Validate all `workflowTemplates` DAGs (catches template corruption)

Each check should:
- Print pass/fail with timing
- On failure: print specific remediation advice
- Return nonzero exit code on any failure (for CI/script integration)
- Complete in under 10 seconds total

**When to run:**
- Automatically after `run_node_setup()` in install.sh (during upgrade)
- Manually via `bd smoke` for user verification
- In CI as post-release gate (release job runs smoke tests against installed tarball)

**Confidence:** HIGH -- the individual checks already exist (health endpoint, lint, validation). Orchestrating them into a single command is straightforward.

---

### 5. Version-Aware Installer with Migration Triggers

| Aspect | Detail |
|--------|--------|
| Why Expected | The installer must detect which version is upgrading to which, and run the appropriate migrations. Currently, install.sh backs up data but does not run migrations. |
| Complexity | MEDIUM |
| Depends On | Existing install.sh, existing migration framework, existing `runMigrations()` |

**What the ecosystem does:**

- **rustup**: Detects current version, downloads target version, runs self-update. Version pinning available via `RUSTUP_VERSION` environment variable.
- **Terraform**: `terraform init` detects version change and runs provider/state migrations.
- **Homebrew**: `brew upgrade` handles formula-level migration hooks.

The pattern: **detect version delta, run migrations for that delta, verify result.**

**What AOF must do:**

1. In `run_node_setup()` (install.sh), pass `--from-version $EXISTING_VERSION` to the Node.js setup command
2. The setup command calls `runMigrations()` with:
   - `targetVersion`: the new version being installed
   - `migrations`: all registered migrations
   - Direction: `up`
3. Migrations run in version order, skipping already-applied ones (existing behavior from migration framework)
4. If any migration fails:
   - Log the failure with specific migration ID
   - Attempt rollback of applied migrations (call `down` on each in reverse order)
   - Restore from backup (existing install.sh backup mechanism)
   - Exit with error code and remediation instructions
5. Write migration history to `.aof/migrations.json` (existing behavior)
6. The `.version` file now stores structured version info (not just a version string):
   ```json
   { "version": "1.3.0", "migratedFrom": "1.2.0", "migratedAt": "2026-03-03T...", "migrations": ["001-add-default-workflow", "002-batch-gate-to-dag", "003-project-workflow-to-templates"] }
   ```

**Confidence:** HIGH -- the migration framework already supports version-ordered execution with history tracking. The gap is wiring it into the installer flow.

---

### 6. Rollback Safety (Restore Previous Version)

| Aspect | Detail |
|--------|--------|
| Why Expected | If the upgrade breaks something, users need to get back to the working version quickly. "Restore from backup" is not enough -- it must be a single command. |
| Complexity | MEDIUM |
| Depends On | Existing backup mechanism in install.sh and updater.ts, existing `rollbackUpdate()` |

**What the ecosystem does:**

- **rustup**: `RUSTUP_VERSION=1.28.1 rustup self update` downgrades to a specific version.
- **AWS Builders Library**: "Ensure rollback safety" -- every deployment must be reversible, rollback must be tested, and data format changes must be backward-compatible for one version.
- **Kubernetes**: `kubectl rollout undo` reverts to previous deployment.
- **macOS/Windows**: OS upgrades keep the previous version available for rollback during a grace period.

The universal pattern: **keep the previous version's artifacts and data accessible, provide a single rollback command, and time-limit the rollback window.**

**What AOF must do:**

1. **Backup retention**: install.sh already backs up data directories. Add: backup the entire previous installation directory (not just data), including `dist/`, `node_modules/`, `package.json`, and `.version`.
2. **Rollback command**: `bd rollback` (or `aof rollback`):
   - Lists available backups (from `.aof-backup/`)
   - Restores the most recent backup by default, or a specific backup by timestamp
   - Re-runs `npm ci --production` (since node_modules may differ between versions)
   - Runs smoke tests after restore
   - Prints restored version
3. **Rollback window**: Keep the last 2 backups. Older backups are pruned automatically during the next upgrade. This prevents unbounded disk usage.
4. **Migration rollback**: Migrations with `down` functions can be reversed. The rollback command runs `runMigrations()` in `down` direction to the previous version.
5. **Data format backward compatibility**: v1.3 task format (with `workflow` field) must be readable by v1.2 code. This means:
   - v1.2 ignores `workflow` field (it is optional in the schema -- Zod `.passthrough()` handles unknown fields)
   - v1.3 migrations must not delete `gate` fields immediately -- keep them for one version as a rollback safety net
   - v1.4 can safely remove `gate` fields

**Confidence:** MEDIUM -- the backup/restore mechanism exists but the rollback command and migration reversal need new code. Backward-compatible data format is the riskiest part.

---

### 7. Release Pipeline Enhancement (Pre-Flight Checks)

| Aspect | Detail |
|--------|--------|
| Why Expected | Before cutting a release tag, CI must verify the build is releasable. The current release workflow runs typecheck/build/test, but needs upgrade-path verification. |
| Complexity | LOW |
| Depends On | Existing `.github/workflows/release.yml`, existing test infrastructure |

**What the ecosystem does:**

- **npm**: Pre-publish checks include `npm audit`, version bump verification, changelog presence. The `prerelease-checks` npm package automates this.
- **release-it**: Runs pre-release hooks (lint, test, changelog) before tagging and publishing.
- **Snyk CLI**: Smoke tests run in CI against the built binary before release.

**What AOF must do:**

Add to release.yml (or as a separate pre-release workflow):

1. **Upgrade simulation**: Install the previous release tarball, create synthetic tasks with gate format, then install the new build over it. Run smoke tests to verify the upgrade path worked.
2. **Migration test**: Run all migrations in `up` direction, then `down` direction, then `up` again. Verify idempotency.
3. **Tarball integrity**: Extract the built tarball to a clean directory, run `npm ci --production`, and verify `bd --version` returns the expected version.
4. **Schema backward compatibility**: Load task files written by the previous version and verify they parse with the current schema (no breaking changes).

These tests run as a separate CI job (not on every PR, only on release tags or release branches) because they need the built tarball.

**Confidence:** HIGH -- these are standard CI patterns. The upgrade simulation is the most valuable and novel addition.

---

### 8. DAG-as-Default for New Tasks

| Aspect | Detail |
|--------|--------|
| Why Expected | The entire point of v1.3 is making DAGs the default. Without this, DAGs remain opt-in and most tasks are created without workflows. |
| Complexity | LOW |
| Depends On | Config migration (table stakes #1), existing `resolveWorkflowTemplate()`, existing `bd create` |

**What AOF must do:**

1. Modify `bd create` to check for `defaultWorkflow` in the project manifest:
   - If `defaultWorkflow` is set and `--workflow` is not specified: auto-attach the default template
   - If `--workflow template-name` is specified: use that template (existing behavior)
   - If `--no-workflow` flag is specified: create bare task (no workflow)
   - If `defaultWorkflow` is not set and `--workflow` is not specified: create bare task (backward-compatible)
2. Modify the MCP tool `aof_task_create` with the same logic.
3. Print a message when auto-attaching: `Workflow "standard-review" auto-attached (project default). Use --no-workflow to skip.`
4. The agent API for ad-hoc workflow composition takes precedence over `defaultWorkflow` (explicit inline workflow overrides the default).

**Confidence:** HIGH -- the template resolution infrastructure already exists. This is a conditional lookup before task creation.

---

### 9. Upgrade Documentation

| Aspect | Detail |
|--------|--------|
| Why Expected | Users need a clear guide for upgrading from v1.2 to v1.3. What changes, what they need to do, what breaks. |
| Complexity | LOW |
| Depends On | All other features (documents what they do) |

**What AOF must do:**

1. `UPGRADING.md` (or `guide/upgrading-v1.3.md`) covering:
   - What changed: DAGs are now default, config migration runs automatically
   - Prerequisites: Node 22, existing v1.2 install
   - Step-by-step: `curl | sh` (same as fresh install -- installer handles upgrade)
   - What happens during upgrade: backup, migrations, smoke test
   - How to verify: `bd smoke` command
   - How to rollback: `bd rollback` command
   - Breaking changes: None (additive changes only)
   - Known issues: (list any)
2. Changelog generated from conventional commits (existing release.yml behavior)
3. Migration summary printed at end of installer (what was migrated, counts)

**Confidence:** HIGH -- documentation, no technical risk.

---

## Differentiators

Features that make the upgrade experience notably better than competitors. Not required for v1.3 MVP, but high value.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Dry-run upgrade** | `install.sh --dry-run` shows what would change without modifying anything. Users preview the impact before committing. | LOW | Print migration plan, show which tasks would be migrated, show config changes. No file writes. High trust signal. |
| **Progressive rollout for DAG default** | Instead of all-or-nothing, let projects opt into DAG-as-default individually. `defaultWorkflow` is per-project. | LOW | Already per-project by design (defaultWorkflow is in project.yaml). Document this as a feature. |
| **Migration audit trail** | After upgrade, `bd migrations` shows which migrations ran, when, and what they changed. Full auditability. | LOW | The `.aof/migrations.json` history already exists. Add a CLI command to display it. |
| **Canary task creation** | During upgrade, the smoke test creates a real task with the default workflow, verifies it parses and validates, then deletes it. Proves the full task lifecycle works. | MEDIUM | Goes beyond static validation -- actually exercises the task store. |
| **Automatic daemon restart** | After upgrade, automatically restart the daemon if it was running. Users should not have to manually restart. | LOW | Check if daemon is running (PID file / health endpoint), stop, wait, start. The existing daemon lifecycle commands handle this. |

---

## Anti-Features

Features that seem related to seamless upgrade but should NOT be built.

| Anti-Feature | Why Requested | Why Avoid | What to Do Instead |
|--------------|---------------|-----------|-------------------|
| **Auto-update mechanism** | "Check for updates and install automatically" | Explicitly deferred to v2 in PROJECT.md. Auto-updating a CLI tool running under OS supervision (launchd/systemd) risks breaking the daemon mid-operation. | Users run `curl \| sh` or `bd update` manually. The channel system can check for updates and notify without auto-installing. |
| **In-place binary replacement** | "Hot-swap the running binary without restart" | Impossible for a Node.js application. The running process has loaded modules from disk. Replacing them while running causes undefined behavior. | Stop daemon, upgrade, start daemon. The installer already handles this flow. |
| **Backward migration of task data** | "Convert DAG tasks back to gate format" | Gate code is being deprecated. Maintaining two-way conversion doubles maintenance. The `down` migration for tasks should restore from backup, not reverse-engineer gates from DAGs. | Rollback restores the backup (which has original gate format). No reverse conversion needed. |
| **Multi-version coexistence** | "Run v1.2 and v1.3 side by side" | Single install directory. Filesystem-based state means one version owns the data directory at a time. | Rollback is the mechanism. If v1.3 has issues, rollback to v1.2. |
| **OpenClaw version compatibility checks** | "Verify OpenClaw gateway version is compatible" | Explicitly deferred to v2 in PROJECT.md. | AOF uses plugin-sdk export. If the export API is stable, version does not matter. |
| **Interactive migration wizard** | "Walk the user through each migration decision" | Migrations should be automatic and deterministic. User decisions introduce variability and risk. | Migrations run automatically with sensible defaults. `--dry-run` previews. `bd rollback` undoes. |

---

## Feature Dependencies

```
[Config Migration: defaultWorkflow] (table stakes #1)
    requires -> ProjectManifest schema
    requires -> existing workflowTemplates
    enables -> [DAG-as-Default] (table stakes #8)
    enables -> [Project Manifest Migration] (table stakes #3)

[Batch Gate-to-DAG Migration] (table stakes #2)
    requires -> existing migrateGateToDAG()
    requires -> existing migration framework
    enables -> [Migration Completeness smoke check]

[Project Manifest Migration] (table stakes #3)
    requires -> existing WorkflowConfig schema
    requires -> [Config Migration: defaultWorkflow]
    enables -> [DAG-as-Default] (table stakes #8)

[Upgrade Smoke Tests] (table stakes #4)
    requires -> existing health endpoint
    requires -> existing validation/lint
    validates -> [Config Migration] (table stakes #1)
    validates -> [Batch Migration] (table stakes #2)
    validates -> [Project Migration] (table stakes #3)

[Version-Aware Installer] (table stakes #5)
    requires -> existing install.sh
    requires -> existing runMigrations()
    triggers -> [Config Migration] (table stakes #1)
    triggers -> [Batch Migration] (table stakes #2)
    triggers -> [Project Migration] (table stakes #3)
    triggers -> [Smoke Tests] (table stakes #4)

[Rollback Safety] (table stakes #6)
    requires -> existing backup mechanism
    requires -> existing rollbackUpdate()
    requires -> backward-compatible data format
    validates -> [Smoke Tests] (table stakes #4)

[Release Pipeline] (table stakes #7)
    requires -> existing release.yml
    tests -> [Version-Aware Installer] (table stakes #5)
    tests -> [Smoke Tests] (table stakes #4)

[DAG-as-Default] (table stakes #8)
    requires -> [Config Migration: defaultWorkflow] (table stakes #1)
    requires -> existing resolveWorkflowTemplate()
    requires -> existing bd create
```

### Dependency Notes

- **Config migration is the foundation**: defaultWorkflow field must exist before DAG-as-default can be implemented.
- **Migrations before smoke tests**: Smoke tests verify migration correctness, so migrations must exist first.
- **Version-aware installer orchestrates**: The installer triggers migrations, then smoke tests. It is the integration point.
- **Rollback must be independent**: Rollback cannot depend on the new version working. It must be able to restore from backup without running any v1.3 code paths.
- **Release pipeline verifies everything**: It exercises the full upgrade path in CI before publishing.

---

## MVP Recommendation

### Phase Ordering (based on dependencies and risk):

**Phase 1: Schema and Migration Foundation**
- Add `defaultWorkflow` optional field to ProjectManifest schema
- Write migration `001-add-default-workflow` (per-project config update)
- Write migration `002-batch-gate-to-dag` (eager task migration)
- Write migration `003-project-workflow-to-templates` (gate workflow conversion)
- Rationale: All downstream work depends on the schema change and migrations existing.

**Phase 2: Installer Integration**
- Wire migrations into installer flow (version-aware `run_node_setup`)
- Enhanced backup (full installation, not just data directories)
- Implement `bd rollback` command
- Rationale: The upgrade must actually run migrations. Without installer integration, migrations are dead code.

**Phase 3: DAG-as-Default + Smoke Tests**
- Modify `bd create` to auto-attach defaultWorkflow
- Modify MCP tool with same logic
- Implement `bd smoke` command with all verification checks
- Add `--no-workflow` flag to `bd create`
- Rationale: This is the user-visible outcome. Smoke tests validate everything built in phases 1-2.

**Phase 4: Release Pipeline + Documentation**
- Add upgrade simulation to release.yml
- Add migration roundtrip test to CI
- Write UPGRADING.md
- Cut v1.3 release tag
- Rationale: Final validation and packaging. Must be last because it tests the complete flow.

### Prioritize (must have for v1.3):
1. Schema change (defaultWorkflow) -- enables everything
2. Batch gate-to-DAG migration -- eliminates dual code path
3. Version-aware installer with migration triggers -- makes upgrade automatic
4. DAG-as-default in bd create -- the user-visible feature
5. Smoke test command -- confidence mechanism
6. Rollback command -- safety net

### Defer if time-constrained:
- Dry-run upgrade (nice but not blocking)
- Migration audit CLI (history already tracked in JSON, manual inspection sufficient)
- Canary task creation (static validation is sufficient for v1.3)
- Automatic daemon restart (documented manual restart is acceptable)
- Release pipeline upgrade simulation (manual testing of upgrade path is acceptable for v1.3, automate in v1.4)

---

## Sources

- AOF migration framework: `src/packaging/migrations.ts` -- HIGH confidence (examined directly, supports up/down direction, version ordering, history tracking)
- AOF self-update engine: `src/packaging/updater.ts` -- HIGH confidence (examined directly, backup/download/extract/rollback with hooks)
- AOF gate-to-DAG migration: `src/migration/gate-to-dag.ts` -- HIGH confidence (examined directly, lazy per-task conversion with in-flight position mapping)
- AOF shell installer: `scripts/install.sh` -- HIGH confidence (examined directly, prerequisite checks, upgrade detection, data backup, Node.js setup delegation)
- AOF task-store lazy migration: `src/store/task-store.ts` lines 245-254 -- HIGH confidence (examined directly, lazy migrateGateToDAG on task read)
- AOF project schema: `src/schemas/project.ts` -- HIGH confidence (examined directly, workflowTemplates optional field, no defaultWorkflow yet)
- AOF workflow template resolution: `src/cli/commands/task-create-workflow.ts` -- HIGH confidence (examined directly, resolves template name from manifest)
- AOF health endpoint: `src/daemon/health.ts` -- HIGH confidence (examined directly, status/components/config checks)
- AOF release workflow: `.github/workflows/release.yml` -- HIGH confidence (examined directly, tag-triggered with typecheck/build/test/tarball/changelog)
- [Terraform version management](https://developer.hashicorp.com/terraform/tutorials/configuration-language/versions) -- MEDIUM confidence (additive schema pattern, backward-compatible minor versions)
- [Snyk CLI smoke tests](https://github.com/snyk/cli/blob/main/test/smoke/README.md) -- MEDIUM confidence (post-install verification pattern: version check, basic operation test, fixture-based validation)
- [rustup self-update mechanism](https://rust-lang.github.io/rustup/basics.html) -- MEDIUM confidence (version pinning, self-update control, channel management)
- [AWS Builders Library: Ensuring Rollback Safety](https://aws.amazon.com/builders-library/ensuring-rollback-safety-during-deployments/) -- MEDIUM confidence (backward-compatible data formats, one-version rollback window, tested rollback paths)
- [Smoke testing in CI/CD](https://circleci.com/blog/smoke-tests-in-cicd-pipelines/) -- MEDIUM confidence (fast critical-path verification, fail-loud with actionable errors)
- [prerelease-checks npm package](https://www.npmjs.com/package/prerelease-checks) -- LOW confidence (pre-release verification pattern, not directly applicable to tarball releases)

---
*Feature research for: AOF v1.3 Seamless Upgrade and Release*
*Researched: 2026-03-03*
