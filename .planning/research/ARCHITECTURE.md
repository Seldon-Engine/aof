# Architecture Patterns: Per-Task Workflow DAGs

**Domain:** DAG-based workflow execution for multi-agent orchestration (AOF v1.2)
**Researched:** 2026-03-02
**Confidence:** HIGH (direct source code analysis of all integration points)

## Executive Summary

AOF currently has a linear gate-based workflow system: tasks progress through an ordered sequence of gates defined in `project.yaml`, with the gate evaluator advancing tasks on completion. The v1.2 milestone replaces this with per-task workflow DAGs -- directed acyclic graphs where hops (the DAG equivalent of gates) can branch, run in parallel, and converge. The critical architectural constraint is that OpenClaw has no nested agent sessions: each hop must be an independent spawn, with the scheduler advancing the DAG between hops.

This document maps every integration point, defines the new components needed, specifies how DAG state persists on tasks, and provides a build order that respects dependency chains and maintains backward compatibility.

---

## 1. Current Architecture (What Exists)

### 1.1 Component Map

```
Scheduler Poll Cycle (src/dispatch/scheduler.ts)
  |
  +-- store.list() --> all tasks
  |
  +-- checkExpiredLeases()
  +-- checkStaleHeartbeats()
  +-- checkGateTimeouts() ---- loads project manifest, finds gate timeout violations
  +-- checkBacklogPromotion()
  |
  +-- buildDispatchActions() -- for ready tasks:
  |     +-- dependency gating (dependsOn check)
  |     +-- resource serialization
  |     +-- throttle checks
  |     +-- builds "assign" actions
  |
  +-- checkBlockedTaskRecovery()
  |
  +-- executeActions() ------- for each action:
        +-- "assign" --> executeAssignAction():
        |     +-- acquireLease()
        |     +-- build TaskContext (with gateContext if workflow task)
        |     +-- executor.spawnSession()
        |     +-- startLeaseRenewal()
        |
        +-- "expire_lease" --> transition back to ready/blocked
        +-- "stale_heartbeat" --> readRunResult, apply transitions
        +-- "promote" --> backlog -> ready
        +-- other action types...
```

### 1.2 Workflow Flow (Current Linear Gates)

```
Task Created (routing.workflow: "standard-sdlc")
  |
  v
Task enters first gate: gate: { current: "implement", entered: "..." }
  |
  v
Scheduler dispatches to role specified by gate
  |
  v
Agent completes --> completion.report via ProtocolRouter
  |
  v
ProtocolRouter.handleCompletionReport():
  applyCompletionOutcome() --> resolveCompletionTransitions()
    --> transitions to "review" (or "done" if no review)
  |
  v
[Note: Gate advancement currently happens via the gate evaluator,
 invoked when an agent completes with a gate outcome]
```

### 1.3 Key Existing Data Structures

**Task frontmatter (relevant fields):**
```typescript
{
  routing: {
    role?: string;          // Current gate's role
    workflow?: string;      // Workflow name from project.yaml
    agent?: string;
  };
  gate: {                   // Current gate state
    current: string;        // Gate ID
    entered: string;        // ISO timestamp
  };
  gateHistory: GateHistoryEntry[];  // Audit trail
  reviewContext?: ReviewContext;      // Rejection feedback
  metadata: Record<string, unknown>; // Extensible
}
```

**WorkflowConfig (project.yaml):**
```typescript
{
  name: string;
  rejectionStrategy: "origin";
  gates: Gate[];           // Ordered sequence
  outcomes?: Record<string, string>;
}
```

**Gate:**
```typescript
{
  id: string;
  role: string;
  canReject: boolean;
  when?: string;           // Conditional expression
  timeout?: string;
  escalateTo?: string;
}
```

### 1.4 Integration Points to Modify

| Component | File | Current Role | DAG Impact |
|-----------|------|-------------|------------|
| WorkflowConfig schema | `schemas/workflow.ts` | Linear gate sequence | Add DAG definition schema |
| Task schema | `schemas/task.ts` | `gate`, `gateHistory` fields | Add `dag`, `dagState`, `hopHistory` fields |
| ProjectManifest | `schemas/project.ts` | `workflow: WorkflowConfig` | Add `workflows: Record<string, WorkflowConfig>` (named templates) |
| Gate evaluator | `dispatch/gate-evaluator.ts` | Linear next-gate logic | Replace with DAG evaluator |
| Gate context builder | `dispatch/gate-context-builder.ts` | Builds context for current gate | Adapt for hop context |
| Gate conditional | `dispatch/gate-conditional.ts` | `when` expression evaluation | Reuse for hop conditions |
| Assign executor | `dispatch/assign-executor.ts` | Injects gateContext on dispatch | Inject hopContext instead |
| Escalation | `dispatch/escalation.ts` | Gate timeout checks | Adapt for hop timeouts |
| Completion utils | `protocol/completion-utils.ts` | Status transition mapping | Add DAG-aware transitions |
| Protocol router | `protocol/router.ts` | `handleCompletionReport()` | Add DAG advancement on completion |
| Scheduler | `dispatch/scheduler.ts` | Gate timeout checking | Add DAG hop dispatch evaluation |
| Action executor | `dispatch/action-executor.ts` | Executes assign actions | No change needed (action types unchanged) |

---

## 2. Recommended Architecture

### 2.1 DAG Schema Design

The DAG is defined as a set of hops with explicit dependency edges. This replaces the implicit ordering of the linear gate array.

```typescript
// NEW: src/schemas/workflow-dag.ts

/** A hop is the DAG equivalent of a gate -- one unit of work at one stage. */
const Hop = z.object({
  /** Unique hop ID within the workflow (e.g., "implement", "review", "test"). */
  id: z.string().min(1),
  /** Role responsible for this hop (from org chart). */
  role: z.string().min(1),
  /** Hop IDs that must complete before this hop can start. Empty = root hop. */
  dependsOn: z.array(z.string()).default([]),
  /** Conditional activation expression (same as gate.when). */
  when: z.string().optional(),
  /** Human-readable description. */
  description: z.string().optional(),
  /** Whether this hop can reject (send back to predecessors). */
  canReject: z.boolean().default(false),
  /** Rejection target: "origin" (first hop) or specific hop ID. */
  rejectTo: z.string().optional(),
  /** Maximum time before escalation. */
  timeout: z.string().optional(),
  /** Escalation target role. */
  escalateTo: z.string().optional(),
  /** Whether this hop requires human approval. */
  requireHuman: z.boolean().optional(),
  /**
   * Hop behavior on completion of predecessor:
   * - "auto": Scheduler dispatches automatically (default)
   * - "pause": Task pauses in ready, awaiting manual trigger
   */
  trigger: z.enum(["auto", "pause"]).default("auto"),
});
type Hop = z.infer<typeof Hop>;

/** DAG workflow definition. */
const WorkflowDAG = z.object({
  /** Workflow name (unique within project). */
  name: z.string().min(1),
  /** Schema version for migration. */
  version: z.literal(2).default(2),
  /** Hop definitions (the nodes of the DAG). */
  hops: z.array(Hop).min(1),
  /** Default rejection strategy for hops without explicit rejectTo. */
  rejectionStrategy: z.enum(["origin", "predecessors"]).default("origin"),
  /** Optional outcome descriptions. */
  outcomes: z.record(z.string(), z.string()).optional(),
});
type WorkflowDAG = z.infer<typeof WorkflowDAG>;
```

**Why this shape:**
- `dependsOn` on each hop makes the DAG explicit and self-documenting in YAML
- Root hops (no `dependsOn`) are entry points -- the scheduler knows where to start
- Fan-out: multiple hops can depend on the same predecessor
- Fan-in: a hop with multiple `dependsOn` waits for all to complete (join)
- Conditional hops (`when`) are evaluated at dispatch time -- if skipped, downstream hops treat them as complete

**Example YAML:**
```yaml
workflows:
  standard-sdlc:
    name: standard-sdlc
    version: 2
    hops:
      - id: implement
        role: swe-backend
        description: "Initial implementation"
      - id: test
        role: swe-qa
        dependsOn: [implement]
        canReject: true
      - id: review
        role: swe-architect
        dependsOn: [implement]
        canReject: true
      - id: security
        role: security
        dependsOn: [implement]
        when: "tags.includes('security')"
      - id: deploy
        role: swe-ops
        dependsOn: [test, review, security]
        description: "Deploy to staging"
```

### 2.2 DAG State on Task (Persisted in Frontmatter)

The DAG execution state lives on the task frontmatter. This is the single source of truth for where the task is in its workflow.

```typescript
// NEW: Added to TaskFrontmatter schema

/** State of a single hop in the DAG execution. */
const HopState = z.object({
  /** Hop ID. */
  id: z.string(),
  /** Hop execution status. */
  status: z.enum([
    "pending",       // Not yet eligible (predecessors incomplete)
    "ready",         // All predecessors complete, eligible for dispatch
    "dispatched",    // Scheduler has dispatched this hop
    "complete",      // Hop completed successfully
    "rejected",      // Hop rejected work back to predecessors
    "blocked",       // Hop hit external blocker
    "skipped",       // Conditional evaluated to false
  ]),
  /** Agent assigned to this hop (set on dispatch). */
  agent: z.string().optional(),
  /** ISO timestamp when hop became ready. */
  readyAt: z.string().datetime().optional(),
  /** ISO timestamp when hop was dispatched. */
  dispatchedAt: z.string().datetime().optional(),
  /** ISO timestamp when hop completed/blocked/rejected. */
  completedAt: z.string().datetime().optional(),
  /** Completion outcome (if completed). */
  outcome: z.enum(["complete", "needs_review", "blocked"]).optional(),
  /** Summary from the completing agent. */
  summary: z.string().optional(),
  /** Blockers if rejected or blocked. */
  blockers: z.array(z.string()).default([]),
  /** Rejection notes. */
  rejectionNotes: z.string().optional(),
});
type HopState = z.infer<typeof HopState>;

/** DAG execution state -- the full runtime state of a workflow on a task. */
const DAGState = z.object({
  /** Workflow name (references workflow template). */
  workflow: z.string(),
  /** Current hops state map (hop ID -> HopState). */
  hops: z.record(z.string(), HopState),
  /** The hop currently being dispatched/executed (for routing). */
  activeHop: z.string().optional(),
  /** ISO timestamp when DAG execution started. */
  startedAt: z.string().datetime(),
  /** ISO timestamp when DAG completed (all terminal hops done). */
  completedAt: z.string().datetime().optional(),
  /** Number of rejection cycles (for circuit breaker). */
  rejectionCount: z.number().int().nonnegative().default(0),
});
type DAGState = z.infer<typeof DAGState>;
```

**Why on the task (not in a separate file):**
1. **Atomic transitions**: Task file rename (status directory change) and DAG state update happen in one write -- no cross-file consistency issues
2. **Human-readable**: `cat task.md` shows the complete picture including DAG progress
3. **Existing pattern**: Gate state already lives in frontmatter (`gate`, `gateHistory`)
4. **Store interface unchanged**: No new file types to manage
5. **Crash recovery**: DAG state survives gateway restarts because it is on the task file

**Frontmatter size concern**: A workflow with 10 hops adds approximately 2-4KB to frontmatter. This is acceptable for the filesystem store. The existing `gateHistory` array can grow much larger (one entry per gate traversal including rejection loops).

### 2.3 DAG Evaluator (New Component)

```
NEW: src/dispatch/dag-evaluator.ts

Purpose: Pure function that evaluates DAG state and returns next actions.
No I/O, deterministic, easy to test.

Input:
  - task: Task (with dagState)
  - workflow: WorkflowDAG definition
  - event: { type: "hop_completed" | "hop_rejected" | "hop_blocked" | "init", hopId: string, ... }

Output:
  - hopUpdates: Record<string, Partial<HopState>>  // State changes to apply
  - readyHops: string[]                              // Hops newly eligible for dispatch
  - taskStatus?: TaskStatus                          // If DAG complete: "review"/"done"
  - rejectionTargets?: string[]                      // Hops to reset on rejection
```

**Evaluation algorithm:**

```
function evaluateDAG(task, workflow, event):

  1. Apply event to current hop state:
     - "hop_completed": mark hop as complete, record outcome
     - "hop_rejected": mark hop as rejected, increment rejectionCount
     - "hop_blocked": mark hop as blocked
     - "init": initialize all hops to "pending"

  2. Evaluate conditional hops:
     For each hop with `when` expression and status "pending":
       If all predecessors are complete/skipped AND condition evaluates false:
         Mark hop as "skipped"

  3. Propagate readiness:
     For each hop with status "pending":
       If ALL predecessors are in {complete, skipped}:
         Mark hop as "ready"

  4. Handle rejection:
     If event is "hop_rejected":
       Determine rejection targets (based on rejectTo or rejectionStrategy)
       Reset target hops to "pending" (or "ready" if they have no pending predecessors)
       Reset all hops downstream of targets to "pending"

  5. Check DAG completion:
     If ALL terminal hops (no dependents) are in {complete, skipped}:
       DAG is complete -> return taskStatus: "review" (or "done" if no review needed)

  6. Return:
     - Updated hop states
     - List of newly "ready" hops (for scheduler to dispatch)
     - Optional task status change
```

**Key properties:**
- **Pure function**: No I/O, no side effects -- takes state and event, returns new state
- **Idempotent**: Same input always produces same output
- **Deterministic**: No LLM calls (maintains control plane guarantee)
- **Testable**: Easy to unit test with fixture DAGs

### 2.4 Scheduler Integration

The scheduler poll cycle gains a new step: evaluating DAG hops for dispatch.

```
Modified Scheduler Poll Cycle:

  1. List all tasks
  2. [existing] Check expired leases, stale heartbeats, SLA violations
  3. [existing] Check gate timeouts --> EXTEND to check hop timeouts
  4. [NEW] Evaluate DAG tasks:
     For each task with dagState where activeHop is NOT dispatched:
       Scan dagState.hops for hops in "ready" status
       For each ready hop:
         If hop.trigger === "auto":
           Build assign action with routing from hop definition
         Else (pause):
           Skip (manual trigger required)
  5. [existing] Build dispatch actions for non-DAG ready tasks
  6. [existing] Execute actions (assign, expire_lease, etc.)
```

**Critical insight**: DAG tasks do NOT use the regular `ready` task status for hop dispatch. A DAG task stays in `in-progress` status throughout its DAG execution. Individual hops go through ready -> dispatched -> complete within the task's `dagState`. The scheduler dispatches hops by reading `dagState.hops`, not by looking at task status.

**Task status lifecycle for DAG tasks:**
```
backlog -> ready -> in-progress (DAG starts, stays here during all hops)
                      |
                      +-- hop1: ready -> dispatched -> complete
                      +-- hop2: ready -> dispatched -> complete
                      +-- hop3: ready -> dispatched -> complete
                      |
                   -> review (all terminal hops complete)
                   -> done
```

**Why keep the task in-progress during DAG execution:**
- The task is actively being worked on (by multiple agents across hops)
- Lease management applies to the currently active hop, not the task overall
- SLA tracking starts at task `in-progress` and includes total DAG execution time
- The task only leaves `in-progress` when the entire DAG completes

### 2.5 Hop Dispatch Flow

When the scheduler identifies a ready hop:

```
1. Scheduler finds task with dagState.hops["test"].status === "ready"

2. Scheduler builds assign action:
   {
     type: "assign",
     taskId: task.id,
     agent: resolve(hop.role),  // From org chart
     reason: "DAG hop 'test' ready for dispatch",
   }

3. executeAssignAction():
   a. Update dagState.hops["test"].status = "dispatched"
   b. Update dagState.hops["test"].dispatchedAt = now
   c. Update dagState.activeHop = "test"
   d. Update task.routing.role = hop.role
   e. Build TaskContext with hopContext (replaces gateContext)
   f. acquireLease() for this hop
   g. executor.spawnSession(context)

4. Agent works, sends completion.report

5. ProtocolRouter.handleCompletionReport():
   a. Detect task has dagState (new check)
   b. Map completion outcome to hop outcome
   c. Call evaluateDAG(task, workflow, { type: "hop_completed", hopId: activeHop })
   d. Apply returned hop state updates
   e. If readyHops returned: update dagState, clear activeHop, release lease
   f. If taskStatus returned: transition task to review/done
   g. If no ready hops and DAG not complete: clear activeHop, wait for next poll
```

### 2.6 Completion Report Handling (Modified)

The `handleCompletionReport` in `ProtocolRouter` needs the most significant change:

```typescript
// In protocol/router.ts handleCompletionReport():

// After existing authorization and run result handling:

if (task.frontmatter.dagState) {
  // DAG task: advance the DAG instead of linear gate progression
  const workflow = await loadWorkflowDAG(store, task);
  const activeHop = task.frontmatter.dagState.activeHop;

  if (!activeHop) {
    // Error: completion report with no active hop
    return;
  }

  const hopOutcome = mapCompletionToHopOutcome(envelope.payload.outcome);
  const result = evaluateDAG(task, workflow, {
    type: hopOutcome === "complete" ? "hop_completed"
        : hopOutcome === "needs_review" ? "hop_rejected"
        : "hop_blocked",
    hopId: activeHop,
    summary: envelope.payload.notes,
    blockers: envelope.payload.blockers,
  });

  // Apply hop state updates
  applyDAGUpdates(task, result);

  // Release lease for completed hop
  task.frontmatter.lease = undefined;
  task.frontmatter.dagState.activeHop = undefined;

  // If DAG complete, transition task
  if (result.taskStatus) {
    await store.transition(task.frontmatter.id, result.taskStatus, {
      reason: "dag_complete",
    });
  }

  // Ready hops will be picked up by next scheduler poll
  await store.save(task);
}
else if (task.frontmatter.gate) {
  // Legacy linear gate task: existing behavior
  // ... existing gate evaluation code ...
}
else {
  // Non-workflow task: existing behavior
  await applyCompletionOutcome(task, ...);
}
```

### 2.7 Backward Compatibility Strategy

**Coexistence period**: v1.2 supports BOTH linear gate tasks and DAG tasks simultaneously.

| Aspect | Linear Gate Tasks | DAG Tasks |
|--------|------------------|-----------|
| Schema | `gate` + `gateHistory` fields | `dagState` field |
| Workflow source | `project.yaml` `workflow:` (single) | `project.yaml` `workflows:` (named map) |
| Dispatch routing | `routing.workflow` + `gate.current` | `dagState.activeHop` + hop definition |
| Evaluator | `gate-evaluator.ts` | `dag-evaluator.ts` |
| Timeout checking | `escalation.ts` (gate timeouts) | Extended to check hop timeouts |
| Completion handling | `applyCompletionOutcome()` | `evaluateDAG()` + `applyDAGUpdates()` |

**Detection**: The presence of `dagState` on a task frontmatter indicates it is a DAG task. The absence means it uses the legacy gate system (or no workflow at all).

**Migration path**: Existing linear workflows can be automatically converted to DAGs:
```yaml
# Linear gates:                    # Equivalent DAG:
workflow:                          workflows:
  name: standard                     standard:
  gates:                               name: standard
    - id: implement                    version: 2
      role: backend                    hops:
    - id: review                         - id: implement
      role: architect                      role: backend
      canReject: true                    - id: review
                                           role: architect
                                           dependsOn: [implement]
                                           canReject: true
```

Each gate becomes a hop that `dependsOn` the previous gate. The ordering is preserved.

### 2.8 Artifact Handoff Between Hops

Hops share artifacts via the task's work directory (already exists: `tasks/<status>/<taskId>/outputs/`).

```
tasks/in-progress/TASK-2026-03-02-001/
  TASK-2026-03-02-001.md          # Task file with DAG state
  outputs/
    implement/                     # Hop-scoped artifact directory
      summary.md
      code-changes.patch
    test/
      test-results.json
    review/
      review-notes.md
```

**Convention**: Each hop writes to `outputs/<hopId>/`. The hop context injected at dispatch time tells the agent where to find predecessor outputs:

```typescript
interface HopContext {
  hop: string;                    // Current hop ID
  role: string;                   // Expected role
  expectations: string[];         // What to do
  outcomes: Record<string, string>; // What outcomes mean
  predecessorOutputs: string[];   // Paths to predecessor hop outputs
  tips?: string[];
}
```

The `ITaskStore.writeTaskOutput` method already supports writing to `outputs/`. A minor extension scopes it to `outputs/<hopId>/`.

---

## 3. New Components

### 3.1 Files to Create

| File | Purpose | Complexity | Dependencies |
|------|---------|-----------|--------------|
| `src/schemas/workflow-dag.ts` | `Hop`, `WorkflowDAG` Zod schemas | Low | `zod` only |
| `src/schemas/dag-state.ts` | `HopState`, `DAGState` Zod schemas | Low | `zod` only |
| `src/dispatch/dag-evaluator.ts` | Pure DAG evaluation function | Medium | Schemas only |
| `src/dispatch/dag-validator.ts` | DAG validation (cycles, missing refs) | Low | Schemas only |
| `src/dispatch/hop-context-builder.ts` | Build agent context for hops | Low | Schemas, gate-conditional.ts |
| `src/dispatch/dag-dispatcher.ts` | Scheduler integration for DAG dispatch | Medium | dag-evaluator, store, executor |
| `src/dispatch/dag-completion-handler.ts` | Handle completion reports for DAG tasks | Medium | dag-evaluator, store, protocol |
| `src/dispatch/dag-timeout-checker.ts` | Hop timeout detection and escalation | Low | dag-state, escalation pattern |

### 3.2 Files to Modify

| File | Change | Scope |
|------|--------|-------|
| `src/schemas/task.ts` | Add `dagState?: DAGState` to TaskFrontmatter | Small |
| `src/schemas/project.ts` | Add `workflows?: Record<string, WorkflowDAG>` to ProjectManifest | Small |
| `src/dispatch/scheduler.ts` | Add DAG hop dispatch step to poll cycle | Medium |
| `src/protocol/router.ts` | Branch `handleCompletionReport` for DAG tasks | Medium |
| `src/dispatch/escalation.ts` | Extend timeout checking for hops | Small |
| `src/dispatch/assign-executor.ts` | Inject hopContext (alongside existing gateContext) | Small |
| `src/protocol/completion-utils.ts` | Add DAG-aware completion transitions | Small |

### 3.3 Files NOT Modified (Preserved)

| File | Reason |
|------|--------|
| `src/dispatch/gate-evaluator.ts` | Preserved for backward compat with linear gate tasks |
| `src/dispatch/gate-context-builder.ts` | Preserved for backward compat |
| `src/dispatch/gate-conditional.ts` | Reused by DAG evaluator (shared `when` logic) |
| `src/dispatch/action-executor.ts` | Action types unchanged, just more assign actions |
| `src/dispatch/task-dispatcher.ts` | Handles non-DAG ready tasks (unchanged) |
| `src/store/task-store.ts` | Task store is schema-agnostic (just serializes frontmatter) |
| `src/store/interfaces.ts` | ITaskStore contract unchanged |
| `src/dispatch/dep-cascader.ts` | Inter-task dependencies unchanged (DAG is intra-task) |

---

## 4. Data Flow

### 4.1 DAG Task Lifecycle

```
1. TASK CREATION
   Agent or human creates task with workflow reference:
   routing: { workflow: "standard-sdlc" }

   Task store (or CLI) loads workflow template, initializes dagState:
   dagState: {
     workflow: "standard-sdlc",
     hops: {
       implement: { id: "implement", status: "ready" },
       test:      { id: "test",      status: "pending" },
       review:    { id: "review",    status: "pending" },
       security:  { id: "security",  status: "pending" },
       deploy:    { id: "deploy",    status: "pending" },
     },
     startedAt: "2026-03-02T10:00:00Z"
   }
   Task status: ready

2. FIRST HOP DISPATCH
   Scheduler poll sees task in "ready" with dagState:
   - Transitions task to "in-progress"
   - Finds root hop(s) in "ready" status: ["implement"]
   - Dispatches "implement" hop
   dagState.hops.implement.status = "dispatched"
   dagState.activeHop = "implement"

3. HOP COMPLETION
   Agent sends completion.report
   ProtocolRouter detects dagState, calls evaluateDAG:
   - Marks "implement" as "complete"
   - Evaluates conditionals (security: when expression)
   - Propagates readiness: test, review become "ready"
     (security becomes "ready" or "skipped" based on condition)
   - Clears activeHop

   dagState.hops:
     implement: { status: "complete", completedAt: "..." }
     test:      { status: "ready", readyAt: "..." }
     review:    { status: "ready", readyAt: "..." }
     security:  { status: "skipped" | "ready" }
     deploy:    { status: "pending" }

4. PARALLEL HOP DISPATCH
   Next scheduler poll sees ready hops: [test, review, (security)]

   CRITICAL CONSTRAINT: OpenClaw cannot run nested sessions.
   Only ONE hop can be dispatched at a time per task.

   Scheduler picks highest-priority ready hop (or earliest readyAt):
   - Dispatches "test" first
   - test completes, then dispatches "review"
   - review completes, then dispatches "security" (if not skipped)

   Note: "parallel" in the DAG means no ordering dependency, not
   simultaneous execution. The scheduler serializes actual dispatch.

5. JOIN CONVERGENCE
   "deploy" depends on [test, review, security]:
   - After all three are complete/skipped, deploy becomes "ready"
   - Scheduler dispatches "deploy"

6. DAG COMPLETION
   All terminal hops complete:
   - evaluateDAG returns taskStatus: "review"
   - Task transitions in-progress -> review -> done

7. REJECTION LOOP
   If "review" hop rejects (outcome: "needs_review"):
   - evaluateDAG determines rejection target: "implement" (origin strategy)
   - Resets "implement" to "ready"
   - Resets all downstream hops (test, review, security, deploy) to "pending"
   - rejectionCount incremented
   - Scheduler dispatches "implement" again on next poll
```

### 4.2 Parallel Execution Model

OpenClaw's no-nested-sessions constraint means "parallel" DAG branches execute sequentially. The DAG captures logical parallelism (no ordering dependency), but the scheduler serializes physical execution.

**Dispatch priority for ready hops (within one task):**
1. Hops with earlier `readyAt` timestamp (FIFO)
2. Hops with canReject=true (reviews before implementation, to fail fast)
3. Hops with timeout (time-sensitive work first)

**Multiple tasks with ready hops**: The existing concurrency system handles this. Each hop dispatch is one `assign` action competing for the global concurrency pool. DAG tasks get no special priority over non-DAG tasks.

### 4.3 Event Flow

```
Protocol Messages:

completion.report (agent -> router)
  |
  +-- Router detects dagState
  |
  +-- Calls dag-completion-handler:
  |     - evaluateDAG(task, workflow, event)
  |     - Apply hop state updates
  |     - Write task with updated dagState
  |
  +-- Logs: dag.hop.completed, dag.hop.ready, dag.completed
  |
  +-- Next scheduler poll picks up ready hops

Events emitted:
  dag.started       - Task enters DAG execution
  dag.hop.ready     - Hop becomes eligible for dispatch
  dag.hop.dispatched - Hop dispatched to agent
  dag.hop.completed  - Hop completed successfully
  dag.hop.rejected   - Hop rejected work
  dag.hop.blocked    - Hop hit blocker
  dag.hop.skipped    - Conditional hop skipped
  dag.hop.timeout    - Hop exceeded timeout
  dag.completed      - All terminal hops done
  dag.rejection_loop - Rejection cycle detected
```

---

## 5. Critical Design Decisions

### D1: DAG State on Task Frontmatter (Not Separate File)

**Decision**: Store `dagState` in the task's YAML frontmatter.

**Rationale**:
- Atomic consistency: task status and DAG state update together
- Human-readable: `cat task.md` tells the full story
- Existing pattern: `gate`/`gateHistory` already live in frontmatter
- No new file management: ITaskStore unchanged
- Crash recovery: state survives restarts (persisted on every write)

**Trade-off**: Frontmatter grows larger. A 10-hop workflow adds ~3KB. Acceptable for filesystem store. If this becomes a problem at scale, consider moving `hopHistory` (the equivalent of `gateHistory`) to a separate `outputs/dag-history.json` file.

### D2: One Active Hop Per Task (Serial Dispatch)

**Decision**: Only one hop executes at a time per task, even when multiple hops are ready.

**Rationale**:
- OpenClaw constraint: no nested sessions
- Lease model: one lease per task, one agent per lease
- Simplicity: no coordination between concurrent hops on same task
- Correctness: no race conditions on dagState updates

**Trade-off**: Logical parallelism is not physical parallelism. A DAG with `test` and `review` running in parallel will actually run them sequentially. This is acceptable because:
- Each hop is a separate agent session (seconds to minutes, not hours)
- The scheduler dispatches the next hop within one poll cycle (~30s)
- True parallelism would require splitting into separate tasks (out of scope per PROJECT.md)

### D3: Workflow Templates in Project Config + Ad-Hoc on Task

**Decision**: Support both pre-defined templates (project.yaml `workflows:`) and ad-hoc agent-composed DAGs (dagState on task at creation time).

**Template path**: Task has `routing.workflow: "standard-sdlc"` -> scheduler loads template from `project.yaml`, initializes `dagState`.

**Ad-hoc path**: Agent creates task with inline `dagState` already populated (the DAG is embedded in the task). No template reference needed.

**Rationale**: Templates handle the 80% case (recurring workflows). Ad-hoc handles dynamic pipelines where agents compose workflows based on task requirements.

### D4: Rejection Resets Downstream Hops

**Decision**: When a hop rejects, reset the rejection target and ALL downstream hops to pending.

**Rationale**: If `review` rejects to `implement`, then `test` (which depends on `implement`) must re-run too -- the implementation changed. Keeping downstream hops as "complete" with stale results is incorrect.

**Circuit breaker**: `dagState.rejectionCount` tracks rejection cycles. After N rejections (configurable, default 3), the task transitions to `blocked` with a circuit breaker alert. Prevents infinite rejection loops.

### D5: Skipped Hops Propagate as "Complete" for Dependency Resolution

**Decision**: When a conditional hop evaluates to "skipped", downstream hops treat it as satisfied (equivalent to "complete" for dependency checking).

**Rationale**: If `security` hop is skipped because the task has no security tags, `deploy` (which depends on `[test, review, security]`) should not be blocked waiting for a hop that will never run.

### D6: Hop History Replaces Gate History

**Decision**: `dagState.hops` serves as both current state AND history. Each hop's `HopState` records timestamps and outcomes. A separate `hopHistory` array is NOT needed initially.

**Rationale**: Unlike linear gates where the same gate can be visited multiple times (rejection loops), a DAG hop is visited once per cycle. On rejection, the hop state is reset. The event log captures the full history (each `dag.hop.*` event is logged to JSONL). If audit trail on the task file is needed later, add `hopHistory` array (append-only, like `gateHistory`).

**Revisit if**: Auditors need full hop traversal history on the task file itself (not just in event logs).

---

## 6. Build Order

The build order respects dependency chains and ensures each phase is independently testable.

### Phase 1: Schema Foundation
```
Create:
  src/schemas/workflow-dag.ts     - Hop + WorkflowDAG schemas
  src/schemas/dag-state.ts        - HopState + DAGState schemas

Modify:
  src/schemas/task.ts             - Add dagState?: DAGState field
  src/schemas/project.ts          - Add workflows?: Record<string, WorkflowDAG>

Test:
  Schema validation, serialization round-trip, backward compat with existing tasks
```

**Why first**: Everything else depends on the data shapes. Schema changes are low-risk (additive, optional fields).

### Phase 2: DAG Evaluator (Pure Logic)
```
Create:
  src/dispatch/dag-evaluator.ts   - Core evaluation algorithm
  src/dispatch/dag-validator.ts   - DAG validation (cycles, missing refs)

Test:
  Extensive unit tests with fixture DAGs:
  - Linear DAG (equivalent to gate sequence)
  - Diamond DAG (fan-out + fan-in)
  - Conditional hops (skip, evaluate)
  - Rejection loops (origin, predecessor)
  - Circuit breaker (max rejections)
  - Edge cases (single hop, all skipped, empty DAG)
```

**Why second**: Pure function, no I/O, no integration points. Can be tested in isolation. This is the algorithmic core.

### Phase 3: Hop Context & Dispatch Integration
```
Create:
  src/dispatch/hop-context-builder.ts  - Build HopContext for agents
  src/dispatch/dag-dispatcher.ts       - Scheduler integration for DAG hop dispatch

Modify:
  src/dispatch/scheduler.ts            - Add DAG hop evaluation step
  src/dispatch/assign-executor.ts      - Inject hopContext alongside gateContext

Test:
  Integration tests: scheduler poll with DAG tasks, hop dispatch flow
```

**Why third**: Depends on schemas (Phase 1) and evaluator (Phase 2). This connects the DAG to the scheduler.

### Phase 4: Completion Handling & Protocol Integration
```
Create:
  src/dispatch/dag-completion-handler.ts - DAG-aware completion processing

Modify:
  src/protocol/router.ts                - Branch for DAG task completions
  src/protocol/completion-utils.ts       - DAG-aware transition mapping

Test:
  Integration tests: completion report -> DAG advancement -> ready hops
  End-to-end: task creation -> dispatch -> complete -> next hop -> DAG done
```

**Why fourth**: Depends on all previous phases. This closes the loop: dispatch -> complete -> advance -> dispatch.

### Phase 5: Timeout, Escalation & Rejection
```
Create:
  src/dispatch/dag-timeout-checker.ts   - Hop timeout detection

Modify:
  src/dispatch/escalation.ts            - Extend for hop timeouts

Test:
  Timeout detection, escalation flow, rejection with downstream reset
```

**Why fifth**: Edge cases built on the working happy path from phases 1-4.

### Phase 6: Workflow Templates & Ad-Hoc Composition
```
Modify:
  CLI commands for workflow management
  Task creation to accept inline DAG definitions
  Template loading and validation

Test:
  Template resolution, ad-hoc DAG creation, validation errors
```

**Why last**: User-facing features built on the complete internal machinery.

---

## 7. Anti-Patterns to Avoid

### Anti-Pattern 1: Storing DAG Definition on Every Task
**What**: Copying the full `WorkflowDAG` definition into each task's frontmatter.
**Why bad**: Duplication, inconsistency when template changes, bloated frontmatter.
**Instead**: Store `dagState.workflow` as a reference name. Load the definition from `project.yaml` when needed. The `dagState.hops` only stores runtime state, not the definition.

### Anti-Pattern 2: Using Task Status for Hop Lifecycle
**What**: Transitioning the task through ready -> in-progress -> review for each hop.
**Why bad**: Task status represents the TASK lifecycle, not the HOP lifecycle. Moving task to "review" after each hop breaks the scheduler's assumptions.
**Instead**: Task stays in-progress during all hops. Hop state lives in `dagState.hops[hopId].status`.

### Anti-Pattern 3: Dispatching Multiple Hops Simultaneously
**What**: Spawning multiple agent sessions for parallel hops on the same task.
**Why bad**: OpenClaw has no nested sessions. Multiple sessions would conflict on the same task file. Lease model is one-agent-per-task.
**Instead**: Serial dispatch of one hop at a time. The DAG captures logical parallelism; the scheduler serializes physical execution.

### Anti-Pattern 4: Modifying Gate Evaluator for DAG Support
**What**: Making `gate-evaluator.ts` handle both linear gates and DAGs.
**Why bad**: Different evaluation algorithms. Linear gate evaluation is sequential; DAG evaluation is graph-based. Mixing them creates complexity and fragility.
**Instead**: Separate `dag-evaluator.ts`. Detection happens at the router/scheduler level (check for `dagState` vs `gate`).

### Anti-Pattern 5: Tight Coupling Between Evaluator and Store
**What**: Having the DAG evaluator directly read/write the task store.
**Why bad**: Breaks testability. The evaluator should be a pure function.
**Instead**: Evaluator takes task + workflow + event, returns state updates. Caller applies updates to the store. Same pattern as existing `evaluateGateTransition()`.

---

## 8. Migration and Compatibility

### 8.1 Existing Task Compatibility

All existing fields remain optional:
- Tasks with `gate` field: use linear gate evaluator (unchanged)
- Tasks with `dagState` field: use DAG evaluator (new)
- Tasks with neither: no workflow (unchanged)

A task MUST NOT have both `gate` and `dagState`. Schema validation enforces mutual exclusivity.

### 8.2 Project Configuration Migration

```yaml
# v1.1 (current):
workflow:
  name: standard
  gates:
    - id: implement
      role: backend
    - id: review
      role: architect
      canReject: true

# v1.2 (new, backward compatible):
workflow:                          # Still supported for legacy tasks
  name: standard
  gates: [...]

workflows:                         # New: named DAG workflows
  standard-v2:
    name: standard-v2
    version: 2
    hops:
      - id: implement
        role: backend
      - id: review
        role: architect
        dependsOn: [implement]
        canReject: true
```

Both `workflow` (singular, linear) and `workflows` (plural, DAG map) coexist in `project.yaml`.

### 8.3 Gate-to-DAG Conversion Utility

A CLI command (`aof workflow convert`) converts linear gate workflows to equivalent DAGs:
- Each gate becomes a hop
- Each hop (except the first) gets `dependsOn: [previousHop]`
- `canReject`, `when`, `timeout`, `escalateTo` carry over directly
- `rejectionStrategy: "origin"` maps to `rejectTo` on the first hop

---

## 9. Scalability Considerations

| Concern | At 10 tasks | At 100 tasks | At 1000 tasks |
|---------|------------|-------------|---------------|
| DAG evaluation per poll | ~1ms | ~10ms | ~100ms (pure function, fast) |
| Frontmatter size | Negligible | Negligible | ~3KB per task (10-hop DAGs) |
| Ready hop scanning | Trivial | Linear scan of dagState | Consider index if needed |
| Event log volume | +5 events/task | +50 events | +500 events (rotation handles this) |

The filesystem store caps at ~1000 active tasks before directory scanning becomes a concern. DAG evaluation adds negligible overhead compared to the existing poll cycle (which already reads all task files).

---

## Sources

- **Direct source code analysis**: All files listed in Section 1.4 (PRIMARY source, HIGH confidence)
- **Existing design doc**: `/Users/xavier/Projects/aof/docs/dev/workflow-gates-design.md` (HIGH confidence)
- **PROJECT.md**: `/Users/xavier/Projects/aof/.planning/PROJECT.md` (HIGH confidence, project constraints)
- **Existing DAG test**: `/Users/xavier/Projects/aof/src/dispatch/__tests__/dag-gating.test.ts` (inter-task dependency tests, not intra-task DAG)
