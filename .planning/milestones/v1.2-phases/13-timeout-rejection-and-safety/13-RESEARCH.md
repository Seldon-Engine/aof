# Phase 13: Timeout, Rejection, and Safety - Research

**Researched:** 2026-03-03
**Domain:** DAG failure mode handling (timeout escalation, rejection cascading, condition DSL safety)
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Timed-out hop stays `dispatched` and gets re-assigned to the `escalateTo` role (mirrors gate timeout pattern -- re-route, don't fail)
- Original agent's session is force-completed via existing `forceCompleteSession()` on GatewayAdapter
- Timeout checking happens during poll cycle only (alongside existing `checkGateTimeouts`) -- not on session_end
- When `escalateTo` is not configured, emit alert event + log warning but don't change hop status (mirrors gate behavior)
- One-shot escalation only -- if the escalateTo role also times out, emit alert but take no further action (no chain escalation)
- Hop timeout uses the `startedAt` timestamp on HopState to calculate elapsed time (set when hop is dispatched)
- Rejection triggered by reviewing agent's run result outcome (same pattern as gate rejections) -- no separate CLI command
- `origin` strategy: full DAG reset -- all hops return to pending/ready, workflow restarts from scratch
- `predecessors` strategy: reset the rejected hop + its immediate `dependsOn` predecessors to pending -- those re-execute, then rejected hop re-runs
- Reset hops have their results cleared (result, startedAt, completedAt, agent, correlationId all wiped) -- clean slate for re-execution
- Completed parallel branches unrelated to the rejection path stay done (only reset hops that need re-execution)
- Rejection cascade is handled in the evaluator as a new event type (alongside complete/failed/skip)
- DAG condition DSL is already safe: Zod-validated ConditionExpr with discriminated union + operator dispatch table (no eval/new Function)
- Add depth/complexity limit: max nesting depth (e.g., 5 levels of and/or/not) and max total conditions count -- enforced in `validateDAG()`
- Validate hop references in conditions: `hop_status` operator and field paths referencing `hops.X...` must point to hop IDs that exist in the DAG
- No runtime evaluation timeout needed -- the operator dispatch table evaluates synchronously with bounded recursion via depth limit
- Gate conditional evaluator (`gate-conditional.ts` with `new Function()`) is out of scope -- SAFE-01 is about DAG conditions, gate system is being replaced in Phase 15
- DAG-specific event types added to EventType enum: `hop_timeout`, `hop_timeout_escalation`, `hop_rejected`, `hop_rejection_cascade`
- Hop timeouts and rejections generate alert actions (same pattern as gate timeouts) -- notification rules pick them up via existing severity tiers
- Rejection events include the reviewing agent's rejection notes/reason in the event payload
- Rejection count limit per hop with configurable maximum (default 3) -- after N rejections, hop fails permanently to prevent infinite review-reject cycles

### Claude's Discretion
- Exact structure of the `checkHopTimeouts()` function (parallel to `checkGateTimeouts()`)
- How rejection event flows through the evaluator (new event type or outcome mapping)
- Internal implementation of depth/complexity counting for condition validation
- Metrics recording pattern for hop timeout/rejection events
- Test structure and fixture design for timeout/rejection scenarios

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SAFE-01 | Hop conditions use a restricted JSON DSL (no eval/new Function) for agent-composed workflows | ConditionExpr is already a Zod-validated discriminated union with OPERATORS dispatch table -- no eval/new Function. This phase adds depth/complexity limits and hop reference validation to `validateDAG()`. |
| SAFE-03 | Each hop supports timeout with escalation to a specified role | Hop schema already has `timeout` and `escalateTo` fields. This phase implements `checkHopTimeouts()` (parallel to `checkGateTimeouts()`) in the poll cycle, with force-complete + re-dispatch logic. |
| SAFE-04 | Hop rejection resets downstream hops and re-dispatches (configurable rejection strategy) | Hop schema already has `canReject`, `rejectionStrategy` fields. This phase implements rejection cascade logic in the evaluator (origin + predecessors strategies), with circuit-breaker after N rejections. |
</phase_requirements>

## Summary

Phase 13 adds three failure-mode capabilities to the DAG execution engine: hop timeout with escalation, rejection with cascade reset, and condition DSL safety hardening. The codebase is exceptionally well-prepared -- all three features have schema placeholders already defined (timeout, escalateTo, canReject, rejectionStrategy on the Hop schema) and strong structural patterns to follow (gate timeout checking in `escalation.ts`, gate rejection handling in `gate-evaluator.ts`, skip cascading in `dag-evaluator.ts`).

The primary work is behavior implementation behind existing schema fields, not new schema design. The `checkHopTimeouts()` function will structurally mirror `checkGateTimeouts()` -- scanning in-progress DAG tasks for dispatched hops that exceed their timeout, then either escalating (force-complete original session + re-dispatch to escalateTo role) or alerting (no escalateTo configured). Rejection adds a new event type to the evaluator alongside complete/failed/skip, with two strategies (origin = full reset, predecessors = partial reset) and a circuit-breaker (hop fails after N rejections). DSL safety adds depth counting and hop reference validation to the existing `validateDAG()` function.

**Primary recommendation:** Implement in three logical units: (1) hop timeout checking + escalation in `escalation.ts`, (2) rejection cascade + circuit-breaker in `dag-evaluator.ts` + `dag-transition-handler.ts`, (3) condition depth/reference validation in `workflow-dag.ts`. All three share the same event logging and metrics patterns already established.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | (existing) | Schema validation, ConditionExpr discriminated union | Already used for all schemas; depth/complexity validation extends existing `validateDAG()` |
| write-file-atomic | (existing) | Crash-safe frontmatter persistence after rejection resets | Already used in `persistWorkflowState()` and gate escalation |
| vitest | (existing) | Unit testing for all three feature areas | Already used for all dispatch tests |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none needed) | - | - | Zero new dependencies -- all features are pure TypeScript logic on existing infrastructure |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Manual depth counting | Zod `.superRefine()` on ConditionExpr | superRefine on recursive lazy schemas is complex; standalone depth counter in `validateDAG()` is simpler and already the pattern |
| Separate rejection handler module | Inline in dag-evaluator | Keeping rejection in the evaluator follows the established pattern where evaluator returns structured changes, caller applies side effects |

**Installation:**
```bash
# No new dependencies needed
```

## Architecture Patterns

### Recommended Project Structure
```
src/dispatch/
├── escalation.ts           # ADD checkHopTimeouts() alongside checkGateTimeouts()
├── dag-evaluator.ts         # ADD rejection event handling (new HopEvent outcome)
├── dag-transition-handler.ts # ADD rejection-triggered cascade + re-dispatch logic
├── dag-condition-evaluator.ts # (no changes -- dispatch table already safe)
├── duration-parser.ts       # FIX: add "d" (days) unit support
├── scheduler.ts             # ADD checkHopTimeouts() call in poll cycle
src/schemas/
├── workflow-dag.ts          # ADD depth/complexity validation + hop reference checking
├── event.ts                 # ADD hop_timeout, hop_timeout_escalation, hop_rejected, hop_rejection_cascade
src/events/
├── notification-policy/
│   └── severity.ts          # ADD hop_timeout_escalation to ALWAYS_CRITICAL_EVENTS set
```

### Pattern 1: Poll-Cycle Timeout Scanning (mirror of checkGateTimeouts)
**What:** Scan all in-progress DAG tasks for dispatched hops that exceed their configured timeout.
**When to use:** During every poll cycle, alongside existing gate timeout checking.
**Example:**
```typescript
// Follows established pattern in src/dispatch/escalation.ts
export async function checkHopTimeouts(
  store: ITaskStore,
  logger: EventLogger,
  config: SchedulerConfig,
  metrics?: AOFMetrics,
): Promise<SchedulerAction[]> {
  const actions: SchedulerAction[] = [];
  const now = Date.now();

  const tasks = await store.list({ status: "in-progress" });

  for (const task of tasks) {
    if (!task.frontmatter.workflow) continue;
    const workflow = task.frontmatter.workflow;

    for (const [hopId, hopState] of Object.entries(workflow.state.hops)) {
      if (hopState.status !== "dispatched") continue;
      if (!hopState.startedAt) continue;

      const hopDef = workflow.definition.hops.find(h => h.id === hopId);
      if (!hopDef?.timeout) continue;

      const timeoutMs = parseDuration(hopDef.timeout);
      if (!timeoutMs) continue;

      const elapsed = now - new Date(hopState.startedAt).getTime();
      if (elapsed > timeoutMs) {
        const action = await escalateHopTimeout(
          task, hopDef, hopState, hopId, elapsed, store, logger, config, metrics,
        );
        actions.push(action);
      }
    }
  }

  return actions;
}
```

### Pattern 2: Rejection as Evaluator Event (extending HopEvent)
**What:** Map `needs_review` run result outcome to a "rejected" hop event, then handle it in the evaluator as a cascade reset.
**When to use:** When `handleDAGHopCompletion()` detects a reviewing agent's `needs_review` outcome on a `canReject` hop.
**Example:**
```typescript
// In mapRunResultToHopEvent -- extend the outcome mapping:
// Currently: "done" -> "complete", anything else -> "failed"
// Add: "needs_review" on a canReject hop -> "rejected"

// In evaluateDAG -- add rejection handling alongside complete/failed/skip:
if (event.outcome === "rejected") {
  const hopDef = definition.hops.find(h => h.id === event.hopId)!;
  const strategy = hopDef.rejectionStrategy ?? "origin";

  if (strategy === "origin") {
    // Reset ALL hops to pending (clean slate)
    resetAllHops(newState, changes, timestamp);
  } else {
    // Reset rejected hop + its immediate predecessors
    resetPredecessorHops(newState, hopDef, changes, timestamp);
  }
}
```

### Pattern 3: Bounded Recursion via Depth Counting
**What:** Count nesting depth and total condition nodes in ConditionExpr trees to prevent abuse.
**When to use:** In `validateDAG()` for every hop that has a `condition` defined.
**Example:**
```typescript
// In validateDAG(), add for each hop with a condition:
function measureConditionComplexity(
  expr: ConditionExprType,
  currentDepth: number = 0,
): { maxDepth: number; totalNodes: number } {
  const MAX_DEPTH = 5;
  const MAX_NODES = 50;

  let maxDepth = currentDepth;
  let totalNodes = 1;

  if (expr.op === "and" || expr.op === "or") {
    for (const child of expr.conditions) {
      const sub = measureConditionComplexity(child, currentDepth + 1);
      maxDepth = Math.max(maxDepth, sub.maxDepth);
      totalNodes += sub.totalNodes;
    }
  } else if (expr.op === "not") {
    const sub = measureConditionComplexity(expr.condition, currentDepth + 1);
    maxDepth = Math.max(maxDepth, sub.maxDepth);
    totalNodes += sub.totalNodes;
  }

  return { maxDepth, totalNodes };
}
```

### Pattern 4: Circuit Breaker via Rejection Count
**What:** Track per-hop rejection count on HopState; after N rejections, fail the hop permanently.
**When to use:** During rejection event processing in the evaluator.
**Example:**
```typescript
// HopState gets a new optional field: rejectionCount
// In rejection handling:
const currentCount = (newState.hops[event.hopId]?.rejectionCount ?? 0) + 1;
const maxRejections = hopDef.maxRejections ?? 3; // configurable, default 3

if (currentCount >= maxRejections) {
  // Circuit breaker: fail the hop permanently
  newState.hops[event.hopId] = {
    ...newState.hops[event.hopId]!,
    status: "failed",
    completedAt: timestamp,
    rejectionCount: currentCount,
  };
  // Then cascade skips downstream (reuse existing cascadeSkips)
} else {
  // Normal rejection cascade
  applyRejectionStrategy(strategy, newState, hopDef, changes, timestamp);
  // Preserve rejection count through reset
}
```

### Anti-Patterns to Avoid
- **Timeout checking on session_end:** Decision explicitly says timeout checking in poll cycle only. Session_end handles run results, not timeouts.
- **Chain escalation:** Decision explicitly says one-shot only. If escalateTo role also times out, alert only.
- **Mutating state directly in evaluator:** The evaluator must return a new state via structuredClone (immutable output), caller persists.
- **Resetting unrelated parallel branches:** Only reset hops on the rejection path. Completed branches that don't intersect the rejected hop's dependency chain stay done.
- **Using eval/new Function for conditions:** The whole point of SAFE-01. ConditionExpr already avoids this; this phase adds depth limits as defense-in-depth.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Duration parsing | Custom regex parser | Extend existing `parseDuration()` in `duration-parser.ts` | Already exists, just needs "d" unit added |
| Atomic file writes | Manual write + rename | `write-file-atomic` (already a dependency) | Handles crash safety edge cases |
| State immutability | Manual deep copy | `structuredClone()` (already used in evaluateDAG) | Native, zero-dependency, handles all JSON types |
| Hop reference collection | Ad-hoc traversal | Extend existing `validateDAG()` adjacency/BFS logic | Already builds hop maps and does graph traversal |

**Key insight:** Every feature in this phase extends existing patterns. The codebase has gate timeout, gate rejection, skip cascading, and DAG validation -- this phase adds DAG-specific variants of all four.

## Common Pitfalls

### Pitfall 1: parseDuration() Missing "d" Unit
**What goes wrong:** `TIMEOUT_REGEX` in `workflow-dag.ts` accepts `\d+[mhd]$` (including days), but `parseDuration()` in `duration-parser.ts` only handles `m` and `h`. A hop with `timeout: "2d"` passes schema validation but `parseDuration` returns `null`, silently skipping the timeout check.
**Why it happens:** The schema regex was updated for Phase 10 (DAG schema) to include "d" but the parser was written earlier for gate timeouts.
**How to avoid:** Add `d` case to `parseDuration()` before implementing `checkHopTimeouts()`.
**Warning signs:** Timeouts configured with "d" never fire.

### Pitfall 2: Rejection Count Survives Reset
**What goes wrong:** When applying rejection strategy (origin or predecessors), the reset wipes all HopState fields (result, startedAt, completedAt, agent, correlationId). If `rejectionCount` is also wiped, the circuit breaker never triggers.
**Why it happens:** The reset logic clears "all fields" but rejectionCount must persist across resets to count cumulative rejections.
**How to avoid:** Explicitly preserve `rejectionCount` when resetting hop state. The reset helper should set `{ status: "pending", rejectionCount: existingCount }` and clear everything else.
**Warning signs:** Rejection loops that never trip the circuit breaker.

### Pitfall 3: Force-Complete Race with Session End
**What goes wrong:** `checkHopTimeouts()` force-completes the timed-out agent's session and re-dispatches to the escalateTo role. But if `handleSessionEnd` fires between the force-complete and the state update, it may process a stale run result.
**Why it happens:** The poll cycle and session_end can interleave. Force-complete triggers a session end event.
**How to avoid:** The CONTEXT.md decision says "force-complete BEFORE re-dispatching to escalateTo role." Use the lock manager (already used in `handleSessionEnd`) to serialize access to the task. Mark the hop as escalated in state before dispatching.
**Warning signs:** Two sessions running for the same hop, stale run results being processed after escalation.

### Pitfall 4: Origin Strategy Resets Already-Dispatched Hops
**What goes wrong:** If the origin rejection strategy resets all hops, a hop that is currently `dispatched` (agent actively working) gets reset to `pending` while the agent's session is still alive.
**Why it happens:** Origin strategy resets ALL hops indiscriminately.
**How to avoid:** With the one-hop-at-a-time invariant, only the rejected hop itself can be dispatched (reviewer just completed). All other hops should be in terminal states (complete/failed/skipped) or pending. But verify this invariant holds before resetting.
**Warning signs:** Dispatched hop reset to pending while agent session still active.

### Pitfall 5: Condition Depth Validation on Lazy Schemas
**What goes wrong:** `ConditionExpr` uses `z.lazy()` for recursive definition. Trying to add depth validation inside the Zod schema itself (via `.superRefine()`) is complex with lazy recursive types.
**Why it happens:** Zod's lazy schemas don't have simple hooks for depth tracking during parse.
**How to avoid:** The decision says to enforce depth/complexity in `validateDAG()` as a post-parse check, not in the Zod schema itself. This is the correct approach -- parse the ConditionExpr with Zod (validates structure), then walk the parsed tree to check depth.
**Warning signs:** Over-complicated Zod schema with runtime errors on deep conditions.

## Code Examples

### Hop Timeout Escalation (force-complete + re-dispatch)
```typescript
// In escalation.ts, mirrors escalateGateTimeout structure
async function escalateHopTimeout(
  task: Task,
  hopDef: Hop,
  hopState: HopState,
  hopId: string,
  elapsedMs: number,
  store: ITaskStore,
  logger: EventLogger,
  config: SchedulerConfig,
  metrics?: AOFMetrics,
): Promise<SchedulerAction> {
  if (!hopDef.escalateTo) {
    // No escalation target -- alert only, don't change hop status
    await logger.log("hop_timeout", "scheduler", {
      taskId: task.frontmatter.id,
      payload: { hopId, elapsed: elapsedMs, timeout: hopDef.timeout },
    });
    return {
      type: "alert",
      taskId: task.frontmatter.id,
      taskTitle: task.frontmatter.title,
      reason: `Hop ${hopId} timeout (${Math.floor(elapsedMs / 1000)}s), no escalation configured`,
    };
  }

  if (!config.dryRun) {
    // 1. Force-complete the timed-out agent's session FIRST
    if (config.executor && hopState.correlationId) {
      await config.executor.forceCompleteSession(hopState.correlationId);
    }

    // 2. Re-assign hop to escalateTo role (stays dispatched)
    const workflow = task.frontmatter.workflow!;
    workflow.state.hops[hopId] = {
      ...workflow.state.hops[hopId]!,
      agent: hopDef.escalateTo,
      startedAt: new Date().toISOString(), // Reset timer for escalateTo
      correlationId: undefined, // Will be set on re-dispatch
    };

    await persistWorkflowState(task, workflow.state);

    // 3. Log escalation event
    await logger.log("hop_timeout_escalation", "scheduler", {
      taskId: task.frontmatter.id,
      payload: {
        hopId,
        fromRole: hopDef.role,
        toRole: hopDef.escalateTo,
        elapsed: elapsedMs,
        timeout: hopDef.timeout,
      },
    });
  }

  return {
    type: "alert",
    taskId: task.frontmatter.id,
    taskTitle: task.frontmatter.title,
    agent: hopDef.escalateTo,
    reason: `Hop ${hopId} timeout, escalated from ${hopDef.role} to ${hopDef.escalateTo}`,
  };
}
```

### Rejection Cascade -- Origin Strategy
```typescript
// In dag-evaluator.ts, applied when event.outcome === "rejected"
function resetAllHopsForOrigin(
  definition: WorkflowDefinition,
  state: WorkflowState,
  changes: HopTransition[],
  rejectedHopId: string,
  timestamp: string,
): void {
  for (const hop of definition.hops) {
    const prevStatus = state.hops[hop.id]?.status;
    if (!prevStatus || prevStatus === "pending") continue;

    // Preserve rejectionCount for the rejected hop
    const existingRejectionCount = state.hops[hop.id]?.rejectionCount;

    state.hops[hop.id] = {
      status: hop.dependsOn.length === 0 ? "ready" : "pending",
      rejectionCount: hop.id === rejectedHopId ? existingRejectionCount : undefined,
    };
    changes.push({
      hopId: hop.id,
      from: prevStatus,
      to: state.hops[hop.id]!.status,
      reason: "rejection_cascade_origin",
    });
  }
}
```

### Rejection Cascade -- Predecessors Strategy
```typescript
function resetPredecessorHops(
  definition: WorkflowDefinition,
  state: WorkflowState,
  changes: HopTransition[],
  rejectedHopId: string,
  timestamp: string,
): void {
  const hopDef = definition.hops.find(h => h.id === rejectedHopId)!;
  const hopsToReset = [rejectedHopId, ...hopDef.dependsOn];

  for (const hopId of hopsToReset) {
    const prevStatus = state.hops[hopId]?.status;
    if (!prevStatus || prevStatus === "pending") continue;

    const dep = definition.hops.find(h => h.id === hopId)!;
    const existingRejectionCount = state.hops[hopId]?.rejectionCount;

    state.hops[hopId] = {
      status: dep.dependsOn.length === 0 ||
              dep.dependsOn.every(d => !hopsToReset.includes(d))
                ? "ready" : "pending",
      rejectionCount: hopId === rejectedHopId ? existingRejectionCount : undefined,
    };
    changes.push({
      hopId,
      from: prevStatus!,
      to: state.hops[hopId]!.status,
      reason: "rejection_cascade_predecessors",
    });
  }
}
```

### Condition Depth Validation
```typescript
// In workflow-dag.ts, added to validateDAG()
const MAX_CONDITION_DEPTH = 5;
const MAX_CONDITION_NODES = 50;

function measureConditionComplexity(
  expr: ConditionExprType,
  depth: number = 0,
): { maxDepth: number; totalNodes: number } {
  let maxDepth = depth;
  let totalNodes = 1;

  if (expr.op === "and" || expr.op === "or") {
    for (const child of (expr as { conditions: ConditionExprType[] }).conditions) {
      const sub = measureConditionComplexity(child, depth + 1);
      maxDepth = Math.max(maxDepth, sub.maxDepth);
      totalNodes += sub.totalNodes;
    }
  } else if (expr.op === "not") {
    const sub = measureConditionComplexity(
      (expr as { condition: ConditionExprType }).condition, depth + 1,
    );
    maxDepth = Math.max(maxDepth, sub.maxDepth);
    totalNodes += sub.totalNodes;
  }

  return { maxDepth, totalNodes };
}

// Usage in validateDAG:
for (const hop of definition.hops) {
  if (hop.condition) {
    const { maxDepth, totalNodes } = measureConditionComplexity(hop.condition);
    if (maxDepth > MAX_CONDITION_DEPTH) {
      errors.push(
        `Hop "${hop.id}" condition exceeds max nesting depth ${MAX_CONDITION_DEPTH} (found: ${maxDepth})`,
      );
    }
    if (totalNodes > MAX_CONDITION_NODES) {
      errors.push(
        `Hop "${hop.id}" condition exceeds max node count ${MAX_CONDITION_NODES} (found: ${totalNodes})`,
      );
    }
  }
}
```

### Hop Reference Validation in Conditions
```typescript
// In validateDAG(), after building hopIds set:
function collectHopReferences(expr: ConditionExprType): string[] {
  const refs: string[] = [];
  if (expr.op === "hop_status") {
    refs.push((expr as { hop: string }).hop);
  } else if (expr.op === "and" || expr.op === "or") {
    for (const child of (expr as { conditions: ConditionExprType[] }).conditions) {
      refs.push(...collectHopReferences(child));
    }
  } else if (expr.op === "not") {
    refs.push(...collectHopReferences((expr as { condition: ConditionExprType }).condition));
  }
  // Also check field paths like "hops.X.result.field"
  if ("field" in expr) {
    const field = (expr as { field: string }).field;
    const match = field.match(/^hops\.([^.]+)/);
    if (match) refs.push(match[1]!);
  }
  return refs;
}

for (const hop of definition.hops) {
  if (hop.condition) {
    const refs = collectHopReferences(hop.condition);
    for (const ref of refs) {
      if (!hopIds.has(ref)) {
        errors.push(
          `Hop "${hop.id}" condition references non-existent hop "${ref}"`,
        );
      }
    }
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Gate timeout only | Gate + hop timeout (this phase) | Phase 13 | DAG hops get the same timeout protection as gates |
| Gate rejection (origin only) | DAG rejection (origin + predecessors strategies) | Phase 13 | More flexible rejection handling; predecessors strategy enables partial DAG re-execution |
| No condition complexity limits | Depth + node count validation | Phase 13 | Prevents agent-authored conditions from creating unbounded recursion |

**Deprecated/outdated:**
- Gate workflow system: Being replaced by DAG in Phase 15, but gate timeout/rejection patterns still serve as structural templates for this phase.

## Open Questions

1. **Hop re-dispatch after escalation -- new session or status change?**
   - What we know: The decision says the timed-out hop stays `dispatched` and gets re-assigned to the `escalateTo` role. But the hop needs a new session spawned for the escalateTo role.
   - What's unclear: Should `checkHopTimeouts()` directly call `dispatchDAGHop()` for the escalateTo role, or should it set the hop back to `ready` with the new role and let the poll cycle's DAG dispatch section handle it?
   - Recommendation: Set hop back to `ready` with role overridden to `escalateTo`, let the standard DAG dispatch in the poll cycle spawn the session. This reuses existing dispatch logic and avoids duplicating spawn code in the escalation function. The "one-shot" tracking can be done with an `escalated: true` flag on HopState to prevent re-escalation.

2. **HopState schema extension for rejectionCount**
   - What we know: HopState needs a `rejectionCount` field to track cumulative rejections for circuit-breaker.
   - What's unclear: Should this be added to the existing HopState Zod schema, or tracked separately?
   - Recommendation: Add `rejectionCount: z.number().int().nonneg().optional()` to HopState schema. It's a natural part of hop execution state and must survive resets.

3. **HopStatus enum -- does "rejected" need to be a status?**
   - What we know: Current statuses are: pending, ready, dispatched, complete, failed, skipped. The evaluator receives a HopEvent with an outcome string.
   - What's unclear: Should "rejected" be added to HopStatus, or is it a transient event that results in "pending" (after reset)?
   - Recommendation: Do NOT add "rejected" to HopStatus. Rejection is an event, not a resting state. The hop transitions to "pending" (via reset) or "failed" (via circuit-breaker). The event is logged as `hop_rejected` in the event stream.

4. **Predecessors strategy -- handling deep chains**
   - What we know: Predecessors strategy resets "rejected hop + its immediate dependsOn predecessors."
   - What's unclear: What if a predecessor's own predecessors need re-execution to produce fresh input? "Immediate dependsOn" means one level only.
   - Recommendation: Follow the decision literally -- immediate predecessors only. If deeper re-execution is needed, the user should use `origin` strategy. This keeps predecessors predictable.

## Sources

### Primary (HIGH confidence)
- Existing codebase: `src/dispatch/escalation.ts` -- `checkGateTimeouts()` and `escalateGateTimeout()` functions (structural template for hop timeout)
- Existing codebase: `src/dispatch/dag-evaluator.ts` -- `evaluateDAG()`, `cascadeSkips()`, `buildDownstreamIndex()` (structural template for rejection cascade)
- Existing codebase: `src/dispatch/dag-transition-handler.ts` -- `handleDAGHopCompletion()`, `dispatchDAGHop()`, `persistWorkflowState()` (integration points)
- Existing codebase: `src/dispatch/gate-evaluator.ts` -- `handleRejectionOutcome()` (gate rejection pattern reference)
- Existing codebase: `src/schemas/workflow-dag.ts` -- `Hop`, `HopState`, `ConditionExpr`, `validateDAG()` schemas and validation
- Existing codebase: `src/schemas/event.ts` -- `EventType` enum (where new event types are added)
- Existing codebase: `src/dispatch/dag-condition-evaluator.ts` -- `OPERATORS` dispatch table (confirms no eval/new Function)
- Existing codebase: `src/dispatch/duration-parser.ts` -- `parseDuration()` (needs "d" unit addition)
- Existing codebase: `src/events/notification-policy/severity.ts` -- `ALWAYS_CRITICAL_EVENTS` set (for escalation alerts)
- Existing codebase: `src/dispatch/executor.ts` -- `GatewayAdapter` interface with `forceCompleteSession()`
- Existing codebase: `src/protocol/router.ts` -- `handleSessionEnd()` (rejection flow integration point)
- Existing codebase: `src/dispatch/scheduler.ts` -- `poll()` function (timeout check + DAG dispatch integration points)

### Secondary (MEDIUM confidence)
- None needed -- all research is codebase-internal

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- zero new dependencies, all existing patterns
- Architecture: HIGH -- every feature mirrors existing gate system patterns; schema placeholders already exist
- Pitfalls: HIGH -- identified from direct code inspection (parseDuration gap, rejection count persistence, race conditions)

**Research date:** 2026-03-03
**Valid until:** 2026-04-03 (stable internal architecture, no external dependency concerns)
