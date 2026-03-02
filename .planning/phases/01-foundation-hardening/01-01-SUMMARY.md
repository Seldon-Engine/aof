---
phase: 01-foundation-hardening
plan: 01
subsystem: scheduler
tags: [abort-controller, promise-race, drain, reconciliation, timeout, lifecycle]

# Dependency graph
requires: []
provides:
  - "Poll timeout guard (AbortController + Promise.race) in AOFService.runPoll()"
  - "Graceful drain protocol in AOFService.stop() with 10s timeout"
  - "Startup orphan reconciliation in AOFService.start() before first poll"
  - "Drain-aware SIGTERM/SIGINT signal handlers in daemon.ts"
  - "New event types: poll.timeout, task.reclaimed, task.deadlettered"
affects: [02-daemon-failure-taxonomy, 03-gateway-reliability, 04-self-healing]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "AbortController + Promise.race for configurable timeout guards"
    - "Promise.race drain protocol with countdown logging"
    - "Startup reconciliation scanning in-progress tasks before first poll"
    - "Multi-project reconciliation iterating projectStores"

key-files:
  created: []
  modified:
    - "src/service/aof-service.ts"
    - "src/daemon/daemon.ts"
    - "src/schemas/event.ts"
    - "src/dispatch/scheduler.ts"
    - "src/service/__tests__/aof-service.test.ts"
    - "src/daemon/__tests__/daemon.test.ts"
    - "src/service/__tests__/multi-project-polling.test.ts"

key-decisions:
  - "DRAIN_TIMEOUT_MS as module-level constant (10_000ms) rather than configurable -- per user decision"
  - "reconcileOrphans iterates all projectStores in multi-project mode (follows pollAllProjects pattern)"
  - "Drain-aware signal handlers registered after health server creation for full shutdown access"
  - "Fire-and-forget signal handler pattern (void drainAndExit()) to avoid unhandled promise rejection"

patterns-established:
  - "AbortController timeout guard: create controller, setTimeout abort, Promise.race poll vs abort signal"
  - "Drain protocol: set running=false, clear timer, race pollQueue vs drain timeout, countdown logger"
  - "Startup reconciliation: list in-progress tasks, transition each to ready, emit task.reclaimed events"

requirements-completed: [FOUND-01, FOUND-02, FOUND-03]

# Metrics
duration: 10min
completed: 2026-02-26
---

# Phase 1 Plan 1: Scheduler Lifecycle Hardening Summary

**Poll timeout guard with AbortController, graceful drain with 10s deadline, and startup orphan reconciliation across all project stores**

## Performance

- **Duration:** 10 min
- **Started:** 2026-02-26T00:37:01Z
- **Completed:** 2026-02-26T00:46:57Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments
- Poll cycles now race against a configurable timeout (default 30s) -- a hanging poll is aborted and the scheduler continues
- Daemon SIGTERM/SIGINT triggers a drain protocol that waits up to 10s for in-flight transitions with countdown progress logging
- On startup, all in-progress tasks are reclaimed to ready before the first poll, with individual reclaim logs and task.reclaimed events
- 8 new tests covering timeout abort, timeout recovery, drain wait, drain timeout, drain quick-return, orphan reclaim, reclaim logging, and no-orphan handling

## Task Commits

Each task was committed atomically:

1. **Task 1: Add poll timeout guard and per-task action timeout to AOFService** - `13f9d35` (feat)
2. **Task 2: Implement graceful drain protocol and drain-aware signal handlers** - `1b37d7d` (feat)
3. **Task 3: Add startup orphan reconciliation and write tests for all three behaviors** - `01e67d9` (feat)

## Files Created/Modified
- `src/service/aof-service.ts` - Added pollTimeoutMs config, timeout guard in runPoll(), drain protocol in stop(), reconcileOrphans() in start()
- `src/daemon/daemon.ts` - Replaced immediate-exit signal handlers with drain-aware async shutdown, moved handlers after health server creation
- `src/schemas/event.ts` - Added poll.timeout, task.reclaimed, task.deadlettered event types
- `src/dispatch/scheduler.ts` - Added pollTimeoutMs and taskActionTimeoutMs to SchedulerConfig interface
- `src/service/__tests__/aof-service.test.ts` - Added Foundation Hardening describe block with 8 new tests
- `src/daemon/__tests__/daemon.test.ts` - Updated signal cleanup test for async drain behavior (vi.waitFor)
- `src/service/__tests__/multi-project-polling.test.ts` - Updated stats assertion to account for orphan reconciliation

## Decisions Made
- DRAIN_TIMEOUT_MS kept as module-level constant (10s) per user decision, not configurable at runtime
- Multi-project reconciliation iterates all project stores, same pattern as pollAllProjects()
- Signal handlers use void drainAndExit() pattern to avoid unhandled promise rejection in process event handlers
- Health server shutdown happens after drain completes, before process.exit -- stays alive during drain for monitoring

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed daemon signal cleanup test for async drain**
- **Found during:** Task 2 (drain implementation)
- **Issue:** Existing daemon test emitted SIGTERM and immediately checked PID file removal; async drain handler meant PID removal is no longer synchronous
- **Fix:** Added vi.waitFor() to wait for async drain to complete before asserting PID file removal
- **Files modified:** src/daemon/__tests__/daemon.test.ts
- **Verification:** All 6 daemon tests pass
- **Committed in:** 1b37d7d (Task 2 commit)

**2. [Rule 1 - Bug] Fixed multi-project stats assertion after reconciliation**
- **Found during:** Task 3 (orphan reconciliation)
- **Issue:** Multi-project test created an in-progress task and expected it to remain in-progress after startup. With FOUND-03 reconciliation, the task gets reclaimed to ready, changing the in-progress count from 4 to 3
- **Fix:** Updated assertion from `expect(stats.inProgress).toBe(4)` to `expect(stats.inProgress).toBe(3)` with updated comment explaining the change
- **Files modified:** src/service/__tests__/multi-project-polling.test.ts
- **Verification:** All 6 multi-project tests pass
- **Committed in:** 01e67d9 (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (2 Rule 1 - Bug: tests broken by correct behavior changes)
**Impact on plan:** Both auto-fixes necessary for test correctness after intentional behavior changes. No scope creep.

## Issues Encountered
None -- all three tasks implemented as specified in the plan.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Timeout guard, drain, and reconciliation provide the foundation for Plan 2 (FOUND-04: failure taxonomy)
- The new event types (poll.timeout, task.reclaimed, task.deadlettered) are available for Phase 3 gateway observability
- Drain protocol pattern can be reused for other services that need graceful shutdown

## Self-Check: PASSED

All 7 modified/created files verified present. All 3 task commit hashes verified in git log.

---
*Phase: 01-foundation-hardening*
*Completed: 2026-02-26*
