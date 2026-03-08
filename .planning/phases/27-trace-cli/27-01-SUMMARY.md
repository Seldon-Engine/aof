---
phase: 27-trace-cli
plan: 01
subsystem: trace
tags: [vitest, zod, tdd, cli, trace, formatter]

# Dependency graph
requires:
  - phase: 26-trace-infra
    provides: "TraceSchema, trace-writer, session-parser"
provides:
  - "readTraceFiles() for loading trace-N.json from task directories"
  - "formatTraceSummary(), formatTraceDebug(), formatTraceJson() presentation functions"
  - "formatDuration() helper"
  - "HopInfo interface for DAG hop grouping"
affects: [27-trace-cli]

# Tech tracking
tech-stack:
  added: []
  patterns: [pure-function-formatters, reader-formatter-separation]

key-files:
  created:
    - src/trace/trace-reader.ts
    - src/trace/trace-formatter.ts
    - src/trace/__tests__/trace-reader.test.ts
    - src/trace/__tests__/trace-formatter.test.ts
  modified: []

key-decisions:
  - "Reader and formatter are fully separated -- reader does I/O, formatter is pure functions"
  - "Corrupted trace files are silently skipped, not thrown"
  - "Single trace in JSON mode returns object, multiple returns array"

patterns-established:
  - "Reader-formatter separation: I/O in reader, pure presentation in formatter"
  - "Trace file pattern: /^trace-\\d+\\.json$/ with numeric sorting"

requirements-completed: [PRES-01, PRES-02, PRES-03, PRES-04]

# Metrics
duration: 2min
completed: 2026-03-07
---

# Phase 27 Plan 01: Trace Reader and Formatter Summary

**Pure trace-reader and three-mode formatter (summary/debug/JSON) with DAG hop grouping via TDD -- 31 tests, all passing**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-08T03:47:19Z
- **Completed:** 2026-03-08T03:49:46Z
- **Tasks:** 2 (TDD features)
- **Files modified:** 4

## Accomplishments
- readTraceFiles() loads, validates, and sorts trace-N.json files with silent error handling
- Three formatting modes: summary (human-readable), debug (full detail with reasoning), JSON (machine-readable)
- DAG workflow support via optional hopMap parameter for grouped hop display
- formatDuration() helper converting ms to human-readable time strings
- 31 tests covering all modes, edge cases, and DAG grouping

## Task Commits

Each task was committed atomically:

1. **Feature 1: Trace Reader** - `755f088` (feat)
2. **Feature 2: Trace Formatter** - `30bf89d` (feat)

_TDD: Tests and implementation committed together per feature._

## Files Created/Modified
- `src/trace/trace-reader.ts` - Reads trace-N.json files from task directory, validates with TraceSchema
- `src/trace/trace-formatter.ts` - Pure formatting functions for summary, debug, and JSON modes
- `src/trace/__tests__/trace-reader.test.ts` - 7 tests for reader edge cases
- `src/trace/__tests__/trace-formatter.test.ts` - 24 tests for all formatter modes and DAG grouping

## Decisions Made
- Reader and formatter fully separated: reader handles I/O, formatter is pure functions (no side effects)
- Corrupted trace files silently skipped rather than thrown (defensive read)
- Single trace in JSON mode returns an object; multiple returns an array
- Summary-mode warning appended in debug output when trace was captured in summary mode

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Reader and formatter ready for CLI command integration (Plan 02)
- HopInfo interface ready for DAG workflow trace display
- All exports documented and tested

---
*Phase: 27-trace-cli*
*Completed: 2026-03-07*
