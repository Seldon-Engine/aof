# Phase 12: Scheduler Integration - Research

**Researched:** 2026-03-03
**Domain:** DAG-based workflow execution integrated into the existing scheduler/protocol router lifecycle
**Confidence:** HIGH

## Summary

Phase 12 wires the pure `evaluateDAG()` function (Phase 11) into the existing scheduler poll cycle and `handleSessionEnd()` completion flow. The scheduler dispatches each DAG hop as an independent OpenClaw session, evaluates the DAG on hop completion, and advances to the next eligible hop. Gate-based tasks remain completely untouched -- DAG code sits alongside the gate code path via a branch on `task.frontmatter.workflow` vs `task.frontmatter.gate`.

The integration is entirely internal to the existing codebase. No new libraries are needed. The patterns are well-established: `gate-transition-handler.ts` provides the exact structural template for a `dag-transition-handler.ts`, `buildGateContext()` provides the pattern for `buildHopContext()`, and `assign-executor.ts` shows how TaskContext is built and passed to `spawnSession()`. The work is pure TypeScript integration: mapping run results to hop events, calling `evaluateDAG()`, persisting state atomically, and dispatching the next hop.

**Primary recommendation:** Create a `dag-transition-handler.ts` module (mirroring `gate-transition-handler.ts`) that orchestrates DAG evaluation and state persistence, then integrate it into `ProtocolRouter.handleSessionEnd()` and the scheduler poll cycle with a simple `workflow` vs `gate` branch.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Hop dispatch mechanics:**
- Agent receives hop-scoped context only: hop ID, hop description, role, upstream hop results from completed predecessors -- no full DAG visibility
- Task stays in-progress for the entire DAG execution; hop-level state is tracked in `workflow.state`, not task status
- Hop's `role` field maps to org chart routing via the same resolution logic used for task routing (role -> agent)
- Hop status set to `dispatched` only after `spawnSession()` succeeds -- if spawn fails, hop stays `ready` for retry on next poll

**Completion-triggered advancement:**
- DAG evaluation happens in `handleSessionEnd()`, alongside existing gate logic -- immediate advancement, poll cycle as fallback
- Run result outcome maps to hop event: agent reports `done` -> hop event `{outcome: 'complete'}`, `blocked`/error -> `{outcome: 'failed'}`; run result notes/data become the hop's `result` field
- When a hop has `autoAdvance: false`, task moves to `review` status; existing review/approval flow resumes DAG evaluation and dispatches next hops
- Hop state changes written via atomic write to task frontmatter (read task, update `workflow.state` with evaluator result, `write-file-atomic`) -- one write per hop event

**Dual-mode gate/DAG routing:**
- Branch point is in both `handleSessionEnd` and poll cycle: check `task.frontmatter.workflow` vs `task.frontmatter.gate` to route to correct evaluator
- Existing gate code (evaluation, timeout checking, gate-related scheduler actions) remains completely untouched -- DAG code sits alongside, zero changes to gate path
- DAG tasks use standard task lifecycle (backlog -> ready -> in-progress); once dispatched (in-progress), scheduler looks at `workflow.state` for ready hops and dispatches the first root hop

**Parallel hop serialization:**
- When `evaluateDAG` returns multiple `readyHops`, dispatch the first one immediately; remaining hops stay in `ready` status for next poll cycle or session_end handler
- Cross-task priority: DAG hop dispatch uses the same priority ordering as existing `buildDispatchActions` -- no special treatment for DAG tasks
- Active hop tracking: hop status map in `workflow.state` is the source of truth -- hop with status `dispatched` is the active one; scheduler checks for no existing `dispatched` hop before dispatching another; no redundant `activeHopId` field

### Claude's Discretion
- Internal structure of hop context injection (how to build TaskContext from hop data)
- Exact placement of DAG evaluation within handleSessionEnd flow
- How to detect "this task is a DAG task" during the poll cycle dispatch path
- Event logging payloads for DAG hop dispatch and advancement
- Error handling for edge cases (e.g., session ends but no matching dispatched hop)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| EXEC-01 | Scheduler dispatches each hop as an independent OpenClaw session (no nesting) | Hop dispatch via `spawnSession()` using `TaskContext` with hop-scoped fields; `dag-transition-handler.ts` builds context from hop definition + upstream results; `assign-executor.ts` pattern for lease acquisition and spawn |
| EXEC-02 | On hop completion, scheduler evaluates DAG graph and advances eligible next hops | `handleSessionEnd()` reads run result, maps outcome to `HopEvent`, calls `evaluateDAG()`, persists new state, dispatches first ready hop; poll cycle as fallback |
| EXEC-03 | Completion-triggered advancement dispatches next hop immediately (poll cycle as fallback) | DAG evaluation in `handleSessionEnd()` provides immediate path; poll cycle checks in-progress DAG tasks for ready hops with no dispatched hop |
| EXEC-06 | Parallel-eligible hops dispatch in sequence without blocking each other | When `evaluateDAG()` returns multiple `readyHops`, dispatch first one; remaining stay `ready` for next cycle; enforced by "no dispatched hop exists" invariant check |
| SAFE-02 | Existing gate-based tasks coexist with DAG tasks via dual-mode evaluator | Branch on `task.frontmatter.workflow` vs `task.frontmatter.gate` at both `handleSessionEnd()` and poll cycle entry points; existing gate code completely untouched |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | (existing) | Implementation language | Project standard |
| Zod | (existing) | Schema validation for workflow state | Already used for all schemas |
| write-file-atomic | (existing) | Crash-safe frontmatter persistence | Already imported in router.ts, assign-executor.ts |
| vitest | (existing) | Test framework | Project standard, configured in vitest.config.ts |

### Supporting
No new libraries needed. All functionality is internal integration of existing modules.

### Alternatives Considered
None. This phase is pure integration of existing codebase components. No external dependencies required.

**Installation:**
```bash
# No new packages needed
```

## Architecture Patterns

### Recommended Project Structure
```
src/dispatch/
├── dag-evaluator.ts           # (Phase 11 - exists) Pure evaluation function
├── dag-condition-evaluator.ts # (Phase 11 - exists) Condition expression interpreter
├── dag-transition-handler.ts  # NEW: Orchestrates DAG eval + state persistence (mirrors gate-transition-handler.ts)
├── dag-context-builder.ts     # NEW: Builds hop-scoped TaskContext (mirrors gate-context-builder.ts)
├── gate-evaluator.ts          # (exists) Pure gate evaluation - UNTOUCHED
├── gate-transition-handler.ts # (exists) Gate orchestration - UNTOUCHED
├── gate-context-builder.ts    # (exists) Gate context injection - UNTOUCHED
├── scheduler.ts               # MODIFIED: Poll cycle adds DAG-aware hop dispatch
├── task-dispatcher.ts         # POSSIBLY MODIFIED: DAG hop dispatch actions alongside regular task dispatch
├── assign-executor.ts         # POSSIBLY MODIFIED: Inject hop context into TaskContext before spawnSession
├── action-executor.ts         # POSSIBLY MODIFIED: Handle DAG hop dispatch action type
├── index.ts                   # MODIFIED: Export new DAG integration types
└── __tests__/
    ├── dag-transition-handler.test.ts  # NEW
    ├── dag-context-builder.test.ts     # NEW
    └── dag-scheduler-integration.test.ts # NEW
src/protocol/
├── router.ts                  # MODIFIED: handleSessionEnd() adds DAG branch
└── router-helpers.ts          # Possibly extended for DAG completion outcome
src/schemas/
└── index.ts                   # MODIFIED: Export any new DAG types
```

### Pattern 1: DAG Transition Handler (mirrors gate-transition-handler.ts)
**What:** A handler module that orchestrates DAG evaluation and state persistence, analogous to `handleGateTransition()`.
**When to use:** Called from `handleSessionEnd()` and the poll cycle when a DAG hop completes or needs dispatch.

```typescript
// dag-transition-handler.ts — mirrors gate-transition-handler.ts structure
import { evaluateDAG, type DAGEvaluationInput, type HopEvent, type EvalContext } from "./dag-evaluator.js";
import { serializeTask } from "../store/task-store.js";
import writeFileAtomic from "write-file-atomic";
import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import type { Task } from "../schemas/task.js";
import type { RunResult } from "../schemas/run-result.js";

/**
 * Map a RunResult outcome to a HopEvent outcome.
 * done -> complete, blocked/error -> failed
 */
function mapRunResultToHopEvent(
  runResult: RunResult,
  hopId: string
): HopEvent {
  return {
    hopId,
    outcome: runResult.outcome === "done" ? "complete" : "failed",
    result: runResult.notes ? { notes: runResult.notes } : undefined,
  };
}

/**
 * Handle DAG hop completion: evaluate DAG, persist state, return ready hops.
 *
 * 1. Read task and find dispatched hop
 * 2. Map run result to hop event
 * 3. Call evaluateDAG() (pure function)
 * 4. Persist new workflow.state atomically
 * 5. Handle DAG completion (task -> done/failed)
 * 6. Return ready hops for dispatch
 */
export async function handleDAGHopCompletion(
  store: ITaskStore,
  logger: EventLogger,
  task: Task,
  runResult: RunResult,
): Promise<{ readyHops: string[]; dagComplete: boolean }> {
  // ... implementation follows gate-transition-handler.ts pattern
}
```

### Pattern 2: Hop Context Builder (mirrors gate-context-builder.ts)
**What:** Builds hop-scoped context for agent dispatch. Progressive disclosure: agent sees only their hop's role, description, and upstream results.
**When to use:** When dispatching a DAG hop via `spawnSession()`.

```typescript
// dag-context-builder.ts — mirrors gate-context-builder.ts
export interface HopContext {
  /** Hop ID being dispatched. */
  hopId: string;
  /** Human-readable description of the hop's purpose. */
  description?: string;
  /** Role this hop expects (e.g., "swe-backend"). */
  role: string;
  /** Results from completed predecessor hops. */
  upstreamResults: Record<string, Record<string, unknown>>;
  /** Whether this hop auto-advances or requires review. */
  autoAdvance: boolean;
}

export function buildHopContext(
  task: Task,
  hopId: string,
  definition: WorkflowDefinition,
  state: WorkflowState,
): HopContext {
  // Find hop definition, gather upstream results from completed predecessors
}
```

### Pattern 3: Dual-Mode Routing in handleSessionEnd
**What:** A simple branch that checks whether an in-progress task has `workflow` (DAG) or `gate` (linear) frontmatter and routes to the correct evaluator.
**When to use:** In `ProtocolRouter.handleSessionEnd()` and the scheduler poll cycle.

```typescript
// In handleSessionEnd() — the dual-mode branch
for (const task of inProgress) {
  const runResult = await readRunResult(this.store, task.frontmatter.id);
  if (!runResult) continue;

  if (task.frontmatter.workflow) {
    // DAG path: evaluate DAG, dispatch next hop
    await handleDAGHopCompletion(this.store, this.logger, task, runResult);
  } else {
    // Gate path (existing code, UNTOUCHED)
    await applyCompletionOutcome(task, { ... }, this.store, this.logger, this.notifier);
  }
}
```

### Pattern 4: DAG-Aware Poll Cycle Dispatch
**What:** During the poll cycle, check in-progress DAG tasks for ready hops with no currently dispatched hop, and dispatch one.
**When to use:** After the regular task dispatch in `scheduler.ts` poll function.

```typescript
// In poll() — after buildDispatchActions for regular tasks
// Check DAG tasks for ready hops that need dispatch
const inProgressTasks = allTasks.filter(t => t.frontmatter.status === "in-progress");
for (const task of inProgressTasks) {
  if (!task.frontmatter.workflow) continue;

  const state = task.frontmatter.workflow.state;
  const hasDispatched = Object.values(state.hops).some(h => h.status === "dispatched");
  if (hasDispatched) continue; // One hop at a time

  const readyHops = Object.entries(state.hops)
    .filter(([, h]) => h.status === "ready")
    .map(([id]) => id);

  if (readyHops.length > 0) {
    // Dispatch first ready hop (using existing dispatch infrastructure)
    await dispatchDAGHop(store, logger, config, task, readyHops[0]);
  }
}
```

### Pattern 5: Hop Dispatch Mechanics
**What:** Dispatching a hop involves: setting hop to `dispatched`, resolving role to agent, building TaskContext with hop context, calling `spawnSession()`, and handling success/failure.
**When to use:** Both immediate dispatch (from handleSessionEnd) and poll-cycle dispatch.

```typescript
async function dispatchDAGHop(
  store: ITaskStore,
  logger: EventLogger,
  config: SchedulerConfig,
  task: Task,
  hopId: string,
): Promise<boolean> {
  const definition = task.frontmatter.workflow!.definition;
  const hop = definition.hops.find(h => h.id === hopId)!;

  // Build TaskContext with hop context injection
  const context: TaskContext = {
    taskId: task.frontmatter.id,
    taskPath: task.path!,
    agent: hop.role, // Role → agent resolution via existing routing logic
    priority: task.frontmatter.priority,
    routing: { role: hop.role },
    projectId: task.frontmatter.project,
    // hopContext injected here (new field on TaskContext)
  };

  const result = await config.executor!.spawnSession(context, { ... });

  if (result.success) {
    // Set hop to "dispatched" and persist
    task.frontmatter.workflow!.state.hops[hopId] = {
      ...task.frontmatter.workflow!.state.hops[hopId]!,
      status: "dispatched",
      startedAt: new Date().toISOString(),
      agent: hop.role,
      correlationId: result.sessionId,
    };
    // Atomic write
    await writeFileAtomic(task.path!, serializeTask(task));
    return true;
  } else {
    // Hop stays "ready" for retry on next poll
    return false;
  }
}
```

### Anti-Patterns to Avoid
- **Modifying gate code:** The gate evaluator, gate transition handler, and gate context builder must remain completely untouched. DAG code sits alongside, never modifies.
- **Nesting sessions:** Each hop is an independent OpenClaw session. No nesting, no child sessions.
- **Tracking hop state outside frontmatter:** The hop status map in `workflow.state` is the single source of truth. No separate state store, no `activeHopId` field.
- **Dispatching multiple hops simultaneously:** OpenClaw constraint means one session at a time. Even if `evaluateDAG()` returns multiple `readyHops`, dispatch only the first; rest wait for next cycle.
- **Changing task status during DAG execution:** Task stays `in-progress` for the entire DAG. Only moves to `done`/`failed` when DAG completes, or `review` for `autoAdvance: false` hops.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| DAG state transitions | Custom state machine | `evaluateDAG()` from Phase 11 | Pure function handles all edge cases: skip cascade, condition evaluation, join types, completion detection |
| Atomic file writes | Manual file operations | `write-file-atomic` | Already used throughout codebase; handles crash safety |
| Task serialization | Custom YAML writing | `serializeTask()` from `task-store.ts` | Handles frontmatter + body format correctly |
| Session spawning | Direct executor calls | `spawnSession()` via `GatewayAdapter` | Handles timeout, correlation ID, error classification |
| Run result reading | Custom file parsing | `readRunResult()` from `run-artifacts.ts` | Already handles missing files, JSON parsing |
| Role resolution | New routing logic | Existing `routing.role -> agent` resolution | Same routing logic used for gate tasks |

**Key insight:** This phase is pure integration -- connecting existing pure functions (`evaluateDAG`) to existing infrastructure (`spawnSession`, `writeFileAtomic`, `readRunResult`). Every building block already exists.

## Common Pitfalls

### Pitfall 1: Race Condition on Hop State Persistence
**What goes wrong:** Two code paths (handleSessionEnd + poll cycle) both try to update `workflow.state` concurrently, causing lost updates.
**Why it happens:** `handleSessionEnd()` evaluates DAG and dispatches next hop while poll cycle also checks for ready hops.
**How to avoid:** Use the existing `TaskLockManager` (already used in `ProtocolRouter` for concurrent message handling). The `lockManager.withLock(taskId, ...)` pattern serializes access to a single task. Also, the "one dispatched hop at a time" invariant naturally prevents most conflicts -- if a hop is `dispatched`, poll cycle skips the task.
**Warning signs:** Two hops dispatched simultaneously for the same task; hop state reverts to a previous value.

### Pitfall 2: Forgetting to Handle the "No Dispatched Hop Found" Edge Case
**What goes wrong:** `handleSessionEnd()` finds a DAG task with a run result but no hop has `dispatched` status (e.g., session ended after crash recovery reset hop state).
**Why it happens:** Crash recovery reclaims tasks, or race between session end and poll cycle dispatch.
**How to avoid:** Defensive check: if no hop is `dispatched`, log a warning and skip DAG evaluation. The poll cycle will pick up ready hops on the next pass.
**Warning signs:** Error logs about "no dispatched hop found for DAG task".

### Pitfall 3: Task Status vs Hop Status Confusion
**What goes wrong:** Code incorrectly transitions task status (e.g., to `ready` or `blocked`) during DAG execution when only the hop status should change.
**Why it happens:** Existing patterns for non-DAG tasks transition task status on completion/failure. DAG tasks should stay `in-progress` throughout.
**How to avoid:** DAG completion handler should only change task status when `evaluateDAG()` returns a `taskStatus` (i.e., DAG is complete/failed). For hop-level failures, only the hop status changes. Exception: `autoAdvance: false` hops move task to `review`.
**Warning signs:** DAG task bouncing between `in-progress` and `ready` during execution.

### Pitfall 4: Orphaned DAG Tasks After Crash
**What goes wrong:** Daemon restarts, `reconcileOrphans()` transitions DAG task from `in-progress` to `ready`, but the DAG has hops in `dispatched` state with no active session.
**Why it happens:** The existing orphan reconciliation doesn't know about DAG state.
**How to avoid:** Two options: (a) during orphan reconciliation, detect DAG tasks and reset `dispatched` hops back to `ready`; or (b) rely on poll cycle to detect the inconsistency (in-progress task with dispatched hop but no active session) and handle recovery. Option (a) is cleaner.
**Warning signs:** DAG task stuck in `in-progress` with a `dispatched` hop that never completes.

### Pitfall 5: Incorrect Run Result to Hop ID Mapping
**What goes wrong:** `handleSessionEnd()` reads a run result for a DAG task but can't determine which hop the run result belongs to.
**Why it happens:** Run results are keyed by task ID, not hop ID. Multiple hops on the same task share the same run result path.
**How to avoid:** The dispatched hop can be identified from the hop status map -- exactly one hop should have status `dispatched`. If using correlation IDs, store the hop ID alongside the session/correlation ID in the hop state so it can be matched back.
**Warning signs:** Wrong hop getting the completion event.

### Pitfall 6: autoAdvance: false Breaks DAG Flow
**What goes wrong:** A hop with `autoAdvance: false` moves the task to `review`, but when the review completes and task returns to `in-progress`, the scheduler doesn't know to re-evaluate the DAG.
**Why it happens:** The review -> approval -> resume flow doesn't call DAG evaluation.
**How to avoid:** When a DAG task transitions back from `review` to `in-progress` (via approval), trigger DAG re-evaluation. This can be done in the poll cycle by checking for ready hops on in-progress DAG tasks. The poll cycle already handles this case -- it just needs to dispatch the next ready hop.
**Warning signs:** DAG task stuck in `in-progress` after review approval with ready hops that never get dispatched.

## Code Examples

### Example 1: Finding the Dispatched Hop
```typescript
/**
 * Find the currently dispatched hop for a DAG task.
 * Returns undefined if no hop is dispatched (edge case / recovery).
 */
function findDispatchedHop(task: Task): string | undefined {
  const state = task.frontmatter.workflow?.state;
  if (!state) return undefined;

  const entry = Object.entries(state.hops).find(
    ([, hopState]) => hopState.status === "dispatched"
  );
  return entry?.[0];
}
```

### Example 2: Detecting DAG vs Gate Tasks
```typescript
/**
 * Check if a task uses DAG workflow (not gate workflow).
 * Used at branch points in handleSessionEnd and poll cycle.
 */
function isDAGTask(task: Task): boolean {
  return task.frontmatter.workflow !== undefined
    && task.frontmatter.workflow !== null;
}

function isGateTask(task: Task): boolean {
  return task.frontmatter.gate !== undefined
    && task.frontmatter.gate !== null;
}
```

### Example 3: Building EvalContext from Task
```typescript
/**
 * Build EvalContext for evaluateDAG() from task frontmatter.
 */
function buildEvalContext(task: Task): EvalContext {
  const state = task.frontmatter.workflow!.state;

  // Collect hop results from completed hops
  const hopResults: Record<string, Record<string, unknown>> = {};
  for (const [hopId, hopState] of Object.entries(state.hops)) {
    if (hopState.result) {
      hopResults[hopId] = hopState.result;
    }
  }

  return {
    hopResults,
    task: {
      status: task.frontmatter.status,
      tags: task.frontmatter.routing.tags ?? [],
      priority: task.frontmatter.priority,
      routing: task.frontmatter.routing as Record<string, unknown>,
    },
  };
}
```

### Example 4: Atomic Workflow State Persistence
```typescript
/**
 * Persist updated workflow state atomically to task frontmatter.
 * Follows the established pattern from gate-transition-handler.ts.
 */
async function persistWorkflowState(
  task: Task,
  newState: WorkflowState,
): Promise<void> {
  task.frontmatter.workflow = {
    ...task.frontmatter.workflow!,
    state: newState,
  };
  task.frontmatter.updatedAt = new Date().toISOString();

  const filePath = task.path!;
  await writeFileAtomic(filePath, serializeTask(task));
}
```

### Example 5: TaskContext Extension for Hop Context
```typescript
// In executor.ts — extend TaskContext interface
export interface TaskContext {
  // ... existing fields ...

  /** Hop context for DAG workflow tasks (transient, computed on dispatch). */
  hopContext?: HopContext;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Gate-only linear workflows | Gate + DAG dual-mode | Phase 10-12 (v1.2) | Tasks can now use either linear gates or DAG workflows |
| Single evaluator path | Dual-mode evaluator routing | Phase 12 | handleSessionEnd and poll cycle branch on task type |
| GateContext on TaskContext | GateContext + HopContext on TaskContext | Phase 12 | Agent dispatch includes hop-scoped context for DAG tasks |

**Deprecated/outdated:**
- None. Gate workflows remain fully supported alongside DAG workflows.

## Open Questions

1. **TaskContext.hopContext field placement**
   - What we know: `TaskContext` already has `gateContext?: GateContext` for gate workflow tasks. DAG tasks need a similar `hopContext?: HopContext`.
   - What's unclear: Whether `hopContext` should be a new optional field alongside `gateContext`, or whether both should be unified under a generic `workflowContext` field.
   - Recommendation: Add `hopContext?: HopContext` as a separate optional field. This keeps the two paths independent, matches the "zero changes to gate path" constraint, and the `TaskFrontmatter` schema already enforces mutual exclusivity of `gate` and `workflow` fields.

2. **Orphan reconciliation for DAG tasks**
   - What we know: `reconcileOrphans()` in `aof-service.ts` moves all in-progress tasks to `ready` on startup. DAG tasks should stay in-progress (they're in-progress for the whole DAG).
   - What's unclear: Whether to modify `reconcileOrphans()` to detect DAG tasks and handle them differently, or leave it as-is and let the poll cycle sort it out.
   - Recommendation: Modify `reconcileOrphans()` to skip DAG tasks (keep them in-progress) but reset any `dispatched` hops to `ready`. This prevents the DAG from being disrupted by a restart while ensuring the dispatched hop can be re-dispatched on the next poll cycle.

3. **Where exactly to place DAG hop dispatch in the poll cycle**
   - What we know: The poll cycle currently builds dispatch actions for ready tasks, then executes them. DAG hop dispatch is different -- the task is already in-progress; only the hop needs dispatch.
   - What's unclear: Whether DAG hop dispatch should be a new step after regular task dispatch, or integrated into `buildDispatchActions`.
   - Recommendation: Add a separate step after regular task dispatch. DAG hop dispatch operates on in-progress tasks (not ready tasks), so it's conceptually different. A separate `dispatchDAGHops()` function keeps the code clean and avoids polluting the existing dispatch logic.

4. **Handling multiple DAG tasks with ready hops concurrently**
   - What we know: Multiple DAG tasks could each have ready hops. The OpenClaw constraint is one session at a time per the whole system (not per task).
   - What's unclear: Whether the "one session at a time" constraint is per-task or system-wide. The CONTEXT.md says "one dispatched hop at a time" per task, but `buildDispatchActions` already handles cross-task concurrency via `maxConcurrentDispatches`.
   - Recommendation: DAG hop dispatch should respect the same concurrency limits as regular task dispatch. Each DAG task can have one dispatched hop, but multiple DAG tasks can each have a dispatched hop simultaneously (up to `maxConcurrentDispatches`). The existing throttle infrastructure handles this.

## Sources

### Primary (HIGH confidence)
- Codebase analysis of `src/protocol/router.ts` -- `handleSessionEnd()` flow, completion handling pattern
- Codebase analysis of `src/dispatch/gate-transition-handler.ts` -- structural template for DAG equivalent
- Codebase analysis of `src/dispatch/gate-context-builder.ts` -- pattern for hop context injection
- Codebase analysis of `src/dispatch/dag-evaluator.ts` -- Phase 11 pure evaluator API and types
- Codebase analysis of `src/dispatch/assign-executor.ts` -- TaskContext building and spawnSession usage
- Codebase analysis of `src/dispatch/scheduler.ts` -- poll cycle structure and dispatch flow
- Codebase analysis of `src/dispatch/executor.ts` -- GatewayAdapter, TaskContext, SpawnResult interfaces
- Codebase analysis of `src/schemas/workflow-dag.ts` -- WorkflowState, HopState, HopStatus types
- Codebase analysis of `src/schemas/task.ts` -- TaskFrontmatter with `workflow` field, gate/workflow mutual exclusivity
- Codebase analysis of `src/service/aof-service.ts` -- handleSessionEnd delegation, reconcileOrphans

### Secondary (MEDIUM confidence)
- CONTEXT.md decisions -- locked implementation choices from user discussion
- REQUIREMENTS.md -- requirement definitions for EXEC-01 through EXEC-06, SAFE-02

### Tertiary (LOW confidence)
- None. All research is based on direct codebase analysis of existing, working code.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new libraries; pure integration of existing modules
- Architecture: HIGH -- patterns directly mirror existing gate-transition-handler.ts and gate-context-builder.ts; all integration points identified and read
- Pitfalls: HIGH -- derived from analysis of actual code paths and known concurrency patterns in the codebase

**Research date:** 2026-03-03
**Valid until:** 2026-04-03 (stable -- internal integration, no external dependencies)
