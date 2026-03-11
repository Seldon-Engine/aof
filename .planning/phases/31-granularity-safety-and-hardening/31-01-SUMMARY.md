---
phase: 31-granularity-safety-and-hardening
plan: 01
subsystem: dispatch
tags: [callbacks, subscriptions, event-log, batching, cursor]

requires:
  - phase: 30-callback-delivery
    provides: deliverCallbacks, SubscriptionStore, EventLogger.query()
provides:
  - deliverAllGranularityCallbacks function for batched transition delivery
  - lastDeliveredAt cursor on TaskSubscription schema
  - subscription.depth_exceeded and subscription.recovery_attempted event types
  - buildCallbackPrompt with optional transitions parameter
affects: [31-02-depth-limiting-and-recovery]

tech-stack:
  added: []
  patterns: [cursor-based event scanning, per-subscriber batching, self-healing cursor on failure]

key-files:
  created: []
  modified:
    - src/schemas/subscription.ts
    - src/schemas/event.ts
    - src/store/subscription-store.ts
    - src/dispatch/callback-delivery.ts
    - src/dispatch/__tests__/callback-delivery.test.ts

key-decisions:
  - "Cursor-based scanning: lastDeliveredAt on subscription filters EventLogger.query() results by timestamp for incremental delivery"
  - "Self-healing cursor: lastDeliveredAt only advances on successful delivery, ensuring retries re-deliver missed transitions"
  - "All-granularity is status-agnostic: deliverAllGranularityCallbacks does not check terminal status, fires on any transition"

patterns-established:
  - "Cursor pattern: lastDeliveredAt timestamp as a high-water mark for incremental event scanning"
  - "Transition batching: multiple events collapsed into single callback with ordered TransitionRecord array"

requirements-completed: [GRAN-02]

duration: 4min
completed: 2026-03-11
---

# Phase 31 Plan 01: All-Granularity Callback Delivery Summary

**Batched transition callbacks via lastDeliveredAt cursor with per-subscriber event log scanning and self-healing on failure**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-11T01:31:01Z
- **Completed:** 2026-03-11T01:34:49Z
- **Tasks:** 2 (TDD RED + GREEN)
- **Files modified:** 5

## Accomplishments
- TaskSubscription schema extended with lastDeliveredAt cursor field for tracking delivery position in event stream
- EventType enum extended with subscription.depth_exceeded and subscription.recovery_attempted (needed by plan 02)
- deliverAllGranularityCallbacks scans event log per subscriber, batches transitions, delivers single callback with ordered transition list
- buildCallbackPrompt accepts optional transitions array, rendering "## Transitions" section with chronological transition list
- Self-healing cursor: lastDeliveredAt advances only after successful delivery; failed deliveries retry all missed transitions
- 8 new tests covering batching, cursor advancement, empty skip, undefined cursor, failure resilience, terminal transition superset

## Task Commits

Each task was committed atomically:

1. **RED: Failing tests for all-granularity delivery** - `22c14d0` (test)
2. **GREEN: Implement all-granularity callback delivery** - `2d99c61` (feat)

_TDD plan: RED wrote 8 failing tests, GREEN implemented schema + store + delivery changes to pass all 27 tests._

## Files Created/Modified
- `src/schemas/subscription.ts` - Added lastDeliveredAt optional datetime field to TaskSubscription
- `src/schemas/event.ts` - Added subscription.depth_exceeded and subscription.recovery_attempted event types
- `src/store/subscription-store.ts` - Expanded update() Pick type to include lastDeliveredAt
- `src/dispatch/callback-delivery.ts` - Added deliverAllGranularityCallbacks, TransitionRecord type, extended buildCallbackPrompt
- `src/dispatch/__tests__/callback-delivery.test.ts` - Added 8 tests for all-granularity delivery + schema validation

## Decisions Made
- Cursor-based scanning using lastDeliveredAt as high-water mark into EventLogger.query() results
- Self-healing cursor: only advances on success, failed deliveries automatically retry all missed transitions
- All-granularity is status-agnostic (no terminal status check), making it a true superset of completion granularity
- Event types for depth_exceeded and recovery_attempted added here for schema atomicity (used by plan 02)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- deliverAllGranularityCallbacks ready for integration into scheduler poll cycle
- subscription.depth_exceeded and subscription.recovery_attempted event types ready for plan 02 (depth limiting and daemon recovery)
- lastDeliveredAt field available on SubscriptionStore.update() for plan 02 recovery scan

---
*Phase: 31-granularity-safety-and-hardening*
*Completed: 2026-03-11*
