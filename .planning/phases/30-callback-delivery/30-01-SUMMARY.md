---
phase: 30-callback-delivery
plan: 01
subsystem: dispatch
tags: [callback, subscription, notification, delivery, retry]

requires:
  - phase: 28-subscription-schema
    provides: TaskSubscription schema and SubscriptionStore CRUD
  - phase: 29-subscription-api
    provides: MCP tool wiring for subscribe/unsubscribe

provides:
  - deliverCallbacks() function for spawning callback sessions to subscriber agents
  - retryPendingDeliveries() function for retrying failed deliveries with backoff
  - buildCallbackPrompt() for structured notification prompt with Outputs extraction
  - Extended TaskSubscription schema with deliveryAttempts and lastAttemptAt tracking
  - SubscriptionStore.update() method for delivery state mutations

affects: [30-callback-delivery plan 02, scheduler integration, onRunComplete wiring]

tech-stack:
  added: []
  patterns: [best-effort delivery with try/catch isolation, retry with cooldown interval, structured callback prompt]

key-files:
  created:
    - src/dispatch/callback-delivery.ts
    - src/dispatch/__tests__/callback-delivery.test.ts
  modified:
    - src/schemas/subscription.ts
    - src/store/subscription-store.ts
    - src/store/__tests__/subscription-store.test.ts

key-decisions:
  - "Callback prompt uses taskFileContents field on TaskContext to pass structured notification to subscriber agent"
  - "Delivery failures tracked with counter and timestamp for retry eligibility (30s cooldown, 3 max attempts)"
  - "extractOutputsSection parses task body for ## Outputs marker to include results in callback prompt"

patterns-established:
  - "Best-effort delivery: each subscriber callback wrapped in try/catch, errors never propagate"
  - "Retry eligibility: deliveryAttempts > 0 AND < MAX AND lastAttemptAt older than MIN_RETRY_INTERVAL_MS"

requirements-completed: [DLVR-01, DLVR-02, DLVR-03, DLVR-04, GRAN-01]

duration: 4min
completed: 2026-03-10
---

# Phase 30 Plan 01: Callback Delivery Summary

**Callback delivery engine with retry tracking, structured prompt builder, and best-effort error isolation for subscriber agent notifications**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-10T12:30:50Z
- **Completed:** 2026-03-10T12:35:00Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Extended TaskSubscription schema with deliveryAttempts (int, default 0) and lastAttemptAt (optional datetime) for delivery tracking
- Added SubscriptionStore.update() method for atomic delivery state mutations
- Implemented deliverCallbacks() that spawns sessions to subscriber agents for completion-granularity subscriptions on terminal tasks
- Implemented retryPendingDeliveries() with 30s cooldown and 3-attempt maximum
- Built buildCallbackPrompt() with structured task summary and Outputs section extraction

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend subscription schema and store with delivery tracking** - `26edcff` (feat)
2. **Task 2: Implement callback delivery function with tests** - `a7ac0d6` (feat)

_Note: TDD tasks — tests written first (RED), then implementation (GREEN)._

## Files Created/Modified
- `src/schemas/subscription.ts` - Added deliveryAttempts and lastAttemptAt fields to TaskSubscription
- `src/store/subscription-store.ts` - Added update() method for delivery state mutations
- `src/store/__tests__/subscription-store.test.ts` - Added tests for new schema fields and update method
- `src/dispatch/callback-delivery.ts` - Core delivery engine with deliverCallbacks, retryPendingDeliveries, buildCallbackPrompt
- `src/dispatch/__tests__/callback-delivery.test.ts` - 15 tests covering all delivery requirements

## Decisions Made
- Used taskFileContents field on TaskContext to pass structured callback prompt to subscriber agent (avoids creating temporary task files)
- Delivery failures tracked with counter + timestamp enabling retry with 30s cooldown and 3 max attempts before marking failed
- extractOutputsSection parses between "## Outputs" and next "## " marker for clean output extraction

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- deliverCallbacks() and retryPendingDeliveries() are ready to be wired into the scheduler and onRunComplete handler in plan 02
- All exports (deliverCallbacks, retryPendingDeliveries, DeliverCallbacksOptions, buildCallbackPrompt) available for integration

---
*Phase: 30-callback-delivery*
*Completed: 2026-03-10*
