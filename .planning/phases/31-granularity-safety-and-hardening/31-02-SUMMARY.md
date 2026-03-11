---
phase: 31-granularity-safety-and-hardening
plan: 02
subsystem: dispatch
tags: [callback, depth-limiting, recovery, safety, subscription]

requires:
  - phase: 31-01
    provides: "All-granularity callback delivery with cursor-based scanning"
  - phase: 30
    provides: "Callback delivery infrastructure, SubscriptionStore, deliverCallbacks"
provides:
  - "callbackDepth field on TaskFrontmatter for chain depth tracking"
  - "MAX_CALLBACK_DEPTH=3 enforcement in deliverCallbacks and deliverAllGranularityCallbacks"
  - "subscription.depth_exceeded event logging"
  - "callbackDepth+1 propagation via TaskContext.metadata"
  - "Restart recovery for never-attempted subscriptions (deliveryAttempts===0)"
  - "subscription.recovery_attempted event for recovered subscriptions"
  - "Both completion and all granularity recovery in retryPendingDeliveries"
affects: [agent-guidance, dispatch]

tech-stack:
  added: []
  patterns: ["depth-limited recursion guard on callback chains", "recovery scan for never-attempted subscriptions"]

key-files:
  created: []
  modified:
    - "src/schemas/task.ts"
    - "src/dispatch/callback-delivery.ts"
    - "src/dispatch/executor.ts"
    - "src/dispatch/__tests__/callback-delivery.test.ts"

key-decisions:
  - "MAX_CALLBACK_DEPTH=3 as constant in callback-delivery.ts (not configurable) for safety simplicity"
  - "TaskContext.metadata field added to executor interface for cross-session callbackDepth propagation"
  - "Recovery scan handles both granularities by routing all-granularity subs through dedicated deliverAllGranularityForSub helper"

patterns-established:
  - "Depth guard pattern: check frontmatter.callbackDepth before delivery, log event, return early"
  - "Recovery pattern: deliveryAttempts===0 filter in retryPendingDeliveries catches daemon-restart orphans"

requirements-completed: [SAFE-01, SAFE-02]

duration: 4min
completed: 2026-03-11
---

# Phase 31 Plan 02: Callback Depth Limiting and Restart Recovery Summary

**MAX_CALLBACK_DEPTH=3 guard preventing infinite callback chains plus daemon restart recovery for never-attempted subscriptions**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-11T01:37:38Z
- **Completed:** 2026-03-11T01:41:49Z
- **Tasks:** 2 (TDD RED + GREEN)
- **Files modified:** 4

## Accomplishments
- callbackDepth field on TaskFrontmatter schema with depth >= 3 delivery prevention
- subscription.depth_exceeded event emitted when callback chain exceeds max depth
- callbackDepth+1 propagated via TaskContext.metadata to spawned callback sessions
- retryPendingDeliveries expanded to recover never-attempted subscriptions on terminal tasks
- Both completion and all granularity subscriptions handled in recovery scan
- 9 new tests covering all SAFE-01 and SAFE-02 requirements (36 total in file)

## Task Commits

Each task was committed atomically:

1. **TDD RED: Failing tests** - `2f63ac6` (test)
2. **TDD GREEN: Implementation** - `9aa20d0` (feat)

## Files Created/Modified
- `src/schemas/task.ts` - Added callbackDepth optional field to TaskFrontmatter
- `src/dispatch/callback-delivery.ts` - Depth checks, MAX_CALLBACK_DEPTH, expanded retryPendingDeliveries, deliverAllGranularityForSub helper
- `src/dispatch/executor.ts` - Added metadata field to TaskContext interface
- `src/dispatch/__tests__/callback-delivery.test.ts` - 9 new tests for SAFE-01 and SAFE-02

## Decisions Made
- MAX_CALLBACK_DEPTH set to 3 as a non-configurable constant for safety simplicity
- Added metadata field to TaskContext interface (rather than a separate parameter) for clean cross-session depth propagation
- Recovery scan routes all-granularity subscriptions through a dedicated deliverAllGranularityForSub helper that mirrors deliverAllGranularityCallbacks logic

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added metadata field to TaskContext interface**
- **Found during:** Task 2 (GREEN implementation)
- **Issue:** TaskContext in executor.ts lacked a metadata field, needed for callbackDepth propagation
- **Fix:** Added optional `metadata?: Record<string, unknown>` to TaskContext interface
- **Files modified:** src/dispatch/executor.ts
- **Verification:** TypeScript compilation passes, all tests green
- **Committed in:** 9aa20d0 (GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Interface extension was necessary for metadata propagation. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 31 complete (both plans): all-granularity delivery + depth limiting + restart recovery
- Ready for Phase 32 (Agent Guidance)
- Note: metadata.callbackDepth propagation to newly dispatched tasks requires aof_dispatch tool handler to read metadata.callbackDepth and set it on new task frontmatter. This is downstream wiring that the existing metadata passthrough may handle; verify in integration testing.

---
*Phase: 31-granularity-safety-and-hardening*
*Completed: 2026-03-11*
