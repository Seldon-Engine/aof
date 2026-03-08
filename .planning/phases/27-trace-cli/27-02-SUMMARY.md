---
phase: 27-trace-cli
plan: 02
subsystem: cli
tags: [commander, cli, trace, dag, workflow, tdd]

# Dependency graph
requires:
  - phase: 27-trace-cli
    plan: 01
    provides: "readTraceFiles(), formatTraceSummary/Debug/Json(), HopInfo interface"
provides:
  - "registerTraceCommand() wiring trace reader+formatter into CLI"
  - "buildHopMap() for DAG workflow hop correlation"
  - "aof trace <task-id> with --debug, --json, --project options"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [command-registration, dynamic-import-project-utils, static-import-pure-modules]

key-files:
  created:
    - src/cli/commands/trace.ts
    - src/cli/commands/__tests__/trace.test.ts
  modified:
    - src/cli/program.ts

key-decisions:
  - "Static imports for trace reader/formatter (pure modules), dynamic import only for project-utils (heavy store dependency)"
  - "buildHopMap uses correlationId-first strategy with sequential fallback when no correlationIds present"
  - "Unmatched traces grouped under 'unassigned' pseudo-hop rather than silently dropped"

patterns-established:
  - "Command registration: static import in program.ts, registerXCommand(program) call"
  - "Hop correlation: correlationId match preferred, sequential fallback, unassigned overflow"

requirements-completed: [PRES-01, PRES-02, PRES-03, PRES-04]

# Metrics
duration: 5min
completed: 2026-03-07
---

# Phase 27 Plan 02: Trace CLI Command Summary

**CLI `aof trace <task-id>` command with summary/debug/JSON modes and DAG workflow hop correlation via buildHopMap**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-08T03:52:31Z
- **Completed:** 2026-03-08T03:57:13Z
- **Tasks:** 2 (1 TDD + 1 registration)
- **Files modified:** 3

## Accomplishments
- `aof trace <task-id>` shows human-readable summary of agent activity
- `--debug` flag shows full tool call details and reasoning text
- `--json` flag outputs valid JSON to stdout with errors to stderr only
- DAG workflow tasks get per-hop trace grouping via correlationId or sequential fallback
- Short task ID prefix resolution via getByPrefix
- 13 tests covering all output modes, error paths, and hop correlation

## Task Commits

Each task was committed atomically:

1. **Task 1: Trace CLI command with DAG hop correlation** - `b428a44` (feat, TDD)
2. **Task 2: Register trace command in program.ts** - `5c3e0de` (feat)

_TDD: Tests and implementation committed together._

## Files Created/Modified
- `src/cli/commands/trace.ts` - registerTraceCommand() with buildHopMap() for workflow hop correlation
- `src/cli/commands/__tests__/trace.test.ts` - 13 tests for command action, error handling, and buildHopMap logic
- `src/cli/program.ts` - Added trace command import and registration

## Decisions Made
- Static imports for trace reader/formatter (pure modules with no side effects), dynamic import only for project-utils (follows existing pattern for heavy store dependency)
- buildHopMap correlates via correlationId first, falls back to sequential ordering when no correlationIds present on any hop
- Unmatched traces grouped under "unassigned" pseudo-hop to avoid silently dropping data
- Mock return values set in beforeEach rather than vi.mock factory for reliable vitest ESM mock behavior

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- vi.mock factory return values not propagating to dynamic imports in vitest ESM mode; resolved by using static imports for pure trace modules and setting mock return values in beforeEach

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 27 (Trace CLI) is now complete -- all plans executed
- Full trace pipeline operational: capture (Phase 26) -> read -> format -> CLI display
- 2975 tests passing across full suite

---
*Phase: 27-trace-cli*
*Completed: 2026-03-07*
