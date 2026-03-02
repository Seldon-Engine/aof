---
phase: 02-daemon-lifecycle
plan: 01
subsystem: daemon
tags: [unix-socket, health-endpoint, pid-gating, crash-recovery, liveness]

# Dependency graph
requires:
  - phase: 01-foundation-hardening
    provides: "drain protocol, reconciliation, AOFService with timeout config"
provides:
  - "Unix socket health server with /healthz and /status routes"
  - "selfCheck() for PID gating verification"
  - "PID-gated startup (health binds before PID write)"
  - "Crash recovery detection with system.crash_recovery event"
  - "Rich HealthStatus with version, components, config fields"
affects: [02-daemon-lifecycle, 03-gateway, 05-install]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Unix domain socket for local-only health endpoints (no port conflicts, no auth)"
    - "selfCheck() pattern: self-verify server is responsive before advertising readiness"
    - "setShuttingDown() module-level flag for liveness degradation during drain"

key-files:
  created: []
  modified:
    - src/daemon/server.ts
    - src/daemon/health.ts
    - src/daemon/daemon.ts
    - src/schemas/event.ts
    - src/events/logger.ts
    - src/daemon/index.ts
    - src/plugins/watchdog/index.ts
    - src/daemon/__tests__/server.test.ts
    - src/daemon/__tests__/health.test.ts
    - src/daemon/__tests__/daemon.test.ts

key-decisions:
  - "Socket path defaults to join(dataDir, 'daemon.sock') -- colocated with PID file"
  - "getLivenessStatus() is synchronous with module-level shuttingDown flag for minimal overhead"
  - "DaemonStatusContext passed as optional parameter to getHealthStatus() for backward compat"

patterns-established:
  - "Unix socket health server: createHealthServer(getState, store, socketPath, getContext)"
  - "selfCheck(socketPath) pre-PID verification pattern"
  - "Startup order: health bind -> self-check -> PID write -> service start"

requirements-completed: [DAEM-03, DAEM-04]

# Metrics
duration: 4min
completed: 2026-02-26
---

# Phase 2 Plan 1: Health Endpoint & PID Gating Summary

**Unix socket health server with /healthz liveness and /status rich JSON, PID gated on self-check, crash recovery detection via stale PID**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-26T02:22:42Z
- **Completed:** 2026-02-26T02:27:05Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- Health server converted from TCP port to Unix domain socket, eliminating port conflicts and auth requirements
- Split single /health endpoint into /healthz (minimal liveness) and /status (full JSON with version, components, config)
- PID file now written only after health server self-check succeeds (DAEM-03)
- Crash recovery: stale PID file triggers system.crash_recovery event with previousPid (DAEM-04)
- Config forwarding fix: pollTimeoutMs and taskActionTimeoutMs now passed through to AOFService

## Task Commits

Each task was committed atomically:

1. **Task 1: Convert health server to Unix socket with /healthz and /status routes** - `c7d66e5` (feat)
2. **Task 2: Fix startup sequence (PID gating + crash recovery) and add system.crash_recovery event** - `92f301a` (feat)

## Files Created/Modified
- `src/daemon/server.ts` - Unix socket health server with /healthz, /status routes and selfCheck()
- `src/daemon/health.ts` - Extended HealthStatus with version, components, config; added getLivenessStatus()
- `src/daemon/daemon.ts` - PID gating on self-check, crash recovery detection, socketPath option, config forwarding
- `src/schemas/event.ts` - Added system.crash_recovery to EventType enum
- `src/events/logger.ts` - Added system.crash_recovery to logSystem() type union
- `src/daemon/index.ts` - Updated CLI entry point for socket-based health server
- `src/plugins/watchdog/index.ts` - Updated fallback HealthStatus for new required fields
- `src/daemon/__tests__/server.test.ts` - Full rewrite for Unix socket testing with fetchSocket helper
- `src/daemon/__tests__/health.test.ts` - Added tests for version, components, config, getLivenessStatus
- `src/daemon/__tests__/daemon.test.ts` - Added PID gating, crash recovery, socket cleanup, config forwarding tests

## Decisions Made
- Socket path defaults to `join(dataDir, "daemon.sock")` -- keeps health socket colocated with PID file and data dir
- `getLivenessStatus()` is synchronous with a module-level `shuttingDown` flag -- zero store queries, minimal overhead for supervisor watchdog
- `DaemonStatusContext` is an optional parameter to `getHealthStatus()` -- backward compatible, existing callers without context get "unknown" defaults
- `selfCheck()` uses Node's `http.request` with `socketPath` option and 2s timeout

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated daemon CLI entry point (index.ts) for socket-based server**
- **Found during:** Task 2 (TypeScript compilation check)
- **Issue:** `src/daemon/index.ts` still referenced removed `healthPort`/`healthBind` options
- **Fix:** Replaced with `socketPath` option, updated console output to show socket path
- **Files modified:** src/daemon/index.ts
- **Verification:** TypeScript compiles cleanly
- **Committed in:** 92f301a (Task 2 commit)

**2. [Rule 3 - Blocking] Updated watchdog fallback HealthStatus for new required fields**
- **Found during:** Task 2 (TypeScript compilation check)
- **Issue:** `src/plugins/watchdog/index.ts` had a fallback HealthStatus missing version, components, config
- **Fix:** Added the three new required fields to the fallback object
- **Files modified:** src/plugins/watchdog/index.ts
- **Verification:** TypeScript compiles cleanly, watchdog tests pass
- **Committed in:** 92f301a (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both auto-fixes necessary for TypeScript compilation after interface changes. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Unix socket health server is ready for service file generation (Plan 02: launchd/systemd templates reference socket path)
- CLI commands (Plan 03: `aof daemon status`) can query /status endpoint via socket
- selfCheck() pattern available for install-time validation

## Self-Check: PASSED

All 7 key files verified on disk. Both task commits (c7d66e5, 92f301a) verified in git log. 45 tests pass across 3 test files. TypeScript compiles cleanly.

---
*Phase: 02-daemon-lifecycle*
*Completed: 2026-02-26*
