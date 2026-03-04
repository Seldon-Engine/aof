---
phase: 19-verification-smoke-tests
plan: 02
subsystem: testing
tags: [vitest, migrations, tarball, upgrade-paths, fixtures]

requires:
  - phase: 17-migration-framework
    provides: "Migration runner (runMigrations), individual migrations (001-003), wizard"
provides:
  - "Upgrade scenario test suite validating four install/upgrade paths"
  - "Tarball verification script for pre-release CI validation"
affects: [20-release]

tech-stack:
  added: []
  patterns: ["fixture-based integration testing with real migration runner", "CI tarball verification pipeline"]

key-files:
  created:
    - src/packaging/__tests__/upgrade-scenarios.test.ts
    - src/packaging/__tests__/__fixtures__/pre-v1.2-upgrade/Projects/demo/project.yaml
    - src/packaging/__tests__/__fixtures__/pre-v1.2-upgrade/Projects/demo/tasks/backlog/TASK-2026-01-01-001.md
    - src/packaging/__tests__/__fixtures__/v1.2-upgrade/Projects/demo/project.yaml
    - src/packaging/__tests__/__fixtures__/v1.2-upgrade/.aof/migrations.json
    - src/packaging/__tests__/__fixtures__/dag-default/Projects/demo/project.yaml
    - scripts/verify-tarball.mjs
  modified:
    - docs/guide/cli-reference.md

key-decisions:
  - "Pre-v1.2 fixture includes workflow.gates section for migration002 gate-to-DAG conversion"
  - "Fixtures force-added to git despite top-level Projects/ gitignore rule"
  - "Used npm ci --omit=dev instead of --production flag (modern npm convention)"

patterns-established:
  - "Fixture-based upgrade testing: static YAML fixtures + real migration runner in isolated temp dirs"
  - "Tarball verification: six-step pipeline (size, extract, files, npm ci, CLI boot, version match)"

requirements-completed: [VERF-02, VERF-03]

duration: 6min
completed: 2026-03-04
---

# Phase 19 Plan 02: Upgrade Scenarios & Tarball Verification Summary

**Four upgrade scenario tests exercising real migration runner against static YAML fixtures, plus six-check tarball verification script for CI**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-04T01:45:03Z
- **Completed:** 2026-03-04T01:51:42Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments
- Four upgrade scenario tests (fresh install, pre-v1.2, v1.2, DAG-default) all pass using real migration runner
- Static YAML fixtures represent realistic project states at each upgrade point
- Tarball verification script validates size, extraction, required files, npm ci, CLI boot, and version match
- No mocking of migration runner -- tests exercise the actual migration code path

## Task Commits

Each task was committed atomically:

1. **Task 1: Create upgrade scenario test suite with fixtures** - `1224078` (test)
2. **Task 2: Create tarball verification script** - `f91d8ed` (feat)

**Plan metadata:** (pending final docs commit)

_Note: Task 1 was TDD but tests passed immediately since migration code pre-exists_

## Files Created/Modified
- `src/packaging/__tests__/upgrade-scenarios.test.ts` - Four upgrade scenario tests using real migration runner
- `src/packaging/__tests__/__fixtures__/pre-v1.2-upgrade/` - Fixture with gate-based tasks, workflow.gates, workflowTemplates but no defaultWorkflow
- `src/packaging/__tests__/__fixtures__/v1.2-upgrade/` - Fixture with migrations 001+002 already applied in migrations.json
- `src/packaging/__tests__/__fixtures__/dag-default/` - Fixture with defaultWorkflow already configured
- `scripts/verify-tarball.mjs` - Standalone tarball verification script for CI
- `docs/guide/cli-reference.md` - Regenerated to include aof smoke command from plan 19-01

## Decisions Made
- Pre-v1.2 fixture includes both `workflow.gates` (for migration002) and `workflowTemplates` (for migration001) to represent a realistic pre-v1.2 project state
- Test fixtures force-added with `git add -f` since top-level `.gitignore` has `Projects/` rule that blocks fixture paths
- Used `npm ci --omit=dev` in tarball verification instead of deprecated `--production` flag

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added workflow.gates to pre-v1.2 fixture**
- **Found during:** Task 1 (upgrade scenario tests)
- **Issue:** Migration002 reads `workflow.gates` from project.yaml for gate-to-DAG conversion. Plan only specified `workflowTemplates` in the fixture, which migration002 does not read -- migration002 would have no gate config to use for conversion.
- **Fix:** Added `workflow.gates` section to pre-v1.2-upgrade fixture's project.yaml alongside existing workflowTemplates
- **Files modified:** src/packaging/__tests__/__fixtures__/pre-v1.2-upgrade/Projects/demo/project.yaml
- **Verification:** Pre-v1.2 upgrade test passes with 3 migrations applied, task converted from gate to DAG
- **Committed in:** 1224078 (Task 1 commit)

**2. [Rule 3 - Blocking] Regenerated CLI docs for pre-commit hook**
- **Found during:** Task 1 (commit phase)
- **Issue:** Pre-commit hook failed: CLI docs stale and `aof smoke` command undocumented (from plan 19-01)
- **Fix:** Ran `npm run docs:generate` to regenerate CLI reference including smoke command
- **Files modified:** docs/guide/cli-reference.md
- **Verification:** Pre-commit hook passes on all 4 checks
- **Committed in:** 1224078 (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both fixes necessary for correct test behavior and successful commit. No scope creep.

## Issues Encountered
- 28 pre-existing test failures in gate-metrics-integration, gate-transition-handler, task schema, and workflow-gate-integration test files. Confirmed these are pre-existing (same failures on commit before this plan). Not caused by this plan's changes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Verification infrastructure complete: upgrade scenarios tested, tarball verification script ready
- Phase 19 plans (01: smoke CLI, 02: upgrade tests + tarball) provide comprehensive pre-release validation
- Ready for Phase 20 (release)

## Self-Check: PASSED

All files verified present. All commits verified in git log.

---
*Phase: 19-verification-smoke-tests*
*Completed: 2026-03-04*
