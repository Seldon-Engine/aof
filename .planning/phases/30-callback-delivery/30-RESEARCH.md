# Phase 30: Callback Delivery - Research

**Researched:** 2026-03-10
**Domain:** Task notification callback delivery (agent-to-agent session spawning)
**Confidence:** HIGH

## Summary

Phase 30 implements the delivery side of the notification subscription system built in Phases 28-29. When a task reaches a terminal state (done, cancelled, deadletter), the system must find active subscriptions with "completion" granularity, spawn a new session to the subscriber agent with task outcome context, and handle delivery failures with retry logic.

The codebase is well-prepared for this work. The `onRunComplete` callback in `assign-executor.ts` already fires async after agent sessions end and handles trace capture -- delivery triggers slot in after trace capture. The `SubscriptionStore` provides CRUD for subscriptions. The `GatewayAdapter.spawnSession()` provides the session spawning mechanism. The `loadOrgChart()` function provides agent validation. The main engineering challenge is wiring these pieces together without blocking task state transitions (DLVR-04), implementing the retry mechanism via scheduler poll scanning (DLVR-02), and extending the subscription schema with delivery tracking fields.

**Primary recommendation:** Implement as three focused units: (1) schema extension + delivery function, (2) trigger integration in onRunComplete + org chart validation, (3) retry scanning in scheduler poll.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Fire delivery in the existing `onRunComplete` callback in assign-executor.ts
- Trigger AFTER trace capture completes (so callback payload can reference the trace file)
- Agent completions only -- no delivery for manual MCP tool transitions (aof_task_complete called directly) or operator cancellations
- All three terminal states trigger completion-granularity delivery: done, cancelled, deadletter (matches GRAN-01)
- Structured summary payload: taskId, title, finalStatus, outcome summary, subscriberId, trace file path, outputs section
- Include the task's Outputs section (deliverables the completing agent produced) in the summary
- Frame as system prompt prefix: "You are receiving a task notification callback..."
- Short timeout (2 min) for callback sessions
- Failed deliveries retry on the next scheduler poll cycle (~30s delay)
- Retry counter and delivery state tracked on the subscription object itself (deliveryAttempts, lastAttemptAt fields)
- After 3 failed attempts: mark subscription status as "failed" with failureReason, emit subscription.delivery_failed event
- Scheduler discovers pending retries by scanning terminal-status tasks for active subscriptions with deliveryAttempts < 3
- subscriberId IS the agentId -- must match an agent ID from the org chart
- Validate at subscribe time (both aof_task_subscribe and subscribe-at-dispatch) -- fail early if agent doesn't exist in org chart
- "mcp" is a valid subscriberId -- if someone dispatches with subscribe but no actor, subscriberId defaults to "mcp" which must exist in org chart or validation fails
- Consistent validation: both standalone subscribe and subscribe-at-dispatch check the org chart

### Claude's Discretion
- Exact structure of the callback system prompt template
- How to integrate delivery scanning into the existing scheduler poll function
- How to pass org chart reference to subscription validation
- Event names and event payload structure for delivery events

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DLVR-01 | Scheduler delivers callbacks by spawning a new session to the subscriber agent with task results as context | Delivery function using GatewayAdapter.spawnSession() with TaskContext built from subscription + task data. Triggered from onRunComplete after trace capture. |
| DLVR-02 | Failed deliveries retry up to 3 times before marking subscription as failed | Schema extension with deliveryAttempts/lastAttemptAt fields. Scheduler poll scans terminal tasks for retryable subscriptions. |
| DLVR-03 | Callback sessions produce traces like normal dispatches | Callback spawn uses same spawnSession() interface with onRunComplete that calls captureTrace(). Trace files land in state/runs/<callbackTaskId>/. |
| DLVR-04 | Delivery never blocks task state transitions (best-effort, non-blocking) | Delivery fires async in onRunComplete AFTER state transition already happened. Wrapped in try/catch. Same pattern as trace capture. |
| GRAN-01 | "completion" granularity fires on terminal states (done/cancelled/deadletter) | Filter subscriptions by granularity === "completion" and status === "active". Check task status against terminal state set. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | (existing) | Schema extension for delivery tracking fields | Already used for all schemas in project |
| write-file-atomic | (existing) | Crash-safe subscription file updates | Already used by SubscriptionStore |
| vitest | ^3.0.0 | Unit/integration testing | Project test framework |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:crypto | built-in | UUID generation for correlation IDs | Callback session correlation |
| node:path | built-in | Path manipulation for task/trace resolution | Building trace file paths for payload |

No new dependencies needed. All required functionality exists in the current stack.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── dispatch/
│   ├── assign-executor.ts      # ADD: delivery trigger after trace capture in onRunComplete
│   ├── scheduler.ts            # ADD: delivery retry scan in poll()
│   └── callback-delivery.ts    # NEW: delivery function + callback payload builder
├── schemas/
│   └── subscription.ts         # MODIFY: add deliveryAttempts, lastAttemptAt fields
├── store/
│   └── subscription-store.ts   # ADD: update() method for delivery tracking, listPendingDeliveries()
└── mcp/
    └── tools.ts                # MODIFY: add org chart validation to subscribe handlers
```

### Pattern 1: Best-Effort Async Operation
**What:** Wrap delivery in try/catch, never let failures propagate to caller
**When to use:** All delivery operations -- both initial trigger and retry
**Example:**
```typescript
// Source: existing pattern in assign-executor.ts (trace capture)
// Delivery follows the same pattern:
try {
  await deliverCallbacks(taskId, store, subscriptionStore, executor, logger);
} catch {
  // Delivery must never crash the scheduler or block task transitions
}
```

### Pattern 2: Scheduler Poll Scanning
**What:** In each poll cycle, scan terminal-status tasks for retryable subscriptions
**When to use:** Retry delivery of failed callbacks
**Example:**
```typescript
// Source: existing pattern in scheduler.ts (stale heartbeat checks, SLA violations)
// Add after existing checks, before action execution:
const terminalTasks = allTasks.filter(t =>
  ["done", "cancelled", "deadletter"].includes(t.frontmatter.status)
);
// For each terminal task, check subscriptions.json for active subs with deliveryAttempts < 3
```

### Pattern 3: CaptureAdapter Test Pattern
**What:** Mock GatewayAdapter that captures onRunComplete callback for manual invocation
**When to use:** Testing delivery trigger integration in onRunComplete
**Example:**
```typescript
// Source: src/dispatch/__tests__/completion-enforcement.test.ts
class CaptureAdapter implements GatewayAdapter {
  capturedOnRunComplete: ((outcome: AgentRunOutcome) => void | Promise<void>) | undefined;
  async spawnSession(context, opts) {
    this.capturedOnRunComplete = opts?.onRunComplete;
    return { success: true, sessionId: `mock-${context.taskId}` };
  }
  // ...
}
```

### Anti-Patterns to Avoid
- **Blocking delivery:** Never await delivery completion in the state transition path. Delivery happens in onRunComplete which is already async/post-transition.
- **Inline retry loops:** Do NOT retry immediately in onRunComplete. Let the scheduler poll cycle handle retries on the next pass (~30s later).
- **Coupling delivery to task store hooks:** The decision explicitly says fire in onRunComplete, not via TaskStoreHooks.afterTransition. This keeps delivery scoped to agent completions only (not manual MCP transitions).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Session spawning | Custom agent invocation | GatewayAdapter.spawnSession() | Already handles timeouts, correlation IDs, onRunComplete |
| Subscription persistence | Direct file I/O | SubscriptionStore (extended) | Handles atomic writes, Zod validation, directory resolution |
| Org chart agent lookup | Manual YAML parsing | loadOrgChart() | Already handles validation, error formatting |
| Trace capture for callbacks | Custom trace logic | captureTrace() | Already handles attempt numbering, 1MB cap, no-op detection |
| Task body parsing for Outputs | Regex extraction | Parse markdown sections from task.body | Simple string splitting on "## Outputs" header |

## Common Pitfalls

### Pitfall 1: Delivery Blocking State Transitions
**What goes wrong:** If delivery is awaited synchronously in the transition path, a slow/failing spawn blocks the task from completing.
**Why it happens:** Natural inclination to ensure delivery before confirming completion.
**How to avoid:** Delivery fires in onRunComplete which runs AFTER the state transition. The task is already in its terminal state when delivery triggers. Use fire-and-forget with try/catch.
**Warning signs:** Test shows task status still "in-progress" during delivery attempt.

### Pitfall 2: Subscription File Race Condition
**What goes wrong:** Two concurrent deliveries for the same task modify subscriptions.json simultaneously, losing one update.
**Why it happens:** Scheduler retry scan and initial delivery could overlap if timing is unlucky.
**How to avoid:** Initial delivery in onRunComplete updates the subscription immediately. Scheduler retry scan skips subscriptions where lastAttemptAt is recent (< 30s). write-file-atomic provides crash safety but not concurrency safety -- use the scheduler's single-threaded poll as the serialization point for retries.
**Warning signs:** deliveryAttempts counter doesn't increment, duplicate deliveries.

### Pitfall 3: Orphaned Subscriptions on Tasks Without onRunComplete
**What goes wrong:** Tasks that reach terminal state via manual MCP tool calls (aof_task_complete) or operator cancellations never trigger delivery because onRunComplete only fires for agent-dispatched sessions.
**Why it happens:** The decision explicitly scopes delivery to agent completions only.
**How to avoid:** This is by design per the locked decisions. Subscriptions on manually-completed tasks remain "active" indefinitely. The scheduler retry scan should only look at tasks where a trace file exists (indicating an agent session ran) or where the subscription has deliveryAttempts > 0 (indicating a prior delivery attempt).
**Warning signs:** Subscriptions stuck in "active" state on done tasks -- expected for manually completed tasks.

### Pitfall 4: Callback Session Needs Valid Agent Context
**What goes wrong:** Spawning a callback session requires a valid TaskContext with agent, routing, and task path. Using the original task's context is wrong -- the callback goes to a DIFFERENT agent (the subscriber).
**Why it happens:** Confusing the original task's agent with the subscription's subscriberId.
**How to avoid:** Build a fresh TaskContext for the callback session with: agent = subscription.subscriberId, routing derived from org chart lookup of subscriber agent, taskPath = original task's current path (for reference).
**Warning signs:** Callback dispatched to the completing agent instead of the subscriber.

### Pitfall 5: SubscriptionStore taskDirResolver After Terminal Transition
**What goes wrong:** After a task transitions to "done", the taskDirResolver must resolve to the "done" status directory. If it uses a cached or stale status, it can't find subscriptions.json.
**Why it happens:** The taskDirResolver does `store.get(taskId)` which returns current state -- this should work correctly after transition.
**How to avoid:** Always re-read the task via store.get() in the delivery function to get the current path. The existing taskDirResolver pattern handles this correctly.
**Warning signs:** "Task not found" errors when trying to read subscriptions for terminal tasks.

## Code Examples

### Callback Delivery Function Skeleton
```typescript
// Source: new file src/dispatch/callback-delivery.ts

import type { ITaskStore } from "../store/interfaces.js";
import type { SubscriptionStore } from "../store/subscription-store.js";
import type { GatewayAdapter, TaskContext } from "./executor.js";
import type { EventLogger } from "../events/logger.js";
import type { Task } from "../schemas/task.js";
import type { TaskSubscription } from "../schemas/subscription.js";
import { captureTrace } from "../trace/trace-writer.js";

const TERMINAL_STATUSES = new Set(["done", "cancelled", "deadletter"]);
const CALLBACK_TIMEOUT_MS = 120_000; // 2 minutes

export interface DeliverCallbacksOptions {
  taskId: string;
  store: ITaskStore;
  subscriptionStore: SubscriptionStore;
  executor: GatewayAdapter;
  logger: EventLogger;
  tracePath?: string;
}

export async function deliverCallbacks(opts: DeliverCallbacksOptions): Promise<void> {
  const task = await opts.store.get(opts.taskId);
  if (!task || !TERMINAL_STATUSES.has(task.frontmatter.status)) return;

  const subs = await opts.subscriptionStore.list(opts.taskId, { status: "active" });
  const completionSubs = subs.filter(s => s.granularity === "completion");

  for (const sub of completionSubs) {
    try {
      await deliverSingleCallback(task, sub, opts);
    } catch {
      // Best-effort -- individual delivery failures don't affect others
    }
  }
}
```

### Callback Payload Builder
```typescript
// Build system prompt for callback session
function buildCallbackPrompt(task: Task, sub: TaskSubscription, tracePath?: string): string {
  const outputsSection = extractOutputsSection(task.body);
  return [
    `You are receiving a task notification callback.`,
    `Task "${task.frontmatter.title}" (${task.frontmatter.id}) completed with status: ${task.frontmatter.status}.`,
    ``,
    `## Task Summary`,
    `- **Task ID:** ${task.frontmatter.id}`,
    `- **Title:** ${task.frontmatter.title}`,
    `- **Final Status:** ${task.frontmatter.status}`,
    `- **Subscription ID:** ${sub.id}`,
    tracePath ? `- **Trace:** ${tracePath}` : null,
    outputsSection ? `\n## Outputs\n${outputsSection}` : null,
  ].filter(Boolean).join("\n");
}

function extractOutputsSection(body: string): string | null {
  const marker = "## Outputs";
  const idx = body.indexOf(marker);
  if (idx === -1) return null;
  const afterMarker = body.slice(idx + marker.length);
  const nextSection = afterMarker.indexOf("\n## ");
  return nextSection === -1 ? afterMarker.trim() : afterMarker.slice(0, nextSection).trim();
}
```

### Schema Extension for Delivery Tracking
```typescript
// Source: extend src/schemas/subscription.ts
export const TaskSubscription = z.object({
  id: z.string().uuid(),
  subscriberId: z.string().min(1),
  granularity: SubscriptionGranularity,
  status: SubscriptionStatus,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deliveredAt: z.string().datetime().optional(),
  failureReason: z.string().optional(),
  // NEW: delivery tracking fields
  deliveryAttempts: z.number().int().min(0).default(0),
  lastAttemptAt: z.string().datetime().optional(),
});
```

### Org Chart Validation for Subscribe
```typescript
// Source: add to tools.ts handleAofTaskSubscribe and handleAofDispatch (subscribe path)
import { loadOrgChart } from "../org/loader.js";

async function validateSubscriberId(orgChartPath: string, subscriberId: string): Promise<void> {
  const result = await loadOrgChart(orgChartPath);
  if (!result.success || !result.chart) {
    throw new McpError(ErrorCode.InternalError, "Failed to load org chart for subscriber validation");
  }
  const agentExists = result.chart.agents.some(a => a.id === subscriberId);
  if (!agentExists) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `subscriberId "${subscriberId}" not found in org chart. Available agents: ${result.chart.agents.map(a => a.id).join(", ")}`,
    );
  }
}
```

### Scheduler Retry Scan Integration
```typescript
// Source: add to scheduler.ts poll() after existing checks
// Delivery retry scan: find terminal tasks with pending subscriptions
if (!config.dryRun && config.executor) {
  const terminalTasks = allTasks.filter(t =>
    TERMINAL_STATUSES.has(t.frontmatter.status)
  );

  for (const task of terminalTasks) {
    try {
      await retryPendingDeliveries({
        taskId: task.frontmatter.id,
        store,
        subscriptionStore,
        executor: config.executor,
        logger,
      });
    } catch {
      // Delivery retry must never crash the scheduler
    }
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No notifications | Subscription schema + store (Phase 28-29) | v1.8 (current) | Foundation for delivery |
| Manual polling for task status | Event-driven subscription delivery (Phase 30) | v1.8 (current) | Agents notified automatically |

**Key design constraint:** AOF is filesystem-based, single-machine. No HTTP webhooks, no message queues, no pub/sub. Delivery = spawning a new agent session via GatewayAdapter.

## Open Questions

1. **Callback trace storage location**
   - What we know: Normal traces go to `state/runs/<taskId>/trace-N.json`. Callback sessions are about the original task but spawned for a different agent.
   - What's unclear: Should callback traces use the original taskId or a synthetic callback-specific ID?
   - Recommendation: Use original taskId with a naming convention like `callback-trace-N.json` to distinguish from normal dispatch traces. Or use the subscription ID as a namespace.

2. **SubscriptionStore access from scheduler**
   - What we know: The scheduler currently doesn't have a SubscriptionStore instance. The MCP context creates one but the scheduler operates independently.
   - What's unclear: How to inject SubscriptionStore into the scheduler poll function.
   - Recommendation: Add subscriptionStore to SchedulerConfig or construct one in poll() using the same taskDirResolver pattern from shared.ts. The store just needs a taskDirResolver function.

3. **Handling "mcp" as subscriber agent**
   - What we know: "mcp" is a valid subscriberId that must exist in the org chart.
   - What's unclear: What does it mean to spawn a session to the "mcp" agent? Is this a real agent in the org chart?
   - Recommendation: Validate "mcp" against org chart like any other agent. If it doesn't exist, the subscribe call fails early. The delivery function treats it the same as any agent ID.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^3.0.0 |
| Config file | vitest.config.ts (root) |
| Quick run command | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DLVR-01 | deliverCallbacks spawns session to subscriber agent with task summary | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "spawns callback session"` | Wave 0 |
| DLVR-02 | Failed delivery increments attempt counter; 3 failures marks subscription failed | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "retry"` | Wave 0 |
| DLVR-03 | Callback session onRunComplete calls captureTrace | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "trace"` | Wave 0 |
| DLVR-04 | Delivery error does not propagate to caller | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "never blocks"` | Wave 0 |
| GRAN-01 | Only completion-granularity subs fire on terminal states | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "completion granularity"` | Wave 0 |
| ORG-VAL | Subscribe validates subscriberId against org chart | unit | `npx vitest run src/mcp/__tests__/subscriptions.test.ts -t "org chart"` | Wave 0 |
| SCHEMA | TaskSubscription schema accepts deliveryAttempts/lastAttemptAt | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "delivery"` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/dispatch/__tests__/callback-delivery.test.ts` -- covers DLVR-01, DLVR-02, DLVR-03, DLVR-04, GRAN-01
- [ ] Extended tests in `src/store/__tests__/subscription-store.test.ts` -- covers schema extension + update method
- [ ] Extended tests in `src/mcp/__tests__/subscriptions.test.ts` -- covers org chart validation

## Sources

### Primary (HIGH confidence)
- Project source code: `src/dispatch/assign-executor.ts` -- onRunComplete callback pattern, trace capture integration
- Project source code: `src/dispatch/scheduler.ts` -- poll() structure, scanning patterns
- Project source code: `src/store/subscription-store.ts` -- CRUD operations, file I/O patterns
- Project source code: `src/schemas/subscription.ts` -- current Zod schema
- Project source code: `src/dispatch/executor.ts` -- GatewayAdapter interface, TaskContext, SpawnResult, MockAdapter
- Project source code: `src/trace/trace-writer.ts` -- captureTrace() interface and behavior
- Project source code: `src/org/loader.ts` -- loadOrgChart() interface
- Project source code: `src/mcp/tools.ts` -- handleAofTaskSubscribe, handleAofDispatch subscribe path
- Project source code: `src/mcp/shared.ts` -- AofMcpContext, SubscriptionStore wiring
- Project source code: `src/dispatch/__tests__/completion-enforcement.test.ts` -- CaptureAdapter test pattern

### Secondary (MEDIUM confidence)
- CONTEXT.md decisions -- user-locked implementation choices

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new dependencies, all existing patterns
- Architecture: HIGH - clear integration points identified in existing code, well-documented patterns
- Pitfalls: HIGH - derived from direct code analysis of race conditions and async patterns

**Research date:** 2026-03-10
**Valid until:** 2026-04-10 (stable internal architecture)
