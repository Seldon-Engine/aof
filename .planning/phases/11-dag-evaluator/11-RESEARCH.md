# Phase 11: DAG Evaluator - Research

**Researched:** 2026-03-02
**Domain:** Pure-function DAG state evaluation, condition DSL interpretation, graph traversal
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Single `evaluateDAG()` function handles all hop events (completion, failure, skip) -- dispatches on event type internally
- Input: `WorkflowDefinition` + `WorkflowState` + hop event object (hopId, outcome, result data) -- pure function with no task dependency
- Returns both a new `WorkflowState` (immutable replacement) AND a change summary listing hop transitions, newly ready hops, and optional DAG status change
- `initializeWorkflowState()` from Phase 10 is sufficient for initial readiness -- evaluator only runs on hop events, not at DAG creation
- Context object contains: all completed hop results (keyed by hop ID) + basic task metadata (status, tags, priority, routing)
- Field paths use dot-path resolution (e.g., `hops.review.result.approved`, `task.priority`) -- simple lodash-style get()
- Missing fields resolve to `undefined` and are treated as falsy -- comparisons against undefined return false (except `neq` which returns true)
- `hop_status` operator reads directly from the live `WorkflowState.hops` map -- it's a special operator, not a field lookup through context
- A downstream hop auto-skips only if ALL its predecessors are in terminal non-success state (skipped or failed) -- if any predecessor completed, the hop can still proceed
- Skip cascading is fully recursive in a single evaluator call -- if A skips -> B skips -> C skips, all transitions appear in one change summary
- OR-join hops (`joinType: 'any'`) become ready as soon as ANY predecessor completes (not just any terminal state -- only `complete` triggers readiness)
- AND-join hops with some predecessors completed and some skipped (but none pending/dispatched) become ready -- skipped predecessors count as "satisfied" for AND-join purposes
- DAG status = `complete` when every hop is either `complete` or `skipped` -- no pending, ready, or dispatched hops remain
- Parallel branches continue executing when a hop fails -- a failed hop only blocks its own downstream dependents via skip cascade
- DAG status = `failed` when all hops are terminal and at least one is `failed` -- distinguishes from `complete` (all success/skipped)
- Evaluator result includes an optional `taskStatus` field (e.g., `done`, `failed`) -- scheduler applies it, keeping completion logic centralized in the evaluator

### Claude's Discretion
- Exact TypeScript interface naming and field layout for input/result types
- Internal implementation of dot-path resolution (lodash-style or custom)
- Condition evaluator function structure (single function or per-operator dispatch table)
- Error handling for malformed conditions (shouldn't happen if Zod-validated, but defensive coding approach)
- Test structure and fixture design

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| EXEC-04 | Conditional hops evaluate a JSON DSL expression to determine execute vs skip | Condition evaluator architecture: per-operator dispatch table consuming `ConditionExprType` schema, with dot-path field resolution and evaluation context building |
| EXEC-05 | Skipped hops propagate skip to downstream dependents with no other satisfied inputs | Skip cascade algorithm: recursive downstream traversal with "all predecessors terminal non-success" check, fully resolved in single evaluator call |
| EXEC-07 | Join hops support configurable join type (all predecessors vs any predecessor) | Readiness algorithm: AND-join (all predecessors complete or skipped, none pending/dispatched) vs OR-join (any predecessor complete), integrated into hop readiness check |
</phase_requirements>

## Summary

Phase 11 implements a pure-function DAG evaluator that processes hop completion/failure/skip events against a workflow definition and current state, producing an updated state and a change summary. This is a self-contained algorithmic module with zero external dependencies -- it operates entirely on the `WorkflowDefinition`, `WorkflowState`, and `ConditionExprType` schemas already defined in Phase 10.

The evaluator has three core algorithms: (1) condition evaluation interpreting the JSON DSL `ConditionExpr` schema to decide hop execute-vs-skip, (2) readiness determination checking whether a hop's predecessors satisfy its join type (AND vs OR), and (3) skip cascade propagation recursively marking downstream hops as skipped when all their inputs are terminal non-success. All three must compose into a single `evaluateDAG()` call that returns every state transition atomically.

The existing `evaluateGateTransition()` in `src/dispatch/gate-evaluator.ts` provides the structural blueprint: a pure function taking structured input, returning structured result with state updates and metadata. Phase 11's evaluator mirrors this pattern but replaces linear gate traversal with graph-based hop evaluation.

**Primary recommendation:** Implement as a single module `src/dispatch/dag-evaluator.ts` with one exported function `evaluateDAG()` plus internal helpers for condition evaluation, readiness checking, and skip cascading. Use a per-operator dispatch table for condition evaluation.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | (project version) | Type-safe evaluator implementation | Project standard |
| Zod | (project version) | Type inference from Phase 10 schemas | Project standard, schemas already defined |
| Vitest | (project version) | Unit testing | Project test framework |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none) | -- | -- | Zero new dependencies per STATE.md decision |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom dot-path get() | lodash.get | Adds dependency for ~15 lines of code; project decision is zero new deps |
| Switch/dispatch table | Single function with if-chain | Dispatch table is more extensible, cleaner per-operator testing |
| Mutable state updates | Immutable replacement | Immutable is decided: evaluator returns new WorkflowState, no mutation |

**Installation:**
```bash
# No new packages -- all types from existing Phase 10 schemas
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── dispatch/
│   ├── dag-evaluator.ts           # evaluateDAG() + types
│   ├── dag-condition-evaluator.ts # evaluateCondition() + dot-path resolver
│   └── __tests__/
│       ├── dag-evaluator.test.ts           # Core evaluator tests
│       └── dag-condition-evaluator.test.ts # Condition DSL tests
├── schemas/
│   ├── workflow-dag.ts            # (Phase 10, unchanged) WorkflowDefinition, WorkflowState, ConditionExpr
│   └── index.ts                   # (update) export new evaluator types
```

### Pattern 1: Pure Function Evaluator (mirrors gate-evaluator.ts)
**What:** A single entry-point function that takes immutable input, returns a structured result with all state changes. No I/O, no side effects, deterministic.
**When to use:** For all DAG state transitions -- hop completion, failure, condition evaluation, skip cascading.
**Example:**
```typescript
// Mirrors: evaluateGateTransition(input: GateEvaluationInput): GateEvaluationResult
// Source: src/dispatch/gate-evaluator.ts (project pattern)

export interface DAGEvaluationInput {
  definition: WorkflowDefinition;
  state: WorkflowState;
  event: HopEvent;       // { hopId, outcome, result? }
  context: EvalContext;   // { hopResults, task metadata }
}

export interface DAGEvaluationResult {
  state: WorkflowState;           // New immutable state
  changes: HopTransition[];       // All hop status changes
  readyHops: string[];            // Newly ready hop IDs
  dagStatus?: WorkflowStatus;     // DAG-level status change (if any)
  taskStatus?: string;            // Suggested task status (e.g., "done", "failed")
}

export function evaluateDAG(input: DAGEvaluationInput): DAGEvaluationResult {
  // 1. Apply primary hop event (complete/failed/skipped)
  // 2. Evaluate conditions on newly unblocked hops
  // 3. Cascade skips to downstream hops
  // 4. Determine readiness for all affected hops
  // 5. Check DAG completion
  // 6. Return new state + change summary
}
```

### Pattern 2: Per-Operator Dispatch Table for Condition Evaluation
**What:** A `Record<string, (expr, context) => boolean>` mapping each `ConditionExprType.op` to its evaluation function. Cleaner than a switch statement, easily testable per-operator.
**When to use:** For evaluating `ConditionExpr` nodes from the JSON DSL schema.
**Example:**
```typescript
// Source: project pattern (ConditionExprType discriminated union from workflow-dag.ts)

type ConditionHandler = (expr: ConditionExprType, ctx: ConditionContext) => boolean;

const OPERATORS: Record<string, ConditionHandler> = {
  eq:  (expr, ctx) => getField(ctx, expr.field) === expr.value,
  neq: (expr, ctx) => getField(ctx, expr.field) !== expr.value,
  gt:  (expr, ctx) => (getField(ctx, expr.field) as number) > expr.value,
  // ...
  and: (expr, ctx) => expr.conditions.every(c => evaluateCondition(c, ctx)),
  or:  (expr, ctx) => expr.conditions.some(c => evaluateCondition(c, ctx)),
  not: (expr, ctx) => !evaluateCondition(expr.condition, ctx),
  true:  () => true,
  false: () => false,
  hop_status: (expr, ctx) => ctx.hopStates[expr.hop]?.status === expr.status,
  has_tag: (expr, ctx) => ctx.task.tags?.includes(expr.value) ?? false,
  in: (expr, ctx) => expr.value.includes(getField(ctx, expr.field)),
};

function evaluateCondition(expr: ConditionExprType, ctx: ConditionContext): boolean {
  const handler = OPERATORS[expr.op];
  if (!handler) return false; // Defensive: unknown op = false
  return handler(expr, ctx);
}
```

### Pattern 3: Dot-Path Field Resolution (Custom, No lodash)
**What:** A simple `getField(context, path)` function that resolves dot-delimited paths like `hops.review.result.approved` against a nested object. No external dependency.
**When to use:** For resolving `field` values in comparison condition operators (eq, neq, gt, etc.).
**Example:**
```typescript
// Source: project decision (zero new dependencies, lodash-style get)

function getField(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// Usage in condition evaluator:
// field: "hops.review.result.approved" resolves against context object
// field: "task.priority" resolves against context object
```

### Pattern 4: Recursive Skip Cascade
**What:** After processing a primary hop event, traverse all downstream hops (via `dependsOn` reverse index) and recursively mark hops as skipped if ALL their predecessors are in terminal non-success state (skipped or failed). All transitions are collected in a single pass.
**When to use:** After any hop completes with `skip` or `failed` outcome, and after condition evaluation skips a hop.
**Example:**
```typescript
// Source: CONTEXT.md locked decisions

function cascadeSkips(
  definition: WorkflowDefinition,
  state: WorkflowState,  // mutable working copy
  changes: HopTransition[],
  downstreamIndex: Map<string, string[]>,  // hopId -> downstream hopIds
  startHopId: string,
): void {
  const downstream = downstreamIndex.get(startHopId) ?? [];
  for (const hopId of downstream) {
    if (state.hops[hopId]?.status !== 'pending') continue; // Only skip pending hops

    const hop = definition.hops.find(h => h.id === hopId)!;
    const allPredecessorsTerminalNonSuccess = hop.dependsOn.every(depId => {
      const depStatus = state.hops[depId]?.status;
      return depStatus === 'skipped' || depStatus === 'failed';
    });

    if (allPredecessorsTerminalNonSuccess) {
      state.hops[hopId] = { ...state.hops[hopId]!, status: 'skipped', completedAt: timestamp };
      changes.push({ hopId, from: 'pending', to: 'skipped', reason: 'cascade' });
      // Recurse: this skip may cascade further
      cascadeSkips(definition, state, changes, downstreamIndex, hopId);
    }
  }
}
```

### Pattern 5: Readiness Determination (AND-join vs OR-join)
**What:** After all skip cascading is complete, scan for hops that should transition from `pending` to `ready` based on their join type and predecessor states.
**When to use:** Final step before DAG completion check.
**Example:**
```typescript
// Source: CONTEXT.md locked decisions

function determineReadyHops(
  definition: WorkflowDefinition,
  state: WorkflowState,
): string[] {
  const newlyReady: string[] = [];

  for (const hop of definition.hops) {
    if (state.hops[hop.id]?.status !== 'pending') continue;
    if (hop.dependsOn.length === 0) continue; // Roots handled at init

    const isReady = hop.joinType === 'any'
      ? hop.dependsOn.some(depId => state.hops[depId]?.status === 'complete')
      : hop.dependsOn.every(depId => {
          const s = state.hops[depId]?.status;
          return s === 'complete' || s === 'skipped';
        }) && hop.dependsOn.some(depId => state.hops[depId]?.status !== undefined);

    if (isReady) {
      newlyReady.push(hop.id);
    }
  }

  return newlyReady;
}
```

### Anti-Patterns to Avoid
- **Mutating input state:** The evaluator MUST return a new `WorkflowState` object. Working internally with a deep copy is fine, but the original input must not be modified. Use spread operators or structuredClone.
- **Partial cascading:** Don't return intermediate states where A is skipped but B (downstream of A) is still pending. The recursive cascade must complete fully in one call.
- **Condition evaluation with side effects:** The condition evaluator must be pure. No logging, no I/O, no timestamp generation inside condition evaluation.
- **Coupling to Task schema:** The evaluator takes `WorkflowDefinition` + `WorkflowState` + context object, NOT a `Task`. This keeps it decoupled and testable without constructing full Task objects.
- **Using `new Function()` or `eval()`:** The gate-conditional.ts uses `new Function()` for JS expressions, but DAG conditions use the structured JSON DSL (SAFE-01 requirement). Never use eval for DAG conditions.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Dot-path resolution | Full lodash.get clone | Simple 5-line split('.') walker | Only needs basic path traversal; no bracket notation, no defaults parameter |
| Topological ordering | Custom sort for cascade ordering | Reverse adjacency index + recursive DFS | Kahn's already in validateDAG; cascade only needs downstream lookup |
| Deep clone of WorkflowState | Manual recursive clone | structuredClone() or spread operators | Built into Node.js, handles nested objects correctly |
| DAG visualization | Custom logging format | Return structured `changes[]` array | Let the scheduler/logger format output however it needs |

**Key insight:** This phase is pure algorithm -- no I/O, no libraries, no frameworks. The complexity is in the state machine logic, not in tooling. The risk is in edge cases (mixed skip/complete predecessors, OR-join readiness, recursive cascade termination), not in technology choices.

## Common Pitfalls

### Pitfall 1: Incomplete Skip Cascade
**What goes wrong:** Skip cascade only processes one level of downstream hops, missing transitive skips (A skips -> B should skip -> C should skip, but C stays pending).
**Why it happens:** Using a simple loop instead of recursive/iterative processing.
**How to avoid:** Use recursive `cascadeSkips()` or a worklist algorithm that continues until no new skips are generated.
**Warning signs:** Tests pass for single-level cascades but fail for chains of 3+ hops.

### Pitfall 2: AND-Join with Mixed Skip/Complete Predecessors
**What goes wrong:** AND-join hop stays pending forever because one predecessor is `skipped` and the code only checks for `complete`.
**Why it happens:** Readiness check uses `status === 'complete'` instead of `status === 'complete' || status === 'skipped'`.
**How to avoid:** Per CONTEXT.md decision: for AND-joins, skipped predecessors count as "satisfied". Check that ALL predecessors are terminal (complete, skipped, or failed) and at least one is not in a non-success terminal state -- wait, actually: AND-join becomes ready when all predecessors are complete or skipped (none pending/dispatched). If all predecessors are failed/skipped (no completions), the hop should cascade-skip instead.
**Warning signs:** Hops with diamond-shaped dependencies (two branches, one skipped) never become ready.

### Pitfall 3: OR-Join Triggering on Skip/Fail
**What goes wrong:** OR-join hop becomes ready when a predecessor is skipped or failed, even though CONTEXT.md says "only `complete` triggers readiness" for OR-joins.
**Why it happens:** Checking for any terminal state instead of specifically `complete`.
**How to avoid:** OR-join readiness check: `hop.dependsOn.some(depId => state.hops[depId].status === 'complete')`. But also handle the case where ALL predecessors are terminal non-success: the OR-join should cascade-skip.
**Warning signs:** OR-join hops activate on the wrong trigger.

### Pitfall 4: Condition Context Missing Live Hop Status
**What goes wrong:** `hop_status` operator resolves against the condition context object (which has static hop results), missing the current run's state changes.
**Why it happens:** Building context before applying the primary event, so the context doesn't reflect the newly completed hop.
**How to avoid:** Per CONTEXT.md: `hop_status` reads directly from `WorkflowState.hops` map (the live, updated state), not from the condition context object. Implement as a special-case operator.
**Warning signs:** Conditions checking `hop_status` of the just-completed hop return stale status.

### Pitfall 5: DAG Completion Check Before Cascade Completes
**What goes wrong:** DAG status is checked right after the primary event, before skip cascade runs. Some hops are still pending, so DAG isn't marked complete even though they would all cascade-skip.
**Why it happens:** Wrong ordering in the evaluator pipeline.
**How to avoid:** Ordering must be: (1) apply primary event -> (2) evaluate conditions on newly unblocked -> (3) cascade skips fully -> (4) determine newly ready hops -> (5) check DAG completion.
**Warning signs:** DAG stays in `running` even when all remaining hops should be skipped.

### Pitfall 6: Undefined Field Comparison Semantics
**What goes wrong:** `eq` operator comparing `undefined === undefined` returns true, which may not match user intent. Or `gt` comparing `undefined > 5` returns false but `neq` comparing `undefined !== 5` should return true.
**Why it happens:** JavaScript's loose comparison rules interacting with the DSL semantics.
**How to avoid:** Per CONTEXT.md: missing fields resolve to `undefined`, treated as falsy. `eq` against undefined returns false (unless value is also undefined). `neq` against undefined returns true (undefined !== anything-else). For numeric operators (gt, gte, lt, lte), `undefined` makes the comparison false.
**Warning signs:** Conditions with optional fields behave unexpectedly.

## Code Examples

Verified patterns from existing project code:

### Building the Evaluation Context
```typescript
// Source: CONTEXT.md decisions + existing gate-evaluator.ts pattern

export interface EvalContext {
  /** All completed hop results keyed by hop ID */
  hopResults: Record<string, Record<string, unknown>>;
  /** Basic task metadata for condition evaluation */
  task: {
    status: string;
    tags: string[];
    priority: string;
    routing: Record<string, unknown>;
  };
}

/**
 * Build flat context object for dot-path field resolution.
 * Merges hop results under "hops." prefix and task metadata under "task." prefix.
 */
function buildConditionContext(
  state: WorkflowState,
  taskMeta: EvalContext['task'],
): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};

  // Hop results: hops.{hopId}.result.{field}
  const hops: Record<string, unknown> = {};
  for (const [hopId, hopState] of Object.entries(state.hops)) {
    hops[hopId] = { result: hopState.result ?? {} };
  }
  ctx.hops = hops;

  // Task metadata: task.{field}
  ctx.task = taskMeta;

  return ctx;
}
```

### Primary Evaluator Flow
```typescript
// Source: project pattern from gate-evaluator.ts + CONTEXT.md decisions

export function evaluateDAG(input: DAGEvaluationInput): DAGEvaluationResult {
  const { definition, state, event, context } = input;
  const timestamp = new Date().toISOString();
  const changes: HopTransition[] = [];

  // Deep copy state for immutable output
  const newState: WorkflowState = structuredClone(state);

  // Build reverse adjacency index: hopId -> downstream hopIds
  const downstreamIndex = buildDownstreamIndex(definition);

  // 1. Apply primary event
  const prevStatus = newState.hops[event.hopId]?.status;
  newState.hops[event.hopId] = {
    ...newState.hops[event.hopId]!,
    status: event.outcome === 'complete' ? 'complete' : event.outcome === 'failed' ? 'failed' : 'skipped',
    completedAt: timestamp,
    result: event.result,
  };
  changes.push({
    hopId: event.hopId,
    from: prevStatus!,
    to: newState.hops[event.hopId]!.status,
  });

  // 2. If hop failed/skipped, cascade skips downstream
  if (event.outcome !== 'complete') {
    cascadeSkips(definition, newState, changes, downstreamIndex, event.hopId, timestamp);
  }

  // 3. Evaluate conditions on newly eligible hops + cascade any new skips
  const conditionContext = buildConditionContext(newState, context.task);
  evaluateNewlyEligibleConditions(definition, newState, changes, downstreamIndex, conditionContext, timestamp);

  // 4. Determine newly ready hops
  const readyHops = determineReadyHops(definition, newState);
  for (const hopId of readyHops) {
    newState.hops[hopId] = { ...newState.hops[hopId]!, status: 'ready' };
    changes.push({ hopId, from: 'pending', to: 'ready' });
  }

  // 5. Check DAG completion
  const dagStatus = checkDAGCompletion(newState);
  if (dagStatus) {
    newState.status = dagStatus;
    if (dagStatus === 'complete' || dagStatus === 'failed') {
      newState.completedAt = timestamp;
    }
  }

  // 6. Suggest task status
  const taskStatus = dagStatus === 'complete' ? 'done' : dagStatus === 'failed' ? 'failed' : undefined;

  return { state: newState, changes, readyHops, dagStatus, taskStatus };
}
```

### Downstream Index Builder
```typescript
// Source: derived from validateDAG() adjacency logic in workflow-dag.ts

function buildDownstreamIndex(definition: WorkflowDefinition): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const hop of definition.hops) {
    if (!index.has(hop.id)) index.set(hop.id, []);
    for (const dep of hop.dependsOn) {
      if (!index.has(dep)) index.set(dep, []);
      index.get(dep)!.push(hop.id);
    }
  }
  return index;
}
```

### DAG Completion Check
```typescript
// Source: CONTEXT.md locked decisions

function checkDAGCompletion(state: WorkflowState): WorkflowStatus | undefined {
  const statuses = Object.values(state.hops).map(h => h.status);
  const allTerminal = statuses.every(s => s === 'complete' || s === 'skipped' || s === 'failed');

  if (!allTerminal) return undefined;  // Still running

  const hasFailed = statuses.some(s => s === 'failed');
  if (hasFailed) return 'failed';

  return 'complete';  // All complete or skipped
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Gate-based linear workflow (JS expression `when` clauses) | DAG-based workflow (structured JSON DSL conditions) | v1.2 (this milestone) | Structured DSL is safer than `new Function()`, supports agent-authored conditions |
| Mutable task state with side effects | Pure function evaluation with immutable return | Established in gate-evaluator.ts | Evaluator is testable, deterministic, composable |
| Per-step evaluation (one gate at a time) | Full DAG evaluation per event (cascade in single call) | v1.2 (this milestone) | Atomic state updates, no intermediate writes to frontmatter |

**Deprecated/outdated:**
- Gate-conditional.ts `new Function()` approach: Still used for legacy gate workflows, but DAG conditions use structured JSON DSL per SAFE-01. The two systems coexist (SAFE-02, Phase 12).

## Open Questions

1. **Condition evaluation on ready hops that have conditions**
   - What we know: When a hop becomes ready (predecessors satisfied), and it has a `condition`, the evaluator should check the condition and potentially skip the hop immediately.
   - What's unclear: Should condition evaluation happen in the same `evaluateDAG()` call that made predecessors complete, or only when the scheduler is about to dispatch?
   - Recommendation: Evaluate conditions eagerly in the same call -- this enables skip cascading in a single atomic operation. The CONTEXT.md decision "skip cascading is fully recursive in a single evaluator call" supports this.

2. **Event type for the initial `evaluateDAG()` call**
   - What we know: `initializeWorkflowState()` from Phase 10 sets root hops to `ready`. The evaluator "only runs on hop events, not at DAG creation."
   - What's unclear: Root hops with conditions -- should they be checked during `initializeWorkflowState()` or does the scheduler call `evaluateDAG()` before dispatching each hop?
   - Recommendation: Keep `initializeWorkflowState()` simple (all roots start as `ready`). Condition evaluation for root hops happens at dispatch time in Phase 12, or alternatively, add an optional `initialize` event type that the scheduler can call once after workflow creation to evaluate root hop conditions. This is a Phase 12 integration concern -- the evaluator itself just needs to handle the condition check when asked.

3. **`has_tag` operator context source**
   - What we know: `has_tag` checks if a tag is present. The context includes `task.tags`.
   - What's unclear: Does `has_tag` use `ctx.task.tags` via the standard field lookup, or is it a special operator with direct access?
   - Recommendation: Implement as a special operator that checks `context.task.tags.includes(expr.value)` directly, keeping it consistent with `hop_status` being a special operator too.

## Sources

### Primary (HIGH confidence)
- `src/schemas/workflow-dag.ts` -- Phase 10 schemas: WorkflowDefinition, WorkflowState, ConditionExprType, HopStatus, Hop, validateDAG, initializeWorkflowState
- `src/dispatch/gate-evaluator.ts` -- Structural pattern: GateEvaluationInput/Result, evaluateGateTransition pure function
- `src/dispatch/gate-conditional.ts` -- Existing condition evaluation (JS expressions, not applicable to DAG DSL but shows project patterns)
- `src/schemas/task.ts` -- TaskFrontmatter with workflow field (mutually exclusive with gate fields)
- `src/schemas/index.ts` -- Barrel export pattern for new types
- `src/dispatch/index.ts` -- Dispatch barrel export pattern
- `.planning/phases/11-dag-evaluator/11-CONTEXT.md` -- All locked decisions and implementation guidance

### Secondary (MEDIUM confidence)
- `vitest.config.ts` -- Test configuration, test file patterns, coverage exclusions
- `src/dispatch/__tests__/gate-evaluator.test.ts` -- Test fixture pattern (inline Task/WorkflowConfig objects, pure function assertions)
- `.planning/STATE.md` -- Project decisions: zero new deps, pure TypeScript/Zod DAG engine

### Tertiary (LOW confidence)
- None -- this phase is entirely internal algorithmic work with no external library dependencies to verify.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- zero new dependencies, all types from Phase 10 schemas, pure TypeScript
- Architecture: HIGH -- mirrors established gate-evaluator.ts pattern, all algorithms are well-defined by locked decisions in CONTEXT.md
- Pitfalls: HIGH -- derived from locked decision specifics (AND/OR join semantics, skip cascade, undefined field handling), all edge cases are explicitly documented in CONTEXT.md

**Research date:** 2026-03-02
**Valid until:** 2026-04-02 (stable -- no external dependencies to go stale)
