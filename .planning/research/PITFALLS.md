# Pitfalls Research: v1.3 Seamless Upgrade

**Domain:** CLI tool upgrade/migration/release pipeline for filesystem-based agent orchestration
**Researched:** 2026-03-03
**Confidence:** HIGH (based on direct codebase analysis + domain research)

---

## Critical Pitfalls

### Pitfall 1: Migration History Records Success But Filesystem Is Partially Written

**What goes wrong:**
The migration framework in `src/packaging/migrations.ts` records each migration to `migrations.json` *after* the `up()` function completes, but the `up()` function itself may perform multiple filesystem operations. If the process crashes mid-migration (after some files are written but before all are), the migration is NOT recorded in history. On next run, the migration re-executes from the top, but now some files already exist in their new format. The migration either fails (file already exists), silently overwrites partial state, or produces duplicated/corrupted data.

This is especially dangerous for AOF because:
- Task files are YAML frontmatter with markdown bodies -- partial YAML writes corrupt the entire file
- The `writeFile` calls in `migrations.ts` are NOT atomic (plain `fs.writeFile`, not `write-file-atomic`)
- Task store uses `writeFileAtomic` but the migration framework does not

**Why it happens:**
Developers test migrations on clean data and assume `up()` is atomic. Filesystem operations are not transactional -- there is no rollback if step 3 of 5 fails.

**How to avoid:**
1. Use `write-file-atomic` for ALL writes inside migration `up()` functions (the codebase already depends on this package)
2. Make each migration idempotent: check current state before acting, skip already-applied changes
3. Add a per-migration checkpoint within `up()` for multi-step migrations: write a breadcrumb file at each step so partial re-runs skip completed steps
4. Record migration as "in-progress" before starting, then "complete" after -- so a re-run of a partially applied migration knows it needs cleanup, not fresh application

**Warning signs:**
- Migration `up()` function has more than one `writeFile` call
- No idempotency checks inside `up()` (e.g., "if file already has new format, skip")
- Tests only run migrations on clean state, never on partially-migrated state

**Phase to address:** Phase 1 (Config Migration) -- harden migration framework before writing any real migrations

---

### Pitfall 2: Lazy Gate-to-DAG Migration Silently Fails for Tasks Without Workflow Config

**What goes wrong:**
The lazy migration in `task-store.ts` (lines 248-254, 328-337) converts gate-format tasks to DAG format on read. It requires a `WorkflowConfig` from `project.yaml` to know the gate definitions. But the migration silently logs a warning and returns the task unchanged when:
- `project.yaml` does not exist (fresh project directory, moved files)
- `project.yaml` exists but has no `workflow.gates` field (config was updated to DAG format but old tasks remain)
- `project.yaml` has a different workflow than the one the task was created with

The task retains its gate fields, the scheduler's dual gate/DAG paths continue to diverge, and the deprecated gate evaluator (`@deprecated Since v1.2. Will be removed in v1.3.`) is still being called. When v1.3 removes the gate evaluator as promised, these un-migrated tasks will break silently -- the scheduler will not know how to advance them.

**Why it happens:**
Lazy migration defers work to "whenever the task is next accessed." But the migration depends on external config state (`project.yaml`) that can change independently from the task. If the config is updated first and the tasks are not accessed before the gate code is removed, there is a window where migration becomes impossible.

**How to avoid:**
1. Before removing gate evaluator code, run an eager scan: iterate ALL tasks across ALL projects and verify none still have `gate` fields
2. Add a startup health check that counts tasks with `gate` fields and warns/blocks if any remain
3. The v1.3 upgrade migration should eagerly migrate all remaining gate tasks (not rely on lazy path)
4. If `project.yaml` lacks workflow config but tasks have gate fields, reconstruct a default config from the gate fields themselves (the gate data is self-describing: `gate.current` tells you which gates exist)

**Warning signs:**
- Tasks in `tasks/in-progress/` or `tasks/blocked/` still have `gate` field after upgrade
- Console warnings: `[gate-to-dag] Task X has gate fields but no workflow config provided`
- `getByPrefix()` in task-store.ts (line 276-292) does NOT run the lazy migration -- tasks accessed via prefix search skip migration entirely

**Phase to address:** Phase 1 (Config Migration) -- eager scan + migration as part of upgrade, not left to lazy path

---

### Pitfall 3: YAML Config Writes Destroy Comments and Reformat User Files

**What goes wrong:**
AOF's config manager (`src/config/manager.ts` line 72) uses `stringifyYaml(raw, { lineWidth: 120 })` to write YAML. The `yaml` npm package (eemeli/yaml) does preserve comments when using its `Document` API, but AOF parses with `parseYaml()` (which returns a plain JS object) and then stringifies back. This round-trip through plain objects **destroys all YAML comments, reorders keys, changes quoting style, and normalizes whitespace**.

For the org chart (`org-chart.yaml`) -- which is the primary human-edited config file in AOF -- this means:
- Developer comments explaining team configurations are lost
- Custom formatting/grouping of agents is destroyed
- String quoting changes (single vs double quotes) make diffs noisy
- Users who carefully organized their config file find it rewritten into a different style

This is a known problem across the YAML ecosystem. Discourse [sponsored a fix](https://blog.discourse.org/2026/02/how-we-fixed-yaml-comment-preservation-in-ruby-and-why-we-sponsored-it/) for Ruby's Psych library. The `yaml` npm package supports comment preservation via `parseDocument()` + `Document.toString()`, but AOF does not use this API.

**Why it happens:**
Developers parse YAML to JS objects (the natural API) without realizing the round-trip is lossy. Comment preservation requires using the AST/Document API, which is more complex.

**How to avoid:**
1. For config migration, use `yaml.parseDocument()` instead of `yaml.parse()` -- the Document API preserves comments, formatting, and key order
2. For surgical changes (adding a `workflowTemplates` key), use the Document API to append to the existing AST rather than rebuilding from scratch
3. Existing `config set` command should also be migrated to Document API (but that is separate from v1.3)
4. If full Document API migration is too costly, use a "patch" approach: read file as string, locate insertion point via regex/AST, splice in new YAML block, never rewrite the whole file

**Warning signs:**
- `git diff` on `org-chart.yaml` after upgrade shows changes to lines that were not logically modified
- Users report "my config was reformatted" or "my comments disappeared"
- Config validation passes but the file looks different

**Phase to address:** Phase 1 (Config Migration) -- use Document API for any config file modifications during upgrade

---

### Pitfall 4: `schemaVersion: 1` Is Hardcoded Everywhere With No Bump Mechanism

**What goes wrong:**
The AOF config schema (`src/schemas/config.ts` line 66) uses `z.literal(1)` for `schemaVersion`. The org chart also uses `schemaVersion: 1`. Task frontmatter uses `schemaVersion: 1`. There is no mechanism to:
- Detect which schema version a file was written with (always 1)
- Bump the schema version when the schema changes
- Reject files with an unknown schema version
- Run version-specific parsing logic

When v1.3 adds `workflowTemplates` to `project.yaml` or changes task frontmatter to require `workflow` instead of `gate`, the schema version should bump. Without a bump, there is no way to distinguish "pre-v1.3 file that needs migration" from "v1.3 file that is just missing the new field."

**Why it happens:**
Schema version was introduced as a future-proofing measure but was never actually used for anything. The literal `1` makes it impossible to increment without breaking validation of existing files.

**How to avoid:**
1. Change `z.literal(1)` to `z.union([z.literal(1), z.literal(2)])` or `z.number().int().min(1)` to allow version progression
2. Write the new schema version into files during migration
3. Use schema version to branch parsing logic: version 1 files get lazy migration, version 2 files are parsed directly
4. The migration itself should bump schema version as its LAST step (so incomplete migrations leave version at 1, signaling "needs re-migration")

**Warning signs:**
- Zod validation fails on files that have been upgraded (because `schemaVersion: 2` does not match `z.literal(1)`)
- All files say `schemaVersion: 1` even after upgrade, making it impossible to audit migration completeness

**Phase to address:** Phase 1 (Config Migration) -- schema version bump should be part of the migration design

---

### Pitfall 5: Release Pipeline Builds Tarball Without Testing the Tarball Itself

**What goes wrong:**
The release workflow (`.github/workflows/release.yml`) runs typecheck, build, and test BEFORE building the tarball. The tarball is then built by `scripts/build-tarball.mjs` which copies specific files into a staging directory and tars them. But nobody tests the tarball contents:
- The tarball is not extracted and verified
- `npm ci --production` is not run against the staged package.json
- The CLI entry point is not executed from the tarball
- There is no SHA256 checksum for integrity verification

The `build-tarball.mjs` script strips `scripts.prepare` and `simple-git-hooks` from package.json (line 49-50) which is correct, but if a new script or field is added that breaks production install, it will not be caught. The installer (`install.sh`) runs `npm ci --production` on the extracted tarball -- if the tarball's package.json is subtly wrong, every user's install fails.

Additionally, the release-it config (`.release-it.json`) has `before:init` hooks that run typecheck and test, but the GitHub Actions workflow ALSO runs these -- the tarball build happens after both, creating a false sense of security ("tests passed, so the release is good").

**Why it happens:**
Testing the artifact (tarball) rather than the source is an often-overlooked step. It is natural to assume "if the source passes tests, the packaged version will work too."

**How to avoid:**
1. After `build-tarball.mjs`, extract the tarball to a clean temp directory
2. Run `npm ci --production` in that temp directory
3. Run `node dist/cli/index.js --version` to verify the CLI boots
4. Run a minimal smoke test (e.g., `node dist/cli/index.js config validate` against a fixture)
5. Generate SHA256 checksum and attach to the GitHub release alongside the tarball
6. Consider a separate `verify-tarball` job that downloads the release artifact and tests it

**Warning signs:**
- Tarball size changes dramatically between releases (missing or extra files)
- Users report `npm ci` failures after download
- `install.sh` fails at the `npm ci --production` step

**Phase to address:** Phase 3 (Release Pipeline) -- add tarball verification step before upload

---

### Pitfall 6: Installer Backup/Restore Does Not Cover All State Directories

**What goes wrong:**
The shell installer (`scripts/install.sh` lines 284-295) backs up: `tasks events memory state data logs memory.db memory-hnsw.dat .version`. But AOF's actual state includes:
- `Projects/` directory (the v1.1 multi-project layout with per-project tasks, events, memory)
- `org/org-chart.yaml` (the primary config file)
- `.aof/migrations.json` (migration history)
- Per-project `project.yaml` files
- Run artifacts in `state/` (lease files, heartbeat files)
- Views directory (`views/`)

If a user has migrated to the Projects layout (v1.1+), the installer backs up the old flat `tasks/` directory but NOT the `Projects/` tree. The tarball extraction overwrites the install directory, and the restore step only restores the listed directories -- everything else is lost.

**Why it happens:**
The installer was written for v1.0's flat directory structure. The v1.1 Projects migration added a new layout, but the installer's backup list was not updated.

**How to avoid:**
1. Back up the ENTIRE data directory, not a hardcoded list of subdirectories
2. Use an exclusion list instead of an inclusion list: back up everything except `node_modules/`, `dist/`, and other build artifacts
3. Extract the tarball to a SEPARATE staging directory, then selectively copy code files over the existing install (never overwrite the data root)
4. Add a `--dry-run` flag to the installer that shows what would be backed up and what would be overwritten

**Warning signs:**
- User reports "my projects disappeared after upgrade"
- `Projects/` directory is missing after upgrade
- `org-chart.yaml` reverted to a default template

**Phase to address:** Phase 2 (Upgrade Path) -- fix installer backup scope before shipping v1.3

---

### Pitfall 7: DAG-as-Default Breaks Existing Workflows That Rely on No-Workflow Behavior

**What goes wrong:**
Currently, new tasks do NOT get workflows unless explicitly requested (`workflow` parameter in `create()`). Making DAG workflows the default means every new task gets a workflow definition. But existing users have:
- Agents that create tasks without workflow awareness (they do not know about hop completion)
- Custom tooling that reads task frontmatter and does not expect a `workflow` field
- Automation scripts that check task status directly (not hop status)
- CLI workflows where tasks go `backlog -> ready -> in-progress -> done` without any hop advancement

If a task has a workflow, the scheduler tries to dispatch hops and expects agents to complete hops via the DAG protocol. An agent that simply marks a task "done" without completing the current hop will leave the workflow in an inconsistent state (task is done, but the DAG says "running" with a dispatched hop).

**Why it happens:**
"Default on" changes are the most dangerous kind of breaking change because they affect users who take no action. The change is invisible until something breaks.

**How to avoid:**
1. Make the default workflow opt-in at the project level, not at the task level: `project.yaml` gets a `defaultWorkflow: "standard-sdlc"` field that project owners explicitly set
2. Tasks created without a workflow continue to work as before (no hops, direct status transitions)
3. The upgrade documentation explicitly tells users "to enable DAG workflows for new tasks, add `defaultWorkflow` to your project.yaml"
4. Add a `--no-workflow` flag to task creation for users who want to override the project default
5. If a task has a workflow and an agent completes it without hop advancement, auto-advance the workflow (graceful degradation) rather than leaving it in an inconsistent state

**Warning signs:**
- Tasks stuck in `in-progress` with workflow status "running" but no hop ever completing
- Agents creating tasks and immediately completing them, bypassing the workflow entirely
- User complaints about "extra steps" in what used to be simple task flows

**Phase to address:** Phase 2 (Upgrade Path) -- define opt-in mechanism, not silent default change

---

### Pitfall 8: Rollback Cannot Undo Lazy Migrations That Were Written Back to Disk

**What goes wrong:**
The lazy gate-to-DAG migration in `task-store.ts` writes the migrated task back to disk atomically (line 252: `await writeFileAtomic(filePath, serializeTask(task))`). Once a task is lazily migrated, the original gate-format data is gone from the task file. If a user needs to roll back to a pre-v1.3 version:
- The task files now have `workflow` fields that old code does not understand
- The `gate` field has been set to `undefined` and `gateHistory` cleared to `[]`
- The old gate evaluator code (which was deprecated) may have been removed in the v1.3 release
- There is no backup of the pre-migration task content

The migration module (`src/projects/migration.ts`) creates backups for the vault migration, but the lazy gate-to-DAG migration creates NO backup of individual task files.

**Why it happens:**
Lazy migrations are designed for convenience ("migrate on next access") but they make rollback nearly impossible because:
1. There is no central record of which files were migrated
2. The migration happens during normal read operations -- no user action triggers it
3. Each migrated file overwrites its own previous state

**How to avoid:**
1. Before any lazy migration write-back, save the original task content to a `.migration-backup/` directory within the project
2. Record migrated task IDs in a manifest file (`.aof/migrated-tasks.json`) so rollback knows what to restore
3. Add a `aof rollback --to-version 1.2` command that:
   a. Checks the migration backup directory
   b. Restores original task files from backup
   c. Updates migration history
4. Alternatively, make the migration non-destructive: keep `gate` fields alongside `workflow` fields during a transition period, remove them only in v1.4

**Warning signs:**
- User rolls back to v1.2 and sees Zod validation errors on task files ("unrecognized key: workflow")
- Tasks with workflow fields fail to parse in older versions
- No way to determine which tasks were migrated vs. which were created as DAG-native

**Phase to address:** Phase 2 (Upgrade Path) -- add backup mechanism before lazy migration writes

---

### Pitfall 9: `getByPrefix()` Skips Lazy Migration, Creating Phantom Gate Tasks

**What goes wrong:**
The `get()` method in task-store.ts (line 240) runs the lazy gate-to-DAG migration, but `getByPrefix()` (line 276) does NOT. This means:
- Tasks accessed via prefix search retain their gate fields
- The same task can appear as gate-format or DAG-format depending on which method reads it
- If `getByPrefix()` is used to list tasks for a CLI view, users see stale gate fields
- If the scheduler uses `get()` to dispatch but the CLI uses `getByPrefix()` to display, the displayed state is inconsistent with actual state

**Why it happens:**
`getByPrefix()` was likely a convenience method added before the migration was implemented. The migration code was added to `get()` and `list()` but the prefix search was overlooked.

**How to avoid:**
1. Add the same lazy migration logic to `getByPrefix()` (simple fix)
2. Better: extract the migration-on-read logic into a shared `ensureMigrated(task)` helper and call it from all read paths
3. Add a test that verifies all public read methods produce identical task objects for the same task

**Warning signs:**
- Task appears differently in `aof task show TASK-xxx` (uses `get()`) vs `aof task show TASK` (uses `getByPrefix()`)
- Gate fields visible in some views but not others

**Phase to address:** Phase 1 (Config Migration) -- fix before any migration work begins

---

### Pitfall 10: Smoke Tests That Only Test Happy Path Miss the Real Upgrade Failures

**What goes wrong:**
Smoke tests for the upgrade path typically verify:
- Fresh install works
- Clean upgrade works (v1.2 with no tasks -> v1.3)
- Version file is written correctly

But the real failures happen in edge cases:
- Upgrade from v1.0 (pre-Projects layout) directly to v1.3
- Upgrade with in-flight tasks (tasks in `in-progress` with active leases)
- Upgrade with corrupted task files (partial YAML, missing frontmatter)
- Upgrade when `project.yaml` does not exist
- Upgrade when daemon is running (PID file exists, Unix socket active)
- Upgrade on a system where `npm ci` fails (network issues, native module build failures)
- Upgrade when disk space is low (backup succeeds, extraction fills disk)

**Why it happens:**
Smoke tests are written by developers who know the expected state. Real users have messy state accumulated over months of usage.

**How to avoid:**
1. Create a fixture set of "dirty" installation states:
   - v1.0 layout (flat `tasks/`, no `Projects/`)
   - v1.1 layout with gate-format tasks in every status
   - Mixed layout (some projects migrated, some not)
   - Tasks with malformed YAML frontmatter
   - Active leases and heartbeat files
2. Test upgrade against each fixture
3. Test rollback after upgrade against each fixture
4. Test upgrade with daemon running (should warn and stop, or fail gracefully)
5. Test upgrade with insufficient disk space (should fail before corrupting state)
6. Test the installer's `detect_existing_install()` function against all legacy paths

**Warning signs:**
- All smoke tests pass but first real user upgrade fails
- Tests use `beforeEach` cleanup that removes the messy state that causes real failures
- No test covers the v1.0-to-v1.3 skip-version upgrade path

**Phase to address:** Phase 4 (Smoke Tests) -- but fixture design should start in Phase 1

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Lazy-only migration (no eager pass) | Zero-cost upgrade for users who never access old tasks | Orphaned gate-format tasks when gate code is removed | Never acceptable for v1.3 if gate evaluator is being removed |
| Hardcoded backup directory list in installer | Simple shell script, easy to understand | Every new directory type requires installer update; missed directories lose data | Acceptable for v1.0-v1.1, must be fixed for v1.3 |
| `schemaVersion: z.literal(1)` | Simple validation, no version branching | Cannot distinguish file versions, cannot drive migration logic | Must be changed before v1.3 ships |
| Non-atomic config writes in migrations | Simpler migration code, fewer dependencies | Partial config writes on crash leave unrecoverable state | Never -- use `write-file-atomic` always |
| Migration history as flat JSON | Simple to read/write, human-inspectable | No locking, concurrent migrations can corrupt history file | Acceptable for v1.x (single-machine, single-process upgrades) |
| Dual gate/DAG code paths in scheduler | Backward compatibility during transition | Doubled maintenance surface, twice the bug surface, harder testing | Must converge to DAG-only in v1.3 |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Shell installer + Node.js setup | Installer assumes Node.js setup script exists at fixed path, but tarball layout might change | Pin the setup entry point path in a manifest file inside the tarball; installer reads it |
| GitHub Actions release + `release-it` | Both `.release-it.json` and `release.yml` have independent quality gates (`before:init` hooks vs. workflow steps) -- they can diverge | Single source of truth: let `release.yml` do all gating, or let `release-it` do all gating, not both |
| `write-file-atomic` + filesystem backups | Atomic write creates temp file then renames; if backup copies the temp file mid-write, backup contains incomplete data | Backup before upgrade, not during -- take snapshot when system is quiescent |
| OpenClaw plugin wiring + version upgrade | Plugin entry point path (`dist/plugin.js`) is hardcoded in `openclaw.plugin.json`; if build output structure changes, plugin loading breaks | Verify plugin loading as part of release smoke test |
| `yaml` npm package + config round-trips | `parse()` returns JS objects that lose comments/formatting; `parseDocument()` preserves them | Use `parseDocument()` for ANY file that users edit manually (org-chart.yaml, project.yaml) |
| Migration framework + concurrent scheduler | If scheduler is running during migration, it reads tasks via lazy migration while eager migration is also running -- race condition | Stop daemon before upgrade; installer should check for running daemon PID |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Eager migration scans all tasks at startup | Upgrade takes minutes on large installations (thousands of tasks) | Show progress bar; allow background migration with "migrating..." task status | >500 tasks |
| Lazy migration writes back on every read | Each `get()` call for an unmigrated task incurs a write; under scheduler polling this means write-per-poll for each gate task | Mark task as "migration checked" in memory (not disk) to avoid re-checking on subsequent reads within same process | >50 unmigrated gate tasks with frequent scheduler polls |
| Tarball extraction overwrites entire directory | On systems with slow disk I/O (NFS, remote mounts), extraction + npm install can take 5+ minutes during which the system is in a broken state | Extract to staging directory, then atomic swap via rename; or use rsync-style incremental copy | Any network-attached storage |
| Migration history JSON grows unbounded | After many versions and many migrations, `migrations.json` becomes large | Not a real concern for AOF (expect <100 migrations over product lifetime) | Never for this project |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Tarball downloaded over HTTP without integrity check | Man-in-the-middle could replace tarball with malicious payload | Add SHA256 checksum to GitHub release; installer verifies checksum before extraction |
| Migration scripts run with user permissions | If migration script has a bug that `rm -rf` wrong path, user data is destroyed | Migrations should NEVER delete data -- only copy/transform; original data stays in backup |
| Backup directories accumulate indefinitely | Old backups fill disk; backup names are predictable (`tasks.backup-<timestamp>`) | Auto-prune backups older than N days; limit to K most recent backups |
| `.version` file is world-readable | Minor: leaks installed version, could help attackers target known vulnerabilities | Not a real concern for local CLI tool; note for future multi-user deployments |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Silent migration with no user feedback | User runs `aof` after upgrade, sees no confirmation that migration happened; worries about data integrity | Print "Migrated X tasks from gate format to DAG format" on first run after upgrade |
| Upgrade requires daemon restart but does not prompt | Scheduler still running old code after code is updated; behavior is unpredictable | Installer checks for running daemon, stops it, restarts after upgrade (or warns user) |
| Rollback documentation exists but rollback command does not | User reads "rollback is safe" but has to manually restore files from backup directory | Provide `aof upgrade rollback` command that automates backup restoration |
| Version mismatch between CLI and daemon | User upgrades CLI but daemon was installed under OS supervisor (launchd/systemd) pointing to old path | After upgrade, automatically re-register daemon service file with updated paths |
| Config migration adds new required fields without defaults | `project.yaml` validation fails after upgrade because new field `workflowTemplates` is required | All new fields must have defaults or be optional; migration adds them with sensible defaults |

## "Looks Done But Isn't" Checklist

- [ ] **Config migration:** Often missing comment preservation -- verify `org-chart.yaml` diff shows ONLY logical changes, not reformatting
- [ ] **Gate-to-DAG migration:** Often missing `getByPrefix()` path -- verify all read methods return identical task objects
- [ ] **Installer backup:** Often missing new directory types -- verify `Projects/` tree is backed up on upgrade
- [ ] **Release tarball:** Often missing production install test -- verify `npm ci --production` succeeds on extracted tarball
- [ ] **Rollback:** Often missing lazy-migrated task restoration -- verify tasks can be read by v1.2 code after rollback
- [ ] **Schema version:** Often missing version bump in migration -- verify files have `schemaVersion: 2` after migration
- [ ] **Daemon lifecycle:** Often missing service file update -- verify launchd/systemd plist/unit points to new binary path after upgrade
- [ ] **Smoke tests:** Often missing dirty-state fixtures -- verify tests cover v1.0 layout, in-flight tasks, and corrupted files
- [ ] **Default workflow:** Often missing opt-in mechanism -- verify tasks created without explicit workflow still work as before
- [ ] **Migration history:** Often missing atomicity -- verify `migrations.json` is not corrupted if process crashes mid-migration

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Partial migration (crash mid-`up()`) | MEDIUM | 1. Check migration history for last successful migration. 2. Manually inspect filesystem for partially-written files. 3. Re-run migration (must be idempotent). 4. If not idempotent, restore from backup. |
| Lost YAML comments after config migration | LOW | 1. Restore `org-chart.yaml` from backup. 2. Re-apply migration using Document API. 3. Comments are recoverable from git history if backup was not taken. |
| Orphaned gate-format tasks after gate code removal | HIGH | 1. Must re-add gate migration code temporarily. 2. Run eager migration pass. 3. Verify all tasks converted. 4. Remove gate code again. **Prevention is far cheaper than recovery.** |
| Tarball missing critical files | LOW | 1. Delete extracted files. 2. Download correct tarball. 3. Re-run installer. Only affects time, not data. |
| Installer overwrites Projects/ directory | HIGH | 1. Check backup directory for Projects/ tree. 2. If not backed up, check OS-level snapshots (Time Machine, etc.). 3. If no backup exists, data is lost. **Prevention is essential.** |
| DAG-as-default breaks existing agents | MEDIUM | 1. Set `defaultWorkflow: null` in project.yaml to disable. 2. Tasks already created with unwanted workflows: manually remove `workflow` field from frontmatter. 3. Restart daemon. |
| Daemon running old code after upgrade | LOW | 1. `aof daemon stop`. 2. Re-install service: `aof daemon install`. 3. `aof daemon start`. Installer should automate this. |
| Migration history corrupted (invalid JSON) | LOW | 1. Delete `.aof/migrations.json`. 2. Manually verify which migrations are applied by inspecting file state. 3. Reconstruct history file. 4. Future: add migration state introspection command. |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Partial migration writes | Phase 1 (Config Migration) | Unit test: kill process mid-migration, re-run succeeds without data loss |
| Lazy migration silent failure | Phase 1 (Config Migration) | Integration test: task with gate fields + missing workflow config -> warning + explicit handling |
| YAML comment destruction | Phase 1 (Config Migration) | Diff test: migrate config file, verify only expected lines changed |
| Schema version stagnation | Phase 1 (Config Migration) | Schema test: v1.3 files have schemaVersion >= 2; old files with version 1 trigger migration |
| Tarball untested | Phase 3 (Release Pipeline) | CI step: extract tarball, `npm ci --production`, run CLI `--version` |
| Installer backup gaps | Phase 2 (Upgrade Path) | Integration test: create v1.1 layout with Projects/, upgrade, verify Projects/ preserved |
| DAG-as-default breakage | Phase 2 (Upgrade Path) | Behavior test: task created without workflow param still works with direct status transitions |
| Rollback impossible for lazy-migrated tasks | Phase 2 (Upgrade Path) | Round-trip test: upgrade, create tasks, rollback, verify v1.2 can read all tasks |
| `getByPrefix()` migration gap | Phase 1 (Config Migration) | Unit test: gate-format task accessed via prefix returns DAG-format task |
| Smoke test blind spots | Phase 4 (Smoke Tests) | Fixture matrix: v1.0 layout, v1.1 layout, mixed, corrupted, in-flight tasks |

## Sources

- Direct codebase analysis of `src/packaging/migrations.ts`, `src/store/task-store.ts`, `src/migration/gate-to-dag.ts`, `src/config/manager.ts`, `scripts/install.sh`, `.github/workflows/release.yml`, `scripts/build-tarball.mjs`
- [Discourse: How We Fixed YAML Comment Preservation in Ruby](https://blog.discourse.org/2026/02/how-we-fixed-yaml-comment-preservation-in-ruby-and-why-we-sponsored-it/) -- demonstrates YAML comment loss is a widespread, recognized problem
- [Oh My Posh: Config migration messes up things for YAML](https://github.com/JanDeDobbeleer/oh-my-posh/issues/5862) -- real-world example of YAML config migration destroying user files
- [Lazy Migration Pattern](https://softwarepatternslexicon.com/102/3/23/) -- tradeoff analysis of lazy vs eager migration strategies
- [CircleCI: Smoke testing in CI/CD pipelines](https://circleci.com/blog/smoke-tests-in-cicd-pipelines/) -- guidance on where smoke tests fit in release pipelines
- [The Hard Truth about GitOps and Database Rollbacks](https://atlasgo.io/blog/2024/11/14/the-hard-truth-about-gitops-and-db-rollbacks) -- partial migration failure modes and recovery strategies
- [The YAML Document from Hell](https://ruudvanasseldonk.com/2023/01/11/the-yaml-document-from-hell) -- YAML type coercion and format pitfalls

---
*Pitfalls research for: AOF v1.3 Seamless Upgrade -- upgrade/migration/release pipeline for filesystem-based CLI tool*
*Researched: 2026-03-03*
