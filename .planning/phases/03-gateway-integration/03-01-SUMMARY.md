---
phase: 03-gateway-integration
plan: 01
subsystem: dispatch
tags: [gateway-adapter, session-lifecycle, mock-adapter, openclaw, executor]

# Dependency graph
requires:
  - phase: 01-foundation-hardening
    provides: "Startup orphan reconciliation, dead-letter events with failure chain"
provides:
  - "GatewayAdapter interface (spawnSession, getSessionStatus, forceCompleteSession)"
  - "OpenClawAdapter with heartbeat-based session status and force-completion"
  - "MockAdapter with configurable completion delays, staleness simulation, and auto-completion"
  - "Config-driven adapter selection via resolveAdapter()"
affects: [03-gateway-integration, 04-self-healing]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "GatewayAdapter three-method contract (spawnSession/getSessionStatus/forceCompleteSession)"
    - "Fire-and-forget spawn with sessionToTask map for lifecycle tracking"
    - "Config-driven adapter selection via resolveAdapter(api, store)"

key-files:
  created: []
  modified:
    - "src/dispatch/executor.ts"
    - "src/openclaw/openclaw-executor.ts"
    - "src/openclaw/adapter.ts"
    - "src/dispatch/assign-executor.ts"
    - "src/dispatch/scheduler.ts"
    - "src/dispatch/task-dispatcher.ts"
    - "src/dispatch/aof-dispatch.ts"
    - "src/dispatch/murmur-integration.ts"
    - "src/dispatch/index.ts"
    - "src/service/aof-service.ts"
    - "src/mcp/shared.ts"

key-decisions:
  - "Deprecated aliases kept (DispatchExecutor, MockExecutor, OpenClawExecutor, ExecutorResult) for backward compatibility with potential external consumers"
  - "OpenClawAdapter receives ITaskStore via constructor for heartbeat-based getSessionStatus"
  - "resolveAdapter() in adapter.ts supports config.executor.adapter='mock' for test/dev mode"
  - "MockAdapter uses Map<string, MockSession> for session tracking with configurable auto-completion"

patterns-established:
  - "GatewayAdapter: three-method contract for full session lifecycle management"
  - "sessionToTask Map: mapping session IDs to task IDs for lifecycle queries"
  - "Inline test adapter stubs: getSessionStatus/forceCompleteSession for test objects"

requirements-completed: [GATE-01, GATE-02]

# Metrics
duration: 10min
completed: 2026-02-26
---

# Phase 3 Plan 1: GatewayAdapter Interface Summary

**GatewayAdapter three-method dispatch contract (spawnSession/getSessionStatus/forceCompleteSession) replacing single-method DispatchExecutor, with OpenClawAdapter and MockAdapter implementations and all 39 consumer files migrated**

## Performance

- **Duration:** 10 min
- **Started:** 2026-02-26T03:48:38Z
- **Completed:** 2026-02-26T03:58:44Z
- **Tasks:** 2
- **Files modified:** 39

## Accomplishments
- Defined GatewayAdapter interface with three-method contract for full session lifecycle
- OpenClawAdapter: heartbeat-based getSessionStatus via readHeartbeat, force-completion via markRunArtifactExpired
- MockAdapter: full session tracking with configurable delays, staleness simulation, auto-completion toggle
- All 9 source consumer files migrated from DispatchExecutor to GatewayAdapter
- All 28 test files migrated from MockExecutor to MockAdapter with proper spawnSession and stub methods
- Config-driven adapter selection via resolveAdapter() supporting mock/production modes
- TypeScript compiles cleanly, 2405 tests pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Define GatewayAdapter interface and refactor implementations** - `8dc6250` (feat)
2. **Task 2: Update all consumers from DispatchExecutor to GatewayAdapter** - `5bf2d47` (feat)

## Files Created/Modified
- `src/dispatch/executor.ts` - GatewayAdapter interface, SpawnResult, SessionStatus types, MockAdapter class
- `src/openclaw/openclaw-executor.ts` - OpenClawAdapter with spawnSession, getSessionStatus, forceCompleteSession
- `src/openclaw/adapter.ts` - resolveAdapter() for config-driven adapter selection
- `src/dispatch/assign-executor.ts` - executor.spawn -> executor.spawnSession
- `src/dispatch/scheduler.ts` - DispatchExecutor -> GatewayAdapter
- `src/dispatch/task-dispatcher.ts` - DispatchExecutor -> GatewayAdapter
- `src/dispatch/aof-dispatch.ts` - DispatchExecutor -> GatewayAdapter, .spawn -> .spawnSession
- `src/dispatch/murmur-integration.ts` - DispatchExecutor -> GatewayAdapter, .spawn -> .spawnSession
- `src/dispatch/index.ts` - Updated primary exports to GatewayAdapter/MockAdapter/SpawnResult/SessionStatus
- `src/service/aof-service.ts` - DispatchExecutor -> GatewayAdapter
- `src/mcp/shared.ts` - DispatchExecutor -> GatewayAdapter
- `src/openclaw/executor.ts` - Updated re-exports
- `src/openclaw/index.ts` - Updated re-exports
- 28 test files - MockExecutor -> MockAdapter, DispatchExecutor -> GatewayAdapter, .spawn -> .spawnSession

## Decisions Made
- Kept deprecated aliases (DispatchExecutor, MockExecutor, OpenClawExecutor, ExecutorResult) for backward compatibility rather than removing immediately, since external consumers may depend on them
- OpenClawAdapter constructor takes optional ITaskStore parameter for heartbeat-based session status queries
- resolveAdapter() checks config.executor.adapter field for mock/production mode selection
- MockAdapter auto-completion defaults to enabled with 0ms delay (microtask resolution)
- Inline test GatewayAdapter objects given minimal stub implementations for getSessionStatus/forceCompleteSession

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Previous session's Task 2 changes were lost (not committed before session ended); redone in this session
- Pre-existing test failures in openclaw executor tests (fire-and-forget behavior mismatch with synchronous test expectations) -- 4+1+4 = 9 failures, all pre-existing and out of scope

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- GatewayAdapter is the sole dispatch contract -- ready for Plan 02 (correlation IDs, heartbeat timeout, integration testing)
- MockAdapter session tracking enables stateful integration tests for session lifecycle
- OpenClawAdapter's getSessionStatus/forceCompleteSession ready for heartbeat-based self-healing in Phase 4

---
*Phase: 03-gateway-integration*
*Completed: 2026-02-26*
