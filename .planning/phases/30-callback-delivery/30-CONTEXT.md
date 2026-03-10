# Phase 30: Callback Delivery - Context

**Gathered:** 2026-03-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver callback sessions to subscriber agents when subscribed task events fire. The scheduler spawns a new session to the subscriber agent with task results as context. Covers: delivery triggering, callback payload, retry on failure, and subscriberId-to-agent resolution. Does NOT cover: "all" granularity batching (Phase 31), safety/loop prevention (Phase 31), or agent guidance docs (Phase 32).

</domain>

<decisions>
## Implementation Decisions

### Delivery trigger point
- Fire delivery in the existing `onRunComplete` callback in assign-executor.ts
- Trigger AFTER trace capture completes (so callback payload can reference the trace file)
- Agent completions only -- no delivery for manual MCP tool transitions (aof_task_complete called directly) or operator cancellations
- All three terminal states trigger completion-granularity delivery: done, cancelled, deadletter (matches GRAN-01)

### Callback session payload
- Structured summary: taskId, title, finalStatus, outcome summary, subscriberId, trace file path, outputs section
- Include the task's Outputs section (deliverables the completing agent produced) in the summary
- Frame as system prompt prefix: "You are receiving a task notification callback. Task X completed with status Y. Here is the summary: ..."
- Short timeout (2 min) for callback sessions -- these are lightweight reactions, not full tasks

### Retry mechanism
- Failed deliveries retry on the next scheduler poll cycle (~30s delay)
- Retry counter and delivery state tracked on the subscription object itself (add deliveryAttempts, lastAttemptAt fields to TaskSubscription schema)
- After 3 failed attempts: mark subscription status as "failed" with failureReason, emit subscription.delivery_failed event
- Scheduler discovers pending retries by scanning terminal-status tasks for active subscriptions with deliveryAttempts < 3

### SubscriberId resolution
- subscriberId IS the agentId -- must match an agent ID from the org chart
- Validate at subscribe time (both aof_task_subscribe and subscribe-at-dispatch) -- fail early if agent doesn't exist in org chart
- "mcp" is a valid subscriberId -- if someone dispatches with subscribe but no actor, subscriberId defaults to "mcp" which must exist in org chart or validation fails
- Consistent validation: both standalone subscribe and subscribe-at-dispatch check the org chart

### Claude's Discretion
- Exact structure of the callback system prompt template
- How to integrate delivery scanning into the existing scheduler poll function
- How to pass org chart reference to subscription validation
- Event names and event payload structure for delivery events

</decisions>

<specifics>
## Specific Ideas

No specific requirements -- open to standard approaches following existing daemon/scheduler patterns.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `onRunComplete` callback in `src/dispatch/assign-executor.ts`: Already fires async after agent session ends, handles trace capture and enforcement
- `captureTrace()` in `src/trace/trace-writer.ts`: Trace capture that runs before delivery can fire
- `SubscriptionStore` in `src/store/subscription-store.ts`: CRUD operations for subscriptions (create, get, list, cancel)
- `GatewayAdapter.spawnSession()` in `src/dispatch/executor.ts`: Session spawning with TaskContext, timeout, and correlationId support
- `loadOrgChart()` in `src/org/loader.ts`: Load and validate org chart for agent ID validation

### Established Patterns
- Best-effort async operations: trace capture wraps in try/catch, never blocks state transitions
- EventLogger for lifecycle events: `completion.enforcement`, `trace.captured`, etc.
- Scheduler poll cycle in `src/dispatch/scheduler.ts`: Lists tasks, checks conditions, builds dispatch actions
- TaskStoreHooks for lifecycle callbacks (afterTransition)

### Integration Points
- `assign-executor.ts` onRunComplete: Add delivery trigger after trace capture
- `scheduler.ts` poll(): Add delivery retry scan for terminal-status tasks
- `subscription-store.ts`: Extend TaskSubscription schema with deliveryAttempts, lastAttemptAt
- `src/schemas/subscription.ts`: Update Zod schema for new fields
- `tools.ts` handleAofTaskSubscribe + handleAofDispatch: Add org chart validation for subscriberId

</code_context>

<deferred>
## Deferred Ideas

None -- discussion stayed within phase scope.

</deferred>

---

*Phase: 30-callback-delivery*
*Context gathered: 2026-03-09*
