# Phase 31: Granularity, Safety, and Hardening - Research

**Researched:** 2026-03-10
**Domain:** Callback delivery extensions — "all" granularity, loop prevention, restart recovery
**Confidence:** HIGH

## Summary

Phase 31 extends the existing callback delivery system (Phase 30) with three targeted features: (1) "all" granularity that fires on every state transition with per-poll-cycle batching, (2) infinite callback loop prevention via depth tracking, and (3) pending delivery recovery across daemon restarts. All three build directly on existing infrastructure with well-defined integration points.

The codebase is well-structured for these additions. The `callback-delivery.ts` module already has `deliverCallbacks()` and `retryPendingDeliveries()` with clear separation. The event logger already records `task.transitioned` events with `{from, to}` payloads — perfect for scanning transition history. The scheduler poll loop already iterates terminal tasks for retry, so recovery scan slots in naturally.

**Primary recommendation:** Implement in three focused waves — "all" granularity first (schema + delivery logic), then depth limiting (schema + propagation), then recovery scan (startup hook). Each wave is independently testable.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Poll-cycle batching: collect all transitions since last delivery into one callback per subscriber per poll cycle
- Payload includes ordered transition list: array of {fromStatus, toStatus, timestamp} in chronological order, plus current task state
- Track `lastDeliveredAt` timestamp on the subscription object; on each poll, scan the task's event log for transitions after that timestamp
- "All" is a superset of "completion" — it fires on every transition INCLUDING terminal ones; no need for separate completion subscription if you have "all"
- Maximum callback depth: 3 (original -> callback -> reaction -> callback -> reaction)
- Track depth via `callbackDepth` field in task frontmatter; when a callback-spawned session creates a new task, it inherits depth+1
- At depth limit: silently skip callback delivery and log a `subscription.depth_exceeded` event; subscription stays active but delivery is suppressed; task completes normally
- Self-subscription loops handled by depth limit — no separate detection needed; keep it simple
- Scan ALL terminal tasks (done/cancelled/deadletter) for undelivered active subscriptions on startup — comprehensive, catches everything regardless of downtime duration
- Recovery scan runs as part of the first poll cycle after startup — leverages existing retryPendingDeliveries logic, keeps startup fast
- Retry counter persists across restarts — pre-restart attempts still count toward 3-attempt limit; prevents infinite retry across restarts
- Emit `subscription.recovery_attempted` event per pending delivery found during startup scan for operator observability

### Claude's Discretion
- Exact event log scanning implementation for transition accumulation
- How callbackDepth propagates through the dispatch/subscribe flow
- Integration of recovery scan into existing poll() function
- Event payload structure for depth_exceeded and recovery_attempted events

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| GRAN-02 | `"all"` granularity fires on every state transition, batched per poll cycle | Add `lastDeliveredAt` to subscription schema, scan event log for `task.transitioned` events after that timestamp, batch into single callback payload per subscriber |
| SAFE-01 | Infinite callback loops prevented (depth counter or cross-cycle delivery) | Add `callbackDepth` to task frontmatter, propagate depth+1 from callback-spawned tasks, skip delivery at depth >= 3 with `subscription.depth_exceeded` event |
| SAFE-02 | Subscription delivery survives daemon restart (pending subscriptions re-evaluated on startup) | First-poll recovery scan of all terminal tasks for active subscriptions with undelivered state, emit `subscription.recovery_attempted` events |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | (existing) | Schema validation for subscription + task frontmatter extensions | Already used throughout codebase |
| write-file-atomic | (existing) | Crash-safe subscription file writes | Already used in SubscriptionStore |
| vitest | (existing) | Unit + integration testing | Already configured project-wide |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| EventLogger | (existing) | Query `task.transitioned` events for transition accumulation | GRAN-02 transition scanning |

No new dependencies needed. All work extends existing modules.

## Architecture Patterns

### Integration Points Map

```
src/
├── schemas/
│   ├── subscription.ts    # Add lastDeliveredAt field
│   ├── task.ts            # Add callbackDepth field to TaskFrontmatter
│   └── event.ts           # Add subscription.depth_exceeded, subscription.recovery_attempted
├── store/
│   └── subscription-store.ts  # Expand update() Pick to include lastDeliveredAt
├── dispatch/
│   ├── callback-delivery.ts   # Main work: all-granularity delivery, depth check, recovery scan
│   ├── assign-executor.ts     # Propagate callbackDepth to spawned callback sessions
│   └── scheduler.ts           # Wire recovery scan on first poll
├── daemon/
│   └── daemon.ts              # No changes needed (recovery scan is in scheduler poll)
└── dispatch/__tests__/
    ├── callback-delivery.test.ts  # Extend with all-granularity + depth + recovery tests
    └── callback-integration.test.ts  # Integration coverage
```

### Pattern 1: Event Log Scanning for Transition Accumulation (GRAN-02)

**What:** Query JSONL event logs for `task.transitioned` events after a timestamp to build the transition batch.
**When to use:** Every poll cycle for tasks with "all" granularity subscriptions.
**Example:**
```typescript
// Use EventLogger.query() — already exists with filter support
const events = await logger.query({ type: "task.transitioned", taskId });
const newTransitions = events
  .filter(e => new Date(e.timestamp).getTime() > lastDeliveredAtMs)
  .map(e => ({
    fromStatus: (e.payload as Record<string, unknown>).from as string,
    toStatus: (e.payload as Record<string, unknown>).to as string,
    timestamp: e.timestamp,
  }));
```

**Key insight:** `EventLogger.query()` already reads all JSONL files and filters by type+taskId. It returns `BaseEvent[]` with `timestamp` and `payload` containing `{from, to, reason}`. This is exactly what we need — no new infrastructure required.

### Pattern 2: Depth Propagation via Task Frontmatter (SAFE-01)

**What:** When `deliverSingleCallback` spawns a callback session, any task created in that session inherits `callbackDepth + 1` from the originating task.
**When to use:** In `deliverSingleCallback` — pass depth to the spawned session's context so downstream dispatches can set it.
**Implementation approach:**
```typescript
// In deliverSingleCallback, include depth in TaskContext
const context: TaskContext = {
  taskId: task.frontmatter.id,
  taskPath: "",
  agent: sub.subscriberId,
  priority: "normal",
  routing: { role: sub.subscriberId },
  taskFileContents: prompt,
  // Depth propagation: callback depth from originating task + 1
  metadata: { callbackDepth: (task.frontmatter.callbackDepth ?? 0) + 1 },
};
```

**Depth check before delivery:**
```typescript
// In deliverCallbacks — check depth before attempting delivery
const depth = task.frontmatter.callbackDepth ?? 0;
if (depth >= MAX_CALLBACK_DEPTH) {
  await logger.log("subscription.depth_exceeded", "callback-delivery", {
    taskId,
    payload: { depth, maxDepth: MAX_CALLBACK_DEPTH },
  });
  return; // Skip all deliveries for this task
}
```

### Pattern 3: First-Poll Recovery Scan (SAFE-02)

**What:** On the first poll cycle after daemon startup, scan all terminal tasks for active subscriptions that haven't been delivered.
**When to use:** Daemon restart recovery.
**Implementation approach:** The scheduler poll loop (section 6.6) already iterates terminal tasks and calls `retryPendingDeliveries`. The recovery scan is essentially the same logic but also catches subscriptions with `deliveryAttempts === 0` (never attempted, not just failed).

Two approaches:
1. **Modify `retryPendingDeliveries` to also handle never-attempted deliveries** — simplest, the retry candidates filter just needs to include `deliveryAttempts === 0`.
2. **Separate `recoverPendingDeliveries` function** — clearer separation, but duplicates logic.

**Recommendation:** Approach 1 is cleanest. The existing `retryPendingDeliveries` already filters for active subscriptions on terminal tasks. Expanding the filter to include `deliveryAttempts === 0` makes it handle both retry AND recovery in one pass. The only addition is emitting `subscription.recovery_attempted` on the first poll.

**First-poll detection:** Track via a boolean flag (`firstPoll`) in the scheduler or pass it as a parameter.

### Anti-Patterns to Avoid
- **Scanning event logs on every poll for all tasks:** Only scan for tasks with active "all" granularity subscriptions. The scheduler already filters terminal tasks — add subscription check before expensive log scan.
- **Storing transition history in subscription object:** Event log is the source of truth. Don't duplicate transition data in subscriptions.json — just use `lastDeliveredAt` as a cursor.
- **Depth check per-subscription instead of per-task:** Depth is a task-level property, not subscription-level. Check once per task, skip all deliveries.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Event log querying | Custom JSONL parser | `EventLogger.query()` | Already handles file listing, line parsing, filtering |
| Atomic subscription writes | Manual write + rename | `SubscriptionStore.update()` with write-file-atomic | Already handles crash safety |
| Task directory resolution | Hardcoded path construction | Existing `taskDirResolver` pattern from scheduler.ts L357-361 | Handles status-based directory structure |

## Common Pitfalls

### Pitfall 1: Race Between Transition and Delivery
**What goes wrong:** Task transitions between "all" granularity check and delivery — subscriber gets incomplete transition list.
**Why it happens:** Poll cycle reads task state, then scans events, then delivers. Task could transition during this window.
**How to avoid:** This is acceptable — best-effort delivery (DLVR-04). The missed transition will be picked up on the next poll cycle because `lastDeliveredAt` is only updated after successful delivery. The cursor approach is self-healing.
**Warning signs:** None needed — this is a known, acceptable trade-off.

### Pitfall 2: EventLogger.query() Performance on Large Logs
**What goes wrong:** `EventLogger.query()` reads ALL JSONL files to filter by taskId. For long-running instances with many days of logs, this could be slow.
**Why it happens:** No date-range filtering in current `query()` implementation.
**How to avoid:** For the "all" granularity scan, we know `lastDeliveredAt` — we can limit to recent log files only. Either add date-range support to `query()` or compute the relevant dates and read only those files.
**Warning signs:** Poll cycle duration increasing over time.

### Pitfall 3: callbackDepth Not Reaching New Tasks
**What goes wrong:** Depth field set on context but not propagated to newly created tasks in the callback session.
**Why it happens:** The callback session spawns an agent that calls `aof_dispatch` — but the dispatch tool doesn't know about callback depth from the session context.
**How to avoid:** The depth must be passed through the TaskContext metadata and picked up by the dispatch handler (`aof_dispatch` tool) when creating new tasks. The tool needs to check for `callbackDepth` in the session context and set it on the new task's frontmatter.
**Warning signs:** Depth always stays at 0 in tests — indicates propagation gap.

### Pitfall 4: Recovery Scan Triggering Duplicate Deliveries
**What goes wrong:** Recovery scan fires for subscriptions that were already successfully delivered but whose status update was lost.
**Why it happens:** Daemon crash between successful delivery and status update to "delivered".
**How to avoid:** This is inherent to at-least-once delivery — documented as acceptable (REQUIREMENTS.md "Exactly-once delivery" is out of scope). Subscribers must be idempotent.
**Warning signs:** None — working as designed.

### Pitfall 5: "All" Granularity + "Completion" Both Active
**What goes wrong:** A task has both an "all" and a "completion" subscription from the same subscriber. Terminal transition gets delivered twice.
**Why it happens:** "All" is a superset of "completion" per the decision.
**How to avoid:** Per user decision, "all" includes terminal transitions, so there's no need for both. But if both exist, each subscription is independent — both fire. This is correct behavior (subscriptions are independent entities).
**Warning signs:** Not a bug — just potentially redundant for the subscriber.

## Code Examples

### Adding lastDeliveredAt to Subscription Schema

```typescript
// In src/schemas/subscription.ts — add to TaskSubscription z.object
lastDeliveredAt: z.string().datetime().optional()
  .describe("ISO-8601 timestamp of last successful delivery (cursor for 'all' granularity)"),
```

### Adding callbackDepth to Task Frontmatter

```typescript
// In src/schemas/task.ts — add to TaskFrontmatter z.object
callbackDepth: z.number().int().min(0).optional()
  .describe("Callback chain depth — 0 for normal tasks, incremented for callback-spawned tasks"),
```

### Expanding SubscriptionStore.update() Pick Type

```typescript
// In src/store/subscription-store.ts — expand update() fields
fields: Partial<
  Pick<
    TaskSubscription,
    "status" | "deliveredAt" | "failureReason" | "deliveryAttempts" | "lastAttemptAt" | "lastDeliveredAt"
  >
>,
```

### "All" Granularity Delivery in deliverCallbacks

```typescript
// New function or branch in callback-delivery.ts
export async function deliverAllGranularityCallbacks(opts: DeliverCallbacksOptions): Promise<void> {
  const { taskId, store, subscriptionStore, logger } = opts;
  const task = await store.get(taskId);
  if (!task) return;

  // Depth check first (SAFE-01)
  const depth = task.frontmatter.callbackDepth ?? 0;
  if (depth >= MAX_CALLBACK_DEPTH) {
    await logger.log("subscription.depth_exceeded", "callback-delivery", {
      taskId,
      payload: { depth, maxDepth: MAX_CALLBACK_DEPTH },
    });
    return;
  }

  const activeSubs = await subscriptionStore.list(taskId, { status: "active" });
  const allSubs = activeSubs.filter(s => s.granularity === "all");

  for (const sub of allSubs) {
    const lastDeliveredAtMs = sub.lastDeliveredAt
      ? new Date(sub.lastDeliveredAt).getTime()
      : 0;

    // Scan event log for transitions since last delivery
    const events = await logger.query({ type: "task.transitioned", taskId });
    const newTransitions = events
      .filter(e => new Date(e.timestamp).getTime() > lastDeliveredAtMs)
      .map(e => ({
        fromStatus: (e.payload as Record<string, unknown>).from as string,
        toStatus: (e.payload as Record<string, unknown>).to as string,
        timestamp: e.timestamp,
      }));

    if (newTransitions.length === 0) continue;

    // Deliver batched transitions as single callback
    try {
      await deliverSingleCallback(task, sub, opts, newTransitions);
    } catch {
      // Best-effort
    }
  }
}
```

### New Event Types

```typescript
// In src/schemas/event.ts — add to EventType z.enum
"subscription.depth_exceeded",
"subscription.recovery_attempted",
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Only "completion" granularity | Adding "all" granularity | Phase 31 | Subscribers can track full task lifecycle |
| No loop protection | callbackDepth tracking | Phase 31 | Prevents infinite callback chains |
| No crash recovery for deliveries | First-poll recovery scan | Phase 31 | Pending deliveries survive daemon restarts |

## Open Questions

1. **How to pass callbackDepth through to newly dispatched tasks in callback sessions?**
   - What we know: The callback spawns a session via `executor.spawnSession()`. Tasks created in that session go through `aof_dispatch` tool handler.
   - What's unclear: How does the `aof_dispatch` tool handler access the session's `callbackDepth` context? The TaskContext has a metadata field but it's unclear if it flows to the tool handler.
   - Recommendation: Research the tool handler's access to session context in Phase 31 implementation. May need to pass depth via the callback prompt itself (e.g., structured metadata in the prompt), or via a side-channel in the gateway adapter. The simplest approach may be to include depth in the task frontmatter of the ORIGINATING task and have the tool handler check the parent task's depth.

2. **Should `deliverAllGranularityCallbacks` run on every poll for non-terminal tasks too?**
   - What we know: "All" granularity fires on EVERY state transition, not just terminal ones. Currently `deliverCallbacks` only runs in `onRunComplete` (when a session ends) and `retryPendingDeliveries` only looks at terminal tasks.
   - What's unclear: Where to hook into the poll loop for non-terminal "all" granularity scanning.
   - Recommendation: The poll loop already iterates ALL tasks. Add a scan for non-terminal tasks with active "all" subscriptions alongside the existing terminal task retry scan in section 6.6. This ensures transitions during normal lifecycle (ready -> in-progress -> review) are also captured.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (existing) |
| Config file | vitest.config.ts |
| Quick run command | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| GRAN-02 | "all" subs fire on every transition, batched per poll | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "all granularity" -x` | Wave 0 |
| GRAN-02 | lastDeliveredAt cursor advances after delivery | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "lastDeliveredAt" -x` | Wave 0 |
| GRAN-02 | Transition payload includes ordered {from,to,timestamp} array | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "transition list" -x` | Wave 0 |
| SAFE-01 | Delivery skipped at depth >= 3 | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "depth" -x` | Wave 0 |
| SAFE-01 | depth_exceeded event logged when skipped | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "depth_exceeded" -x` | Wave 0 |
| SAFE-01 | callbackDepth propagated to spawned tasks | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "callbackDepth" -x` | Wave 0 |
| SAFE-02 | Recovery scan finds active subs on terminal tasks with 0 attempts | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "recovery" -x` | Wave 0 |
| SAFE-02 | recovery_attempted event emitted per pending delivery | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "recovery_attempted" -x` | Wave 0 |
| SAFE-02 | Retry counter persists across restarts (pre-restart attempts count) | unit | `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -t "retry persist" -x` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/dispatch/__tests__/callback-delivery.test.ts -x`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] New test cases in `src/dispatch/__tests__/callback-delivery.test.ts` for all-granularity, depth limiting, recovery scan
- [ ] Schema validation tests for new `lastDeliveredAt` and `callbackDepth` fields (tested implicitly via unit tests)

## Sources

### Primary (HIGH confidence)
- `src/dispatch/callback-delivery.ts` — existing delivery logic, function signatures, patterns
- `src/schemas/subscription.ts` — current schema, field structure
- `src/schemas/task.ts` — TaskFrontmatter structure, valid transitions
- `src/schemas/event.ts` — EventType enum, existing subscription event types
- `src/dispatch/scheduler.ts` — poll loop structure, section 6.6 retry scan
- `src/store/subscription-store.ts` — update() method signature, Pick type constraint
- `src/daemon/daemon.ts` — startup flow, crash recovery detection
- `src/events/logger.ts` — EventLogger.query() method, logTransition helper
- `src/dispatch/assign-executor.ts` — onRunComplete callback delivery integration

### Secondary (MEDIUM confidence)
- Event log format (JSONL with `task.transitioned` type + `{from, to}` payload) — verified via grep of logTransition calls

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new dependencies, all existing modules
- Architecture: HIGH - clear integration points identified from source code
- Pitfalls: HIGH - identified from direct code analysis of existing patterns

**Research date:** 2026-03-10
**Valid until:** 2026-04-10 (stable internal codebase, no external dependencies)
