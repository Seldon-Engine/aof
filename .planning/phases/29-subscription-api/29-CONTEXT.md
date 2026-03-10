# Phase 29: Subscription API - Context

**Gathered:** 2026-03-09
**Status:** Ready for planning

<domain>
## Phase Boundary

MCP tools for agents to subscribe to task outcomes -- at dispatch time or after. Three operations: subscribe-at-dispatch (param on aof_dispatch), standalone subscribe (aof_task_subscribe), and unsubscribe (aof_task_unsubscribe). Callback delivery is a separate phase (30).

</domain>

<decisions>
## Implementation Decisions

### Subscribe-at-dispatch
- `subscribe` param on aof_dispatch accepts a granularity string: `"completion"` or `"all"`
- Omitting `subscribe` = no subscription (opt-in only, fully backward compatible)
- Subscribe is atomic with dispatch -- if subscription creation fails, dispatch also fails
- Response adds `subscriptionId` field alongside existing `taskId` (lightweight, no full subscription object)
- Subscriber is always the dispatching agent (whoever called aof_dispatch)

### Tool naming
- Standalone subscribe: `aof_task_subscribe` (matches aof_task_update, aof_task_complete pattern)
- Unsubscribe: `aof_task_unsubscribe`

### aof_task_subscribe response
- Returns subscriptionId, taskId, granularity, status ("active"), taskStatus (current task status), createdAt
- Including taskStatus gives agent a snapshot of where the task is right now

### aof_task_unsubscribe
- Requires both taskId and subscriptionId (cancel one specific subscription)
- Returns subscriptionId and status: "cancelled" (confirmation only, no extra info)

### Subscriber identity
- subscriberId is an explicit param on aof_task_subscribe (required)
- Free-form non-empty string -- no naming convention enforced ("coordinator", "swe-backend", etc.)
- For subscribe-at-dispatch: subscriber is inferred as the dispatching agent, no separate param needed

### Duplicate prevention
- Idempotent: if identical active subscription exists (same subscriberId + taskId + granularity), return the existing one
- No duplicate subscriptions created -- calling subscribe twice is safe

### Claude's Discretion
- Error handling patterns (what errors to throw, error messages)
- How to wire SubscriptionStore into AofMcpContext
- Test structure and organization
- Internal implementation of duplicate detection

</decisions>

<specifics>
## Specific Ideas

No specific requirements -- open to standard approaches following existing MCP tool patterns.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `SubscriptionStore` (src/store/subscription-store.ts): CRUD operations already built in Phase 28
- Subscription Zod schemas (src/schemas/subscription.ts): SubscriptionGranularity, TaskSubscription, SubscriptionsFile
- MCP tool registration pattern in src/mcp/tools.ts: Zod schema -> handler -> registerTool()

### Established Patterns
- Tool handlers: `handleAof*` async functions accepting `ctx: AofMcpContext` + parsed input
- Tool registration: `server.registerTool("name", { description, inputSchema }, handler)`
- Error handling: throw `McpError` with `ErrorCode` for failures
- Task resolution: `resolveTask(ctx.store, taskId)` finds task or throws

### Integration Points
- `src/mcp/shared.ts`: AofMcpContext needs SubscriptionStore added
- `src/mcp/adapter.ts`: Initialize SubscriptionStore in startup, wire into context
- `src/mcp/tools.ts`: Add new tool handlers and registrations
- `src/dispatch/aof-dispatch.ts`: Add subscribe param handling to dispatch flow

</code_context>

<deferred>
## Deferred Ideas

None -- discussion stayed within phase scope.

</deferred>

---

*Phase: 29-subscription-api*
*Context gathered: 2026-03-09*
