# Phase 31: Granularity, Safety, and Hardening - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Extend the callback delivery system with "all" granularity (fire on every state transition with per-poll-cycle batching), prevent infinite callback loops via depth limiting, and ensure pending deliveries survive daemon restarts. Does NOT cover: filtered subscriptions (FILT-01), batch coalescing across tasks (BATCH-01), or agent guidance docs (Phase 32).

</domain>

<decisions>
## Implementation Decisions

### "All" granularity batching
- Poll-cycle batching: collect all transitions since last delivery into one callback per subscriber per poll cycle
- Payload includes ordered transition list: array of {fromStatus, toStatus, timestamp} in chronological order, plus current task state
- Track `lastDeliveredAt` timestamp on the subscription object; on each poll, scan the task's event log for transitions after that timestamp
- "All" is a superset of "completion" — it fires on every transition INCLUDING terminal ones; no need for separate completion subscription if you have "all"

### Callback loop prevention
- Maximum callback depth: 3 (original → callback → reaction → callback → reaction)
- Track depth via `callbackDepth` field in task frontmatter; when a callback-spawned session creates a new task, it inherits depth+1
- At depth limit: silently skip callback delivery and log a `subscription.depth_exceeded` event; subscription stays active but delivery is suppressed; task completes normally
- Self-subscription loops handled by depth limit — no separate detection needed; keep it simple

### Daemon restart recovery
- Scan ALL terminal tasks (done/cancelled/deadletter) for undelivered active subscriptions on startup — comprehensive, catches everything regardless of downtime duration
- Recovery scan runs as part of the first poll cycle after startup — leverages existing retryPendingDeliveries logic, keeps startup fast
- Retry counter persists across restarts — pre-restart attempts still count toward 3-attempt limit; prevents infinite retry across restarts
- Emit `subscription.recovery_attempted` event per pending delivery found during startup scan for operator observability

### Claude's Discretion
- Exact event log scanning implementation for transition accumulation
- How callbackDepth propagates through the dispatch/subscribe flow
- Integration of recovery scan into existing poll() function
- Event payload structure for depth_exceeded and recovery_attempted events

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches following existing daemon/scheduler patterns.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `deliverCallbacks()` in `src/dispatch/callback-delivery.ts`: Already filters by granularity — extend to handle "all" alongside "completion"
- `retryPendingDeliveries()` in `src/dispatch/callback-delivery.ts`: Retry logic that runs in scheduler poll — recovery scan builds on this
- `EventLogger` JSONL files in events directory: Task transitions are already logged as events — can be scanned for transition history
- `SubscriptionStore.update()`: Already supports updating subscription fields like lastAttemptAt — can add lastDeliveredAt

### Established Patterns
- Best-effort delivery: try/catch wrapping, never blocks state transitions (DLVR-04)
- Subscription metadata fields: deliveryAttempts, lastAttemptAt already exist on TaskSubscription schema
- EventLogger for lifecycle events: `subscription.delivered`, `subscription.delivery_failed` patterns established
- Daemon crash recovery: `system.crash_recovery` event already emitted in daemon.ts startup (Step 6)

### Integration Points
- `callback-delivery.ts deliverCallbacks()`: Add "all" granularity branch alongside existing "completion" filter
- `callback-delivery.ts deliverSingleCallback()`: Modify payload builder for batched transition list
- `src/schemas/subscription.ts`: Add lastDeliveredAt field to TaskSubscription
- `src/schemas/task.ts`: Add optional callbackDepth field to task frontmatter
- `src/dispatch/scheduler.ts poll()`: Ensure retryPendingDeliveries runs on first poll (recovery scan)
- `src/schemas/event.ts`: Add subscription.depth_exceeded, subscription.recovery_attempted event types

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 31-granularity-safety-and-hardening*
*Context gathered: 2026-03-10*
