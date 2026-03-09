# Architecture: Task Notification Subscriptions (v1.8)

**Domain:** Agent orchestration platform -- task notification/callback integration
**Researched:** 2026-03-09
**Confidence:** HIGH (based on direct codebase analysis of all integration points)

## Design Premise

Agent sessions are ephemeral. When Agent A dispatches Task X and wants to know when it completes, Agent A's session will have ended long before Task X finishes. Therefore, "notification delivery" means **spawning a new agent session** with the task outcome as context -- the same mechanism the scheduler already uses for DAG hop dispatch and Murmur reviews.

This is not a pub/sub system in the traditional sense. It is a **subscription-triggered dispatch** system: the scheduler checks subscriptions at state transition time and spawns callback sessions.

## Recommended Architecture

### Component Boundaries

| Component | Responsibility | New/Modified | Communicates With |
|-----------|---------------|--------------|-------------------|
| **SubscriptionStore** | Persist/query task notification subscriptions as JSON co-located with task | NEW | TaskStore, Scheduler |
| **SubscriptionSchema** | Zod schema for subscription records | NEW | SubscriptionStore, MCP tools |
| **NotificationDispatcher** | Evaluate subscriptions on state transition, build `notify_subscriber` actions | NEW | SubscriptionStore, GatewayAdapter, EventLogger |
| **MCP tool: `aof_task_subscribe`** | Agent-facing API for creating subscriptions | NEW | SubscriptionStore |
| **MCP tool: `aof_dispatch`** | Extended with optional `subscribe` parameter | MODIFIED (additive) | SubscriptionStore |
| **Scheduler poll cycle** | Trigger notification evaluation after state transitions | MODIFIED (hook point) | NotificationDispatcher |
| **Action executor** | Execute `notify_subscriber` actions alongside existing action types | MODIFIED (new case in switch) | NotificationDispatcher, GatewayAdapter |
| **DAG transition handler** | Evaluate subscriptions on DAG completion | MODIFIED (hook after `persistWorkflowState`) | NotificationDispatcher |
| **EventLogger / Event schema** | New event types for subscription lifecycle | MODIFIED (additive) | NotificationDispatcher |

### Data Flow

```
Agent A calls aof_dispatch(title, ..., subscribe: "completion")
  |
  v
TaskStore.create() --> task file written to tasks/ready/TASK-xxx.md
SubscriptionStore.create() --> subscriptions.json written alongside task
  |
  v
[time passes, scheduler dispatches, agent completes task]
  |
  v
Task transitions to "done" (via aof_task_complete or DAG completion)
  |
  v
Post-transition hook:
  NotificationDispatcher.evaluate(taskId, newStatus)
    |
    v
  SubscriptionStore.getForTask(taskId) --> finds Agent A's subscription
    |
    v
  Builds callback TaskContext (task outcome, original subscription context)
    |
    v
  Returns notify_subscriber SchedulerAction
    |
    v
  Action executor: GatewayAdapter.spawnSession() --> new session for Agent A
    |
    v
  SubscriptionStore.markDelivered(subscriptionId)
  EventLogger.log("notification.delivered", ...)
```

---

## Integration Points: Detailed Analysis

### 1. Where Subscriptions Are Stored

**Recommendation: Filesystem JSON, co-located with the subscribed task.**

```
tasks/{status}/TASK-xxx.md                    -- task file (existing)
tasks/{status}/TASK-xxx/                      -- task artifacts dir (existing)
tasks/{status}/TASK-xxx/subscriptions.json    -- NEW
```

**Rationale:**
- Follows existing filesystem patterns (trace files in `TASK-xxx/trace-N.json`, work dirs in `TASK-xxx/work/`)
- Moves with the task during status transitions (the `store.transition()` method uses `rename()` which moves the entire directory atomically)
- No new storage mechanism -- reads/writes via `node:fs` + `write-file-atomic`
- Natural cleanup: when a task is deleted, subscriptions go with it
- Human-readable for debugging

**Schema (in `src/schemas/subscription.ts`):**

```typescript
const TaskSubscription = z.object({
  id: z.string().uuid(),
  taskId: z.string(),                       // Subscribed task ID
  subscriberId: z.string(),                 // Agent ID to callback
  subscriberRole: z.string().optional(),    // Role for dispatch routing
  granularity: z.enum(["completion", "all"]),
  createdAt: z.string().datetime(),
  createdBy: z.string(),                    // Agent that created subscription
  callbackContext: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["active", "delivered", "failed", "expired"]),
  deliveredAt: z.string().datetime().optional(),
  deliverySessionId: z.string().optional(),
  deliveryError: z.string().optional(),
});
```

**Why not a central subscription index?** A central file creates a synchronization problem. Task state lives in filesystem directories (`tasks/ready/`, `tasks/done/`). If subscriptions lived in a separate index, every `store.transition()` (which does an atomic `rename()`) would need to update the index -- fragile coupling. Co-location means subscriptions move with the task automatically.

**Trade-off acknowledged:** The query "show all subscriptions for Agent A" requires scanning task directories. This is acceptable because:
1. It is a rare diagnostic query, not a hot path
2. The hot path ("get subscriptions for task X that just transitioned") is O(1) file read
3. A diagnostic CLI command can afford the scan

### 2. How the Scheduler Delivers Notifications

**Recommendation: New `notify_subscriber` action type in the scheduler action pipeline.**

The scheduler has a clean separation: `poll()` builds `SchedulerAction[]`, `executeActions()` runs them. Notifications follow this exact pattern.

**Where evaluation happens -- two transition paths need hooks:**

**Path A: Simple task completion (non-DAG)**

The completion flow for non-DAG tasks:
1. Agent calls `aof_task_complete` tool
2. `task-workflow-tools.ts::aofTaskComplete()` transitions task to `done`
3. `dep-cascader.ts::cascadeOnCompletion()` promotes dependents

Hook point: After `cascadeOnCompletion()` returns. The cascader already runs synchronously after task completion. Add notification evaluation here.

Actually, this is cleaner: the **scheduler poll cycle** already detects tasks that transitioned to `done` between polls. Step 6.5 of `poll()` (lines 297-350 in `scheduler.ts`) already scans in-progress DAG tasks. Add a parallel step 6.6 that scans recently-completed tasks for pending notifications.

But there is a subtlety: completion happens **during agent sessions** (via `aof_task_complete` tool call), not during the poll cycle. The task transitions to `done` inside the MCP tool handler. The scheduler only discovers this on the next poll.

**Recommended approach: Evaluate notifications at two points:**

1. **Inline at completion time** (in `task-workflow-tools.ts::aofTaskComplete` or the protocol router): Read `subscriptions.json`, build notification actions, but do NOT dispatch inline. Instead, write a `pendingNotifications` array to task metadata.

2. **Scheduler poll executes notifications**: Step 6.6 scans tasks with `metadata.pendingNotifications`, creates `notify_subscriber` actions, and the action executor dispatches them.

Wait -- this is overcomplicating it. The simpler pattern (and what the codebase already does for DAG hops) is:

**Simplest viable approach: Post-completion hook that returns actions.**

The `handleDAGHopCompletion()` function already returns `readyHops` which the scheduler then dispatches. Similarly, notification evaluation should return actions that the scheduler dispatches. The key question is: where does the evaluation run?

**Final recommendation: NotificationDispatcher called from three hook points:**

```typescript
// Hook 1: In assign-executor onRunComplete (after enforcement/completion check)
// This catches BOTH happy path and enforcement path
const notifyActions = await notificationDispatcher.evaluate(taskId, newStatus);
// Store in a queue that the next poll() picks up

// Hook 2: In handleDAGHopCompletion (after DAG completes)
if (evalResult.dagStatus === "complete" || evalResult.dagStatus === "failed") {
  const notifyActions = await notificationDispatcher.evaluate(taskId, dagStatus);
}

// Hook 3: Scheduler poll step 6.6 (picks up any queued notifications)
// Process notify_subscriber actions
```

Actually, the cleanest approach that aligns with existing patterns:

**Use the `onRunComplete` callback.** It already fires after every session completion. It already re-reads the task to check current status. It is the single point where AOF knows a session ended. Add notification evaluation here:

```typescript
// In onRunComplete callback (assign-executor.ts):
// After existing logic (enforcement, trace capture, etc.):
const freshTask = await store.get(taskId);
if (freshTask && isTerminalStatus(freshTask.frontmatter.status)) {
  await notificationDispatcher.evaluateAndDispatch(freshTask, executor);
}
```

This fires for simple tasks. For DAG tasks, the equivalent hook is in `dag-transition-handler.ts::dispatchDAGHop`'s `onRunComplete` callback. When the last hop completes and the DAG reaches terminal state, evaluate notifications.

**Important: The dispatcher itself calls `executor.spawnSession()` directly, not through the scheduler action pipeline.** This avoids the poll-cycle latency. It follows the same pattern as `dispatchDAGHop()` which also calls `executor.spawnSession()` directly.

The notification dispatch is best-effort: if `spawnSession()` fails, log the error and mark the subscription as `failed`. Do not retry (the subscriber can re-subscribe if needed). This keeps the system simple and avoids infinite retry loops for notification delivery.

### 3. Interaction with DAG Workflows

DAG workflows create interesting notification semantics. A task with a DAG goes through multiple hop completions before reaching terminal state.

| Granularity | Hop completion | DAG complete | DAG failed | Task blocked/deadletter |
|-------------|---------------|--------------|------------|------------------------|
| `completion` | No | Yes | Yes | No |
| `all` | Yes (with hop context) | Yes | Yes | Yes |

**For `completion` granularity:** Only fires when DAG reaches terminal state (`complete` or `failed`). The hook is in `handleDAGHopCompletion()` when `evalResult.dagStatus` is set.

**For `all` granularity:** Fires on every hop state change. The hook is in `handleDAGHopCompletion()` after every evaluation, regardless of DAG status. Each notification includes hop-specific context:

```typescript
{
  type: "hop_completed",
  hopId: "implement",
  hopOutcome: "complete",
  hopResult: { ... },
  dagStatus: "running",
  readyHops: ["review"],
}
```

**Integration in `handleDAGHopCompletion()`:**

```typescript
// After evaluateDAG and persistWorkflowState:
const subscriptions = await subscriptionStore.getForTask(task.frontmatter.id);

for (const sub of subscriptions) {
  if (sub.status !== "active") continue;

  const shouldNotify =
    sub.granularity === "all" ||
    (sub.granularity === "completion" && evalResult.dagStatus !== undefined);

  if (shouldNotify) {
    await notificationDispatcher.deliver(sub, task, {
      hopId, outcome: hopEvent.outcome, dagStatus: evalResult.dagStatus,
    });
  }
}
```

### 4. Interaction with Completion Enforcement

Completion enforcement (v1.5) catches agents exiting without `aof_task_complete`. The task transitions to `blocked` or `deadletter`.

**Rule: Do NOT dispatch notification callbacks during enforcement.**

The enforcement callback (`onRunComplete`) runs in the GatewayAdapter's completion context. Spawning new sessions from within it is safe (the DAG hop dispatch already does this), BUT notification callbacks for enforcement transitions should only fire for `granularity: "all"` subscriptions. A task that gets enforcement-blocked is not "completed" -- notifying completion subscribers would be misleading.

For `all` subscribers, enforcement transitions ARE delivered:
```typescript
{
  type: "task_enforcement",
  taskId: "TASK-xxx",
  newStatus: "blocked",
  reason: "agent_exited_without_completion",
  enforcementAt: "...",
}
```

### 5. Interaction with Dependency Cascade

When Task X completes, `cascadeOnCompletion()` promotes dependent tasks from backlog/blocked to ready. If Agent A subscribed to Task X with `completion` granularity, the notification callback should include information about what was promoted:

```typescript
{
  type: "task_completed",
  taskId: "TASK-xxx",
  finalStatus: "done",
  cascadeResult: {
    promoted: ["TASK-yyy", "TASK-zzz"],
    skipped: [],
  },
}
```

This requires `cascadeOnCompletion()` to return its `CascadeResult` (it already does -- line 38 of `dep-cascader.ts`) and passing it to the notification context.

### 6. MCP Tool Design

**New tool: `aof_task_subscribe`**

```typescript
const subscribeInputSchema = z.object({
  taskId: z.string().min(1),
  granularity: z.enum(["completion", "all"]).default("completion"),
  callbackContext: z.record(z.string(), z.unknown()).optional(),
  actor: z.string().optional(),
});
```

Return value:
```typescript
{
  subscriptionId: "uuid",
  taskId: "TASK-xxx",
  granularity: "completion",
  status: "active",
}
```

**Extended `aof_dispatch` tool:**

Add optional `subscribe` field:
```typescript
const dispatchInputSchema = z.object({
  // ... existing fields ...
  subscribe: z.enum(["completion", "all"]).optional(),
});
```

When `subscribe` is set, `handleAofDispatch()` creates both the task and a subscription atomically. This is the primary UX -- Agent A dispatches and subscribes in one call.

**SKILL.md update:**

Add guidance for when agents should subscribe:
```
When dispatching tasks you need results from, use subscribe: "completion" to
receive a callback with the outcome. Do not poll for task status.
```

---

## Patterns to Follow

### Pattern 1: Filesystem Co-location

**What:** Store related data alongside the entity it belongs to.
**When:** Data lifecycle is coupled to the entity.
**Existing examples:**
- Task work artifacts in `TASK-xxx/work/` directory
- Trace files in `TASK-xxx/trace-N.json`
- Subscriptions in `TASK-xxx/subscriptions.json` (new, follows same pattern)

### Pattern 2: Scheduler Action Types

**What:** Define action types, build them in evaluation, execute in action-executor.
**When:** Any new scheduler-driven operation.
**Example in codebase:** `SchedulerAction.type` union includes `assign`, `expire_lease`, `promote`, `murmur_create_task`, etc.
**Apply:** Add `notify_subscriber` to the union, with execution in action-executor's switch.

However, as noted above, the recommended approach for low-latency notification delivery is to dispatch directly from the `onRunComplete` callback, bypassing the poll cycle. The `notify_subscriber` action type is still useful as a **fallback** -- if inline dispatch fails, the scheduler can retry on the next poll.

### Pattern 3: Best-Effort Delivery (Never Block State Transitions)

**What:** Notification delivery failures must never prevent task state advancement.
**Existing example:** Trace capture (v1.5) wraps every call in try/catch: "Trace capture must never crash the scheduler."
**Apply:** Same pattern for notification dispatch:
```typescript
try {
  await notificationDispatcher.deliver(subscription, task, executor);
} catch {
  // Log failure, mark subscription as failed, continue
}
```

### Pattern 4: Schema-First with Zod

**What:** Define Zod schema, derive TypeScript types, validate at boundaries.
**Existing pattern:** Every schema in `src/schemas/` follows this.
**Apply:** `TaskSubscription` schema, callback context shape.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: In-Memory Subscription Registry

**What:** Store subscriptions in a `Map` within the scheduler process.
**Why bad:** Lost on restart. AOF is restart-safe by design -- all state must survive daemon restarts via filesystem persistence.
**Instead:** `subscriptions.json` co-located with task files.

### Anti-Pattern 2: Dispatch During `onRunComplete` Without Concurrency Awareness

**What:** Spawning callback sessions from `onRunComplete` without checking the concurrency limit.
**Why bad:** If 3 tasks complete simultaneously and each has 2 subscribers, that is 6 new sessions -- potentially exceeding `maxConcurrentDispatches`.
**Instead:** Check concurrency before dispatching. If at limit, queue for next poll cycle via task metadata flag.

### Anti-Pattern 3: Central Subscription Database

**What:** Separate SQLite or JSON file indexing all subscriptions globally.
**Why bad:** Creates synchronization between task state (filesystem directories) and subscription state (database). Task `rename()` transitions must update the index -- fragile coupling. AOF explicitly chose "no external database" (project constraint).
**Instead:** Co-locate with task files.

### Anti-Pattern 4: Unbounded Callback Chains

**What:** A callback session subscribes to another task, which triggers another callback, ad infinitum.
**Why bad:** Resource exhaustion, unpredictable behavior.
**Instead:** Track subscription depth in metadata. Callback sessions can create new subscriptions (agents need this), but enforce a maximum chain depth (3 levels). The `callbackContext` carries a `depth` counter incremented on each callback dispatch.

### Anti-Pattern 5: Notifications That Block Task State

**What:** Making task state transitions depend on successful notification delivery.
**Why bad:** A failed callback spawn would prevent task completion.
**Instead:** Notifications are fire-and-forget with logging. Failed delivery is recorded in `subscriptions.json` (status: "failed"), task state advances regardless.

---

## Suggested Build Order

Build order respects dependencies between components:

### Phase 1: Schema + Store (no existing code changes)
1. `TaskSubscription` Zod schema in `src/schemas/subscription.ts`
2. `SubscriptionStore` in `src/store/subscription-store.ts`
   - `create(taskId, subscription)` -- writes/appends to `subscriptions.json`
   - `getForTask(taskId)` -- reads active subscriptions for a task
   - `markDelivered(taskId, subscriptionId, sessionId)` -- updates status
   - `markFailed(taskId, subscriptionId, error)` -- updates status
3. Unit tests: CRUD, co-location with task directories, status transitions

### Phase 2: NotificationDispatcher (core logic, no scheduler integration)
4. `NotificationDispatcher` in `src/dispatch/notification-dispatcher.ts`
   - `evaluate(task, transition)` -- returns subscriptions that match
   - `deliver(subscription, task, transition, executor)` -- spawns callback session
   - Builds `TaskContext` for callback with subscription context
5. Unit tests with MockAdapter: verify session spawned with correct context

### Phase 3: MCP Tools (agent-facing API)
6. `aof_task_subscribe` tool in `src/mcp/tools.ts`
7. `subscribe` parameter on `aof_dispatch` input schema
8. Tool handler tests

### Phase 4: Scheduler Integration (ties everything together)
9. New event types in `src/schemas/event.ts`: `notification.created`, `notification.delivered`, `notification.delivery_failed`
10. Hook in `assign-executor.ts` `onRunComplete`: after task reaches terminal status, evaluate and dispatch notifications
11. Hook in `dag-transition-handler.ts` `onRunComplete`: after DAG reaches terminal status, evaluate and dispatch
12. Integration tests: dispatch-with-subscribe -> complete -> verify callback spawned

### Phase 5: DAG `all` Granularity
13. Hook in `handleDAGHopCompletion()` for per-hop notifications to `all` subscribers
14. Tests: DAG task with `all` subscriber -> complete hop -> verify notification with hop context

### Phase 6: Edge Cases + Hardening
15. Concurrency gate: check `maxConcurrentDispatches` before notification dispatch, queue if at limit
16. Depth limiting for callback chains
17. `aof subscriptions <task-id>` CLI command for diagnostics
18. SKILL.md update with subscribe guidance
19. Subscription expiry cleanup for terminal tasks older than N days

### Build Dependency Graph

```
Phase 1 (schema + store)
  |
  v
Phase 2 (dispatcher) ----> Phase 3 (MCP tools)
  |
  v
Phase 4 (scheduler hooks) ----> Phase 5 (DAG all-granularity)
  |
  v
Phase 6 (hardening)
```

Phases 2 and 3 can run in parallel once Phase 1 is complete. Phase 5 depends on Phase 4 (needs the hook infrastructure). Phase 6 is incremental polish.

---

## Key Architectural Constraints

1. **No new storage mechanism.** Subscriptions use filesystem JSON, consistent with task store. No SQLite, no external DB.
2. **Best-effort delivery.** Failed notification delivery does not affect task state. Logged, not retried.
3. **Deterministic evaluation.** Subscription matching is a pure function: compare task status against subscription granularity. No LLM calls.
4. **Restart-safe.** All subscription state persists to disk. Daemon restart picks up where it left off. Pending notifications survive restarts because they are stored in task metadata or `subscriptions.json`.
5. **Concurrency-aware.** Notification callback sessions respect `maxConcurrentDispatches`. The dispatcher checks before spawning.
6. **No nested sessions.** Callback sessions are independent top-level sessions, same as any other dispatch. This satisfies the OpenClaw constraint.

---

## Sources

- Direct codebase analysis of `/Users/xavier/Projects/aof/src/`
- `dispatch/scheduler.ts` -- poll cycle, action pipeline, DAG hop dispatch (step 6.5)
- `dispatch/action-executor.ts` -- action execution switch, SchedulerAction type union
- `dispatch/assign-executor.ts` -- `onRunComplete` callback, session lifecycle
- `dispatch/dag-transition-handler.ts` -- DAG hop completion, `dispatchDAGHop()`, `onRunComplete`
- `dispatch/dag-evaluator.ts` -- DAG evaluation, `evaluateDAG()`, terminal status detection
- `dispatch/dep-cascader.ts` -- post-completion cascade, `CascadeResult` return
- `dispatch/executor.ts` -- `GatewayAdapter` contract, `TaskContext`, `SpawnResult`
- `store/interfaces.ts` -- `ITaskStore` contract, `transition()` method
- `schemas/task.ts` -- `TaskFrontmatter`, status transitions, metadata
- `schemas/workflow-dag.ts` -- `WorkflowState`, `WorkflowStatus`, hop state
- `schemas/event.ts` -- event type enum, `BaseEvent`
- `events/notifier.ts` -- existing system notification service (separate from task notifications)
- `events/notification-policy/` -- existing rule-based notification engine (for system alerts)
- `mcp/subscriptions.ts` -- existing MCP resource subscriptions (different feature: live resource updates over MCP protocol, not task outcome callbacks)
- `mcp/tools.ts` -- MCP tool registration patterns, `dispatchInputSchema`
- `tools/task-workflow-tools.ts` -- `aofTaskComplete` flow
- Confidence: HIGH -- all findings from direct code inspection with module-level references
