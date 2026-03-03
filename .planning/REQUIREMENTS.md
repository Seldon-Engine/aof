# Requirements: AOF v1.3 Seamless Upgrade

**Defined:** 2026-03-03
**Core Value:** Tasks never get dropped -- they survive gateway restarts, API failures, rate limits, and agent crashes, always resuming and completing end-to-end without human intervention.

## v1.3 Requirements

Requirements for the seamless upgrade milestone. Each maps to roadmap phases.

### Migration Framework

- [ ] **MIGR-01**: Migration framework uses atomic writes (write-file-atomic) for all file mutations
- [ ] **MIGR-02**: Migration framework tracks in-progress state so interrupted migrations can be detected and resumed
- [ ] **MIGR-03**: Pre-migration snapshot captures full data directory before any migration runs, restores on failure
- [ ] **MIGR-04**: YAML config modifications preserve user comments and formatting (parseDocument API)
- [ ] **MIGR-05**: `schemaVersion` relaxed from `z.literal(1)` to support version 2 for migration versioning

### Config Migration

- [ ] **CONF-01**: Migration 001 adds `defaultWorkflow` field to project.yaml pointing to a sensible workflow template
- [ ] **CONF-02**: Migration 002 batch-converts all gate-based tasks to DAG workflows eagerly across all status directories
- [ ] **CONF-03**: Migration 003 writes version metadata to `.aof/channel.json` for upgrade tracking
- [ ] **CONF-04**: Migrations are wired into `setup.ts` `getAllMigrations()` and run automatically during installer upgrade

### Bug Fixes

- [ ] **BUGF-01**: `getByPrefix()` in task-store runs gate-to-DAG migration (same as `get()` and `list()`)
- [ ] **BUGF-02**: Installer backup scope includes `Projects/` directory tree (not just flat v1.0 data dirs)

### DAG Default

- [ ] **DAGD-01**: `bd create` auto-attaches the project's `defaultWorkflow` template when no `--workflow` flag is specified
- [ ] **DAGD-02**: `--no-workflow` flag on `bd create` allows opting out of the default workflow for bare tasks
- [ ] **DAGD-03**: Tasks created without a configured `defaultWorkflow` continue to work as bare tasks (graceful degradation)

### Verification

- [ ] **VERF-01**: `bd smoke` command runs post-install health checks (version, schema, task store, org chart, migration status, workflow templates)
- [ ] **VERF-02**: Upgrade smoke test suite validates fresh install, pre-v1.2 upgrade, v1.2 upgrade, and DAG default scenarios
- [ ] **VERF-03**: Tarball verification script validates extraction, `npm ci --production`, CLI boot, version match, and size check before release upload

### Release

- [ ] **RELS-01**: Release pipeline runs smoke tests between tarball build and GitHub Releases upload
- [ ] **RELS-02**: UPGRADING.md documents what changed, prerequisites, step-by-step upgrade, verification commands, and rollback via backup restore
- [ ] **RELS-03**: v1.3.0 release tagged and published with installer-downloadable tarball

## Future Requirements

Deferred to v1.4+. Tracked but not in current roadmap.

### Rollback CLI

- **ROLL-01**: `bd rollback` command lists available backups and restores a selected one
- **ROLL-02**: Automatic daemon stop/start around upgrade process

### Upgrade UX

- **UPGR-01**: `install.sh --dry-run` shows what would change without modifying anything
- **UPGR-02**: `bd migrations` command shows migration history and pending migrations
- **UPGR-03**: Automatic daemon restart after successful upgrade

## Out of Scope

| Feature | Reason |
|---------|--------|
| Auto-update mechanism | Deferred to v2 per PROJECT.md |
| In-place binary replacement | Impossible for Node.js runtime |
| Backward gate-from-DAG conversion | Rollback restores from backup instead |
| Multi-version coexistence | Rollback is the mechanism |
| Interactive migration wizard | Migrations must be automatic and deterministic |
| Dynamic workflow template variables | Deferred to v2 -- adds complexity for marginal value |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| MIGR-01 | Phase 17 | Pending |
| MIGR-02 | Phase 17 | Pending |
| MIGR-03 | Phase 17 | Pending |
| MIGR-04 | Phase 17 | Pending |
| MIGR-05 | Phase 17 | Pending |
| CONF-01 | Phase 17 | Pending |
| CONF-02 | Phase 17 | Pending |
| CONF-03 | Phase 17 | Pending |
| CONF-04 | Phase 17 | Pending |
| BUGF-01 | Phase 17 | Pending |
| BUGF-02 | Phase 17 | Pending |
| DAGD-01 | Phase 18 | Pending |
| DAGD-02 | Phase 18 | Pending |
| DAGD-03 | Phase 18 | Pending |
| VERF-01 | Phase 19 | Pending |
| VERF-02 | Phase 19 | Pending |
| VERF-03 | Phase 19 | Pending |
| RELS-01 | Phase 20 | Pending |
| RELS-02 | Phase 20 | Pending |
| RELS-03 | Phase 20 | Pending |

**Coverage:**
- v1.3 requirements: 20 total
- Mapped to phases: 20
- Unmapped: 0

---
*Requirements defined: 2026-03-03*
*Last updated: 2026-03-03 after roadmap creation*
