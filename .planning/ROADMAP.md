# Roadmap: AOF

## Milestones

- ✅ **v1.0 AOF Production Readiness** — Phases 1-3 (shipped 2026-02-26)
- ✅ **v1.1 Stabilization & Ship** — Phases 4-9 (shipped 2026-02-27)
- ✅ **v1.2 Task Workflows** — Phases 10-16 (shipped 2026-03-03)
- 🚧 **v1.3 Seamless Upgrade** — Phases 17-20 (in progress)

## Phases

<details>
<summary>✅ v1.0 AOF Production Readiness (Phases 1-3) — SHIPPED 2026-02-26</summary>

- [x] Phase 1: Foundation Hardening (2/2 plans) — completed 2026-02-26
- [x] Phase 2: Daemon Lifecycle (3/3 plans) — completed 2026-02-26
- [x] Phase 3: Gateway Integration (2/2 plans) — completed 2026-02-26

See: `.planning/milestones/v1.0-ROADMAP.md` for full details

</details>

<details>
<summary>✅ v1.1 Stabilization & Ship (Phases 4-9) — SHIPPED 2026-02-27</summary>

- [x] Phase 4: Memory Fix & Test Stabilization (3/3 plans) — completed 2026-02-26
- [x] Phase 5: CI Pipeline (2/2 plans) — completed 2026-02-26
- [x] Phase 6: Installer (2/2 plans) — completed 2026-02-26
- [x] Phase 7: Projects (3/3 plans) — completed 2026-02-26
- [x] Phase 8: Production Dependency Fix (1/1 plan) — completed 2026-02-26
- [x] Phase 9: Documentation & Guardrails (5/5 plans) — completed 2026-02-27

See: `.planning/milestones/v1.1-ROADMAP.md` for full details

</details>

<details>
<summary>✅ v1.2 Task Workflows (Phases 10-16) — SHIPPED 2026-03-03</summary>

- [x] Phase 10: DAG Schema Foundation (2/2 plans) — completed 2026-03-03
- [x] Phase 11: DAG Evaluator (2/2 plans) — completed 2026-03-03
- [x] Phase 12: Scheduler Integration (2/2 plans) — completed 2026-03-03
- [x] Phase 13: Timeout, Rejection, Safety (3/3 plans) — completed 2026-03-03
- [x] Phase 14: Templates, Ad-Hoc API, Artifacts (3/3 plans) — completed 2026-03-03
- [x] Phase 15: Migration and Documentation (3/3 plans) — completed 2026-03-03
- [x] Phase 16: Integration Wiring Fixes (1/1 plan) — completed 2026-03-03

See: `.planning/milestones/v1.2-ROADMAP.md` for full details

</details>

### 🚧 v1.3 Seamless Upgrade (In Progress)

**Milestone Goal:** Make the v1.2 DAG workflow system deployable with confidence -- upgrade path works end-to-end, DAGs become the default, release is cut and installable.

- [x] **Phase 17: Migration Foundation & Framework Hardening** - Harden the migration framework and implement all config/data migrations for the v1.2-to-v1.3 upgrade path (completed 2026-03-04)
- [x] **Phase 18: DAG-as-Default** - Make DAG workflows the default for new tasks via project-level configuration (completed 2026-03-04)
- [ ] **Phase 19: Verification & Smoke Tests** - Validate the entire upgrade path with automated smoke tests and a CLI health-check command
- [ ] **Phase 20: Release Pipeline, Documentation & Release Cut** - Gate the release on tarball verification, document the upgrade, cut v1.3.0

## Phase Details

### Phase 17: Migration Foundation & Framework Hardening
**Goal**: Users upgrading from pre-v1.2 or v1.2 installations get their config and task data migrated automatically, atomically, and safely -- with snapshot-based rollback on any failure
**Depends on**: Phase 16 (v1.2 complete)
**Requirements**: MIGR-01, MIGR-02, MIGR-03, MIGR-04, MIGR-05, CONF-01, CONF-02, CONF-03, CONF-04, BUGF-01, BUGF-02
**Success Criteria** (what must be TRUE):
  1. Running the installer upgrade on a pre-v1.2 data directory completes all three migrations (defaultWorkflow, gate-to-DAG batch, version metadata) without data loss or comment destruction in YAML files
  2. If a migration is interrupted mid-run (simulated crash), re-running the installer detects the incomplete state and resumes from where it left off rather than corrupting or duplicating work
  3. A pre-migration snapshot of the full data directory is created before any migration runs, and is restored automatically if any migration fails
  4. `bd list` and `bd get --prefix` both return DAG-migrated tasks consistently (no format divergence between access methods)
  5. `schemaVersion` field accepts version 2, and migrated installations carry version metadata in `.aof/channel.json`
**Plans:** 3/3 plans complete

Plans:
- [ ] 17-01-PLAN.md — Snapshot module, schema version relaxation, migration framework hardening
- [ ] 17-02-PLAN.md — Three migration implementations (defaultWorkflow, gate-to-DAG batch, version metadata)
- [ ] 17-03-PLAN.md — Bug fixes (getByPrefix gate-to-DAG, installer backup scope)

### Phase 18: DAG-as-Default
**Goal**: New tasks automatically use the project's configured workflow template, while bare tasks remain available for projects that have not configured a default
**Depends on**: Phase 17
**Requirements**: DAGD-01, DAGD-02, DAGD-03
**Success Criteria** (what must be TRUE):
  1. `bd create "task name"` in a project with a `defaultWorkflow` configured auto-attaches that workflow template to the new task (visible in `bd get`)
  2. `bd create --no-workflow "task name"` creates a bare task with no workflow, even when the project has a `defaultWorkflow` configured
  3. `bd create "task name"` in a project without a `defaultWorkflow` creates a bare task as before (no errors, no warnings, graceful degradation)
**Plans:** 1/1 plans complete

Plans:
- [ ] 18-01-PLAN.md — resolveDefaultWorkflow function, --no-workflow flag, three-way precedence in task create

### Phase 19: Verification & Smoke Tests
**Goal**: The upgrade path is validated end-to-end by automated tests that catch regressions in migration, installation, and DAG-default behavior before release
**Depends on**: Phase 18
**Requirements**: VERF-01, VERF-02, VERF-03
**Success Criteria** (what must be TRUE):
  1. `bd smoke` runs post-install health checks and reports pass/fail for version, schema, task store, org chart, migration status, and workflow templates
  2. An automated test suite exercises four upgrade scenarios (fresh install, pre-v1.2 upgrade, v1.2 upgrade, DAG-default behavior) and passes in CI
  3. A tarball verification script validates extraction, `npm ci --production`, CLI boot, version string match, and package size before any release upload
**Plans:** 1/2 plans executed

Plans:
- [ ] 19-01-PLAN.md — aof smoke CLI command with 6 health checks (version, schema, task store, org chart, migrations, workflows)
- [ ] 19-02-PLAN.md — Upgrade scenario test suite (4 scenarios) and tarball verification script

### Phase 20: Release Pipeline, Documentation & Release Cut
**Goal**: v1.3.0 is tagged, built, verified, and published with upgrade documentation so users can confidently install or upgrade
**Depends on**: Phase 19
**Requirements**: RELS-01, RELS-02, RELS-03
**Success Criteria** (what must be TRUE):
  1. The release pipeline runs smoke tests between tarball build and GitHub Releases upload -- a failing smoke test blocks the release
  2. UPGRADING.md exists and documents what changed, prerequisites, step-by-step upgrade instructions, verification commands, and rollback via backup restore
  3. v1.3.0 is tagged in git and published as a GitHub Release with an installer-downloadable tarball
**Plans**: TBD

Plans:
- [ ] 20-01: TBD
- [ ] 20-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 17 → 18 → 19 → 20

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation Hardening | v1.0 | 2/2 | Complete | 2026-02-26 |
| 2. Daemon Lifecycle | v1.0 | 3/3 | Complete | 2026-02-26 |
| 3. Gateway Integration | v1.0 | 2/2 | Complete | 2026-02-26 |
| 4. Memory Fix & Test Stabilization | v1.1 | 3/3 | Complete | 2026-02-26 |
| 5. CI Pipeline | v1.1 | 2/2 | Complete | 2026-02-26 |
| 6. Installer | v1.1 | 2/2 | Complete | 2026-02-26 |
| 7. Projects | v1.1 | 3/3 | Complete | 2026-02-26 |
| 8. Production Dependency Fix | v1.1 | 1/1 | Complete | 2026-02-26 |
| 9. Documentation & Guardrails | v1.1 | 5/5 | Complete | 2026-02-27 |
| 10. DAG Schema Foundation | v1.2 | 2/2 | Complete | 2026-03-03 |
| 11. DAG Evaluator | v1.2 | 2/2 | Complete | 2026-03-03 |
| 12. Scheduler Integration | v1.2 | 2/2 | Complete | 2026-03-03 |
| 13. Timeout, Rejection, Safety | v1.2 | 3/3 | Complete | 2026-03-03 |
| 14. Templates, Ad-Hoc API, Artifacts | v1.2 | 3/3 | Complete | 2026-03-03 |
| 15. Migration and Documentation | v1.2 | 3/3 | Complete | 2026-03-03 |
| 16. Integration Wiring Fixes | v1.2 | 1/1 | Complete | 2026-03-03 |
| 17. Migration Foundation & Framework Hardening | v1.3 | 3/3 | Complete | 2026-03-04 |
| 18. DAG-as-Default | v1.3 | 1/1 | Complete | 2026-03-04 |
| 19. Verification & Smoke Tests | 1/2 | In Progress|  | - |
| 20. Release Pipeline, Documentation & Release Cut | v1.3 | 0/2 | Not started | - |
