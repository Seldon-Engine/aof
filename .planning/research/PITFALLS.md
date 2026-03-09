# Domain Pitfalls: v1.8 Task Notifications & Callbacks

**Domain:** Adding task notification subscriptions and callback delivery to an existing agent orchestration platform with filesystem-based state, DAG workflows, and ephemeral agent sessions
**Researched:** 2026-03-09
**Confidence:** HIGH (based on direct codebase analysis of scheduler, DAG evaluator, protocol router, notification service, and MCP subscription manager)

---

## Critical Pitfalls

Mistakes that cause infinite loops, lost work, or require architectural rewrites.

### Pitfall 1: Callback-Creates-Task-Creates-Callback Infinite Loop

**What goes wrong:**
Agent A subscribes to task T1's completion. T1 completes, triggering a callback dispatch to Agent A. Agent A's callback session creates a new task T2 (via `aof_dispatch`). If Agent A also subscribed to "all tasks by team X" or if there is a blanket subscription pattern, T2's creation triggers another callback to Agent A. Agent A creates T3. This loops until the scheduler hits its concurrency limit, the daemon runs out of file descriptors, or the disk fills with task files.

The loop is insidious because each step is legitimate: subscribing to outcomes is the feature's purpose, and creating tasks in response to outcomes is a valid agent behavior. The loop emerges from the composition of individually correct operations.

**Why it happens:**
The scheduler poll loop in `scheduler.ts` already processes DAG hops, murmur evaluations, SLA checks, and dispatch actions in a single cycle. Adding notification delivery to this loop means a single poll cycle can: complete task -> evaluate subscriptions -> dispatch callback session -> callback creates task -> task triggers more subscriptions. If notifications are evaluated eagerly (within the same poll cycle as completion), the loop is synchronous and unbounded.

**Consequences:**
- Runaway task creation fills `tasks/backlog/` and `tasks/ready/` directories
- Scheduler poll duration exceeds `pollTimeoutMs` (30s default), triggering timeout events
- Agent sessions spawn faster than they complete, hitting OpenClaw's platform concurrency limit
- Daemon becomes unresponsive; launchd/systemd restarts it, but the backlog of ready tasks immediately triggers the same storm

**Prevention:**
1. **Notifications must NEVER be delivered in the same poll cycle as the triggering completion.** The scheduler should record pending notifications in a durable queue (a file in `state/notifications/pending/`) and deliver them in the NEXT poll cycle. This creates a natural one-cycle delay that breaks synchronous loops.
2. **Per-task notification depth counter.** When a task is created by a notification callback, stamp it with `metadata.notificationDepth = parentDepth + 1`. Refuse to deliver notifications for tasks where `notificationDepth >= MAX_DEPTH` (suggest 3). This is analogous to the DAG evaluator's `DEFAULT_MAX_REJECTIONS` circuit breaker.
3. **Per-subscriber rate limit.** No single subscriber (agent) should receive more than N notification deliveries per poll cycle (suggest 2). Excess notifications queue for the next cycle.
4. **Self-subscription guard.** A callback session should NOT be able to create subscriptions that would trigger on its own outputs. Detect and reject subscriptions where the subscribing agent is the same as the task's assigned agent AND the subscription targets the task being created in the same session.
5. **Dry-run validation.** Before enabling notification delivery in active mode, run the notification evaluator in dry-run mode (like the existing scheduler dry-run) and log what WOULD be delivered. This lets operators spot loops before they fire.

**Detection:**
- Monitor `notification.delivered` event count per poll cycle. Alert if > 5 in a single cycle.
- Monitor task creation rate. A sudden spike correlated with notification delivery indicates a loop.
- Add a circuit breaker: if pending notification queue exceeds 20 items, pause delivery and emit `notification.circuit_breaker` event.

**Phase to address:** Must be designed into the notification delivery mechanism from the very first implementation. Retrofitting loop prevention onto an eager delivery system requires rewriting the delivery pipeline.

---

### Pitfall 2: Lost Notifications on Daemon Restart

**What goes wrong:**
Task T1 completes during scheduler poll cycle N. The scheduler evaluates subscriptions and identifies Agent A should be notified. Before the notification is dispatched (session spawned), the daemon crashes or is restarted (launchd restart, `aof daemon restart`, system reboot). When the daemon comes back up, T1 is already in `done/` status. The scheduler has no record that a notification was pending. Agent A never learns T1 completed.

This is the classic "dual write" problem: the task state transition (rename to `done/`) and the notification delivery are two separate operations with no transactional guarantee.

**Why it happens:**
AOF's filesystem store uses atomic `rename()` for state transitions -- the task file moves from `in-progress/` to `done/`. This is durable and crash-safe for the task itself. But the notification is an in-memory intention (or at best, a pending queue entry) that hasn't been persisted when the crash occurs. The existing `NotificationService` in `events/notifier.ts` is entirely in-memory (the `lastSent` Map and dedup state are not persisted).

The existing MCP `SubscriptionManager` in `mcp/subscriptions.ts` has the same problem: subscriptions live in an in-memory `Map<string, SubscriptionRecord>` that is lost on restart.

**Consequences:**
- Agent A is waiting for T1's result and never receives it
- If Agent A was going to start follow-up work based on T1's completion, that work is permanently stalled
- The system appears to work in steady state but silently loses notifications during any restart -- a correctness bug masked by uptime

**Prevention:**
1. **Write-ahead notification log.** Before delivering a notification, write a pending notification record to disk: `state/notifications/pending/{notificationId}.json` containing `{ taskId, subscriberId, eventType, createdAt }`. After successful delivery (callback session spawned), move it to `state/notifications/delivered/` or delete it. On daemon startup, scan `pending/` and redeliver.
2. **Idempotent delivery.** Since at-least-once delivery means duplicates are possible (crash after spawn but before marking as delivered), the callback session must be idempotent. Include a `notificationId` in the callback context so the receiving agent can detect duplicates.
3. **Delivery confirmation.** Don't mark a notification as delivered just because the session was spawned. Mark it delivered when the callback session completes (via the same `onRunComplete` mechanism used for DAG hops). If the callback session fails, the notification stays pending for retry.
4. **Startup reconciliation.** On daemon startup, the scheduler already reconciles orphaned tasks (leases, stale heartbeats). Add a notification reconciliation pass: for every active subscription, check if the subscribed task has reached a terminal state. If yes and no delivery record exists, queue a delivery. This is the "catch-up" mechanism.
5. **Do NOT rely on the existing `NotificationService` for callback delivery.** That service is for system alerts (channel routing to `#aof-dispatch`, `#aof-alerts`). Task notification callbacks require a separate, durable delivery pipeline.

**Detection:**
- Integration test: create subscription, complete task, kill daemon before delivery, restart daemon, verify notification is delivered on restart.
- Monitor `notification.pending` count in health endpoint. A non-zero count that persists across multiple poll cycles indicates stuck notifications.

**Phase to address:** The write-ahead notification log must be implemented in the same phase as notification delivery. Deferring durability to a later phase means every notification delivered in the interim is unreliable.

---

### Pitfall 3: Race Between Task Completion and Subscription Creation

**What goes wrong:**
Agent A dispatches task T1 via `aof_dispatch` and then immediately calls a (new) `aof_subscribe` tool to subscribe to T1's completion. But T1 was assigned to a fast agent that completes the task before Agent A's subscription is written to disk. The completion event fires, the notification evaluator finds zero subscribers, and Agent A's subscription is created moments later -- after the event has already passed.

This race is particularly likely in AOF because:
- `aof_dispatch` with an executor spawns the session immediately (assign-executor.ts line 79+)
- The OpenClaw session can start and complete within seconds for simple tasks
- The subscribing agent's session and the dispatched agent's session are independent (OpenClaw constraint: no nested sessions)
- The scheduler advances DAG hops between independent sessions, so there's no synchronization point

**Why it happens:**
Subscription creation and task execution are concurrent, unsynchronized operations. The filesystem store provides atomic operations per-file (write-file-atomic for task updates) but no cross-file transactions. There is no way to atomically "create subscription AND dispatch task" as a single operation.

**Consequences:**
- The exact scenario the feature is designed to solve (knowing when a task completes) fails silently for fast tasks
- Developers write workarounds (polling, delays) that defeat the purpose of the notification system
- Intermittent: works for slow tasks, fails for fast ones -- making it hard to reproduce

**Prevention:**
1. **Subscribe-on-create.** The `aof_dispatch` tool should accept an optional `subscribe: true` parameter that atomically creates both the task AND the subscription. The subscription is written to disk before the task is dispatched. This eliminates the race entirely for the most common case.
2. **Catch-up on subscribe.** When a subscription is created, immediately check if the task is already in a terminal state (`done`, `deadletter`, `cancelled`). If yes, deliver the notification immediately (or queue it for the next poll cycle). This handles the "subscribe after completion" case.
3. **Subscription-before-dispatch ordering.** If subscribe-on-create is not used, document and enforce that subscriptions must be created BEFORE dispatching the task. The `aof_subscribe` tool should accept a task ID that may not exist yet, and the subscription should be durable (written to disk) so it survives the gap between subscribe and dispatch.
4. **Never assume temporal ordering.** The notification evaluator should check subscriptions against current task state, not just react to transition events. A periodic "catch-up sweep" (every N poll cycles) checks all active subscriptions against current task states and delivers any missed notifications.

**Detection:**
- Test: create subscription, immediately complete the task in the same test, verify notification is still delivered.
- Test: complete task, THEN create subscription, verify catch-up delivery.
- Measure time-to-subscribe vs time-to-complete in production and alert if subscribe latency exceeds 1 second.

**Phase to address:** The subscribe-on-create parameter on `aof_dispatch` should be part of the MVP. Catch-up-on-subscribe should be implemented immediately after.

---

### Pitfall 4: Notification Storm from DAG Workflow Completion

**What goes wrong:**
A DAG workflow with 8 hops completes. Each hop completion triggers the DAG evaluator (`dag-evaluator.ts:evaluateDAG`), which transitions hop states and may complete the DAG. If subscribers are notified on every state transition (the "all" granularity level), a single task with an 8-hop DAG generates:
- 8 hop dispatched events
- 8 hop completed events
- Up to 8 "ready" transitions
- 1 DAG completion event
- 1 task status transition (in-progress -> done)

That is potentially 25+ notification deliveries for a single task. If each delivery spawns a new agent session (the OpenClaw constraint), that is 25 sessions spawned to notify about one task's lifecycle. Each session consumes an OpenClaw concurrency slot, blocking real work from being dispatched.

**Why it happens:**
The "all" granularity level (subscribing to all state transitions) is designed for observability, but in a DAG workflow, state transitions are frequent and mechanical. The DAG evaluator in `dag-evaluator.ts` returns `changes: HopTransition[]` which can contain many transitions per evaluation (cascaded skips, condition evaluations, ready promotions). Naively mapping each `HopTransition` to a notification delivery multiplies the problem.

**Consequences:**
- OpenClaw concurrency limit exhausted by notification sessions, starving real task dispatch
- Scheduler poll duration spikes due to spawning many sessions
- Receiving agent is overwhelmed by rapid-fire notifications for intermediate states it doesn't care about
- Rate limiting (from Pitfall 1 prevention) kicks in and drops legitimate notifications

**Prevention:**
1. **Batch notifications per task per poll cycle.** Instead of delivering one notification per state transition, aggregate all transitions for a task within a poll cycle into a single notification payload. Agent A receives one callback with `{ taskId: "T1", transitions: [...], currentStatus: "done" }` instead of 25 separate callbacks.
2. **Debounce intermediate states.** For "all" granularity, only deliver after the task has been stable for one full poll cycle. If hop-2 completes and hop-3 immediately starts, the subscriber gets the aggregated state, not each intermediate step.
3. **Make "completion" the default granularity.** The "all" level should require explicit opt-in with a warning about volume. Most agents only care about the final outcome, not intermediate hops.
4. **Notification coalescence.** If multiple notifications for the same (subscriber, taskId) pair are pending, coalesce them into one. The callback session receives the latest state, not a replay of every transition.
5. **Cap notifications per task.** A task should generate at most 3 notification deliveries per poll cycle regardless of granularity. Excess transitions are aggregated into the next delivery.

**Detection:**
- Track `notification.queued` count per task per poll cycle. Alert if > 5.
- Track total notification sessions spawned per poll cycle. Alert if notifications consume > 30% of concurrency slots.

**Phase to address:** Notification batching/coalescence must be part of the initial delivery implementation. Delivering individual transitions is the wrong default.

---

## Moderate Pitfalls

### Pitfall 5: Subscription Lifecycle Leaks (Orphaned Subscriptions)

**What goes wrong:**
Agent A creates a subscription for task T1's completion. T1 is deadlettered (after 3 dispatch failures via `failure-tracker.ts`). The subscription remains active, pointing at a task that will never complete. Over time, the subscription store accumulates orphaned subscriptions that are checked every poll cycle, wasting I/O and memory.

Worse: if T1 is later resurrected from deadletter (a v2 feature), the ancient subscription fires unexpectedly.

**Why it happens:**
Deadletter and cancellation are terminal states but are not "completion" events. If the subscription system only triggers on `done` status, it never fires for deadlettered tasks, and the subscription is never cleaned up. The existing task lifecycle (`backlog -> ready -> in-progress -> review -> done -> deadletter`) has multiple terminal states, and subscriptions must account for all of them.

**Prevention:**
1. Define "terminal" as `done | deadletter | cancelled`. Subscriptions should fire (with appropriate outcome metadata) on ANY terminal state, not just `done`. The callback payload should include the terminal status so the subscriber knows the task failed vs succeeded.
2. Add a subscription TTL. Subscriptions expire after N hours (suggest 48h) if the task hasn't reached a terminal state. Expired subscriptions are cleaned up with a `notification.subscription_expired` event.
3. On task deletion (manual cleanup), scan and remove associated subscriptions.
4. Periodic subscription audit: every N poll cycles (suggest 100), scan all active subscriptions and verify the target task still exists and is not terminal. Clean up stale subscriptions.
5. Store subscriptions adjacent to the task: `tasks/<status>/TASK-xxx/subscriptions/` rather than in a global directory. When the task file moves between status directories, subscriptions move with it. When the task is deleted, subscriptions are deleted.

**Detection:**
- Health endpoint should report active subscription count. Monotonically increasing count with stable task volume indicates leaks.
- `aof smoke` should check for subscriptions targeting non-existent tasks.

**Phase to address:** Subscription cleanup for terminal states must be in the MVP. TTL and audit can be phase 2.

---

### Pitfall 6: Callback Session Lacks Context About WHY It Was Triggered

**What goes wrong:**
Agent A subscribed to task T1's completion. T1 completes, and the scheduler spawns a new session for Agent A to deliver the notification. But the session is dispatched with minimal context -- the agent knows it was "notified" but doesn't know: what task completed, what the outcome was, what data the completed task produced, or what it should do with this information.

The agent session starts, calls `aof_status_report` to figure out what happened, reads the completed task to get results, and then starts its actual work. This "bootstrapping" burns tokens and time, and if the agent misidentifies which completion triggered the callback, it does the wrong thing.

**Why it happens:**
The existing dispatch mechanism (`assign-executor.ts`, `dag-transition-handler.ts`) builds `TaskContext` for the task being dispatched, not for a notification about a different task. The notification callback needs context about BOTH the subscribing agent's task AND the completed task that triggered the notification. This is a new context shape that doesn't fit the existing `TaskContext` interface.

**Consequences:**
- Wasted tokens on context bootstrapping
- Agent may act on wrong task if multiple tasks completed between poll cycles
- If the completed task's results are in its work directory, the callback agent may not have access (different task, different directory)

**Prevention:**
1. **Rich notification payload in dispatch context.** The callback session's `hopContext` (or a new `notificationContext` field) should include: `{ triggeredBy: taskId, outcome: "done"|"failed"|..., completedAt: timestamp, resultSummary: string, subscriberTaskId?: string }`.
2. **Include result artifacts.** If the completed task produced outputs (files in its work directory), include file paths or content snippets in the notification context. The callback agent shouldn't need to resolve the completed task's location.
3. **Use `formatTaskInstruction` for notification-specific guidance.** The per-dispatch prompt injection (the "dual-channel" pattern from v1.5) should include notification-specific instructions: "You are being notified that task X completed. The results are: ... Your action should be: ..."
4. **Define a notification dispatch context schema** (Zod) separate from `TaskContext`. This prevents overloading the existing interface and makes the callback session's context explicit and validatable.

**Phase to address:** Context schema design must happen before implementing delivery. The schema determines what information flows to the callback agent.

---

### Pitfall 7: Notification Delivery Blocks the Scheduler's Main Dispatch Loop

**What goes wrong:**
Notification delivery spawns agent sessions via the same `GatewayAdapter.spawnSession()` used for task dispatch. Each `spawnSession()` call has a timeout (`spawnTimeoutMs`, default 30s). If there are 5 pending notifications, the scheduler spends up to 150 seconds trying to deliver them -- during which no regular task dispatch occurs. Ready tasks pile up while the scheduler is busy spawning notification sessions.

This is especially bad because notification sessions are low-priority (informing an agent about a result) while task dispatch is high-priority (agents doing actual work). The scheduler's dispatch loop in `scheduler.ts:poll()` runs everything sequentially.

**Why it happens:**
The existing scheduler architecture is a single-threaded poll loop. DAG hop dispatch (lines 298-350 in scheduler.ts) already adds latency to each poll cycle. Adding notification delivery to the same sequential loop compounds the problem. The `maxDispatchesPerPoll` (default 2) limits task dispatches but won't automatically limit notification dispatches unless they share the same counter.

**Consequences:**
- Task dispatch latency increases proportionally to notification volume
- Poll cycles exceed `pollTimeoutMs`, triggering warnings
- The system prioritizes notification delivery over productive work

**Prevention:**
1. **Separate notification budget from dispatch budget.** Notifications get their own `maxNotificationsPerPoll` limit (suggest 1-2), independent of `maxDispatchesPerPoll`. Notifications are always dispatched AFTER all regular task dispatches in a poll cycle.
2. **Notification dispatch is lower priority.** In the poll loop, process in order: (1) lease expiry, (2) task promotion, (3) task dispatch, (4) DAG hop dispatch, (5) notification delivery. Notifications only run if the poll cycle has time remaining (check against `pollTimeoutMs`).
3. **Don't spawn a full agent session for simple notifications.** If the subscriber just needs to know "T1 completed with outcome X", consider writing the notification to the subscriber's task file (appending to its work log) rather than spawning a session. Reserve session spawning for callbacks that require the agent to take action.
4. **Async notification delivery.** If notifications must spawn sessions, do it outside the poll loop using `setImmediate` or a microtask queue. The poll loop records "deliver notification X" as an intention, and a separate background worker handles the spawn.

**Detection:**
- Track poll cycle duration with and without notification delivery. If notifications add > 20% to poll duration, the priority/budget is wrong.
- Track `notification.delivery_deferred` events (notifications that were queued because the poll cycle ran out of time).

**Phase to address:** Notification budget and priority ordering must be part of the initial scheduler integration.

---

### Pitfall 8: Existing NotificationService and MCP SubscriptionManager Confusion

**What goes wrong:**
AOF already has TWO notification/subscription systems:
1. `events/notifier.ts` -- `NotificationService` with channel routing, deduplication, and adapter pattern. Used for system alerts.
2. `mcp/subscriptions.ts` -- `SubscriptionManager` with filesystem watching, debounced MCP resource update notifications. Used for MCP client UI updates.

Adding a THIRD system for task notification callbacks creates confusion about which system handles what. Developers wire notifications through the wrong system: they route task callbacks through the system alert `NotificationService` (which sends to Slack channels, not agent sessions) or through the MCP `SubscriptionManager` (which sends MCP protocol notifications, not agent dispatches).

**Why it happens:**
All three systems use the word "notification" and "subscription" but serve fundamentally different purposes:
- System alerts: human operators, via Slack/chat channels, fire-and-forget
- MCP subscriptions: MCP clients (IDEs), via protocol notifications, in-session only
- Task callbacks: agent sessions, via `spawnSession()`, durable and retryable

The naming overlap makes it easy to conflate them, especially for future contributors unfamiliar with the distinction.

**Consequences:**
- Task callbacks routed to Slack channels instead of agent sessions
- MCP notifications spawning agent sessions (wrong direction -- MCP notifies the client, not the agent)
- Inconsistent deduplication logic across three systems
- Code duplication when each system reimplements subscription storage differently

**Prevention:**
1. **Clear naming.** Call the new system "Task Callbacks" or "Task Watchers", NOT "Task Notifications". Reserve "notification" for the existing system alert service. Reserve "subscription" for the existing MCP resource subscriptions.
2. **Separate module.** Create `src/callbacks/` (or `src/watchers/`) as a new top-level module, not a subfolder of `events/` or `mcp/`. This makes the separation architectural, not just naming.
3. **Document the taxonomy** in a brief comment at the top of each module: "This module handles X. For Y, see module Z. For W, see module Q."
4. **Do NOT extend the existing `NotificationService` adapter pattern** for task callbacks. The adapter pattern (send to a channel) is wrong for callbacks (spawn a session). Building callbacks as a `NotificationAdapter` implementation forces a bad abstraction.

**Detection:**
- Code review: any import from `events/notifier.ts` or `mcp/subscriptions.ts` in the new callback module is a red flag.
- Grep for "notification" in the new module's code -- it should use "callback" or "watcher" terminology.

**Phase to address:** Module naming and separation should be decided before any code is written.

---

## Minor Pitfalls

### Pitfall 9: Subscription Schema Stored in Task Metadata Bag

**What goes wrong:**
Using the existing `metadata: z.record(z.string(), z.unknown())` bag on task frontmatter to store subscription data (e.g., `metadata.subscriptions: [{ agent: "...", granularity: "..." }]`) seems convenient but creates problems:
- The metadata bag has no schema validation for its contents. Malformed subscription data silently persists.
- The metadata bag is serialized/deserialized with the entire task frontmatter on every read. Adding subscription arrays to every task increases I/O for the common case (reading a task that has no subscriptions).
- The metadata bag is written via `writeFileAtomic` on task updates. If the scheduler updates subscriptions while an agent updates the task body, the last writer wins and one write is lost.

**Prevention:**
1. Store subscriptions in separate files, not in task frontmatter. Use `state/callbacks/<taskId>/` with one file per subscription. This decouples subscription I/O from task I/O.
2. If subscriptions must be co-located with tasks, use a separate file in the task's directory: `tasks/<status>/TASK-xxx/callbacks.json`. This survives task status transitions (the directory moves with the task) without bloating the frontmatter.
3. Never modify task frontmatter from the notification system. Task frontmatter is owned by the task lifecycle (store, protocol router). Notification subscriptions are owned by the callback system.

**Phase to address:** Storage design should be decided in the first phase alongside the subscription schema.

---

### Pitfall 10: Testing Notification Delivery Requires Real Timing

**What goes wrong:**
Notification delivery involves timing-dependent behavior: poll cycles, debouncing, TTLs, rate limits, and cross-cycle queuing. Unit tests that mock `Date.now()` or use `vi.useFakeTimers()` can't reliably test scenarios like "notification is queued in cycle N and delivered in cycle N+1" because the scheduler's `poll()` function is designed to run once per invocation, not continuously.

Integration tests that run multiple poll cycles need real timing or a test harness that drives the scheduler through multiple cycles deterministically.

**Prevention:**
1. Make the poll cycle number an explicit input to the notification evaluator, not derived from wall clock time. This allows deterministic testing: `evaluateNotifications(subscriptions, tasks, pollCycle: 5)`.
2. Extract notification delivery logic into a pure function that takes current state and returns delivery decisions, separate from the I/O of actually spawning sessions. Test the pure function extensively; integration-test the I/O path with fewer tests.
3. Use the existing test patterns from `dispatch/__tests__/scheduler.test.ts` which already test multi-cycle behavior with mock executors.
4. Build a `TestCallbackHarness` (similar to how `MockNotificationAdapter` exists for the alert system) that captures callback delivery intentions without spawning sessions.

**Phase to address:** Build the test harness in the same phase as the notification evaluator.

---

### Pitfall 11: aof_subscribe Tool Exposes Subscription to Wrong Agent

**What goes wrong:**
Agent A calls `aof_subscribe({ taskId: "T1", granularity: "completion" })`. The subscription is stored with Agent A's identity. But in OpenClaw, the "agent" identity is determined by the role in the org chart, and multiple sessions can run as the same role. If Agent B shares Agent A's role (or Agent A's role is reassigned in the org chart), the callback session may be dispatched to the wrong physical agent instance.

**Prevention:**
1. Subscriptions should identify the subscriber by a combination of (agentRole, taskId-of-subscribing-session, correlationId) -- not just agent role. The callback is dispatched to the agent role, but the context includes which specific task/session created the subscription.
2. Accept that callback delivery is role-based, not instance-based, because OpenClaw sessions are ephemeral. Document this: "Callbacks are delivered to the agent role, not to a specific session."
3. If instance-level targeting is needed later, store the original session's `correlationId` on the subscription and include it in the callback context. The receiving agent can correlate.

**Phase to address:** Subscription identity design should be part of the schema phase.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Subscription schema & storage | Metadata bag abuse (Pitfall 9) | Separate files, not task frontmatter |
| Subscription creation API | Race with fast tasks (Pitfall 3) | Subscribe-on-create param on `aof_dispatch`; catch-up on subscribe |
| Notification evaluator | Infinite loop (Pitfall 1) | Cross-cycle delivery, depth counter, rate limit |
| Delivery durability | Lost on restart (Pitfall 2) | Write-ahead notification log; startup reconciliation |
| Scheduler integration | Blocking dispatch loop (Pitfall 7) | Separate budget, lower priority, time-boxed |
| DAG workflow notifications | Notification storm (Pitfall 4) | Batch per task per cycle, coalesce, debounce |
| Callback context | Agent lacks context (Pitfall 6) | Rich notification payload schema; include results |
| Module naming | Confusion with existing systems (Pitfall 8) | "Callbacks" not "notifications"; separate module |
| Subscription cleanup | Orphaned subscriptions (Pitfall 5) | Fire on all terminal states; TTL; audit sweep |
| Testing | Timing-dependent behavior (Pitfall 10) | Pure evaluator function; explicit poll cycle counter |

---

## Integration Points at Risk

These are the specific files/systems where v1.8 changes integrate with existing code and where mistakes are most costly:

| Integration Point | File | Risk | Prevention |
|-------------------|------|------|------------|
| Scheduler poll loop | `dispatch/scheduler.ts` (lines 298-350) | Notification delivery added to already-long loop | Separate phase after DAG hop dispatch; time-boxed |
| DAG evaluator output | `dispatch/dag-evaluator.ts:evaluateDAG()` | `changes[]` array mapped 1:1 to notifications | Coalesce transitions per task, not per hop |
| DAG transition handler | `dispatch/dag-transition-handler.ts:handleDAGHopCompletion()` | Callback delivery interleaved with hop dispatch | Notifications queued, not delivered inline |
| Task state transitions | `store/task-store.ts` (rename-based transitions) | Subscription check after rename creates dual-write | Write-ahead notification log before rename |
| Protocol router | `protocol/router.ts:handleCompletionReport()` | Completion triggers both DAG advancement AND notification | DAG advancement first, notification queueing second |
| `aof_dispatch` tool | `mcp/tools.ts` (dispatch handler) | Subscribe-on-create parameter extends existing schema | Optional field with Zod; backward-compatible |
| Existing `NotificationService` | `events/notifier.ts` | Developers route callbacks through alert system | Separate module, separate terminology |
| Existing `SubscriptionManager` | `mcp/subscriptions.ts` | MCP subscriptions confused with task callbacks | Document distinction; no shared code |
| `GatewayAdapter.spawnSession()` | `dispatch/executor.ts` | Callback sessions compete with task dispatch for slots | Callback budget separate from dispatch budget |
| Daemon startup | `daemon/daemon.ts` | Pending notifications not reconciled on restart | Startup reconciliation pass; scan pending queue |
| Completion enforcement | `dispatch/assign-executor.ts:onRunComplete` | Enforcement fires on callback sessions that don't call `aof_task_complete` | Callback sessions should not require task completion |
| Failure tracker | `dispatch/failure-tracker.ts` | Callback dispatch failures counted as task dispatch failures | Separate failure tracking for callbacks |

---

## Sources

- Direct codebase analysis of AOF v1.7 source (2975+ tests, TypeScript)
- `src/dispatch/scheduler.ts` -- poll loop structure, DAG hop dispatch integration point
- `src/dispatch/dag-evaluator.ts` -- DAG evaluation producing HopTransition changes array
- `src/dispatch/dag-transition-handler.ts` -- hop completion handling and session dispatch
- `src/events/notifier.ts` -- existing NotificationService (in-memory, channel-based)
- `src/mcp/subscriptions.ts` -- existing MCP SubscriptionManager (in-memory, filesystem-watching)
- `src/dispatch/assign-executor.ts` -- task dispatch with onRunComplete callback
- `src/dispatch/action-executor.ts` -- sequential action execution in poll loop
- `src/dispatch/failure-tracker.ts` -- dispatch failure counting and deadletter transitions
- `src/store/task-store.ts` -- filesystem-based store with atomic rename transitions
- `src/protocol/router.ts` -- protocol routing with task lock manager
- [Outbox/Inbox Patterns and Delivery Guarantees](https://event-driven.io/en/outbox_inbox_patterns_and_delivery_guarantees_explained/) -- at-least-once delivery pattern
- [Event Notification Pattern](https://medium.com/geekculture/the-event-notification-pattern-a62d48519107) -- event notification architecture
- [What do you mean by "Event-Driven"?](https://martinfowler.com/articles/201701-event-driven.html) -- event notification vs event-carried state transfer distinction
