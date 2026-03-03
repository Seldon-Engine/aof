# Project Research Summary

**Project:** AOF v1.3 Seamless Upgrade and Release
**Domain:** CLI tool upgrade/migration/release pipeline for filesystem-based agent orchestration
**Researched:** 2026-03-03
**Confidence:** HIGH

## Executive Summary

AOF v1.3 is a hardening milestone, not a greenfield build. The existing codebase already contains every library, framework, and pattern needed -- zero new dependencies are required. The work is writing migration implementations for an already-built migration framework, wiring those migrations into an already-built installer flow, making DAG workflows the default through an already-existing template system, and validating the whole upgrade path with smoke tests using an already-configured vitest setup. The research consistently confirms that the infrastructure from v1.0-v1.2 was designed with this milestone in mind.

The recommended approach is a four-phase build: (1) write the migration implementations and harden the migration framework against partial-write failures, (2) wire migrations into the installer and implement rollback safety, (3) enable DAG-as-default in task creation and build smoke tests that validate the entire upgrade path, and (4) enhance the release pipeline with tarball verification and cut the release. This ordering follows the natural dependency chain: schema changes enable migrations, migrations enable the installer flow, the installer flow enables smoke testing, and smoke tests gate the release.

The primary risks are concentrated in Phases 1 and 2. The migration framework writes are not atomic (plain `fs.writeFile`, not `write-file-atomic`), the YAML config manager destroys comments on round-trip, the installer backup list misses the `Projects/` directory tree, and the lazy gate-to-DAG migration has a code path (`getByPrefix()`) that skips conversion entirely. All of these are known, bounded problems with clear fixes identified in the research. The most dangerous pitfall is making DAG-as-default a silent behavioral change -- it must be opt-in at the project level via `defaultWorkflow` in `project.yaml`, not a code-level flag flip.

## Key Findings

### Recommended Stack

No new dependencies. The existing stack covers every v1.3 requirement. This is the strongest possible signal that the v1.2 architecture was well-designed.

**Core technologies (all existing, verified from node_modules):**
- **yaml 2.8.2**: YAML parse/stringify -- use `parseDocument()` API (not `parse()`) for config migration to preserve comments
- **zod 3.25.76**: Schema validation -- extend `ProjectManifest` with `defaultWorkflow` field, relax `schemaVersion` from `z.literal(1)` to allow version 2
- **vitest 3.2.4**: Test runner -- add dedicated upgrade smoke test config with `pool: "forks"`, `bail: 1`, 30s timeout
- **release-it 19.2.4**: Release pipeline -- extend `before:init` hooks with `test:upgrade`, add `after:bump` tarball verification
- **write-file-atomic 7.x**: Atomic file writes -- must be used in ALL migration `up()` functions (currently only used in task-store)
- **Node.js 22 (pinned)**: Runtime -- sufficient, no version change needed

**What NOT to add:** semver, fs-extra, shellspec/bats, umzug, semantic-release, ajv, deep-diff, inquirer (all evaluated and rejected with clear rationale in STACK.md).

### Expected Features

**Must have (table stakes):**
1. **Config migration: `defaultWorkflow` field** -- enables DAG-as-default; foundation for everything else
2. **Eager gate-to-DAG batch migration** -- eliminates dual code path; lazy migration alone is insufficient
3. **Project manifest migration** -- converts `workflow.gates` to `workflowTemplates` at project level
4. **Upgrade smoke tests** -- `bd smoke` command + CI smoke steps; fast (<10s), critical-path, fail-loud
5. **Version-aware installer** -- pass `--from-version` to setup, trigger migrations, verify result
6. **Rollback safety** -- single `bd rollback` command; backup retention (last 2); migration `down()` reversal
7. **Release pipeline pre-flight** -- tarball extraction + `npm ci --production` + CLI boot test before upload
8. **DAG-as-default in `bd create`** -- auto-attach `defaultWorkflow` template; `--no-workflow` opt-out
9. **Upgrade documentation** -- UPGRADING.md covering what changed, how to verify, how to rollback

**Should have (differentiators):**
- Dry-run upgrade (`install.sh --dry-run`) -- LOW complexity, high trust signal
- Migration audit trail (`bd migrations` command) -- LOW complexity, `.aof/migrations.json` already exists
- Automatic daemon restart after upgrade -- LOW complexity, existing daemon lifecycle commands
- Canary task creation in smoke tests -- MEDIUM complexity, exercises full task lifecycle

**Defer (anti-features, explicitly do NOT build):**
- Auto-update mechanism (deferred to v2 per PROJECT.md)
- In-place binary replacement (impossible for Node.js)
- Backward gate-from-DAG conversion (rollback restores from backup instead)
- Multi-version coexistence (rollback is the mechanism)
- Interactive migration wizard (migrations must be automatic and deterministic)

### Architecture Approach

The upgrade surface area spans three coordinating layers: shell installer (backup/extract/delegate), Node.js setup (branch on fresh/upgrade/legacy, run migration registry), and runtime (lazy task-level migration). The critical architectural decision is that config migration belongs in the **migration registry** (`getAllMigrations()` in setup.ts), not in the lazy task-store path. The registry runs once at upgrade time, has access to the full filesystem, tracks history, and supports `down()` reversal. The lazy gate-to-DAG migration in task-store.ts remains as a complementary safety net for individual tasks.

**Major components (new + modified):**
1. **Migration implementations** (3 new files) -- `001-default-workflow-template`, `002-deprecate-gate-config`, `003-version-metadata`
2. **Pre-migration snapshot** (new `snapshot.ts`) -- full data dir backup before any migration runs; restore on any failure
3. **`store.create()` default workflow** (modified) -- `loadDefaultWorkflowTemplate()` with graceful degradation to taskless
4. **CLI `--no-workflow` flag** (modified) -- opt-out of project-level default workflow
5. **Smoke test suite** (new `tests/upgrade/`) -- fixture-based: fresh install, upgrade, DAG default, rollback
6. **Tarball verification** (new `scripts/verify-tarball.mjs`) -- extract, `npm ci --production`, CLI boot, size check
7. **Release pipeline** (modified `release.yml`) -- smoke test steps between tarball build and upload

**Unchanged components (explicitly):** scheduler, dag-evaluator, dag-transition-handler, gate-to-dag.ts, install.sh (shell portion), updater.ts, channels.ts.

### Critical Pitfalls

1. **Partial migration writes corrupt filesystem state** -- Migration `up()` functions use plain `fs.writeFile`, not `write-file-atomic`. A crash mid-migration leaves partially-written YAML files that cannot be parsed. FIX: Use `write-file-atomic` for ALL migration writes; make every migration idempotent with state checks before acting.

2. **YAML round-trip destroys comments and formatting** -- `parseYaml()` returns plain JS objects; `stringifyYaml()` rebuilds from scratch, losing all comments, key order, and quoting style. FIX: Use `yaml.parseDocument()` API for all config file modifications during migration. Already available in yaml@2.8.2.

3. **`getByPrefix()` skips lazy migration** -- `get()` and `list()` run gate-to-DAG conversion, but `getByPrefix()` does not. Same task appears in different formats depending on access method. FIX: Extract migration logic into shared `ensureMigrated()` helper; call from all read paths.

4. **Installer backup misses `Projects/` directory** -- install.sh backs up a hardcoded list of flat directories from v1.0 layout. The v1.1+ `Projects/` tree (with per-project tasks, events, memory) is not backed up. FIX: Back up the entire data directory with an exclusion list instead of an inclusion list.

5. **DAG-as-default silently breaks workflow-unaware agents** -- Making workflows default means every new task gets DAG hops. Agents that mark tasks "done" without hop advancement leave workflows inconsistent. FIX: Default workflow is opt-in at project level (`defaultWorkflow` in project.yaml), not a code-level flag flip. Tasks without workflow still work exactly as before.

6. **`schemaVersion: z.literal(1)` blocks version progression** -- No way to distinguish pre-v1.3 files from v1.3 files. FIX: Relax to `z.union([z.literal(1), z.literal(2)])` and bump to 2 during migration.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Migration Foundation and Framework Hardening

**Rationale:** Every downstream feature depends on the migration framework working correctly and the schema changes being in place. The framework itself has known deficiencies (non-atomic writes, no idempotency guarantees) that must be fixed before writing production migrations.

**Delivers:**
- Hardened migration framework (atomic writes, idempotency checks, in-progress tracking)
- Schema changes: `defaultWorkflow` field on ProjectManifest, `schemaVersion` relaxed to allow version 2
- Migration `001-default-workflow-template`: adds default workflowTemplate to project.yaml
- Migration `002-deprecate-gate-config`: converts `workflow.gates` to `workflowTemplates`
- Migration `003-version-metadata`: writes `.aof/channel.json` with version + channel
- Pre-migration snapshot utility (`snapshot.ts`)
- Test fixtures for upgrade paths (pre-v1.2, v1.2-clean)
- Fix: `getByPrefix()` migration gap
- Fix: YAML comment preservation via `parseDocument()` API

**Addresses features:** Table stakes 1-3 (config migration, batch gate-to-DAG, project manifest migration)
**Avoids pitfalls:** Partial writes (#1), YAML comment destruction (#3), `getByPrefix()` gap (#9), schema version stagnation (#4)

### Phase 2: Installer Integration and Rollback Safety

**Rationale:** Migrations are dead code until the installer triggers them. The installer itself has a known backup gap (`Projects/` directory missing from backup list) that must be fixed before shipping any upgrade path.

**Delivers:**
- Wired migrations into `setup.ts` `getAllMigrations()` with pre-migration snapshot/restore
- Fixed installer backup scope (exclusion-based, not inclusion-based)
- `bd rollback` command with backup listing and restoration
- Backward-compatible data format (keep `gate` fields alongside `workflow` for one version)
- Daemon stop/start around upgrade
- Version tracking synchronization (`.version`, `package.json`, `channel.json`)

**Addresses features:** Table stakes 5-6 (version-aware installer, rollback safety)
**Avoids pitfalls:** Installer backup gaps (#6), rollback impossible for lazy-migrated tasks (#8), DAG-as-default breakage (#7)

### Phase 3: DAG-as-Default and Smoke Tests

**Rationale:** This is the user-visible outcome of v1.3. DAG-as-default is safe to implement only after migrations are wired and rollback is available. Smoke tests validate everything built in Phases 1-2.

**Delivers:**
- Modified `store.create()` to load default workflow template with graceful degradation
- `--no-workflow` flag on `bd create` and MCP `aof_task_create`
- `bd smoke` command with 7 verification checks (version, schema, task store, org chart, migration completeness, daemon, workflow templates)
- Upgrade smoke test suite (vitest, fixture-based, tmpdir isolation)
- Test coverage: fresh install, pre-v1.2 upgrade, v1.2 upgrade, DAG default, rollback round-trip

**Addresses features:** Table stakes 4, 8 (smoke tests, DAG-as-default)
**Avoids pitfalls:** Smoke test blind spots (#10), DAG-as-default breakage (#7)

### Phase 4: Release Pipeline, Documentation, and Release Cut

**Rationale:** Final validation and packaging. Must be last because it tests the complete integrated flow. The release pipeline gates on everything being correct.

**Delivers:**
- `scripts/verify-tarball.mjs`: extract tarball, `npm ci --production`, CLI boot, version match, size check, SHA256 checksum
- Updated `.release-it.json` hooks: `test:upgrade` in `before:init`, `verify-tarball.mjs` in `after:bump`
- Updated `.github/workflows/release.yml`: smoke test steps between tarball build and upload
- Upgrade simulation in CI: install previous tarball, create gate tasks, install new build, verify upgrade
- `UPGRADING.md`: what changed, prerequisites, step-by-step, verification, rollback, known issues
- Changelog from conventional commits (existing)
- Cut v1.3.0 release tag

**Addresses features:** Table stakes 7, 9 (release pipeline, documentation)
**Avoids pitfalls:** Untested tarball (#5)

### Phase Ordering Rationale

- **Schema changes before migrations:** Migrations depend on the `defaultWorkflow` field and relaxed `schemaVersion` existing in the Zod schema.
- **Migrations before installer wiring:** `getAllMigrations()` must return actual migration objects before `runSetup()` calls `runMigrations()`.
- **Installer before DAG-as-default:** Users must have a working upgrade path before the default behavior changes.
- **Rollback before DAG-as-default:** Safety net must exist before a potentially breaking behavioral change ships.
- **Smoke tests alongside DAG-as-default:** Smoke tests validate the combined effect of migrations + installer + default workflow.
- **Release pipeline last:** It tests the complete flow, so everything must be built first.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1:** Migration idempotency patterns -- the "in-progress" tracking mechanism needs design work; the breadcrumb approach vs. status field approach should be decided during phase planning.
- **Phase 2:** Installer backup refactor -- changing from inclusion to exclusion list in install.sh requires understanding all possible directory layouts across v1.0/v1.1/v1.2 installs. May need `/gsd:research-phase`.
- **Phase 2:** Backward-compatible data format -- keeping `gate` fields alongside `workflow` fields needs careful schema design to avoid Zod `.strict()` validation failures.

Phases with standard patterns (skip research-phase):
- **Phase 3:** DAG-as-default is a straightforward conditional lookup in `store.create()` -- the template resolution infrastructure already exists in `resolveWorkflowTemplate()`.
- **Phase 3:** Smoke tests follow established vitest e2e patterns already used in `src/packaging/__tests__/migrations.test.ts`.
- **Phase 4:** Release pipeline changes are additive hooks in well-documented tools (release-it, GitHub Actions).

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All versions verified from installed `node_modules`; zero new dependencies needed |
| Features | HIGH | 9 table stakes derived from direct codebase analysis + industry patterns (Terraform, Snyk, rustup, AWS Builders Library) |
| Architecture | HIGH | Every integration point mapped via direct source code inspection; dependency graph fully traced |
| Pitfalls | HIGH | 10 pitfalls identified from direct codebase analysis; 6 confirmed via existing code patterns, 4 confirmed via external sources |

**Overall confidence:** HIGH

All four research files are based primarily on direct inspection of the AOF codebase, not external speculation. The existing migration framework, installer, task store, and release pipeline were all read and analyzed. External sources (Terraform version management, Snyk smoke tests, AWS rollback safety, YAML comment preservation) corroborate the patterns but are secondary to the codebase findings.

### Gaps to Address

- **Migration rollback granularity:** The existing framework supports per-migration `down()`, but there is no tested pattern for rolling back migration N while keeping migrations 1 through N-1. The framework code suggests it should work (reverse-order execution), but this needs validation during Phase 1 implementation.
- **Dynamic workflow template variables:** The architecture research identified a desire for `${routing.role}` style variables in default templates, but recommended deferring to v2. If stakeholders want this for v1.3, it adds complexity to Phase 3.
- **Multi-project upgrade path:** The research assumes single-project installations. Multi-project installations (multiple `project.yaml` files under `Projects/`) need each project migrated independently. The migration framework context needs to support iterating over projects.
- **Daemon lifecycle during upgrade:** The research notes that the daemon should be stopped before upgrade and restarted after, but the exact mechanism (PID file check, health endpoint probe, launchd/systemd service detection) was not fully specified. Phase 2 planning should address this.

## Sources

### Primary (HIGH confidence)
- AOF migration framework: `src/packaging/migrations.ts` -- up/down lifecycle, version comparison, history tracking
- AOF setup orchestrator: `src/cli/commands/setup.ts` -- fresh/upgrade/legacy branching, `getAllMigrations()` returns `[]`
- AOF task store: `src/store/task-store.ts` -- lazy gate-to-DAG migration, `getByPrefix()` gap
- AOF gate-to-DAG: `src/migration/gate-to-dag.ts` -- per-task conversion logic
- AOF shell installer: `scripts/install.sh` -- prerequisite checks, backup list, tarball extraction
- AOF project schema: `src/schemas/project.ts` -- `workflowTemplates` optional, no `defaultWorkflow`
- AOF config schema: `src/schemas/config.ts` -- `schemaVersion: z.literal(1)`
- AOF release workflow: `.github/workflows/release.yml` -- tag-triggered CI
- AOF tarball builder: `scripts/build-tarball.mjs` -- staging, package.json stripping
- AOF config manager: `src/config/manager.ts` -- `stringifyYaml` loses comments

### Secondary (MEDIUM confidence)
- [Terraform version management](https://developer.hashicorp.com/terraform/tutorials/configuration-language/versions) -- additive schema migration pattern
- [Snyk CLI smoke tests](https://github.com/snyk/cli/blob/main/test/smoke/README.md) -- post-install verification pattern
- [AWS Builders Library: Ensuring Rollback Safety](https://aws.amazon.com/builders-library/ensuring-rollback-safety-during-deployments/) -- backward-compatible data formats, one-version rollback window
- [rustup self-update](https://rust-lang.github.io/rustup/basics.html) -- version pinning, channel management
- [CircleCI smoke testing guide](https://circleci.com/blog/smoke-tests-in-cicd-pipelines/) -- fast critical-path verification

### Tertiary (LOW confidence)
- [Discourse YAML comment preservation](https://blog.discourse.org/2026/02/how-we-fixed-yaml-comment-preservation-in-ruby-and-why-we-sponsored-it/) -- confirms comment loss is a recognized ecosystem problem
- [Oh My Posh YAML migration issue](https://github.com/JanDeDobbeleer/oh-my-posh/issues/5862) -- real-world example of config migration destroying user files

---
*Research completed: 2026-03-03*
*Ready for roadmap: yes*
