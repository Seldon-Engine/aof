# Technology Stack

**Project:** AOF v1.2 Per-Task Workflow DAG Execution
**Researched:** 2026-03-02
**Scope:** Stack additions/changes for DAG execution engine, conditional branching, parallel hop dispatch, workflow composition API, hop lifecycle state machine
**Confidence:** HIGH (zero new runtime dependencies; all capabilities buildable with existing Zod + TypeScript)

---

## Executive Decision: Build In-House, No New Dependencies

The per-task workflow DAG engine requires **zero new npm dependencies**. The existing stack (Zod schemas, TypeScript, filesystem task store, deterministic scheduler) provides everything needed. This is not a "DAG library" problem -- it is a schema evolution and scheduler integration problem.

**Why not use an external DAG library:**

| Rejected Library | Why Not |
|------------------|---------|
| `graphlib` / `dagre` | Unmaintained (last release 2021). AOF's DAG is simple (tens of nodes, not thousands). Topological sort is ~30 lines of TypeScript. Adding a dependency for this is over-engineering. |
| `xstate` v5 | State machines for hop lifecycle are tempting, but xstate brings 40KB+ of runtime, actor model complexity, and a learning curve. AOF's hop states are a simple enum with 5-6 transitions -- a switch statement or lookup table suffices. The existing gate evaluator is already a pure-function state machine without xstate. |
| `bull` / `bullmq` | Job queue libraries assume Redis. AOF is filesystem-based with no external databases. Fundamentally incompatible constraint. |
| `temporal` / `inngest` | Workflow-as-code platforms with server dependencies. AOF is a single-machine plugin. Massive over-engineering. |
| `p-limit` / `p-queue` | For parallel hop dispatch limiting. AOF already has throttle.ts with concurrency tracking. Adding another concurrency library creates dual control planes. |

**What we build instead:**

1. **DAG data structure** -- adjacency list as a plain `Record<string, string[]>` (hop ID to successor hop IDs), validated by Zod. Topological sort is a simple DFS (~30 lines).
2. **Hop lifecycle** -- enum-based state transitions validated by a lookup table (same pattern as `VALID_TRANSITIONS` in `task.ts`).
3. **Condition evaluator** -- extend the existing `evaluateGateCondition()` from `gate-conditional.ts`. Already has sandboxed JS eval with timeout protection.
4. **Parallel dispatch tracking** -- extend the existing `pendingDispatches` counter in `task-dispatcher.ts` to track multiple hops per task.
5. **Workflow schema** -- Zod discriminated unions and `.superRefine()` for DAG validation (cycle detection, reachability).

```bash
# Nothing new to install.
npm ci   # verify clean state
```

---

## Core Stack Components for DAG Execution

### 1. DAG Schema (Zod Extension)

**Existing:** `WorkflowConfig` in `src/schemas/workflow.ts` defines linear gate sequences.

**New:** `WorkflowDAG` schema that replaces linear gates with a hop graph.

| Component | Technology | Purpose | Why This Approach |
|-----------|-----------|---------|-------------------|
| `HopSchema` | Zod `z.object()` | Individual hop definition (agent, role, conditions) | Extends existing `Gate` schema pattern. Agents already understand gates. |
| `WorkflowDAG` | Zod `z.object()` with `.superRefine()` | DAG structure with edges, validation | `.superRefine()` allows custom validation (cycle detection, reachability) at parse time. No separate validation step needed. |
| `WorkflowTemplate` | Zod `z.object()` | Pre-defined workflow in `project.yaml` | Extends existing `WorkflowConfig` location in `ProjectManifest` |
| `TaskWorkflow` | Zod `z.object()` | Per-task workflow instance with runtime state | New field on `TaskFrontmatter`, parallel to existing `gate` field |

**Schema design decision -- adjacency list, not edge list:**

```typescript
// CHOSEN: Adjacency list (hop defines its own successors)
// Why: Each hop is self-contained. No separate edges array to keep in sync.
// Easy to validate: every successor reference must point to a valid hop ID.
const HopSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  next: z.array(z.string()).default([]),       // successor hop IDs
  when: z.string().optional(),                  // condition for THIS hop's activation
  joinType: z.enum(["any", "all"]).default("all"), // parallel join strategy
  // ... other fields from Gate (timeout, escalateTo, description, etc.)
});

// REJECTED: Edge list (separate edges array)
// Why not: Requires cross-referencing two arrays. Easy to have orphaned edges.
// More complex validation. No benefit for graphs under 50 nodes.
```

**Integration point:** The `ProjectManifest` schema in `src/schemas/project.ts` already has `workflow: WorkflowConfig.optional()`. This evolves to support both legacy `WorkflowConfig` (linear gates) and new `WorkflowDAG` (DAG hops) via a discriminated union or version field.

**Backward compatibility strategy:** Keep `WorkflowConfig` as-is. Add `workflowDAG` as a new optional field. If both are present, `workflowDAG` takes precedence. The gate evaluator continues to work for legacy tasks. Migration path: existing gate sequences map trivially to DAGs (linear chain of hops).

### 2. Hop Lifecycle State Machine

**Existing pattern:** `VALID_TRANSITIONS` in `src/schemas/task.ts` -- a lookup table `Record<TaskStatus, readonly TaskStatus[]>`. Pure data, no library.

**New:** `HOP_VALID_TRANSITIONS` -- same pattern for hop states.

| Hop State | Description | Valid Next States |
|-----------|-------------|-------------------|
| `pending` | Not yet eligible (predecessors incomplete) | `ready` |
| `ready` | All predecessors complete, eligible for dispatch | `dispatched`, `skipped` |
| `dispatched` | Agent session spawned | `complete`, `failed`, `blocked` |
| `complete` | Hop finished successfully | (terminal) |
| `failed` | Hop failed (will retry or deadletter) | `ready`, `deadletter` |
| `blocked` | Hop blocked on external dependency | `ready`, `deadletter` |
| `skipped` | Hop skipped due to condition evaluation | (terminal) |
| `deadletter` | Hop permanently failed | (terminal) |

```typescript
// Same pattern as existing VALID_TRANSITIONS -- no xstate needed
const HOP_VALID_TRANSITIONS: Record<HopStatus, readonly HopStatus[]> = {
  pending:     ["ready"],
  ready:       ["dispatched", "skipped"],
  dispatched:  ["complete", "failed", "blocked"],
  complete:    [],
  failed:      ["ready", "deadletter"],
  blocked:     ["ready", "deadletter"],
  skipped:     [],
  deadletter:  [],
} as const;
```

**Why not xstate:** The hop lifecycle has 8 states and ~12 transitions. xstate's value is in complex statecharts with nested/parallel states, guards, actions, and delayed transitions. AOF's hop states are flat with no nesting. The existing pure-function gate evaluator pattern (`evaluateGateTransition()` in `gate-evaluator.ts`) proves this works without a state machine library. The same approach scales to hop lifecycle.

### 3. DAG Execution Engine (Topological Sort + Frontier Tracking)

**Existing:** The scheduler's `poll()` function in `scheduler.ts` already:
- Scans all tasks
- Checks dependencies (`dependsOn` with DFS cycle detection)
- Dispatches eligible tasks
- Tracks concurrency limits

**New:** A `DAGAdvancer` module that evaluates a single task's workflow DAG on each poll cycle.

| Function | Purpose | Integration Point |
|----------|---------|-------------------|
| `evaluateDAGFrontier(task, workflow)` | Find hops that are ready to dispatch (all predecessors complete) | Called from `poll()` for each task with an active DAG workflow |
| `advanceHop(task, hopId, outcome)` | Process hop completion, update state, find next hops | Replaces `evaluateGateTransition()` for DAG tasks |
| `validateDAG(workflow)` | Cycle detection, reachability check, orphan detection | Called at schema parse time via Zod `.superRefine()` |
| `topologicalSort(hops)` | Kahn's algorithm for execution order | Used by `evaluateDAGFrontier()` |

**Topological sort implementation (Kahn's algorithm):**

```typescript
// ~30 lines, no library needed
function topologicalSort(hops: Hop[]): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const hop of hops) {
    inDegree.set(hop.id, 0);
    adj.set(hop.id, hop.next);
  }
  for (const hop of hops) {
    for (const next of hop.next) {
      inDegree.set(next, (inDegree.get(next) ?? 0) + 1);
    }
  }
  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const newDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }
  if (order.length !== hops.length) throw new Error("Cycle detected in workflow DAG");
  return order;
}
```

**Integration with scheduler:** The scheduler's `poll()` function calls `buildDispatchActions()` for ready tasks. For DAG-enabled tasks, dispatch decisions are per-hop, not per-task. The task stays `in-progress` while hops execute. Each poll cycle re-evaluates the DAG frontier.

### 4. Condition Evaluation (Extend Existing)

**Existing:** `evaluateGateCondition()` in `src/dispatch/gate-conditional.ts` provides:
- Sandboxed JavaScript expression evaluation via `Function` constructor
- Access to `tags`, `metadata`, `gateHistory` context variables
- 100ms timeout protection
- Syntax validation

**Extension for DAG hops:**

| New Context Variable | Type | Purpose |
|---------------------|------|---------|
| `hopResults` | `Record<string, HopResult>` | Results from completed predecessor hops |
| `artifacts` | `Record<string, string[]>` | File lists from predecessor hop output directories |
| `workflow` | `{ currentPhase: string }` | Workflow-level metadata |

```typescript
// Extended context for DAG condition evaluation
interface DAGEvaluationContext extends GateEvaluationContext {
  hopResults: Record<string, { status: HopStatus; summary?: string }>;
  artifacts: Record<string, string[]>;
}
```

**Existing `buildGateContext()` extends naturally.** The function already builds context from task frontmatter. Adding `hopResults` from the task's workflow state is straightforward.

**Condition examples for branching:**

```yaml
# Only run security review if task has security tag
when: "tags.includes('security')"

# Only run hotfix deploy if previous hop flagged urgency
when: "hopResults.triage?.summary?.includes('hotfix')"

# Skip manual QA if automated tests passed
when: "hopResults.autoTest?.status !== 'complete'"
```

### 5. Parallel Hop Dispatch and Join Semantics

**Existing:** The scheduler tracks `currentInProgress` globally and `inProgressByTeam` per team. The `maxConcurrentDispatches` config limits parallel work.

**New concern:** A single task can have multiple hops executing in parallel. The scheduler must:
1. Dispatch all eligible hops in the frontier (not just one per task)
2. Track which hops are dispatched (per-task hop state, not just task-level lease)
3. Join parallel branches (wait for all/any predecessors before advancing)

**Implementation approach -- hop-level leases:**

Each hop dispatch creates a correlation ID (existing pattern from `dispatch/executor.ts`). The hop state in the task frontmatter tracks:

```typescript
const HopState = z.object({
  hopId: z.string(),
  status: HopStatus,
  correlationId: z.string().uuid().optional(),  // links to gateway session
  agent: z.string().optional(),
  dispatchedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  summary: z.string().optional(),
  retryCount: z.number().int().nonnegative().default(0),
});
```

**Join semantics (`joinType` on each hop):**

| Join Type | Behavior | When to Use |
|-----------|----------|-------------|
| `all` (default) | Wait for ALL predecessors to complete | Standard sequential dependency |
| `any` | Advance when ANY predecessor completes | Race conditions, first-available patterns |

**Scheduler integration:** The `buildDispatchActions()` function in `task-dispatcher.ts` currently iterates ready tasks. For DAG tasks, it additionally iterates the hop frontier of each in-progress task with an active DAG. This is an additive change, not a rewrite.

### 6. Workflow Composition API (Agent-Facing)

**Existing:** Tasks are created via `ITaskStore.create()` and the `aof_create_task` MCP tool. The `routing.workflow` field references a workflow name from `project.yaml`.

**New:** Two composition modes:

| Mode | When | Schema Location |
|------|------|----------------|
| **Template reference** | Task references a pre-defined workflow template | `routing.workflow: "standard-sdlc"` (existing pattern, now resolves to DAG) |
| **Ad-hoc composition** | Agent defines workflow inline at task creation | New `workflow` field on task frontmatter containing the DAG definition |

**Agent API extension (MCP tools):**

| Tool | Change | Purpose |
|------|--------|---------|
| `aof_create_task` | Add optional `workflow` parameter accepting DAG definition | Agents compose workflows at task creation |
| `aof_advance_hop` | New tool | Agent reports hop completion (replaces `aof_gate_transition` for DAG tasks) |
| `aof_get_workflow_status` | New tool | Agent queries current DAG state (which hops complete, which pending) |

**Template resolution:** When `routing.workflow` names a template and the task also has an inline `workflow`, the inline definition wins (override semantics, same as CSS specificity).

---

## Stack Component Summary

### Runtime Dependencies: No Changes

```
Current package.json is correct as-is for all v1.2 DAG work.
No npm install/add/remove needed.
```

### Existing Libraries Used (No Version Changes)

| Library | Current Version | Role in v1.2 |
|---------|----------------|--------------|
| `zod` | ^3.24.0 | DAG schema definition, validation with `.superRefine()`, discriminated unions |
| `yaml` | ^2.7.0 | Parse workflow templates from `project.yaml` |
| `write-file-atomic` | ^7.0.0 | Atomic hop state updates (same pattern as gate transitions) |
| `vitest` | ^3.0.0 (dev) | Unit tests for DAG engine, integration tests for scheduler |

### New Modules to Create

| Module | Path | Purpose |
|--------|------|---------|
| `WorkflowDAG` schema | `src/schemas/workflow-dag.ts` | Zod schema for DAG-based workflows (hops, edges, conditions, join types) |
| `HopStatus` types | `src/schemas/hop.ts` | Hop lifecycle types and valid transitions |
| DAG validator | `src/dispatch/dag-validator.ts` | Cycle detection, reachability, orphan detection (pure functions) |
| DAG advancer | `src/dispatch/dag-advancer.ts` | Evaluate frontier, advance hops, join semantics (pure functions) |
| Hop dispatch | `src/dispatch/hop-dispatcher.ts` | Per-hop dispatch (extends task-dispatcher pattern) |
| Workflow resolver | `src/dispatch/workflow-resolver.ts` | Resolve template name to DAG definition |

### Existing Modules to Extend

| Module | Path | Change |
|--------|------|--------|
| Task schema | `src/schemas/task.ts` | Add `workflow` and `hopStates` fields to `TaskFrontmatter` |
| Project schema | `src/schemas/project.ts` | Add `workflowTemplates` (map of named DAG workflows) alongside existing `workflow` |
| Scheduler | `src/dispatch/scheduler.ts` | Call DAG advancer for tasks with active DAG workflows |
| Task dispatcher | `src/dispatch/task-dispatcher.ts` | Handle hop-level dispatch for DAG tasks |
| Gate conditional | `src/dispatch/gate-conditional.ts` | Extend context with `hopResults` for DAG condition evaluation |
| Gate transition handler | `src/dispatch/gate-transition-handler.ts` | Add DAG-aware path alongside existing gate path |
| MCP tools | `src/mcp/tools.ts` | Add `aof_advance_hop` and `aof_get_workflow_status` tools |
| Action executor | `src/dispatch/action-executor.ts` | Handle new `advance_hop` action type |
| Event schema | `src/schemas/event.ts` | Add `hop_dispatched`, `hop_completed`, `hop_failed` event types |

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| No external DAG library | Build ~100 lines of topological sort + frontier eval | AOF DAGs are small (5-20 hops). Graph libraries add dependency weight for trivial operations. The existing codebase already has O(n+e) DFS cycle detection in `scheduler.ts`. |
| No state machine library | Lookup table pattern (matches existing `VALID_TRANSITIONS`) | Hop lifecycle is flat (8 states, 12 transitions). xstate's value is in complex nested statecharts, not simple FSMs. |
| Zod `.superRefine()` for DAG validation | Parse-time validation, not runtime | Catches invalid DAGs (cycles, unreachable hops) when config is loaded, not when task is executing. Fail fast. |
| Hop-level state in task frontmatter | `hopStates: HopState[]` on task | Filesystem-based persistence. Each hop state persists via atomic write. Crash recovery reads hop states on restart. |
| Extend gate-conditional, don't replace | Add `hopResults` to evaluation context | Conditional branching reuses the same sandboxed eval engine. One security model, one test suite. |
| Adjacency list in hop definition | `next: string[]` on each hop | Self-contained hops. No separate edge array to drift out of sync. |
| Join semantics per-hop, not per-edge | `joinType` on destination hop | Simpler mental model: "this hop waits for all/any predecessors." Avoids per-edge join complexity. |
| Backward compatibility via dual schema | `workflow` (legacy gates) + `workflowDAG` (new) | Existing tasks with linear gate workflows continue working. No migration required for v1.2 launch. |

---

## What NOT to Add

| Technology | Why Not |
|------------|---------|
| `graphlib` / `dagre` | Unmaintained. AOF's graphs are tiny. Topological sort is trivial to implement. |
| `xstate` v5 | Overkill for flat state machines. Would add ~40KB runtime + learning curve for 12 transitions. |
| `bull` / `bullmq` | Requires Redis. Violates filesystem-only constraint. |
| `p-limit` | AOF already has throttle.ts. Dual concurrency control is a bug factory. |
| `temporal` / `inngest` / `trigger.dev` | Server-based workflow platforms. AOF is a single-machine plugin. |
| Separate SQLite table for hop state | Hop state belongs in the task file (filesystem task store constraint). Adding a side-channel database violates the single-source-of-truth principle. |
| React Flow / vis.js | DAG visualization is deferred to v2. CLI-only for v1.2. |
| `json-logic-js` | Condition evaluation. The existing `Function` constructor approach in `gate-conditional.ts` is more powerful and already proven. json-logic adds a learning curve with no benefit. |

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| DAG representation | Adjacency list in hop definitions | Edge list (separate `edges` array) | Two arrays to keep in sync. Orphan edges possible. More complex validation. |
| State machine | Lookup table (`Record<HopStatus, HopStatus[]>`) | xstate v5 | 8 states, 12 transitions. Lookup table is simpler, zero-dep, matches existing patterns. |
| Condition engine | Extend existing `gate-conditional.ts` | `json-logic-js` or `expr-eval` | Existing engine is proven, sandboxed, tested. Swapping adds risk for no gain. |
| Parallel tracking | Hop-level state in task frontmatter | Separate tracking file per task | Violates single-file-per-task pattern. Complicates atomic writes. |
| Join semantics | Per-hop `joinType: "all" | "any"` | Per-edge join annotations | Per-hop is simpler mental model. Per-edge creates combinatorial complexity for N predecessors. |
| Workflow storage | Template in `project.yaml`, instance in task frontmatter | Separate workflow files | Adds file management complexity. Task frontmatter is the natural home for per-task state. |

---

## Version Compatibility (v1.2 relevant)

| Component | Version | Notes |
|-----------|---------|-------|
| Node.js | >=22.0.0 (pinned) | No change from v1.1. Node 24/25 still have better-sqlite3 issues. |
| Zod | ^3.24.0 | `.superRefine()` available since Zod 3.x. `.discriminatedUnion()` available since Zod 3.0. No upgrade needed. |
| TypeScript | ^5.7.0 | Satisfies constraint types and template literal types used in schema definitions. |
| vitest | ^3.0.0 | No change. Test patterns remain the same. |
| write-file-atomic | ^7.0.0 | No change. Atomic writes for hop state updates. |

---

## Installation

```bash
# No new packages needed for v1.2
npm ci

# Verify build works
npm run typecheck
npm test
```

---

## Sources

### Codebase (PRIMARY - HIGH confidence)

All technology decisions are grounded in direct reading of the existing codebase:

- `src/schemas/workflow.ts` -- Existing `WorkflowConfig` with linear gate sequences. Extension point for DAG schema.
- `src/schemas/gate.ts` -- Gate/hop type definitions. `GateOutcome`, `GateHistoryEntry`, `GateTransition` patterns to replicate for hops.
- `src/schemas/task.ts` -- `TaskFrontmatter` with `gate`, `gateHistory`, `reviewContext` fields. Pattern for adding `hopStates`.
- `src/schemas/project.ts` -- `ProjectManifest` with `workflow: WorkflowConfig.optional()`. Extension point for DAG templates.
- `src/dispatch/scheduler.ts` -- Poll loop with dependency checking, concurrency tracking. Integration point for DAG advancement.
- `src/dispatch/gate-evaluator.ts` -- Pure-function state machine pattern. Replicate for hop advancement.
- `src/dispatch/gate-conditional.ts` -- Sandboxed condition evaluator with `Function` constructor. Extend for DAG conditions.
- `src/dispatch/gate-transition-handler.ts` -- Orchestrator glue between pure logic and filesystem. Pattern for hop transition handler.
- `src/dispatch/task-dispatcher.ts` -- Dispatch action builder. Extension point for per-hop dispatch.
- `src/store/interfaces.ts` -- `ITaskStore` interface. May need `writeHopState()` convenience method.
- `package.json` -- Current dependency tree confirms all needed libraries are present.

### Algorithm Knowledge (MEDIUM confidence -- training data, not verified against current docs)

- **Kahn's algorithm** for topological sort -- well-established, O(V+E), standard for DAG processing. Used in build systems (Make, Gradle), CI pipelines, and data pipelines universally.
- **Frontier evaluation** -- standard pattern in DAG task schedulers. At each tick, find nodes with all predecessors complete. Apache Airflow, Prefect, and Dagster all use this approach.
- **Join semantics (all/any)** -- standard pattern from BPMN (Business Process Model and Notation) parallel gateways. "all" = AND-join, "any" = OR-join.

### Design Pattern Sources (MEDIUM confidence -- training data)

- **Adjacency list representation** -- standard graph representation. Preferred for sparse graphs (which workflow DAGs always are).
- **State machine as lookup table** -- used in game engines, protocol implementations, and workflow engines where state count is small and transitions are data-driven rather than behavior-driven.

---
*Stack research for: AOF v1.2 Per-Task Workflow DAG Execution*
*Researched: 2026-03-02*
*Previous research (v1.1): 2026-02-26 -- retained items not repeated here*
