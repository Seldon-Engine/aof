---
phase: 13-timeout-rejection-and-safety
plan: 02
subsystem: dispatch
tags: [dag, timeout, escalation, force-complete, one-shot, poll-cycle]

requires:
  - phase: 13-timeout-rejection-and-safety
    provides: "HopState.escalated field, dag.hop_timeout/dag.hop_timeout_escalation event types, parseDuration d-unit"
  - phase: 12-scheduler-integration
    provides: "dispatchDAGHop, DAG poll cycle dispatch, buildHopContext"
provides:
  - "checkHopTimeouts() function scanning dispatched hops against configured timeouts"
  - "escalateHopTimeout() with force-complete, re-dispatch to escalateTo role, one-shot rule"
  - "Poll cycle integration calling checkHopTimeouts alongside checkGateTimeouts"
affects: [13-rejection-runtime, 14-workflow-templates]

tech-stack:
  added: []
  patterns: ["DAG hop timeout mirroring gate timeout pattern", "escalation with force-complete then re-dispatch", "one-shot escalation flag preventing re-escalation loops"]

key-files:
  created: ["src/dispatch/__tests__/dag-timeout.test.ts"]
  modified: ["src/dispatch/escalation.ts", "src/dispatch/scheduler.ts"]

key-decisions:
  - "Escalation spawns new session directly from escalateHopTimeout (contained in escalation.ts, no dispatchDAGHop modification needed)"
  - "On spawn failure after force-complete, hop set to ready with escalated=true for poll cycle retry"
  - "No executor available with escalateTo configured: alert-only (cannot re-dispatch without executor)"

patterns-established:
  - "DAG hop timeout mirrors gate timeout pattern: scan dispatched hops, compare elapsed vs parseDuration, escalate or alert"
  - "One-shot escalation via HopState.escalated boolean prevents infinite escalation loops"

requirements-completed: [SAFE-03]

duration: 6min
completed: 2026-03-03
---

# Phase 13 Plan 02: Hop Timeout Checking and Escalation Summary

**checkHopTimeouts scanning dispatched DAG hops with one-shot escalation via force-complete and re-dispatch to escalateTo role**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-03T15:51:30Z
- **Completed:** 2026-03-03T15:57:55Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Implemented `checkHopTimeouts()` scanning all in-progress DAG tasks for dispatched hops exceeding their configured timeout
- Implemented `escalateHopTimeout()` with three paths: one-shot rule (alert only), no escalateTo (alert only), escalateTo configured (force-complete + re-dispatch)
- Integrated `checkHopTimeouts` call in scheduler poll() alongside existing `checkGateTimeouts`
- 19 comprehensive tests covering all behavior cases, edge cases, and dry-run mode

## Task Commits

Each task was committed atomically:

1. **Task 1: TDD RED -- failing tests** - `175ccfa` (test)
2. **Task 2: TDD GREEN -- implementation + scheduler integration** - `1f2a5f6` (feat)

_Note: TDD tasks have two commits (test -> feat). No refactor needed._

## Files Created/Modified
- `src/dispatch/__tests__/dag-timeout.test.ts` - 19 TDD tests for checkHopTimeouts and escalation behavior (new)
- `src/dispatch/escalation.ts` - Added checkHopTimeouts() and escalateHopTimeout() functions, imports for randomUUID, TaskContext, buildHopContext
- `src/dispatch/scheduler.ts` - Added checkHopTimeouts import and call in poll() after checkGateTimeouts

## Decisions Made
- Escalation spawns new session directly from `escalateHopTimeout` using `executor.spawnSession` rather than modifying `dispatchDAGHop` -- keeps changes contained to escalation.ts
- On spawn failure after force-complete, hop is set to `ready` status with `escalated=true` so standard poll cycle DAG dispatch can retry
- When no executor is available but escalateTo is configured, returns alert-only (cannot re-dispatch without executor)
- `buildHopContext` is reused for building hop context with role overridden to escalateTo

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Hop timeout checking and escalation complete
- Plan 13-03 (Rejection Runtime) can proceed independently
- All existing tests pass (542 dispatch tests, 2710+ total)
- No blockers for next plans

## Self-Check: PASSED

All 3 files verified present. Both commit hashes verified in git log.

---
*Phase: 13-timeout-rejection-and-safety*
*Completed: 2026-03-03*
