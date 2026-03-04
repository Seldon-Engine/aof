---
phase: 19-verification-smoke-tests
plan: 01
subsystem: cli
tags: [smoke-test, health-check, commander, zod, validation]

# Dependency graph
requires:
  - phase: 17-migration-framework
    provides: "getMigrationHistory() for migration status check"
  - phase: 18-dag-as-default
    provides: "workflowTemplates and defaultWorkflow fields in ProjectManifest"
provides:
  - "aof smoke CLI command for post-install health verification"
  - "runSmokeChecks() composable runner for programmatic use"
  - "6 individual health checks (version, schema, task store, org chart, migration, workflow)"
affects: [19-verification-smoke-tests, 20-release]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Smoke check runner composing existing Zod schemas and file readers"]

key-files:
  created:
    - src/cli/commands/smoke.ts
    - src/cli/commands/__tests__/smoke.test.ts
  modified:
    - src/cli/commands/system.ts

key-decisions:
  - "Inlined version read instead of importing from setup.ts (not exported, trivial logic)"
  - "Each check independent -- one failure does not prevent others from running"
  - "Org chart and Projects directory treated as optional (pass when absent)"

patterns-established:
  - "Smoke check pattern: SmokeCheck interface with name + run function returning SmokeResult"
  - "ANSI checklist output pattern matching setup.ts conventions"

requirements-completed: [VERF-01]

# Metrics
duration: 4min
completed: 2026-03-04
---

# Phase 19 Plan 01: Smoke Check Command Summary

**`aof smoke` CLI command with 6 health checks (version, schema, task store, org chart, migration, workflow templates) composing existing Zod validators and file readers**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-04T01:44:54Z
- **Completed:** 2026-03-04T01:48:49Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Implemented 6 independent health checks covering all VERF-01 requirements
- Registered `aof smoke` command in CLI, visible in `aof --help`
- 9 unit tests covering all check categories plus edge cases (empty dir, missing files, malformed YAML)
- Command exits 0 on all-pass, 1 on any failure -- suitable for CI pipelines

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Failing smoke tests** - `91e79b1` (test)
2. **Task 1 (GREEN): Smoke check runner implementation** - `4e900f7` (feat)
3. **Task 2: Register smoke command in CLI** - `d9a40c9` (feat)

## Files Created/Modified
- `src/cli/commands/smoke.ts` - Smoke check runner with 6 checks and CLI registration (208 lines)
- `src/cli/commands/__tests__/smoke.test.ts` - Unit tests for all smoke check categories (229 lines)
- `src/cli/commands/system.ts` - Added registerSmokeCommand import and call

## Decisions Made
- Inlined the trivial version read (JSON.parse package.json) rather than importing the private `readPackageVersion` from setup.ts -- avoids coupling to a non-exported function
- Each check runs independently and returns its own SmokeResult -- no short-circuiting on failure
- Org chart check passes when no org chart exists (optional component)
- Task store check requires at least one project with a tasks directory to pass
- Workflow check validates that defaultWorkflow references exist in workflowTemplates

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Smoke command is registered and functional
- Ready for plan 19-02 (upgrade scenario tests and tarball verification)
- `runSmokeChecks()` is exported for programmatic use in future integration tests

## Self-Check: PASSED

All files exist, all commits verified.

---
*Phase: 19-verification-smoke-tests*
*Completed: 2026-03-04*
