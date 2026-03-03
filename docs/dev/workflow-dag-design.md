---
title: "Workflow DAGs: High-Level Design"
description: "Technical architecture, evaluator internals, and extension points for DAG-based workflows."
---

**Version:** 1.2
**Author:** Architect
**Date:** 2026-03-03
**Status:** Approved

---

## Executive Summary

Workflow DAGs is a **domain-neutral engine** for orchestrating multi-stage processes as directed acyclic graphs. It replaces the linear gate-based system (v1.0) with a graph-based model supporting parallel execution, conditional branching, structured conditions, and per-hop artifact isolation.

**Design principles:**
- **Pure evaluation**: The evaluator is a pure function (no side effects, deterministic given same inputs)
- **Immutable state output**: Input state is never mutated (`structuredClone`)
- **Agent-simple**: Agents receive hop-scoped context, complete work, signal outcomes
- **No eval**: Conditions use a JSON DSL with a per-operator dispatch table (no `eval`/`new Function`)
- **Atomic persistence**: State updates via `write-file-atomic` prevent corruption
- **Domain-neutral**: Works for SWE, sales, content, compliance -- any staged process

---

## 1. Architecture Overview

The DAG workflow system has four layers:

```
+------------------+     +------------------+     +------------------+
|   Schema Layer   |     |  Evaluator Layer |     | Scheduler Layer  |
|                  |     |                  |     |                  |
| WorkflowDef      | --> | evaluateDAG()    | --> | dispatchDAGHop() |
| Hop, HopState    |     | pure function    |     | spawns sessions  |
| ConditionExpr    |     | state + event =  |     | updates state    |
| validateDAG()    |     |   new state      |     | logs events      |
+------------------+     +------------------+     +------------------+
        |                        |                        |
        v                        v                        v
+------------------------------------------------------------------+
|                    Transition Handler                             |
|  handleDAGHopCompletion() -- orchestrates eval + persist + log   |
|  dispatchDAGHop() -- builds context + spawns + updates state     |
+------------------------------------------------------------------+
```

**Source files:**
- Schema: `src/schemas/workflow-dag.ts`
- Evaluator: `src/dispatch/dag-evaluator.ts`
- Conditions: `src/dispatch/dag-condition-evaluator.ts`
- Transitions: `src/dispatch/dag-transition-handler.ts`
- Context: `src/dispatch/dag-context-builder.ts`

---

## 2. Schema Model

All types are defined in `src/schemas/workflow-dag.ts` using Zod for runtime validation.

### WorkflowDefinition (immutable)

The DAG shape, set at task creation and never modified:

```typescript
export const WorkflowDefinition = z.object({
  name: z.string().min(1),
  hops: z.array(Hop).min(1),
});
```

### Hop (node definition)

Each hop is a node in the DAG:

```typescript
export const Hop = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  joinType: z.enum(["all", "any"]).default("all"),
  autoAdvance: z.boolean().default(true),
  condition: ConditionExpr.optional(),
  description: z.string().optional(),
  canReject: z.boolean().default(false),
  rejectionStrategy: z.enum(["origin", "predecessors"]).optional(),
  timeout: z.string().optional(),       // "1h", "30m", "2d"
  escalateTo: z.string().optional(),
});
```

### HopState (mutable per-hop state)

Runtime state tracking for each hop:

```typescript
export const HopState = z.object({
  status: HopStatus,                    // pending|ready|dispatched|complete|failed|skipped
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  agent: z.string().optional(),
  correlationId: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  rejectionCount: z.number().int().nonnegative().optional(),
  escalated: z.boolean().optional(),
});
```

### WorkflowState (mutable DAG state)

```typescript
export const WorkflowState = z.object({
  status: WorkflowStatus,              // pending|running|complete|failed
  hops: z.record(z.string(), HopState),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
});
```

### TaskWorkflow (top-level field)

Lives on task frontmatter:

```typescript
export const TaskWorkflow = z.object({
  definition: WorkflowDefinition,       // Immutable shape
  state: WorkflowState,                 // Mutable execution progress
  templateName: z.string().optional(),  // Informational traceability
});
```

### ConditionExpr (JSON DSL)

Recursive discriminated union of operator nodes:

```typescript
export type ConditionExprType =
  | { op: "eq"; field: string; value?: unknown }
  | { op: "neq"; field: string; value?: unknown }
  | { op: "gt"; field: string; value: number }
  | { op: "gte"; field: string; value: number }
  | { op: "lt"; field: string; value: number }
  | { op: "lte"; field: string; value: number }
  | { op: "in"; field: string; value: unknown[] }
  | { op: "has_tag"; value: string }
  | { op: "hop_status"; hop: string; status: string }
  | { op: "and"; conditions: ConditionExprType[] }
  | { op: "or"; conditions: ConditionExprType[] }
  | { op: "not"; condition: ConditionExprType }
  | { op: "true" }
  | { op: "false" };
```

---

## 3. Evaluator Pipeline

The core evaluation logic lives in `evaluateDAG()` (`src/dispatch/dag-evaluator.ts`). It is a **pure function**: input state is never mutated, output is deterministic given the same inputs (modulo timestamps).

### Input

```typescript
interface DAGEvaluationInput {
  definition: WorkflowDefinition;   // Immutable DAG shape
  state: WorkflowState;             // Current state (NOT mutated)
  event: HopEvent;                  // What just happened
  context: EvalContext;             // Hop results + task metadata
}
```

### Pipeline Steps

1. **Deep copy state** (`structuredClone`) -- ensures immutable output
2. **Build reverse adjacency index** -- maps each hop to its downstream dependents
3. **If rejected**: handle rejection cascade
   - Increment `rejectionCount` on the rejected hop
   - If count >= 3: circuit-breaker fires, hop -> `failed`, cascade skips downstream
   - If count < 3: apply rejection strategy (`origin` resets all, `predecessors` resets subset)
   - Short-circuit: skip steps 4-6, jump to readyHops + completion check
4. **Apply primary hop event** -- set hop status to complete/failed/skipped
5. **Cascade skips downstream** -- if hop failed/skipped, recursively skip dependent hops where ALL predecessors are terminal non-success
6. **Evaluate conditions** on newly eligible hops -- hops whose predecessors are all terminal get their condition checked; false -> skip + cascade
7. **Determine ready hops** -- AND-join: all deps complete/skipped with >= 1 complete; OR-join: any dep complete
8. **Check DAG completion** -- all terminal? If any failed -> DAG `failed`; else -> DAG `complete`

### Output

```typescript
interface DAGEvaluationResult {
  state: WorkflowState;         // New immutable state
  changes: HopTransition[];     // All status transitions
  readyHops: string[];          // Hops now eligible for dispatch
  dagStatus?: WorkflowStatus;   // Terminal DAG status (if reached)
  taskStatus?: string;          // Suggested task status ("done" or "failed")
}
```

---

## 4. Condition DSL

Defined in `src/dispatch/dag-condition-evaluator.ts`.

### Operator Dispatch Table

Evaluation uses a `Record<string, ConditionHandler>` dispatch table for extensibility. Each operator is a function `(expr, ctx) => boolean`.

Key behaviors:
- **Missing fields** resolve to `undefined`: `eq` returns false, `neq` returns true, numeric operators return false
- **`hop_status`** reads directly from `WorkflowState.hops` map (special operator, not field resolution)
- **`has_tag`** checks `ctx.task.tags` directly (special operator)

### Adding a New Operator

Three-step process (no other files need changes):

1. **Add to `ConditionExprType`** union in `src/schemas/workflow-dag.ts`
2. **Add Zod variant** to the `z.discriminatedUnion` in `ConditionExpr`
3. **Add handler** to `OPERATORS` table in `src/dispatch/dag-condition-evaluator.ts`

### Complexity Limits

Enforced by `measureConditionComplexity()` in `validateDAG()`:
- `MAX_CONDITION_DEPTH = 5` -- max nesting depth of logical operators
- `MAX_CONDITION_NODES = 50` -- max total node count in expression tree

All nodes are counted including logical operators (`and`/`or`/`not` each count as 1 node).

### Field Resolution

`getField(obj, path)` resolves dot-delimited paths. Context built by `buildConditionContext()`:
- `hops.<hopId>.result.<field>` -- hop output data
- `task.status`, `task.tags`, `task.priority`, `task.routing` -- task metadata

---

## 5. State Machine

### HopStatus Lifecycle

```
                 +-- condition false --> [skipped]
                 |
[pending] --> [ready] --> [dispatched] --> [complete]
                 ^                    |
                 |                    +--> [failed]
                 |                    |
                 |                    +--> [skipped] (cascade)
                 |
                 +-- rejection reset (origin/predecessors)
```

Valid transitions:
- `pending -> ready` -- all predecessors satisfied (`determineReadyHops`)
- `pending -> skipped` -- condition false or cascade skip
- `ready -> dispatched` -- scheduler spawned session (`dispatchDAGHop`)
- `dispatched -> complete` -- hop finished successfully
- `dispatched -> failed` -- hop errored or circuit breaker
- `complete/failed/skipped -> pending/ready` -- rejection reset only

### WorkflowStatus Lifecycle

- `pending` -- created but no hops dispatched
- `running` -- at least one hop dispatched
- `complete` -- all hops terminal, none failed
- `failed` -- all hops terminal, at least one failed

---

## 6. Scheduler Integration

### Dispatch Flow

The scheduler integrates with DAG workflows via the transition handler (`src/dispatch/dag-transition-handler.ts`):

1. **Poll cycle**: Scheduler reads tasks with active workflows
2. **Dual-mode routing**: Checks `task.frontmatter.workflow` (DAG) vs `task.frontmatter.gate` (legacy gates)
3. **Fresh read**: Re-reads task before dispatch to prevent stale state races
4. **Dispatch**: `dispatchDAGHop()` for each ready hop
5. **One-hop-at-a-time**: One hop dispatched per poll cycle per task (OpenClaw constraint)

### Completion-Triggered Advancement

Primary path (no polling needed):

1. Agent completes -> `handleSessionEnd` fires
2. `handleDAGHopCompletion()` calls `evaluateDAG()` with completion event
3. New state persisted atomically
4. Ready hops dispatched immediately
5. If `dagComplete`, task status updated

### dispatchDAGHop Internals

1. Find hop definition from workflow
2. Create per-hop artifact directory: `<task-dir>/work/<hopId>/`
3. Build `HopContext` (hop metadata + `artifactPaths` from completed predecessors)
4. Build `TaskContext` with hop context
5. Spawn agent session via `GatewayAdapter`
6. On success: set hop to `dispatched`, persist atomically
7. On failure: hop stays `ready` for retry, log error

Key invariant: hop status set to `dispatched` ONLY after `spawnSession` succeeds. Prevents orphan dispatches.

---

## 7. Extension Points

### New Condition Operators

See Section 4. Three-step process: type union, Zod variant, dispatch handler.

### Template Registry

Defined in `ProjectManifest.workflowTemplates` (`Record<string, WorkflowDefinition>`). Template names match `^[a-z0-9][a-z0-9-]*$`.

Resolution in CLI (`resolveWorkflowTemplate` module), not `store.create()` (keeps store simple). Belt-and-suspenders `validateDAG()` in both CLI and store.

### Artifact Directories

Per-hop dirs at `<task-dir>/work/<hop-id>/`. Created before spawn. Only completed predecessor hops appear in `artifactPaths`.

### Custom Hop Types (Future)

Hop fields use Zod defaults for backward compatibility. New optional fields can be added without migration.

---

## 8. Migration Internals

Gate-to-DAG lazy migration:
- **Dual-mode routing**: Scheduler checks for `workflow` (DAG) vs `gate` (legacy)
- **Position mapping**: Gate index maps to hop in linear DAG
- **Condition conversion**: JavaScript `when` strings replaced by JSON DSL `ConditionExpr`
- **One-time write-back**: Migrated state written on first DAG evaluation

New tasks always use DAG format. Legacy gate tasks continue via gate path.

---

## 9. Safety

### Condition Safety
- **No eval**: JSON DSL dispatch table only. No `eval()`, `new Function()`, or arbitrary code.
- **Complexity limits**: `MAX_CONDITION_DEPTH=5`, `MAX_CONDITION_NODES=50` at creation time.
- **Missing fields**: `undefined`, treated as falsy.
- **Unknown operators**: Return `false` defensively.

### DAG Structural Safety
- **Cycle detection**: Kahn's algorithm in `validateDAG()`.
- **Unreachable hops**: BFS from root hops.
- **Root hop check**: At least one empty `dependsOn`.
- **Timeout format**: Regex `^\d+[mhd]$`.

### Rejection Safety
- **Circuit breaker**: `DEFAULT_MAX_REJECTIONS = 3`.
- **Count persistence**: `rejectionCount` survives cascades.
- **Skip cascade**: Failed hops cascade skips downstream.

### Escalation Safety
- **One-shot flag**: `escalated: true` prevents re-escalation.
- **Spawn failure recovery**: Hop set to `ready` with `escalated: true` for poll retry.

---

## 10. Testing

### Evaluator Unit Tests

Pure function -- ideal for unit testing:

```typescript
import { evaluateDAG } from "../src/dispatch/dag-evaluator.js";

const result = evaluateDAG({
  definition: { name: "test", hops: [...] },
  state: { status: "pending", hops: { implement: { status: "dispatched" } } },
  event: { hopId: "implement", outcome: "complete" },
  context: { hopResults: {}, task: { status: "ready", tags: [], priority: "medium", routing: {} } },
});

expect(result.readyHops).toContain("review");
expect(result.state.hops.implement.status).toBe("complete");
```

### Condition Evaluator Tests

```typescript
import { evaluateCondition } from "../src/dispatch/dag-condition-evaluator.js";

const ctx = {
  context: { task: { tags: ["security"] } },
  hopStates: {},
  task: { status: "ready", tags: ["security"], priority: "high", routing: {} },
};

expect(evaluateCondition({ op: "has_tag", value: "security" }, ctx)).toBe(true);
```

### DAG Validation Tests

```typescript
import { validateDAG } from "../src/schemas/workflow-dag.ts";

const errors = validateDAG({
  name: "cycle-test",
  hops: [
    { id: "a", role: "dev", dependsOn: ["b"] },
    { id: "b", role: "dev", dependsOn: ["a"] },
  ],
});
expect(errors).toContain(expect.stringContaining("Cycle detected"));
```

### Integration Test Pattern

Test full flow: create task with workflow -> dispatch hop -> simulate completion -> verify state transitions. Mock `GatewayAdapter` to avoid real sessions.

---

## Appendix: Event Types

| Event | Trigger | Payload |
|-------|---------|---------|
| `dag.hop_dispatched` | Hop assigned to agent | hopId, agent, sessionId, correlationId |
| `dag.hop_completed` | Hop finished | hopId, outcome, readyHops, dagStatus, changes |
| `dag.hop_rejected` | Hop rejected work | hopId, rejectionNotes, rejectionCount, strategy |
| `dag.hop_escalated` | Hop timeout fired | hopId, escalateTo, originalAgent |
| `dag.dispatch_error` | Dispatch failed | hopId, error |
| `dag.dispatch_failed` | Spawn session failed | hopId, error, correlationId |
| `dag.warning` | Non-critical issue | message |
