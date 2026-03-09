# Feature Landscape: Task Notification Subscriptions & Callback Delivery

**Domain:** Task-to-agent callback system for agent orchestration platform (AOF v1.8)
**Researched:** 2026-03-09

## Context

This is a SUBSEQUENT MILESTONE (v1.8). AOF already has:
- Task CRUD via `aof_dispatch` MCP tool with workflow params, context tiers, routing
- Task lifecycle with state transitions (`backlog -> ready -> in-progress -> review -> done -> deadletter`)
- DAG workflows with hop-based execution — scheduler dispatches each hop independently
- Completion enforcement — agents exiting without `aof_task_complete` are caught and blocked
- `GatewayAdapter.spawnSession()` for dispatching agent sessions with context
- `NotificationService` for system-level alerts (channel routing, deduplication) — NOT agent callbacks
- `SubscriptionManager` for MCP resource subscriptions (file-watch based, for MCP clients) — NOT task outcome callbacks
- JSONL event logging with `EventLogger` for all state transitions
- Filesystem-based task store with atomic `write-file-atomic` persistence
- OpenClaw constraint: no nested agent sessions

**The core problem:** Agents creating tasks must currently poll for results or use DAG workflows to chain work. There is no way for an agent to say "notify me when task X finishes" and receive a callback with the results. The subscription/callback mechanism must fit AOF's existing patterns: filesystem persistence, scheduler-driven dispatch, deterministic control plane.

---

## Table Stakes

Features that agents and operators expect from a task notification system. Missing any of these makes the feature feel incomplete compared to the DAG workaround.

### 1. Subscribe on Dispatch (`notify` parameter on `aof_dispatch`)

| Aspect | Detail |
|--------|--------|
| Why Expected | The primary use case. Agent A dispatches a task to Agent B and wants to know when it finishes. Adding `notify` to `aof_dispatch` follows the existing pattern of optional params like `workflow`, `contextTier`. |
| Complexity | LOW |
| Depends On | `aof_dispatch` input schema (`src/mcp/tools.ts`), `TaskFrontmatter` schema (`src/schemas/task.ts`) |

**What must change:**

Add `notify` parameter to dispatch input schema:
```typescript
notify: z.object({
  subscriberId: z.string(),       // agent ID to notify
  granularity: z.enum(["completion", "all"]).default("completion"),
}).optional()
```

On dispatch, write subscription to created task's frontmatter:
```typescript
subscriptions: [{
  subscriberId: "agent-a",
  granularity: "completion",
  createdAt: "2026-03-09T...",
  status: "pending",           // pending | delivered | failed
}]
```

**Confidence:** HIGH — follows established pattern of extending `aof_dispatch`.

---

### 2. Subscription Schema in Task Frontmatter

| Aspect | Detail |
|--------|--------|
| Why Expected | Subscriptions must persist with the task. If the scheduler crashes, pending subscriptions must survive restart. Task frontmatter is the single source of truth. |
| Complexity | LOW |
| Depends On | `TaskFrontmatter` Zod schema, `schemaVersion` bump, migration framework |

**Schema addition to `TaskFrontmatter`:**
```typescript
const TaskSubscription = z.object({
  subscriberId: z.string(),                              // agent to notify
  granularity: z.enum(["completion", "all"]),             // what to watch
  createdAt: z.string().datetime(),                      // when subscribed
  status: z.enum(["pending", "delivered", "failed"]),    // delivery state
  deliveredAt: z.string().datetime().optional(),         // when callback dispatched
  deliverySessionId: z.string().optional(),              // callback session ID
});

// Add to TaskFrontmatter:
subscriptions: z.array(TaskSubscription).default([]),
```

Subscriptions stored directly in task YAML. No separate registry. One source of truth per task.

**Confidence:** HIGH — extends existing schema pattern, follows filesystem-only constraint.

---

### 3. Completion-Only Granularity (`"completion"`)

| Aspect | Detail |
|--------|--------|
| Why Expected | The 90% use case. "Tell me when this task reaches done, cancelled, or deadletter." Agent dispatches work and wants the result. |
| Complexity | LOW |
| Depends On | State transition hooks in task store |

**Trigger conditions:** Task status transitions to one of: `done`, `cancelled`, `deadletter`.

These are terminal states (no further transitions possible per `VALID_TRANSITIONS`). The subscription fires once and is done.

**Confidence:** HIGH — terminal states are well-defined in existing schema.

---

### 4. All-Transitions Granularity (`"all"`)

| Aspect | Detail |
|--------|--------|
| Why Expected | Monitoring agents or manager agents tracking subordinate progress. Less common but expected as an option. |
| Complexity | MED |
| Depends On | State transition hooks, delivery queue |

**Key difference from completion:** Fires on every `task.transitioned` event. Must deliver multiple callbacks over the task lifecycle. Each delivery is a separate session dispatch.

**Edge case:** If a task transitions rapidly (`ready -> in-progress -> review -> done` within one poll cycle), should all transitions be delivered? Yes — batch them into one callback with transition history, not four separate sessions. This prevents session spawn storms.

**Confidence:** MEDIUM — the batching decision needs design attention.

---

### 5. Callback Delivery via Session Dispatch

| Aspect | Detail |
|--------|--------|
| Why Expected | OpenClaw has no nested sessions, no persistent agent connections, no message queues. The only way to "call back" an agent is to spawn a new session for them with results as context. This is how DAG hops already work. |
| Complexity | MED |
| Depends On | `GatewayAdapter.spawnSession()`, scheduler poll loop, `NotificationContext` builder |

**Delivery mechanism:** The scheduler, during its poll loop, checks for tasks with pending subscriptions that have reached their trigger condition. For each pending subscription, it spawns a new session to the subscriber agent with a `NotificationContext` payload.

This mirrors `dispatchDAGHop()` in `dag-transition-handler.ts` — build context, spawn session, update state on success.

**Callback session context must include:**
- Source task ID and title
- Final status (or transition history for `"all"` granularity)
- Completion summary (from `run_result.json` if available)
- Output files list (from task metadata)
- The subscriber's own identity (so it knows why it was spawned)

**Confidence:** HIGH — follows established dispatch pattern exactly.

---

### 6. At-Least-Once Delivery with Idempotency

| Aspect | Detail |
|--------|--------|
| Why Expected | If the scheduler crashes between detecting a trigger and delivering the callback, the subscription must retry on next poll. Exactly-once is impossible without distributed transactions. At-least-once with idempotent consumers is the industry standard. |
| Complexity | MED |
| Depends On | Subscription `status` field in task frontmatter, atomic write persistence |

**How it works:**

1. Task transitions to terminal state -> subscription `status` stays `"pending"`
2. Scheduler poll detects pending subscription on completed task -> attempts delivery
3. On successful spawn -> atomically update subscription `status` to `"delivered"` with `deliveredAt` timestamp and `deliverySessionId`
4. On spawn failure -> subscription stays `"pending"`, retried next poll
5. If scheduler crashes before step 3 -> subscription stays `"pending"`, retried after restart

**Agent-side idempotency:** Agents receiving a callback should check if they already processed the result (e.g., check if they already created a follow-up task for the source task ID). This is the agent's responsibility, documented in SKILL.md.

**Confidence:** HIGH — at-least-once with filesystem state is a well-understood pattern.

---

### 7. Subscription Cleanup and Audit Trail

| Aspect | Detail |
|--------|--------|
| Why Expected | Delivered subscriptions must not re-fire. Failed deliveries must not retry forever. The subscription record serves as an audit trail. |
| Complexity | LOW |
| Depends On | Subscription schema, delivery tracking |

**Rules:**
- Delivered subscriptions: `status: "delivered"`, `deliveredAt` set. Never re-fired.
- Failed deliveries: Retry up to 3 times (matching existing `maxDispatchRetries`). After 3 failures, set `status: "failed"`. Emit event.
- Audit: Subscriptions stay in task frontmatter permanently. Visible via `aof trace` or direct task file inspection.

**Confidence:** HIGH — mirrors existing failure tracking pattern in `failure-tracker.ts`.

---

## Differentiators

Features that go beyond basic expectations. Not required for MVP but add meaningful value.

| Feature | Value Proposition | Complexity | Dependencies | Notes |
|---------|-------------------|------------|--------------|-------|
| **`aof_subscribe` tool** | Subscribe to tasks not created by the current agent. Manager agents monitoring subordinates. | LOW | New MCP tool, task frontmatter write | Lower priority because dispatch-time subscription covers 90% of cases. |
| **Filtered subscriptions** | "Notify me only on failure" — `filter: { outcomes: ["deadletter", "cancelled"] }`. Reduces noise for agents only interested in error cases. | LOW | Schema extension to `TaskSubscription` | Easy to add later. Optional `filter` field. |
| **Callback retry with backoff** | If notification delivery fails, retry with jittered backoff matching existing dispatch retry pattern. | MED | Existing `failure-tracker.ts` | Reuse `trackDispatchFailure` / `shouldTransitionToDeadletter` pattern. |
| **Notification delivery trace** | Capture trace data for notification-spawned sessions. Debug "my callback never arrived." | LOW | Existing `captureTrace` infrastructure | Should come for free if callbacks go through standard dispatch path. |
| **Unsubscribe tool** | Cancel a subscription before delivery. Prevents unnecessary session spawns. | LOW | MCP tool to update subscription status to `"cancelled"` | Edge case. Most subscriptions complete quickly. |
| **Batch notification coalescing** | If agent subscribes to 5 tasks and 3 complete in one poll cycle, deliver one callback with all 3 results. | HIGH | Notification queue, batch assembly, new context format | Significant complexity. Defer unless session spawn cost is a bottleneck. |
| **Cross-task query-based subscriptions** | "Notify me when ANY task tagged `deploy` completes." | HIGH | Separate subscription registry, query engine | Fundamentally different model (topic-based vs point-to-point). Defer to v2. |

---

## Anti-Features

Features to explicitly NOT build for v1.8.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Webhook/HTTP callback endpoints** | AOF is filesystem-based, single-machine, no HTTP server. Health endpoint uses Unix socket. Adding HTTP callbacks violates architecture constraints. | Deliver callbacks via `GatewayAdapter.spawnSession()` — the existing dispatch path. |
| **Real-time push (WebSocket/SSE)** | Agents are spawned sessions, not persistent processes. No long-lived connections to push to. The MCP `SubscriptionManager` handles real-time for MCP clients — that is a different layer for a different audience. | Scheduler poll-based delivery. Callbacks arrive as new sessions. |
| **LLM-driven notification routing** | "Let an LLM decide who to notify" violates the deterministic control plane constraint. | Subscriptions are explicit. Subscriber ID recorded at subscribe time. No inference. |
| **Email/Slack/Matrix callback delivery** | The existing `NotificationService` handles system-level operator alerts to channels. Task-to-agent callbacks are a different concern — they must spawn agent sessions, not send messages to humans. | Keep `NotificationService` for operator alerts. Subscription system delivers to agents via session dispatch. |
| **Separate subscription database (SQLite)** | Tempting for query-based subscriptions. Violates filesystem-only constraint. Adds operational complexity. | Store subscriptions in task frontmatter YAML. One file, one source of truth per task. |
| **Exactly-once delivery** | Impossible without distributed transactions. Not worth the complexity for a single-machine filesystem system. | At-least-once with idempotent agents. Document in SKILL.md: "You may receive duplicate callbacks. Check if you already processed the source task." |
| **Nested session callbacks** | OpenClaw does not support nested agent sessions. Cannot deliver a callback into a running session. | Callbacks are independent sessions dispatched by the scheduler. The subscribing agent is NOT currently running — it receives a new session. |
| **Persistent agent mailbox** | Building a queue of undelivered messages for each agent. Over-engineers the problem. | Subscriptions live on the source task. Scheduler scans completed tasks for pending subscriptions. No separate per-agent queue needed. |

---

## Feature Dependencies

```
aof_dispatch `notify` param ──> Subscription schema in TaskFrontmatter
                                    |
aof_subscribe tool (later) ────────>|
                                    |
                                    v
                          Subscription persistence (in task YAML)
                                    |
                                    v
                          State transition detection
                          (scheduler checks completed tasks for pending subs)
                                    |
                                    v
                          NotificationContext builder
                          (assemble payload: source task, status, summary, outputs)
                                    |
                                    v
                          Scheduler notification delivery
                          (new phase in poll loop: scan + dispatch callbacks)
                                    |
                                    v
                          GatewayAdapter.spawnSession (callback delivery)
                                    |
                                    v
                          Delivery tracking
                          (mark subscription delivered/failed in task frontmatter)
```

### Build Order Implications

1. **Subscription schema must come first** — everything reads/writes this schema.
2. **`aof_dispatch` notify param is the primary entry point** — agents need a way to create subscriptions.
3. **State transition detection and notification delivery are the scheduler changes** — the core engine. Must be in the same phase since detection without delivery is useless.
4. **NotificationContext builder is the payload** — follows `HopContext` pattern from DAG workflows. Required for delivery to be meaningful.
5. **Delivery tracking closes the loop** — marks subscriptions delivered, prevents re-fire.
6. **`aof_subscribe` tool is additive** — can ship after the core loop works.

---

## MVP Recommendation

### Phase 1: Foundation (schema + subscribe API)

1. **Subscription schema** in `TaskFrontmatter` — `TaskSubscription` Zod schema, `subscriptions` array field, schema version consideration.
2. **`notify` parameter on `aof_dispatch`** — When present, write subscription to created task's frontmatter alongside task creation.
3. **Event type additions** — Add `notification.pending`, `notification.delivered`, `notification.failed` to `EventType` enum.

Rationale: Establishes the data model. Agents can start creating subscriptions even before delivery works.

### Phase 2: Delivery engine (scheduler + context)

4. **NotificationContext builder** — Assemble callback payload: source task ID, title, final status, completion summary, outputs. Follow `HopContext` / `buildHopContext()` pattern.
5. **Scheduler notification delivery phase** — New step in poll loop: scan tasks in terminal states (`done`, `cancelled`, `deadletter`) for pending subscriptions. For each, spawn callback session to subscriber agent. Mark delivered on success.
6. **Delivery failure handling** — Track delivery failures per subscription. Retry up to 3 times. Mark `"failed"` after exhausting retries. Emit `notification.failed` event.

Rationale: The core engine. After this phase, the full subscribe-trigger-deliver loop works end-to-end.

### Phase 3: Polish (additional APIs + SKILL.md)

7. **`aof_subscribe` tool** — Subscribe to tasks not created by the current agent. Separate MCP tool.
8. **SKILL.md callback guidance** — Document callback behavior: "You may be spawned as a notification callback. Check the notification context to understand why."
9. **`all` granularity delivery** — Batch state transitions into single callback per poll cycle for `"all"` subscriptions.

Rationale: Expands the API surface and handles the less common use cases.

### Defer:
- **Filtered subscriptions** — Easy schema extension, add when agents request it
- **Batch coalescing** — Premature optimization unless session spawn cost proves problematic
- **Query-based subscriptions** — Fundamentally different model, v2
- **Unsubscribe** — Edge case, add on demand

---

## Key Observations from Codebase

1. **DAG hop dispatch is the closest analogue.** `dispatchDAGHop()` in `dag-transition-handler.ts` already builds context, spawns a session, and updates state atomically on success. Notification delivery should follow this exact pattern.

2. **The scheduler poll loop is the natural home.** The scheduler already scans all tasks, checks leases, promotes tasks, and dispatches work. Adding a "check pending notifications" phase fits cleanly after completion processing.

3. **Existing `NotificationService` is for operators, not agents.** It routes to channels (`#aof-dispatch`, `#aof-alerts`), deduplicates, and formats human-readable messages. Task-to-agent callbacks are a completely separate system despite sharing the word "notification."

4. **MCP `SubscriptionManager` is for MCP resource changes, not task outcomes.** It watches the filesystem and sends `notifications/resources/updated` to MCP clients. Different audience, different mechanism. No code reuse.

5. **Task frontmatter is the right persistence layer.** Subscriptions are per-task data. Storing them in frontmatter means they are: persisted atomically with the task, visible in task files, backed up with tasks, cleaned up when tasks are archived.

6. **`write-file-atomic` is already used everywhere.** The delivery tracking update (marking subscription as delivered) uses the same atomic write pattern as DAG state persistence.

7. **The `onRunComplete` callback fires AFTER task completion.** This is where completion enforcement runs. It is also where notification checks should trigger — detecting that a task reached a terminal state.

8. **Schema version may need a bump.** Adding `subscriptions` to frontmatter is a schema extension. However, it defaults to `[]`, so old tasks parse fine without migration. A migration may not be needed if the field is optional with a default.

---

## Sources

- AOF codebase: `src/schemas/task.ts` — task frontmatter schema, valid transitions, terminal states (HIGH confidence)
- AOF codebase: `src/dispatch/dag-transition-handler.ts` — analogous pattern for hop dispatch with context, spawn, atomic state update (HIGH confidence)
- AOF codebase: `src/dispatch/scheduler.ts` — poll loop structure, action types, scheduler config (HIGH confidence)
- AOF codebase: `src/events/notifier.ts` — existing notification service for operator alerts, NOT agent callbacks (HIGH confidence)
- AOF codebase: `src/mcp/subscriptions.ts` — MCP resource subscriptions, different layer (HIGH confidence)
- AOF codebase: `src/mcp/tools.ts` — dispatch input schema, tool registration pattern (HIGH confidence)
- AOF codebase: `src/dispatch/executor.ts` — `GatewayAdapter` interface, `TaskContext`, `SpawnResult` (HIGH confidence)
- AOF codebase: `src/dispatch/aof-dispatch.ts` — dispatch flow: get task, assemble context, transition, spawn (HIGH confidence)
- [At-Least-Once Delivery patterns](https://www.cloudcomputingpatterns.org/at_least_once_delivery/) — delivery guarantee design (MEDIUM confidence)
- [You Cannot Have Exactly-Once Delivery](https://bravenewgeek.com/you-cannot-have-exactly-once-delivery/) — rationale for at-least-once (MEDIUM confidence)
- [AI Agent Orchestration Patterns - Azure](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns) — event-driven agent communication patterns (MEDIUM confidence)

---
*Feature research for: AOF v1.8 Task Notifications & Callback Delivery*
*Researched: 2026-03-09*
