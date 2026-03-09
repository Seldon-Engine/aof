---
title: "DAG Workflow Architecture Specification"
description: "Formal architecture specification for the DAG-based workflow engine in AOF."
version: "1.0"
status: "Draft"
author: "Demerzel (main)"
date: "2026-03-06"
---

# DAG Workflow Architecture Specification

## 1. Purpose and Scope

This document is the authoritative architecture specification for AOF's DAG-based workflow engine. It defines the system's structural decomposition, component contracts, data flow, persistence model, concurrency semantics, failure modes, and extension points.

**Audience:** Contributors implementing, extending, or debugging the DAG workflow system.

**Scope:** Covers the workflow engine from schema definition through evaluation, dispatch, and completion. Does not cover the broader AOF system (task store, memory, org chart) except where they interface with the DAG engine.

**Relationship to other documents:**
- `workflow-dag-design.md` — High-level design rationale and design decisions
- `workflow-dags.md` (guide) — User-facing guide and reference
- `architecture.md` — System-wide architecture overview

---

## 2. Design Invariants

These invariants are **non-negotiable**. Any change that violates them is a bug.

| # | Invariant | Enforcement |
|---|-----------|-------------|
| I-1 | The evaluator is a **pure function** — no side effects, no I/O, no mutations of input state | `structuredClone` on entry; no injected services |
| I-2 | Hop status transitions follow the **defined state machine** — no illegal transitions | `VALID_TRANSITIONS` map + runtime assertions |
| I-3 | DAG definitions are **immutable after task creation** — only `WorkflowState` changes | Schema separation: `definition` (frozen) vs `state` (mutable) |
| I-4 | **No eval** — conditions use a JSON DSL with a dispatch table, never `eval()` or `new Function()` | Zod discriminated union + `OPERATORS` table |
| I-5 | State persistence is **atomic** — partial writes are impossible | `write-file-atomic` for all state updates |
| I-6 | A hop is marked `dispatched` **only after** the agent session is successfully spawned | Dispatch-then-persist ordering in `dispatchDAGHop()` |
| I-7 | **One hop dispatched per poll cycle per task** — no parallel dispatch within a single poll | Scheduler loop constraint |
| I-8 | Rejection count **persists across cascades** — never reset to zero by the engine | `rejectionCount` carried forward in all reset paths |

---

## 3. Component Architecture

### 3.1 Layer Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Tool / CLI Layer                       │
│  aof_dispatch · aof_task_* · bd task create --workflow   │
└──────────────┬──────────────────────────┬────────────────┘
               │                          │
               v                          v
┌──────────────────────┐   ┌──────────────────────────────┐
│    Schema Layer       │   │     Transition Handler       │
│                       │   │                              │
│  WorkflowDefinition   │   │  handleDAGHopCompletion()    │
│  WorkflowState        │──▶│  dispatchDAGHop()            │
│  ConditionExpr        │   │  persistWorkflowState()      │
│  validateDAG()        │   │  buildEvalContext()           │
│                       │   │                              │
│  src/schemas/         │   │  src/dispatch/               │
│    workflow-dag.ts    │   │    dag-transition-handler.ts │
└──────────────────────┘   └──────┬──────────┬────────────┘
                                  │          │
                    ┌─────────────┘          └──────────┐
                    v                                    v
     ┌──────────────────────────┐     ┌─────────────────────────┐
     │    Evaluator Layer       │     │    Dispatch Layer        │
     │                          │     │                          │
     │  evaluateDAG()           │     │  GatewayAdapter.spawn()  │
     │  (pure function)         │     │  lease acquisition       │
     │                          │     │  context building        │
     │  dag-evaluator.ts        │     │                          │
     │  dag-condition-           │     │  dag-context-builder.ts  │
     │    evaluator.ts          │     │  assign-executor.ts      │
     └──────────────────────────┘     └─────────────────────────┘
                                              │
                                              v
                                   ┌─────────────────────┐
                                   │  Persistence Layer   │
                                   │                      │
                                   │  FilesystemTaskStore  │
                                   │  EventLogger          │
                                   │  write-file-atomic    │
                                   └─────────────────────┘
```

### 3.2 Component Responsibilities

#### Schema Layer (`src/schemas/workflow-dag.ts`)

**Responsibility:** Define the canonical types and validation rules for all DAG structures.

**Exports:**
- `WorkflowDefinition` — Zod schema for the immutable DAG shape
- `WorkflowState` / `HopState` — Zod schemas for mutable execution state
- `ConditionExpr` — Zod discriminated union for the condition DSL
- `Hop` — Zod schema for individual hop definitions
- `TaskWorkflow` — Top-level schema embedding definition + state on task frontmatter
- `validateDAG()` — Structural validation (cycle detection, reachability, condition complexity)
- `initializeWorkflowState()` — Create initial state from a definition (root hops → `ready`, others → `pending`)

**Contracts:**
- `validateDAG()` returns `string[]` (empty = valid). Errors are human-readable.
- `initializeWorkflowState()` is called exactly once at task creation time.
- All schemas use Zod `.default()` for backward-compatible evolution.

#### Evaluator Layer (`src/dispatch/dag-evaluator.ts`, `dag-condition-evaluator.ts`)

**Responsibility:** Compute the next workflow state given current state + an event. Pure function — no I/O.

**Primary interface:**

```typescript
function evaluateDAG(input: DAGEvaluationInput): DAGEvaluationResult;
```

**Input contract (`DAGEvaluationInput`):**

| Field | Type | Description |
|-------|------|-------------|
| `definition` | `WorkflowDefinition` | Immutable DAG shape |
| `state` | `WorkflowState` | Current state (NOT mutated) |
| `event` | `HopEvent` | Trigger: `{ hopId, outcome, rejectionNotes? }` |
| `context` | `EvalContext` | Hop results map + task metadata |

**Output contract (`DAGEvaluationResult`):**

| Field | Type | Description |
|-------|------|-------------|
| `state` | `WorkflowState` | New state (deep copy of input + applied changes) |
| `changes` | `HopTransition[]` | All status transitions that occurred |
| `readyHops` | `string[]` | Hops now eligible for dispatch |
| `dagStatus?` | `WorkflowStatus` | Terminal DAG status if reached |
| `taskStatus?` | `string` | Suggested task status (`"done"` or `"failed"`) |

**Evaluation pipeline (ordered steps):**

1. Deep copy state via `structuredClone`
2. Build reverse adjacency index (`buildDownstreamIndex`)
3. **If rejected:** handle rejection cascade → skip to step 7
4. Apply primary hop event (set hop status)
5. Cascade skips downstream for failed/skipped hops (`cascadeSkips`)
6. Evaluate conditions on newly eligible hops (`evaluateNewlyEligibleConditions`)
7. Determine ready hops (`determineReadyHops`)
8. Check DAG completion (`checkDAGCompletion`)

**Condition evaluator (`dag-condition-evaluator.ts`):**

- `evaluateCondition(expr, ctx)` — Recursive dispatch over `ConditionExpr` nodes
- `OPERATORS` table — `Record<string, ConditionHandler>` for extensibility
- `buildConditionContext(hopResults, task)` — Builds the field-resolution context
- `getField(obj, path)` — Dot-delimited path resolution

#### Transition Handler (`src/dispatch/dag-transition-handler.ts`)

**Responsibility:** Orchestrate the full lifecycle of a hop completion or dispatch. This is the **integration seam** between the pure evaluator and the side-effecting persistence/dispatch layers.

**Key functions:**

| Function | Trigger | Side Effects |
|----------|---------|--------------|
| `handleDAGHopCompletion()` | Agent session ends | Evaluate → persist state → dispatch ready hops → log events → update task status |
| `dispatchDAGHop()` | Ready hop found | Create artifact dir → build context → spawn session → persist dispatched state → log event |
| `persistWorkflowState()` | State change | Atomic write of updated frontmatter to task file |
| `buildEvalContext()` | Pre-evaluation | Read hop results from task, build `EvalContext` |

**Ordering guarantees:**
- `handleDAGHopCompletion`: evaluate → persist → dispatch (never dispatch before persist)
- `dispatchDAGHop`: spawn session → persist dispatched state (never persist before spawn succeeds)

#### Context Builder (`src/dispatch/dag-context-builder.ts`)

**Responsibility:** Build the `HopContext` that agents receive when dispatched.

**Interface:**

```typescript
interface HopContext {
  hopId: string;
  hopDefinition: Hop;        // The hop's schema definition
  artifactPaths: Record<string, string>;  // Completed predecessor artifacts
  workflowState: WorkflowState;           // Current state (read-only snapshot)
}

function buildHopContext(
  task: Task,
  hopId: string,
  definition: WorkflowDefinition,
  state: WorkflowState,
  taskDir: string
): HopContext;
```

**Artifact path contract:**
- Directory: `<taskDir>/work/<hopId>/`
- Created (mkdir -p) before dispatch
- Only completed predecessor hops appear in `artifactPaths`
- Skipped/failed predecessors are excluded

---

## 4. Data Model

### 4.1 Structural Types (Immutable)

```
WorkflowDefinition
  ├── name: string
  └── hops: Hop[]
        ├── id: string (unique within workflow)
        ├── role: string (org chart role)
        ├── dependsOn: string[] (predecessor hop IDs)
        ├── joinType: "all" | "any"
        ├── autoAdvance: boolean
        ├── condition?: ConditionExpr
        ├── canReject: boolean
        ├── rejectionStrategy?: "origin" | "predecessors"
        ├── timeout?: string (e.g., "2h", "1d")
        ├── escalateTo?: string (role)
        └── description?: string
```

### 4.2 Runtime State (Mutable)

```
WorkflowState
  ├── status: "pending" | "running" | "complete" | "failed"
  ├── startedAt?: ISO datetime
  ├── completedAt?: ISO datetime
  └── hops: Record<string, HopState>
        ├── status: HopStatus
        ├── startedAt?: ISO datetime
        ├── completedAt?: ISO datetime
        ├── agent?: string
        ├── correlationId?: string
        ├── result?: Record<string, unknown>
        ├── rejectionCount?: number
        └── escalated?: boolean
```

### 4.3 Task Frontmatter Integration

The `workflow` field on task frontmatter contains the full `TaskWorkflow`:

```yaml
workflow:
  definition:       # WorkflowDefinition — set once, never modified
    name: my-workflow
    hops: [...]
  state:            # WorkflowState — updated on every transition
    status: running
    hops:
      implement: { status: complete, completedAt: "..." }
      review: { status: dispatched, agent: reviewer-1 }
  templateName: my-workflow   # Optional: traceability back to template
```

### 4.4 Persistence Model

| What | Where | Atomicity |
|------|-------|-----------|
| DAG definition | Task frontmatter (`workflow.definition`) | Written once at task creation |
| DAG state | Task frontmatter (`workflow.state`) | `write-file-atomic` on every transition |
| Events | `events/YYYY-MM-DD.jsonl` | Append-only, one JSON line per event |
| Artifacts | `tasks/<status>/TASK-ID/work/<hopId>/` | Directory per hop, created before dispatch |

---

## 5. State Machines

### 5.1 Hop Status State Machine

```
                                ┌──────────────────────────────────┐
                                │        rejection reset           │
                                │    (origin or predecessors)      │
                                ▼                                  │
          condition=false   ┌─────────┐                            │
     ┌──────────────────── │ pending  │ ──────────────┐            │
     │                      └────┬────┘               │            │
     │                           │ deps satisfied     │            │
     │                           ▼                    │            │
     │    condition=false   ┌─────────┐               │            │
     │  ┌────────────────── │  ready  │               │            │
     │  │                   └────┬────┘               │            │
     │  │                        │ session spawned    │            │
     │  │                        ▼                    │            │
     │  │                  ┌────────────┐             │            │
     │  │                  │ dispatched │─────────────┤            │
     │  │                  └──┬───┬───┬─┘             │            │
     │  │          success    │   │   │  cascade      │            │
     │  │                     │   │   │               │            │
     │  │     ┌───────────────┘   │   └───────────┐   │            │
     │  │     ▼                   │               ▼   ▼            │
     │  │  ┌──────────┐    ┌─────┴────┐    ┌─────────┐            │
     │  └─▶│ skipped  │    │  failed  │    │complete │────────────┘
     │     └──────────┘    └──────────┘    └─────────┘
     │          ▲                ▲
     └──────────┴────────────────┘
              cascade skip
```

**Valid transitions:**

| From | To | Trigger |
|------|----|---------|
| `pending` | `ready` | All predecessors satisfied (per `joinType`) |
| `pending` | `skipped` | Condition false or cascade from upstream |
| `ready` | `dispatched` | Session successfully spawned |
| `ready` | `skipped` | Condition false (late evaluation) |
| `dispatched` | `complete` | Agent reports success |
| `dispatched` | `failed` | Agent error, circuit breaker, or timeout |
| `dispatched` | `skipped` | Cascade from upstream (edge case) |
| `complete` | `pending` | Rejection reset (origin strategy) |
| `complete` | `ready` | Rejection reset (predecessors strategy, no further deps) |
| `failed` | `pending` | Rejection reset (origin strategy) |
| `skipped` | `pending` | Rejection reset (origin strategy) |

### 5.2 Workflow Status State Machine

```
[pending] ──▶ [running] ──▶ [complete]
                  │
                  └──▶ [failed]
```

| From | To | Trigger |
|------|----|---------|
| `pending` | `running` | First hop dispatched |
| `running` | `complete` | All hops terminal, none failed |
| `running` | `failed` | All hops terminal, at least one failed |

---

## 6. Data Flow

### 6.1 Task Creation

```
User/Tool
  │
  ├─ CLI: `bd task create --workflow <template>`
  │   └─ resolveWorkflowTemplate() reads project.yaml
  │
  └─ Tool: aof_dispatch with workflow field
      │
      ▼
  validateDAG(definition)
  ├─ Cycle detection (Kahn's algorithm)
  ├─ Reachability check (BFS from roots)
  ├─ Condition complexity check
  └─ Hop ID uniqueness + reference integrity
      │
      ▼
  initializeWorkflowState(definition)
  ├─ Root hops (empty dependsOn) → status: ready
  └─ All other hops → status: pending
      │
      ▼
  FilesystemTaskStore.create()
  ├─ Write task file with workflow frontmatter
  └─ File placed in tasks/ready/ directory
```

### 6.2 Steady-State Dispatch Cycle

```
Scheduler poll tick
  │
  ▼
Scan tasks with active workflows (status: running or ready)
  │
  ▼
For each task with workflow:
  ├─ Read workflow.state
  ├─ Find hops with status: ready
  │   └─ (Zero or more — may be zero if all dispatched or pending)
  │
  ▼
For first ready hop (one-per-tick constraint):
  │
  ▼
dispatchDAGHop(task, hopId, definition, state)
  ├─ 1. Find hop definition
  ├─ 2. mkdir -p <taskDir>/work/<hopId>/
  ├─ 3. buildHopContext(task, hopId, definition, state, taskDir)
  │      └─ Collect artifactPaths from completed predecessors
  ├─ 4. Build TaskContext with HopContext
  ├─ 5. GatewayAdapter.spawn(agent, taskContext)
  │      └─ ✓ Success: continue
  │      └─ ✗ Failure: log error, hop stays ready, return
  ├─ 6. Set hop status → dispatched (+ startedAt, agent, correlationId)
  ├─ 7. Set workflow status → running (if pending)
  ├─ 8. persistWorkflowState() [atomic write]
  └─ 9. EventLogger.log("dag.hop_dispatched", {...})
```

### 6.3 Hop Completion

```
Agent session ends (success or failure)
  │
  ▼
handleDAGHopCompletion(task, runResult)
  │
  ├─ 1. findDispatchedHop(state) → hopId
  ├─ 2. mapRunResultToHopEvent(hopId, runResult) → HopEvent
  ├─ 3. buildEvalContext(task) → EvalContext
  │
  ▼
  evaluateDAG({ definition, state, event, context })  ← PURE FUNCTION
  │
  ├─ structuredClone(state)
  ├─ Apply event (hop → complete/failed)
  ├─ Cascade skips if failed
  ├─ Evaluate conditions on newly eligible hops
  ├─ Determine ready hops (join semantics)
  └─ Check DAG completion
  │
  ▼
  DAGEvaluationResult { state, changes, readyHops, dagStatus, taskStatus }
  │
  ├─ 4. persistWorkflowState(newState) [atomic write]
  │
  ├─ 5. For each readyHop:
  │      └─ dispatchDAGHop() (recursive into §6.2 flow)
  │
  ├─ 6. Log events for all changes
  │
  └─ 7. If dagStatus is terminal:
         ├─ Update task status (done or failed)
         └─ Release lease
```

### 6.4 Rejection Flow

```
Reviewer rejects hop (canReject: true)
  │
  ▼
handleDAGHopCompletion with outcome: "rejected"
  │
  ▼
evaluateDAG with rejected event
  │
  ├─ Increment rejectionCount on rejected hop
  │
  ├─ Check circuit breaker (rejectionCount >= 3?)
  │   ├─ Yes: hop → failed, cascade skip downstream → DAG failed
  │   └─ No: apply rejection strategy
  │
  ├─ Strategy: "origin"
  │   └─ Reset ALL hops: root hops → ready, others → pending
  │
  ├─ Strategy: "predecessors"
  │   └─ Reset rejected hop + its dependsOn predecessors only
  │
  └─ Determine ready hops from reset state
      │
      ▼
  Persist + dispatch ready hops (back to §6.2)
```

---

## 7. Concurrency Model

### 7.1 Single-Writer Guarantee

The DAG engine operates under a **single-writer model**:

- The AOF scheduler runs as a single poll loop (no parallel poll threads)
- One hop is dispatched per poll tick per task (invariant I-7)
- State persistence is atomic (invariant I-5)

This eliminates write-write conflicts on workflow state.

### 7.2 Read-Dispatch Race

**Scenario:** Scheduler reads task state, then dispatches. Between read and dispatch, a hop completion could modify state.

**Mitigation:** `handleDAGHopCompletion` performs a **fresh read** of the task before evaluation. The transition handler always reads the latest state from disk before computing next state. Combined with atomic writes, this ensures the evaluation is based on current state.

### 7.3 Completion-Dispatch Overlap

**Scenario:** Agent completes hop A → `handleDAGHopCompletion` fires → ready hop B is found → `dispatchDAGHop(B)` is called. Simultaneously, the scheduler's next poll tick also sees hop B as ready.

**Mitigation:** The dispatch-then-persist ordering (invariant I-6) means hop B is set to `dispatched` in the persisted state before the scheduler's next read. The scheduler will see `dispatched` and skip it.

### 7.4 Lease Semantics

Leases are orthogonal to DAG state but interact at the task level:

- A task lease is acquired when the first hop is dispatched
- The lease covers the entire task, not individual hops
- Lease TTL is configurable with renewal limits
- Lease expiration triggers recovery (hop → ready for retry)

---

## 8. Validation Rules

`validateDAG(definition)` enforces all of the following at creation time:

| Rule | Method | Error |
|------|--------|-------|
| At least one hop | Array length check | "Workflow must have at least one hop" |
| Unique hop IDs | Set comparison | "Duplicate hop id: X" |
| Valid dependency references | Lookup against hop ID set | "Hop X depends on unknown hop Y" |
| No self-dependencies | `dependsOn` check | "Hop X depends on itself" |
| At least one root hop | Find hops with empty `dependsOn` | "No root hops found" |
| No cycles | Kahn's topological sort | "Cycle detected involving hops: X, Y" |
| All hops reachable | BFS from root set | "Unreachable hops: X" |
| Condition complexity ≤ limits | `measureConditionComplexity()` | "Condition exceeds max depth/nodes" |
| Timeout format valid | Regex `^\d+[mhd]$` | "Invalid timeout format" |
| `escalateTo` requires `timeout` | Cross-field check | "escalateTo without timeout" |
| `rejectionStrategy` requires `canReject` | Cross-field check | "rejectionStrategy without canReject" |

Validation is run in two locations (belt-and-suspenders):
1. **CLI / tool layer** — before calling `store.create()`
2. **`FilesystemTaskStore.create()`** — before writing to disk

---

## 9. Failure Modes and Recovery

### 9.1 Agent Session Failure

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Agent crashes mid-hop | Session status check / lease expiry | Hop remains `dispatched` → lease expires → hop reset to `ready` → retry on next poll |
| Spawn failure | `GatewayAdapter.spawn()` throws | Hop stays `ready`, error logged as `dag.dispatch_error`, retry on next poll |
| Agent returns error | `runResult.outcome === "error"` | Hop → `failed`, cascade skips downstream |

### 9.2 Persistence Failure

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Atomic write fails | `write-file-atomic` throws | State not updated — next poll re-reads old state. Session may be spawned but hop not marked `dispatched`. Deduplication in scheduler prevents double-dispatch for already-running sessions. |
| Disk full | OS error | Logged, task remains in current state. Manual intervention required. |

### 9.3 Evaluation Anomalies

| Anomaly | Handling |
|---------|----------|
| Unknown condition operator | Returns `false` defensively (hop skipped) |
| Missing field in condition | Returns `undefined` → operator-specific default (eq=false, neq=true, numeric=false) |
| All root hops skipped by conditions | DAG completes immediately with status `complete` (all terminal, none failed) |
| Circuit breaker triggers | Hop → `failed`, cascade skips, DAG → `failed` |

### 9.4 Escalation Failure

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Escalation spawn fails | `GatewayAdapter.spawn()` throws | Hop set to `ready` with `escalated: true` → poll retry dispatches to escalation target |
| `escalateTo` role has no available agent | Routing failure | Same as spawn failure — logged, retried on next poll |

---

## 10. Event Catalog

All events are emitted via `EventLogger.log()` and written to `events/YYYY-MM-DD.jsonl`.

| Event Type | Emitter | Payload Fields | When |
|------------|---------|----------------|------|
| `dag.hop_dispatched` | `dispatchDAGHop` | `hopId`, `agent`, `sessionId`, `correlationId` | Session successfully spawned |
| `dag.hop_completed` | `handleDAGHopCompletion` | `hopId`, `outcome`, `readyHops`, `dagStatus`, `changes` | Evaluator returns result |
| `dag.hop_rejected` | `handleDAGHopCompletion` | `hopId`, `rejectionNotes`, `rejectionCount`, `strategy` | Rejection event processed |
| `dag.hop_escalated` | Timeout handler | `hopId`, `escalateTo`, `originalAgent` | Timeout fires |
| `dag.circuit_breaker` | `evaluateDAG` | `hopId`, `rejectionCount` | Circuit breaker threshold reached |
| `dag.dispatch_error` | `dispatchDAGHop` | `hopId`, `error` | Non-fatal dispatch failure |
| `dag.dispatch_failed` | `dispatchDAGHop` | `hopId`, `error`, `correlationId` | Spawn session failure |
| `dag.warning` | Various | `message` | Non-critical anomalies |

---

## 11. Extension Points

### 11.1 Adding a Condition Operator

**Effort:** Minimal (3 files, ~20 lines)

1. Add variant to `ConditionExprType` union in `src/schemas/workflow-dag.ts`
2. Add Zod discriminated union case in `ConditionExpr`
3. Add handler to `OPERATORS` table in `src/dispatch/dag-condition-evaluator.ts`

No other files require changes. The dispatch table pattern makes this purely additive.

### 11.2 Adding a Hop Property

**Effort:** Low (1–3 files)

1. Add field to `Hop` schema in `src/schemas/workflow-dag.ts` with `.default()` for backward compatibility
2. If the field affects evaluation: update `evaluateDAG()` or `determineReadyHops()`
3. If the field affects dispatch: update `buildHopContext()` or `dispatchDAGHop()`

Zod defaults ensure existing task files parse without migration.

### 11.3 Adding a Workflow Status

**Effort:** Medium (schema + evaluator + transition handler)

1. Add value to `WorkflowStatus` enum in schema
2. Update `checkDAGCompletion()` in evaluator
3. Update `handleDAGHopCompletion()` in transition handler
4. Update any CLI/tool display logic

### 11.4 Custom Join Semantics

**Effort:** Medium

1. Add value to `joinType` enum in `Hop` schema
2. Update `determineReadyHops()` in evaluator to handle new join type
3. No changes to transition handler or dispatch

### 11.5 Workflow Templates

Templates are defined in `ProjectManifest.workflowTemplates` (`project.yaml`). Template resolution happens in the CLI layer (`resolveWorkflowTemplate`), not in the store — keeping the store simple.

Template names match `^[a-z0-9][a-z0-9-]*$`. The resolved definition is embedded in the task (definition is the source of truth, `templateName` is informational).

---

## 12. Performance Characteristics

| Operation | Complexity | Notes |
|-----------|------------|-------|
| `validateDAG()` | O(V + E) | Kahn's sort + BFS |
| `evaluateDAG()` | O(V + E) | Single pass over hops + downstream index |
| `evaluateCondition()` | O(N) | N = condition tree node count (bounded by MAX_CONDITION_NODES=50) |
| `determineReadyHops()` | O(V × max_deps) | For each hop, check all predecessors |
| `cascadeSkips()` | O(V + E) | Recursive downstream traversal |
| `persistWorkflowState()` | O(file_size) | Atomic write of full task file |
| Per-poll overhead per DAG task | O(V + E) | State read + ready hop scan |

Where V = number of hops, E = number of edges (dependsOn references).

Practical workflows are small (3–10 hops). None of these operations are bottlenecks.

---

## 13. Security Model

| Threat | Mitigation |
|--------|------------|
| Arbitrary code execution via conditions | JSON DSL with dispatch table — no `eval()` (I-4) |
| Condition DoS (deeply nested/large expressions) | Complexity limits: depth ≤ 5, nodes ≤ 50 |
| State corruption via partial write | Atomic persistence via `write-file-atomic` (I-5) |
| Unauthorized hop dispatch | Org chart routing — agents only receive hops matching their role |
| State tampering by agent | Agents receive read-only snapshots; state updates go through the transition handler only |
| Infinite rejection loops | Circuit breaker at 3 rejections per hop (I-8) |

---

## 14. Testing Strategy

### 14.1 Unit Tests (Evaluator)

The evaluator is a pure function — ideal for exhaustive unit testing without mocks.

**Coverage targets:**
- Every hop status transition in the state machine
- Every condition operator (true/false/missing field)
- AND-join and OR-join semantics
- Rejection with both strategies (origin, predecessors)
- Circuit breaker at boundary (2 rejections OK, 3 triggers)
- Cascade skip propagation (deep chains)
- All validation rules in `validateDAG()`

**Test location:** `src/dispatch/__tests__/dag-evaluator.test.ts`, `dag-condition-evaluator.test.ts`

### 14.2 Integration Tests (Transition Handler)

Test the full orchestration: create task → dispatch hop → simulate completion → verify state transitions. Mock `GatewayAdapter` to avoid real sessions.

**Coverage targets:**
- Complete happy path (create → dispatch all hops → done)
- Rejection → re-dispatch → completion
- Timeout escalation
- Persistence atomicity (verify file contents after each transition)
- Event emission (verify JSONL entries)

**Test location:** `src/dispatch/__tests__/dag-scheduler-integration.test.ts`, `dag-transition-handler.test.ts`

### 14.3 E2E Tests

Full system test with real scheduler, real task store, mocked gateway.

**Test location:** `tests/e2e/suites/11-workflow-gates-tool-completion.test.ts`, `13-workflow-gate-integration.test.ts`

---

## 15. Migration Path

### 15.1 Gate-to-DAG Migration

Legacy gate-based tasks (v1.0) coexist with DAG tasks. The scheduler has **dual-mode routing**:

- Check `task.frontmatter.workflow` → DAG path
- Check `task.frontmatter.gate` → Legacy gate path

Migration is **lazy**: legacy tasks are migrated to DAG format on first evaluation. The migration logic in `src/migration/gate-to-dag.ts` handles:

- Position-based gate index → linear DAG hop mapping
- JavaScript `when` strings → JSON DSL `ConditionExpr` conversion
- One-time write-back to task frontmatter

New tasks always use DAG format. The gate code path is frozen — no new features.

### 15.2 Batch Migration

`src/packaging/migrations/002-gate-to-dag-batch.ts` provides a batch migration for converting all legacy gate tasks at once. This is optional — lazy migration handles individual tasks on demand.

---

## Appendix A: File Map

| Component | File | Lines (approx) |
|-----------|------|-----------------|
| Schema + validation | `src/schemas/workflow-dag.ts` | ~300 |
| Evaluator (pure) | `src/dispatch/dag-evaluator.ts` | ~250 |
| Condition evaluator | `src/dispatch/dag-condition-evaluator.ts` | ~150 |
| Transition handler | `src/dispatch/dag-transition-handler.ts` | ~200 |
| Context builder | `src/dispatch/dag-context-builder.ts` | ~80 |
| Evaluator tests | `src/dispatch/__tests__/dag-evaluator.test.ts` | ~400 |
| Condition tests | `src/dispatch/__tests__/dag-condition-evaluator.test.ts` | ~200 |
| Integration tests | `src/dispatch/__tests__/dag-scheduler-integration.test.ts` | ~300 |
| Transition tests | `src/dispatch/__tests__/dag-transition-handler.test.ts` | ~200 |
| Migration | `src/migration/gate-to-dag.ts` | ~150 |

---

## Appendix B: Glossary

| Term | Definition |
|------|------------|
| **Hop** | A node in the workflow DAG; a discrete unit of work assigned to a role |
| **Edge** | A dependency relationship between hops (defined by `dependsOn`) |
| **Root hop** | A hop with no predecessors (empty `dependsOn`); starts immediately |
| **Terminal hop** | A hop in a terminal status: `complete`, `failed`, or `skipped` |
| **AND-join** | Join type where ALL predecessors must be terminal (with ≥1 complete) before the hop is ready |
| **OR-join** | Join type where ANY predecessor being complete makes the hop ready |
| **Cascade skip** | When a hop fails/is skipped, downstream hops that cannot possibly succeed are transitively skipped |
| **Circuit breaker** | Safety mechanism that fails a hop permanently after 3 rejections |
| **Artifact path** | Per-hop directory for storing work products, passed to downstream hops |
| **Condition DSL** | JSON-based expression language for hop conditions (no eval) |
| **Dispatch table** | Pattern where condition operators map to handler functions in a record |
