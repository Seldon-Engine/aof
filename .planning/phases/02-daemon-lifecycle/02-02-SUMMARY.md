---
phase: 02-daemon-lifecycle
plan: 02
subsystem: daemon
tags: [launchd, systemd, service-file, plist, unit-file, install, uninstall]

# Dependency graph
requires:
  - phase: 02-daemon-lifecycle
    plan: 01
    provides: "Unix socket health server with selfCheck(), PID gating, crash recovery"
provides:
  - "generateLaunchdPlist() for macOS service file generation"
  - "generateSystemdUnit() for Linux service file generation"
  - "installService()/uninstallService() for OS supervisor management"
  - "aof daemon install CLI command with config validation"
  - "aof daemon uninstall CLI command with full cleanup"
  - "aof daemon start --foreground for development mode"
affects: [02-daemon-lifecycle, 05-install]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Service file generation with ServiceFileConfig interface for cross-platform abstraction"
    - "Config validation before service install (data dir, tasks dir, logs dir)"
    - "install = write service file + OS supervisor load in one step (brew services pattern)"

key-files:
  created:
    - src/daemon/service-file.ts
    - src/daemon/__tests__/service-file.test.ts
  modified:
    - src/cli/commands/daemon.ts
    - src/cli/init-steps-lifecycle.ts

key-decisions:
  - "ai.openclaw.aof as the launchd/systemd service label (matches gateway pattern ai.openclaw.gateway)"
  - "launchctl bootstrap/bootout (modern API) instead of deprecated load/unload"
  - "XML escaping in plist generation for safety with special characters in paths"
  - "Foreground mode via --foreground flag on start command for development debugging"

patterns-established:
  - "ServiceFileConfig interface: dataDir + optional nodeBinary/daemonBinary/extraArgs/extraEnv"
  - "validateConfig() pre-flight check before install: data dir, tasks dir, logs dir"
  - "install/uninstall as primary lifecycle commands, start reserved for foreground dev mode"

requirements-completed: [DAEM-01, DAEM-02]

# Metrics
duration: 3min
completed: 2026-02-26
---

# Phase 2 Plan 2: Service File Generation & Install/Uninstall Commands Summary

**Launchd plist and systemd unit generation with install/uninstall CLI commands, config validation, and OS supervisor integration**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-26T02:30:15Z
- **Completed:** 2026-02-26T02:33:26Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Service file generation module with launchd plist (macOS) and systemd unit (Linux) templates
- Install command validates config, writes service file, and starts daemon via OS supervisor in one step
- Uninstall command stops daemon, removes service file, and cleans up socket/PID files
- 28 new tests covering all generation functions, path resolution, XML escaping, and edge cases

## Task Commits

Each task was committed atomically:

1. **Task 1: Create service file generation module** - `7345f4c` (feat)
2. **Task 2: Wire install/uninstall commands into CLI and add config validation** - `57abf71` (feat)

## Files Created/Modified
- `src/daemon/service-file.ts` - Service file generation (plist/systemd), install/uninstall, path resolution
- `src/daemon/__tests__/service-file.test.ts` - 28 tests for generation functions, paths, XML escaping
- `src/cli/commands/daemon.ts` - Rewritten: install, uninstall, start (foreground), stop, status commands
- `src/cli/init-steps-lifecycle.ts` - Updated init wizard to use installService() instead of removed daemonStart()

## Decisions Made
- Used `ai.openclaw.aof` as the service label, matching the existing `ai.openclaw.gateway` pattern
- Used modern `launchctl bootstrap/bootout` API instead of deprecated `load/unload` commands
- Added XML escaping to plist generation for safety with special characters in data directory paths
- Repurposed `start` command: plain `start` redirects to `install` with helpful message, `--foreground` runs in-process for development
- Removed `restart` command entirely -- OS supervisor handles restarts (KeepAlive/Restart=on-failure)
- Config validation checks: data dir existence, tasks/ dir writable, logs/ dir writable

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated init wizard to use installService() instead of removed daemonStart()**
- **Found during:** Task 2 (TypeScript compilation check)
- **Issue:** `src/cli/init-steps-lifecycle.ts` imported `daemonStart` from `./commands/daemon.js` which was removed in the rewrite
- **Fix:** Changed to import `installService` from `../daemon/service-file.js` and call it directly
- **Files modified:** src/cli/init-steps-lifecycle.ts
- **Verification:** TypeScript compiles cleanly
- **Committed in:** 57abf71 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Auto-fix necessary for TypeScript compilation after removing old daemonStart export. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Service file generation ready for `aof daemon status` redesign (Plan 03)
- installService() and uninstallService() available for Phase 5 (Install) installer integration
- selfCheck() health verification integrated into install flow for startup confirmation

## Self-Check: PASSED

All 4 key files verified on disk. Both task commits (7345f4c, 57abf71) verified in git log. 28 new tests pass, 60 total daemon tests pass. TypeScript compiles cleanly.

---
*Phase: 02-daemon-lifecycle*
*Completed: 2026-02-26*
