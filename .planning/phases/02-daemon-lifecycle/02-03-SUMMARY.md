---
phase: 02-daemon-lifecycle
plan: 03
subsystem: daemon
tags: [cli, status-table, drain-progress, watchdog, exit-codes, launchd, systemd]

# Dependency graph
requires:
  - phase: 02-daemon-lifecycle
    plan: 01
    provides: "Unix socket health server with /status endpoint, HealthStatus interface"
  - phase: 02-daemon-lifecycle
    plan: 02
    provides: "Service file generation with KeepAlive/Restart config, install/uninstall CLI"
provides:
  - "formatStatusTable() for human-readable daemon status display"
  - "aof daemon status --json for raw JSON output"
  - "aof daemon stop with drain progress countdown and OS supervisor integration"
  - "Exit code 2 for not-running daemon (stop and status)"
  - "DAEM-05 watchdog verification: service files configure OS restart, E2E script"
affects: [05-install]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure formatter functions (formatStatusTable, formatDegradedStatus) for testable CLI output"
    - "OS supervisor stop before direct SIGTERM (launchctl bootout / systemctl stop)"
    - "Drain progress polling at 500ms with 2s status messages"

key-files:
  created:
    - scripts/verify-watchdog.sh
  modified:
    - src/cli/commands/daemon.ts
    - src/daemon/__tests__/daemon-cli.test.ts

key-decisions:
  - "formatStatusTable is a pure function taking HealthStatus + PID, no side effects -- fully testable"
  - "Stop prefers OS supervisor (launchctl/systemctl) before SIGTERM; --force bypasses supervisor"
  - "Default stop timeout increased from 10s to 15s (10s drain + 5s buffer)"
  - "Exit code 2 for not-running on both stop and status commands"
  - "Watchdog E2E verification via scripts/verify-watchdog.sh since launchd/systemd cannot be unit tested"

patterns-established:
  - "CLI output formatting: pure functions returning strings, tested without running daemon"
  - "Exit code convention: 0=success, 1=error, 2=daemon-not-running"
  - "queryStatusEndpoint() HTTP request on Unix socket with 3s timeout"

requirements-completed: [DAEM-05]

# Metrics
duration: 3min
completed: 2026-02-26
---

# Phase 2 Plan 3: CLI Status Table, Drain Progress & Watchdog Verification Summary

**Rich status table with --json flag, drain progress countdown on stop, and DAEM-05 watchdog verification via service file assertions and E2E script**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-26T02:37:09Z
- **Completed:** 2026-02-26T02:40:57Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Status command redesigned: human-readable table showing Status, PID, Uptime, Version, Tasks, Components, Config with --json flag for raw JSON
- Stop command shows drain progress with countdown every 2 seconds, tries OS supervisor before SIGTERM, supports --force flag
- DAEM-05 satisfied: 7 unit tests verify KeepAlive/Restart configuration in service files, plus E2E verification script
- 25 daemon CLI tests covering all formatting functions, edge cases, and watchdog assertions

## Task Commits

Each task was committed atomically:

1. **Task 1: Redesign status command with table output and --json flag** - `09759cd` (feat)
2. **Task 2: Redesign stop command with drain progress and verify watchdog (DAEM-05)** - `1f5819b` (feat)

## Files Created/Modified
- `src/cli/commands/daemon.ts` - Redesigned status (table + --json) and stop (drain progress + supervisor) commands
- `src/daemon/__tests__/daemon-cli.test.ts` - 25 tests: formatting, drain progress, exit codes, DAEM-05 watchdog
- `scripts/verify-watchdog.sh` - E2E script: install, SIGKILL, wait for restart, verify, cleanup

## Decisions Made
- `formatStatusTable()` is a pure function (HealthStatus + PID -> string) -- zero side effects, trivially testable
- Stop command tries OS supervisor first (launchctl bootout / systemctl stop), falls back to SIGTERM; --force bypasses this
- Default stop timeout increased from 10s to 15s to accommodate the 10s drain protocol plus buffer
- Exit code 2 for not-running daemon on both stop and status (consistent convention)
- Watchdog E2E test is a shell script rather than unit test because launchd/systemd require a real OS supervisor

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 2 (Daemon Lifecycle) is now complete -- all 3 plans executed
- Daemon has full CLI: install, uninstall, start --foreground, stop (with drain), status (with table + --json)
- Health endpoint, PID gating, crash recovery, service files, and watchdog all verified
- Ready for Phase 3 (Gateway) which depends on daemon being fully operational

## Self-Check: PASSED

All 3 key files verified on disk. Both task commits (09759cd, 1f5819b) verified in git log. 25 daemon CLI tests pass, 85 total daemon tests pass. TypeScript compiles cleanly.

---
*Phase: 02-daemon-lifecycle*
*Completed: 2026-02-26*
