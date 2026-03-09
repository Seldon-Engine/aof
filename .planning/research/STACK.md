# Technology Stack

**Project:** AOF v1.8 Task Notification Subscriptions & Callback Delivery
**Researched:** 2026-03-09
**Scope:** Stack additions/changes for task completion/failure callbacks, agent notification delivery, subscription storage, and event integration

## Executive Assessment

**No new runtime dependencies required.** The existing stack covers all needs for v1.8. Task notification subscriptions are stored as metadata on task frontmatter (filesystem-native). Callback delivery reuses the existing `GatewayAdapter.spawnSession()` mechanism to dispatch a notification session to the subscribing agent. Event integration hooks into the existing `EventLogger.onEvent` callback and `NotificationPolicyEngine` pipeline.

The key architectural insight: "notification delivery" in AOF means "spawn a new agent session with the completion/failure result as context." There is no push channel, no WebSocket, no HTTP callback -- the scheduler dispatches a session to the subscribing agent, exactly like it dispatches any other task hop. This keeps the design within AOF's existing patterns and constraints (no nested sessions, deterministic control plane, filesystem-based).

**Confidence:** HIGH -- all capabilities verified against installed packages, existing codebase patterns, and AOF constraints.

## Existing Stack (Confirmed Sufficient)

| Technology | Installed | Purpose for v1.8 | Status |
|------------|-----------|-------------------|--------|
| Node.js | 22 (pinned) | `fs/promises` for subscription storage, `crypto.randomUUID` for subscription IDs | Sufficient |
| TypeScript | 5.7.x | Type-safe subscription schemas, callback context types | Sufficient |
| zod | 3.24.x | Subscription schema validation, callback payload schemas | Sufficient |
| write-file-atomic | 7.x | Atomic task file writes when adding/removing subscriptions | Sufficient |
| yaml | 2.7.x | Task frontmatter serialization (subscriptions live in frontmatter metadata) | Sufficient |
| gray-matter | 4.0.3 | Task file parsing for subscription reads | Sufficient |
| commander | 14.0.x | `aof subscribe` / `aof unsubscribe` CLI commands (if needed) | Sufficient |
| vitest | 3.0.x | Unit/integration tests for subscription lifecycle, delivery, integration | Sufficient |
| @modelcontextprotocol/sdk | 1.26.x | MCP tool registration for `aof_subscribe` / `aof_unsubscribe` | Sufficient |

## What Each v1.8 Feature Needs

### 1. Subscription Storage

**What:** Store which agents want to be notified about which task outcomes. Two granularity levels: `"completion"` (success/failure only) and `"all"` (every state transition).

**Stack needed:** Existing only.

**Storage approach -- task frontmatter metadata:**

Subscriptions are stored as a `subscriptions` array in the watched task's frontmatter metadata. This is the natural choice because:
- Subscriptions are per-task data (co-located with the task they watch)
- No new storage system needed (no SQLite table, no separate JSON file)
- Atomic with task state transitions (write-file-atomic)
- Survives restarts (filesystem-based, same as all AOF state)
- Cleaned up automatically when tasks reach terminal states

```typescript
// New Zod schema for subscription records
const TaskSubscription = z.object({
  id: z.string().uuid(),
  subscriberAgent: z.string().min(1),       // Agent ID to notify
  subscriberTaskId: z.string().optional(),   // Task that triggered the subscription (for context)
  granularity: z.enum(["completion", "all"]),
  createdAt: z.string().datetime(),
  createdBy: z.string(),                     // Agent that created the subscription
});
```

**Why NOT a separate subscription store:**
- A separate `subscriptions.json` or SQLite table introduces a second source of truth
- Subscriptions must survive task moves between status directories -- frontmatter moves with the file
- The task file is already atomically written on every state change via `write-file-atomic`
- No cross-task subscription queries are needed (subscriptions fire when the watched task changes)

**Why NOT the MCP SubscriptionManager:**
- The existing `src/mcp/subscriptions.ts` handles MCP resource subscriptions (real-time, in-session, protocol-level)
- Task notification subscriptions are durable (persist across restarts) and trigger agent sessions
- These are fundamentally different: MCP subscriptions = protocol notification within an active session; task subscriptions = spawn a new session when a task completes

### 2. Subscription Registration (MCP Tool)

**What:** Let agents subscribe to task outcomes via `aof_subscribe` and unsubscribe via `aof_unsubscribe`.

**Stack needed:** Existing only.
- `@modelcontextprotocol/sdk` for tool registration (same pattern as `aof_dispatch`, `aof_task_complete`)
- `zod` for input validation
- `write-file-atomic` for atomic task file update

**Tool signatures:**

```typescript
// aof_subscribe
const subscribeInput = z.object({
  taskId: z.string(),                          // Task to watch
  granularity: z.enum(["completion", "all"]).default("completion"),
  actor: z.string().optional(),                // Subscribing agent (auto-detected from session)
});

// aof_unsubscribe
const unsubscribeInput = z.object({
  taskId: z.string(),                          // Task being watched
  subscriptionId: z.string().optional(),       // Specific subscription (or remove all for this agent)
  actor: z.string().optional(),
});
```

**Integration:** Follows exact pattern of `aof_task_dep_add` / `aof_task_dep_remove` -- read task, mutate metadata, write atomically.

### 3. Notification Delivery (Session Dispatch)

**What:** When a watched task reaches a notifiable state, spawn a new agent session to the subscribing agent with the outcome as context.

**Stack needed:** Existing only.
- `GatewayAdapter.spawnSession()` -- the same mechanism used for task dispatch and DAG hop dispatch
- `EventLogger` -- for logging delivery events
- Task context builder -- formats the notification payload as task instructions

**Delivery mechanism:**

The scheduler already has the `onRunComplete` callback pattern (used in `dag-transition-handler.ts` and `assign-executor.ts`). When a task transitions to a notifiable state:

1. Read the task's `subscriptions` from frontmatter metadata
2. For each subscription matching the granularity:
   a. Build a `TaskContext` with the outcome as context (task ID, final status, summary, outputs)
   b. Call `executor.spawnSession()` to dispatch a notification session to the subscribing agent
   c. Log a `notification.delivered` event
   d. Remove the subscription (one-shot for `"completion"`, keep for `"all"`)

**Why spawn a session (not a push notification):**
- OpenClaw constraint: no nested sessions. The subscribing agent cannot receive a callback during an active session.
- Spawning a session IS the callback. The agent wakes up, gets the notification context, and can act on it.
- This reuses 100% of existing dispatch infrastructure (lease management, timeout handling, failure tracking).
- The subscribing agent gets the same environment it would for any other task -- tools, memory, org chart access.

**Notification context (passed as task instructions):**

```typescript
const notificationContext = {
  type: "task_notification",
  watchedTaskId: string,
  watchedTaskStatus: TaskStatus,
  watchedTaskTitle: string,
  outcome: "completed" | "failed" | "transitioned",
  summary?: string,           // From aof_task_complete summary
  outputs?: string[],         // Task output artifacts
  transition?: { from: string; to: string },  // For "all" granularity
  subscriberTaskId?: string,  // The subscriber's own task context
};
```

### 4. Event Integration

**What:** Hook notification delivery into the existing event pipeline so subscriptions fire at the right time.

**Stack needed:** Existing only.
- `EventLogger.onEvent` callback -- already used for notification dispatch
- New event types in `EventType` Zod enum
- `NotificationPolicyEngine` -- can route subscription delivery events for operator visibility

**Integration points:**

**A. Task state transition hook (primary trigger):**
The `TaskStore.transition()` method emits `task.transitioned` events. The scheduler's `action-executor.ts` handles completion transitions. The notification check hooks in at the same point where `cascadeOnCompletion()` runs in `dep-cascader.ts` -- after a task reaches a terminal or notifiable state.

**B. DAG hop completion hook:**
For DAG workflows, `handleDAGHopCompletion()` in `dag-transition-handler.ts` processes hop completions. Subscriptions should also fire when the entire DAG completes (not per-hop).

**C. New event types:**

```typescript
// Add to EventType enum in schemas/event.ts:
"notification.subscription_created",   // Agent subscribed to a task
"notification.subscription_removed",   // Subscription removed (manual or one-shot consumed)
"notification.delivered",              // Notification session dispatched
"notification.delivery_failed",        // Notification dispatch failed
```

**D. Notification policy rules:**
Add rules to `DEFAULT_RULES` for the new event types so operators see subscription activity in their notification channels.

### 5. Scheduler Integration

**What:** The scheduler must check for pending notification deliveries during each poll cycle.

**Stack needed:** Existing only.

**Approach:** Add a notification delivery step to the scheduler's `poll()` function, after the existing action execution and DAG hop dispatch steps. This follows the same pattern as murmur evaluation (step 9 in `scheduler.ts`).

The scheduler already lists all tasks each poll. For tasks that just transitioned to a notifiable state, check for subscriptions and queue delivery actions.

**Trigger detection:** Use the `task.transitioned` events logged during the current poll cycle (available in the `actions` array) to identify which tasks just changed state. For each, check the task's `subscriptions` metadata.

## What NOT to Add

| Library | Why Not |
|---------|---------|
| `bullmq` / `bee-queue` | No Redis, no external queue -- filesystem-based constraint. Notification delivery IS session dispatch. |
| `node-cron` / `agenda` | Scheduler already polls on interval. No separate scheduling system needed. |
| `ws` / `socket.io` | No WebSocket push. Agents receive notifications as spawned sessions. |
| `nodemailer` / `sendgrid` | Notifications go to agents (session dispatch), not humans (email). |
| `eventemitter3` | Node.js built-in `EventEmitter` sufficient, but not even needed -- the EventLogger's `onEvent` callback is the hook. |
| `uuid` | Node.js 22 has `crypto.randomUUID()` built-in. |
| `rxjs` | Reactive patterns add complexity. The poll-based scheduler is the right delivery loop. |
| Any pub/sub library | AOF is single-machine, single-process. No inter-process messaging needed. |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Subscription storage | Task frontmatter metadata | Separate subscriptions.json | Second source of truth; doesn't move with task file |
| Subscription storage | Task frontmatter metadata | SQLite table | Violates filesystem-based principle; adds query complexity for simple per-task data |
| Delivery mechanism | Session dispatch via `spawnSession()` | MCP notification (`sendNotification`) | MCP notifications only work within active sessions; subscriptions need to wake agents |
| Delivery mechanism | Session dispatch via `spawnSession()` | Write to agent's "inbox" directory | Agent would need to poll; session dispatch is immediate and reuses existing infra |
| Trigger mechanism | Scheduler poll cycle check | `EventLogger.onEvent` callback | Callback fires synchronously during event logging; dispatch should be in scheduler's async context |
| Trigger mechanism | Scheduler poll cycle check | Filesystem watcher (like MCP SubscriptionManager) | Adds another watcher; scheduler already scans all tasks every poll |
| Subscription scope | Per-task (frontmatter) | Global registry | Per-task is simpler; no cross-referencing needed; cleaned up with task lifecycle |

## Integration Points with Existing Stack

### TaskFrontmatter Schema Extension

Add `subscriptions` field to task frontmatter metadata (not a top-level field -- use the existing `metadata` bag to avoid schema migration):

```typescript
// In task metadata (no schema migration needed):
metadata: {
  subscriptions: TaskSubscription[],
  // ... existing metadata fields
}
```

**Why metadata, not a top-level field:** Adding a top-level frontmatter field would require a schema version bump (v2 -> v3), migration logic, and backward compatibility handling. The `metadata` bag is `z.record(z.string(), z.unknown())` -- it accepts arbitrary keys with no migration needed.

### EventType Enum Extension

Add four new event types to `src/schemas/event.ts`. No schema changes beyond enum extension.

### Scheduler Extension

Add a new step after DAG hop dispatch (step 6.5) and before murmur evaluation (step 9). Pattern mirrors `evaluateMurmurTriggers()`:

```
Step 6.7: Notification delivery
  - For each task that transitioned this poll cycle:
    - Read task subscriptions from metadata
    - For each matching subscription:
      - Build notification TaskContext
      - Call executor.spawnSession() (respects concurrency limits)
      - Log notification.delivered event
      - Remove subscription if one-shot (completion granularity)
```

### MCP Tool Registration

Register `aof_subscribe` and `aof_unsubscribe` in `src/mcp/tools.ts` following the exact pattern of `aof_task_dep_add` / `aof_task_dep_remove`.

### NotificationPolicyEngine Rules

Add four new rules to `DEFAULT_RULES` in `src/events/notification-policy/rules.ts` for operator visibility of subscription activity.

### SKILL.md Update

Add `aof_subscribe` and `aof_unsubscribe` tool descriptions to the compressed SKILL.md. Budget impact: ~50-80 tokens (two one-liner tool descriptions). Well within the 2150-token ceiling.

## File Organization (Recommended)

```
src/
  notifications/
    schemas.ts            # TaskSubscription Zod schema
    subscription-store.ts # Read/write subscriptions in task metadata
    delivery.ts           # Build notification context, dispatch sessions
    index.ts              # Public API
    __tests__/
      schemas.test.ts
      subscription-store.test.ts
      delivery.test.ts
      integration.test.ts
```

## Concurrency and Edge Cases

**Concurrency limit awareness:** Notification deliveries must respect the same `maxConcurrentDispatches` limit as regular task dispatch. If the scheduler is at capacity, notifications queue for the next poll cycle (subscriptions persist in frontmatter, so nothing is lost).

**Terminal state cleanup:** When a task reaches `done` or `cancelled`, all `"all"` granularity subscriptions should be removed. `"completion"` subscriptions are consumed on delivery.

**Self-subscription prevention:** An agent should not be able to subscribe to its own currently-dispatched task (it will get the completion result via `aof_task_complete`). Validate at subscription time.

**Delivery failure handling:** If `spawnSession()` fails for a notification, the subscription persists (not consumed). The scheduler retries on the next poll cycle, same as failed task dispatches. After N failures, log `notification.delivery_failed` and remove the subscription to prevent infinite retries.

## Sources

- Task schema: `src/schemas/task.ts` -- TaskFrontmatter with `metadata: z.record(z.string(), z.unknown())`
- Event schema: `src/schemas/event.ts` -- EventType Zod enum
- Scheduler: `src/dispatch/scheduler.ts` -- poll cycle structure, murmur evaluation pattern
- DAG transition handler: `src/dispatch/dag-transition-handler.ts` -- `handleDAGHopCompletion()`, `dispatchDAGHop()`
- Action executor: `src/dispatch/action-executor.ts` -- `executeActions()`, completion cascade
- GatewayAdapter: `src/dispatch/executor.ts` -- `spawnSession()` contract
- MCP subscriptions (different purpose): `src/mcp/subscriptions.ts` -- protocol-level resource subscriptions
- Notification policy: `src/events/notification-policy/rules.ts` -- DEFAULT_RULES pattern
- Existing MCP tools: `src/mcp/tools.ts` -- tool registration pattern
- PROJECT.md: v1.8 milestone scope, constraints
- Package.json: Verified installed dependencies and versions
