---
phase: 17-migration-foundation-framework-hardening
plan: 02
subsystem: packaging
tags: [migrations, yaml, parseDocument, gate-to-dag, channel-json, write-file-atomic, idempotent]

# Dependency graph
requires:
  - phase: 17-migration-foundation-framework-hardening
    provides: migration framework (runMigrations, MigrationContext), snapshot module, defaultWorkflow schema field
  - phase: 15-migration
    provides: migrateGateToDAG per-task converter, parseTaskFile/serializeTask
provides:
  - migration 001: defaultWorkflow population for project.yaml files (comment-preserving)
  - migration 002: batch gate-to-DAG conversion across all projects and status directories
  - migration 003: version metadata in .aof/channel.json for both fresh installs and upgrades
  - getAllMigrations() populated with three migrations in setup.ts
affects: [18-dag-as-default, 20-release]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "parseDocument() from yaml package for comment-preserving YAML edits in migrations"
    - "Idempotent migration pattern: check-before-act for safe re-runs"
    - "Direct file I/O in batch migrations (bypass store API to avoid side effects)"

key-files:
  created:
    - src/packaging/migrations/001-default-workflow-template.ts
    - src/packaging/migrations/002-gate-to-dag-batch.ts
    - src/packaging/migrations/003-version-metadata.ts
    - src/packaging/__tests__/migrations-impl.test.ts
  modified:
    - src/cli/commands/setup.ts

key-decisions:
  - "Used parseDocument() API with doc.get('workflowTemplates', true) and .items access for AST-level YAML editing preserving comments"
  - "Migration 002 reads project.yaml workflow config directly via parseYaml (not through store) to extract legacy gate definitions"
  - "Fresh installs run migration003 directly after wizard scaffolding for consistent channel.json across all install paths"

patterns-established:
  - "Migration file structure: named export of Migration object with id, version, description, up function"
  - "Project discovery: readdir Projects/ then check project.yaml existence per subdirectory"
  - "Batch task migration: walk all 8 STATUS_DIRS, parse each .md file, check guard conditions, mutate, write-file-atomic"

requirements-completed: [MIGR-04, CONF-01, CONF-02, CONF-03, CONF-04]

# Metrics
duration: 5min
completed: 2026-03-04
---

# Phase 17 Plan 02: Migration Implementations Summary

**Three idempotent v1.3 migrations -- defaultWorkflow via parseDocument, batch gate-to-DAG conversion, and channel.json version metadata -- wired into setup.ts getAllMigrations()**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-04T00:46:22Z
- **Completed:** 2026-03-04T00:51:33Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Created three migration files in src/packaging/migrations/ with correct IDs and version "1.3.0"
- Migration 001 uses parseDocument() for comment-preserving YAML edits and writeFileAtomic for writes
- Migration 002 reuses existing migrateGateToDAG() and converts all gate tasks across all projects/statuses
- Migration 003 writes channel.json for both fresh installs and upgrades with idempotent same-version skip
- getAllMigrations() returns all three migrations in order; fresh installs also write channel.json
- 10 comprehensive tests covering all migration behaviors and edge cases

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Add failing tests for three migrations** - `8841e65` (test)
2. **Task 1 (GREEN): Implement three migration files** - `77b5d59` (feat)
3. **Task 2: Wire migrations into getAllMigrations() in setup.ts** - `d18c391` (feat)

## Files Created/Modified
- `src/packaging/migrations/001-default-workflow-template.ts` - Migration adding defaultWorkflow to project.yaml files using parseDocument
- `src/packaging/migrations/002-gate-to-dag-batch.ts` - Migration batch-converting gate tasks to DAG across all projects
- `src/packaging/migrations/003-version-metadata.ts` - Migration writing channel.json version metadata
- `src/packaging/__tests__/migrations-impl.test.ts` - 10 tests covering all three migration implementations
- `src/cli/commands/setup.ts` - getAllMigrations() populated; fresh install path runs migration003

## Decisions Made
- Used `parseDocument()` with `doc.get("workflowTemplates", true)` to access AST nodes and `.items[0].key` for first template name -- avoids pitfall 2 from Research (AST nodes vs plain values)
- Migration 002 reads `project.yaml` via plain `parseYaml` to extract legacy gate config, then passes `WorkflowConfig` to `migrateGateToDAG` -- avoids importing through store API (anti-pattern from Research)
- Fresh installs call `migration003.up()` directly after wizard scaffolding to ensure channel.json exists on all install paths per CONTEXT.md decision

## Deviations from Plan

None -- plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All three v1.3 migrations are implemented and wired into the setup.ts migration runner
- Snapshot-based rollback from Plan 01 wraps around these migrations for crash safety
- Phase 18 (DAG-as-Default) can rely on migration 001 having set defaultWorkflow on all projects with templates
- Full test suite shows no regressions from these changes (pre-existing gate integration test failures unrelated)

## Self-Check: PASSED

All 5 files found, all 3 commits verified, all content markers confirmed present.

---
*Phase: 17-migration-foundation-framework-hardening*
*Completed: 2026-03-04*
