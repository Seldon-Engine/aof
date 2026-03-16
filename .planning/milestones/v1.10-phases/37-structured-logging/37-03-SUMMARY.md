---
phase: 37-structured-logging
plan: 03
subsystem: logging
tags: [pino, structured-logging, console-migration, observability]

requires:
  - phase: 37-01
    provides: createLogger factory, Logger type, lazy singleton Pino instance
provides:
  - Zero console.* calls in all core modules (daemon, service, protocol, openclaw, murmur, plugins, store, mcp, memory, metrics)
  - Structured JSON logging across entire runtime (non-CLI) codebase
  - Verified CLI/EventLogger/config boundaries untouched
affects: [37-04, 37-05, observability, debugging]

tech-stack:
  added: []
  patterns:
    - "Module-level const log = createLogger(component) for all core modules"
    - "Shared mockLogFns pattern for test files asserting on structured log calls"
    - "Silent catch remediation with warn-level structured logs"

key-files:
  created: []
  modified:
    - src/daemon/daemon.ts
    - src/daemon/index.ts
    - src/daemon/standalone-adapter.ts
    - src/service/aof-service.ts
    - src/protocol/router.ts
    - src/protocol/task-lock.ts
    - src/openclaw/openclaw-executor.ts
    - src/openclaw/adapter.ts
    - src/openclaw/matrix-notifier.ts
    - src/murmur/cleanup.ts
    - src/plugins/watchdog/index.ts
    - src/store/task-store.ts
    - src/mcp/server.ts
    - src/memory/index.ts
    - src/memory/project-memory.ts
    - src/metrics/exporter.ts

key-decisions:
  - "Used err field name (not error) for Error objects to trigger Pino serializer"
  - "Remediated all silent catches with warn-level structured logs"
  - "Test mock pattern: shared mockLogFns object with indirect function wrappers to avoid vi.mock hoisting issues"

patterns-established:
  - "vi.mock hoisting workaround: declare mockFns object before vi.mock, use arrow wrapper functions inside createLogger mock"
  - "Component naming convention: daemon, service, protocol, openclaw, matrix-notifier, murmur, watchdog, store, mcp, memory, metrics"

requirements-completed: [LOG-04, LOG-06]

duration: 45min
completed: 2026-03-12
---

# Phase 37 Plan 03: Core Module Migration Summary

**Migrated ~60 console.* calls across 16 core modules to structured Pino logging with silent catch remediation and 24 test file updates**

## Performance

- **Duration:** ~45 min (across 2 context windows)
- **Started:** 2026-03-12T23:55:00Z
- **Completed:** 2026-03-13T00:50:05Z
- **Tasks:** 2
- **Files modified:** 37 (16 source + 21 test)

## Accomplishments
- Zero console.* calls remain in any core module source file (daemon, service, protocol, openclaw, murmur, plugins, store, mcp, memory, metrics)
- All silent catch blocks remediated with warn-level structured logs including contextual fields
- CLI (src/cli/, src/commands/) confirmed untouched -- still uses console.* for user-facing output
- EventLogger (src/events/) confirmed zero changes
- config/registry.ts console.warn exception preserved (runs before logger init)
- All 2948 tests pass, TypeScript compilation clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Migrate daemon, service, and protocol modules** - `b3e8f21` (feat)
2. **Task 2: Migrate openclaw, murmur, plugins, store, mcp, memory, metrics** - `d63dc67` (feat)

## Files Created/Modified

### Source files (16)
- `src/daemon/daemon.ts` - 1 console.info replaced with structured log
- `src/daemon/index.ts` - 3 console.* replaced (startup/shutdown messages)
- `src/daemon/standalone-adapter.ts` - 4 console.error replaced, 1 silent catch remediated
- `src/service/aof-service.ts` - 15 console.* replaced (drain, reconciliation, poll, project init)
- `src/protocol/router.ts` - 4 console.error replaced (cascade, DAG errors)
- `src/protocol/task-lock.ts` - 2 silent catches remediated with warn-level logs
- `src/openclaw/openclaw-executor.ts` - 12 console.* replaced (spawn, background agent, session management)
- `src/openclaw/adapter.ts` - 2 console.warn replaced
- `src/openclaw/matrix-notifier.ts` - 1 console.error replaced
- `src/murmur/cleanup.ts` - 3 console.info replaced
- `src/plugins/watchdog/index.ts` - 5 console.* replaced (health check, restart)
- `src/store/task-store.ts` - 2 console.error replaced
- `src/mcp/server.ts` - 1 console.error replaced
- `src/memory/index.ts` - 3 console.warn replaced
- `src/memory/project-memory.ts` - 3 console.* replaced
- `src/metrics/exporter.ts` - 1 console.log replaced

### Test files (24)
- `src/daemon/__tests__/daemon.test.ts` - Added vi.mock for logging
- `src/service/__tests__/aof-service.test.ts` - Added shared mockLogFns, updated 2 reconciliation tests
- `src/service/__tests__/aof-service-router-wiring.test.ts` - Added vi.mock
- `src/service/__tests__/heartbeat-integration.test.ts` - Added vi.mock
- `src/service/__tests__/multi-project-polling.test.ts` - Added vi.mock
- `src/protocol/__tests__/router.test.ts` - Added vi.mock
- `src/protocol/__tests__/protocol-integration.test.ts` - Added vi.mock
- `src/protocol/__tests__/dag-router-integration.test.ts` - Added vi.mock
- `src/protocol/__tests__/block-cascade.test.ts` - Added vi.mock
- `src/protocol/__tests__/completion-status.test.ts` - Added vi.mock
- `src/protocol/__tests__/concurrent-handling.test.ts` - Added vi.mock
- `src/protocol/__tests__/handoff.test.ts` - Added vi.mock
- `src/protocol/__tests__/task-lock.test.ts` - Added vi.mock
- `src/openclaw/__tests__/openclaw-executor-http.test.ts` - Added shared mockOcLogFns, updated 3 tests
- `src/openclaw/__tests__/executor.test.ts` - Added shared mockExecLogFns, updated 2 tests
- `src/openclaw/__tests__/openclaw-executor-platform-limit.test.ts` - Added shared mockPlatLogFns, updated 1 test
- `src/openclaw/__tests__/adapter.test.ts` - Added vi.mock
- `src/openclaw/__tests__/bug-001-executor-wiring.test.ts` - Added vi.mock
- `src/openclaw/__tests__/matrix-notifier.test.ts` - Added vi.mock
- `src/openclaw/__tests__/plugin.unit.test.ts` - Added vi.mock
- `src/murmur/__tests__/cleanup.test.ts` - Added vi.mock
- `src/plugins/watchdog/__tests__/index.test.ts` - Added vi.mock
- `src/store/__tests__/task-store.test.ts` - Added shared mockStoreFns, updated 1 test
- `src/metrics/__tests__/exporter.test.ts` - Added vi.mock

## Decisions Made
- Used `err` field name for Error objects to trigger Pino's built-in error serializer
- Remediated all silent catches with warn-level structured logs (not just the ones with console.* calls)
- Test mock pattern: shared mockFns object declared before vi.mock with indirect arrow wrappers to avoid vi.mock hoisting issues

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed vi.mock hoisting issue in test files**
- **Found during:** Task 1 (service tests)
- **Issue:** Tests using `const mockLogger` before vi.mock caused ReferenceError due to hoisting
- **Fix:** Used indirect function pattern: declare mockFns object, wrap in arrow functions inside vi.mock factory
- **Files modified:** Multiple test files
- **Verification:** All tests pass
- **Committed in:** b3e8f21, d63dc67

**2. [Rule 2 - Missing Critical] Remediated silent catch blocks in task-lock.ts**
- **Found during:** Task 1 (protocol module migration)
- **Issue:** 2 catch blocks in task-lock.ts silently swallowed errors
- **Fix:** Added warn-level structured logs with contextual fields
- **Files modified:** src/protocol/task-lock.ts
- **Verification:** Tests pass, catch blocks now emit structured logs
- **Committed in:** b3e8f21

---

**Total deviations:** 2 auto-fixed (1 bug fix, 1 missing critical)
**Impact on plan:** Both fixes were necessary for correctness. Silent catch remediation was explicitly called out in the plan. No scope creep.

## Issues Encountered
- vi.mock hoisting: Vitest hoists vi.mock() calls above const declarations, causing ReferenceError when mock factory references variables. Solved with indirect function wrapper pattern that all 24 test files now use consistently.
- Tests asserting on console.warn/error spies needed updates to assert on structured logger mock instead. Affected 6 test files with specific assertion updates.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All core modules now use structured Pino logging via createLogger()
- Ready for 37-04 (dispatch/scheduler migration) or 37-05 (log-level configuration)
- Component naming convention established for log filtering: daemon, service, protocol, openclaw, matrix-notifier, murmur, watchdog, store, mcp, memory, metrics

## Self-Check: PASSED

- Commit b3e8f21: FOUND
- Commit d63dc67: FOUND
- createLogger in all 10 core source files: FOUND
- SUMMARY.md: FOUND

---
*Phase: 37-structured-logging*
*Completed: 2026-03-12*
