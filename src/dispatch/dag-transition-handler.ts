/**
 * DAG transition handler — orchestrates DAG evaluation, state persistence,
 * and hop dispatch within DAG-based task workflows.
 *
 * Two exported functions:
 * - handleDAGHopCompletion: processes a hop completion/failure, evaluates DAG,
 *   persists state atomically, and returns ready hops for dispatch.
 * - dispatchDAGHop: builds hop context, spawns agent session, and updates
 *   hop state to dispatched only on success.
 *
 * Design decisions:
 * - Hop state is set to dispatched ONLY after spawnSession succeeds
 * - Run result notes/data become the hop's result field
 * - State is persisted atomically via write-file-atomic
 * - Zero changes to gate path (independent code paths)
 *
 * @module dag-transition-handler
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "../logging/index.js";
import type {
  WorkflowDefinition,
  WorkflowState,
} from "../schemas/workflow-dag.js";
import {
  evaluateDAG,
  type DAGEvaluationInput,
  type HopEvent,
  type EvalContext,
} from "./dag-evaluator.js";
import { buildHopContext } from "./dag-context-builder.js";
import { serializeTask } from "../store/task-store.js";
import writeFileAtomic from "write-file-atomic";
import type { Task } from "../schemas/task.js";
import type { TaskContext, GatewayAdapter } from "./executor.js";
import type { EventLogger } from "../events/logger.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { RunResult } from "../schemas/run-result.js";
import { trackDispatchFailure, shouldTransitionToDeadletter, transitionToDeadletter } from "./failure-tracker.js";
import { captureTrace } from "../trace/trace-writer.js";

const log = createLogger("dag-transition");

// ---------------------------------------------------------------------------
// Result Types
// ---------------------------------------------------------------------------

/**
 * Result of handling a DAG hop completion.
 */
export interface DAGHopCompletionResult {
  /** Hop IDs that became ready and can be dispatched. */
  readyHops: string[];
  /** Whether the entire DAG has reached a terminal state. */
  dagComplete: boolean;
  /** Whether the completed hop requires human review before advancing. */
  reviewRequired: boolean;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Find the currently dispatched hop in workflow state.
 *
 * @param task - Task with workflow frontmatter
 * @returns Hop ID of the dispatched hop, or undefined if none found
 */
function findDispatchedHop(task: Task): string | undefined {
  const hops = task.frontmatter.workflow?.state.hops;
  if (!hops) return undefined;

  for (const [hopId, hopState] of Object.entries(hops)) {
    if (hopState.status === "dispatched") return hopId;
  }
  return undefined;
}

/**
 * Map a RunResult to a HopEvent for DAG evaluation.
 *
 * - done outcome -> complete
 * - needs_review + canReject -> rejected
 * - needs_review + !canReject -> complete (reviewer cannot reject)
 * - Any other outcome -> failed
 * - Notes become the hop result field
 *
 * @param runResult - Agent run result
 * @param hopId - Hop ID the run result corresponds to
 * @param hopDef - Hop definition (needed for canReject check)
 * @returns HopEvent for evaluateDAG
 */
function mapRunResultToHopEvent(
  runResult: RunResult,
  hopId: string,
  hopDef?: { canReject?: boolean },
): HopEvent {
  let outcome: HopEvent["outcome"];

  if (runResult.outcome === "done") {
    outcome = "complete";
  } else if (runResult.outcome === "needs_review" && hopDef?.canReject) {
    outcome = "rejected";
  } else if (runResult.outcome === "needs_review") {
    outcome = "complete";
  } else {
    outcome = "failed";
  }

  const result = runResult.notes
    ? { notes: runResult.notes }
    : undefined;

  return { hopId, outcome, result };
}

/**
 * Build EvalContext from task frontmatter for DAG evaluation.
 *
 * Collects hop results from all completed hops and task metadata.
 *
 * @param task - Task with workflow frontmatter
 * @returns EvalContext for evaluateDAG
 */
function buildEvalContext(task: Task): EvalContext {
  const workflow = task.frontmatter.workflow!;
  const hopResults: Record<string, Record<string, unknown>> = {};

  for (const [hopId, hopState] of Object.entries(workflow.state.hops)) {
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

/**
 * Persist updated workflow state to task file atomically.
 *
 * @param task - Task object (mutated in-place with new state)
 * @param newState - New WorkflowState to persist
 */
async function persistWorkflowState(
  task: Task,
  newState: WorkflowState,
): Promise<void> {
  task.frontmatter.workflow!.state = newState;
  task.frontmatter.updatedAt = new Date().toISOString();
  await writeFileAtomic(task.path!, serializeTask(task));
}

// ---------------------------------------------------------------------------
// Exported Functions
// ---------------------------------------------------------------------------

/**
 * Handle completion/failure of a DAG hop.
 *
 * Orchestrates the full DAG transition flow:
 * 1. Find the dispatched hop
 * 2. Map run result to HopEvent
 * 3. Build evaluation context
 * 4. Call evaluateDAG
 * 5. Persist new state atomically
 * 6. Log transition event
 * 7. Determine if review is required (autoAdvance=false)
 *
 * @param store - Task store instance
 * @param logger - Event logger
 * @param task - Task with workflow frontmatter
 * @param runResult - Agent run result
 * @returns Ready hops, DAG completion status, and review requirement
 */
export async function handleDAGHopCompletion(
  store: ITaskStore,
  logger: EventLogger,
  task: Task,
  runResult: RunResult,
): Promise<DAGHopCompletionResult> {
  // 1. Find dispatched hop
  const hopId = findDispatchedHop(task);
  if (!hopId) {
    await logger.log("dag.warning", "system", {
      taskId: task.frontmatter.id,
      payload: { message: "No dispatched hop found for completion event" },
    });
    return { readyHops: [], dagComplete: false, reviewRequired: false };
  }

  // 2. Find hop definition for canReject check
  const hopDef = task.frontmatter.workflow!.definition.hops.find(
    (h) => h.id === hopId,
  );

  // 3. Map run result to HopEvent (pass hop definition for rejection awareness)
  const hopEvent = mapRunResultToHopEvent(runResult, hopId, hopDef);

  // 4. Build evaluation context
  const evalContext = buildEvalContext(task);

  // 5. Call evaluateDAG
  const evalResult = evaluateDAG({
    definition: task.frontmatter.workflow!.definition,
    state: task.frontmatter.workflow!.state,
    event: hopEvent,
    context: evalContext,
  });

  // 6. Persist new state atomically
  await persistWorkflowState(task, evalResult.state);

  // 7. Log event — rejection or completion
  if (hopEvent.outcome === "rejected") {
    await logger.log("dag.hop_rejected", runResult.agentId, {
      taskId: task.frontmatter.id,
      payload: {
        hopId,
        rejectionNotes: runResult.notes,
        rejectionCount: evalResult.state.hops[hopId]?.rejectionCount,
        strategy: hopDef?.rejectionStrategy ?? "origin",
        readyHops: evalResult.readyHops,
        changes: evalResult.changes,
      },
    });
  } else {
    await logger.log("dag.hop_completed", runResult.agentId, {
      taskId: task.frontmatter.id,
      payload: {
        hopId,
        outcome: hopEvent.outcome,
        readyHops: evalResult.readyHops,
        dagStatus: evalResult.dagStatus,
        taskStatus: evalResult.taskStatus,
        changes: evalResult.changes,
      },
    });
  }

  // 8. Check autoAdvance for review requirement
  const dagComplete = evalResult.taskStatus !== undefined;
  let reviewRequired = false;

  // Rejection IS the review outcome — reviewRequired=false
  if (hopEvent.outcome === "complete") {
    if (hopDef && !hopDef.autoAdvance) {
      reviewRequired = true;
    }
  }

  return {
    readyHops: evalResult.readyHops,
    dagComplete,
    reviewRequired,
  };
}

/**
 * Dispatch a ready hop to an agent.
 *
 * Builds hop-scoped context, spawns an agent session, and updates hop state
 * to dispatched ONLY after successful spawn. On failure, the hop remains
 * in "ready" state for retry.
 *
 * @param store - Task store instance
 * @param logger - Event logger
 * @param config - Dispatch configuration (spawnTimeoutMs)
 * @param executor - Gateway adapter for spawning sessions
 * @param task - Task with workflow frontmatter
 * @param hopId - ID of the hop to dispatch
 * @returns true if dispatch succeeded, false otherwise
 */
export async function dispatchDAGHop(
  store: ITaskStore,
  logger: EventLogger,
  config: { spawnTimeoutMs?: number },
  executor: GatewayAdapter,
  task: Task,
  hopId: string,
): Promise<boolean> {
  const workflow = task.frontmatter.workflow!;
  const hop = workflow.definition.hops.find((h) => h.id === hopId);
  if (!hop) {
    await logger.log("dag.dispatch_error", "system", {
      taskId: task.frontmatter.id,
      payload: { hopId, error: `Hop "${hopId}" not found in definition` },
    });
    return false;
  }

  // Create per-hop artifact directory before spawn
  const hopWorkDir = join(dirname(task.path!), "work", hopId);
  await mkdir(hopWorkDir, { recursive: true });
  log.info({ hopId, taskId: task.frontmatter.id, hopWorkDir }, "created artifact directory");

  // Build hop-scoped context
  const hopContext = buildHopContext(task, hopId);

  // Build TaskContext with hop context
  const correlationId = randomUUID();
  const context: TaskContext = {
    taskId: task.frontmatter.id,
    taskPath: task.path!,
    agent: hop.role,
    priority: task.frontmatter.priority,
    routing: { role: hop.role },
    projectId: task.frontmatter.project,
    hopContext,
  };

  // Spawn session with enforcement callback
  const spawnResult = await executor.spawnSession(context, {
    timeoutMs: config.spawnTimeoutMs ?? 30_000,
    correlationId,
    onRunComplete: async (outcome) => {
      // Re-read task to get fresh state
      const freshTask = await store.get(task.frontmatter.id);
      if (!freshTask) return;

      // Check if hop is still "dispatched" — if not, agent already completed via protocol
      const hopState = freshTask.frontmatter.workflow?.state.hops[hopId];
      if (!hopState || hopState.status !== "dispatched") {
        // --- Trace capture (Phase 26) --- best-effort, never blocks transitions
        try {
          const traceDebug = freshTask.frontmatter.metadata?.debug === true;
          await captureTrace({
            taskId: task.frontmatter.id,
            sessionId: outcome.sessionId,
            agentId: hop.role,
            durationMs: outcome.durationMs,
            store,
            logger,
            debug: traceDebug,
          });
        } catch (err) {
          log.warn({ err, taskId: task.frontmatter.id, hopId, op: "traceCapture" }, "trace capture failed (best-effort)");
        }
        return;
      }

      // Hop agent exited without calling aof_task_complete — enforcement
      const enforcementReason =
        `DAG hop "${hopId}" failed: agent exited without calling aof_task_complete. ` +
        `Session lasted ${(outcome.durationMs / 1000).toFixed(1)}s. ` +
        `Run \`aof trace ${task.frontmatter.id}\` for details.`;

      log.error({ taskId: task.frontmatter.id, hopId, op: "dagEnforcement" }, enforcementReason);

      try {
        // Track dispatch failure on the parent task
        await trackDispatchFailure(store, task.frontmatter.id, enforcementReason);

        // Check deadletter threshold on parent task
        const updatedTask = await store.get(task.frontmatter.id);
        if (updatedTask && shouldTransitionToDeadletter(updatedTask)) {
          await transitionToDeadletter(store, logger, task.frontmatter.id, enforcementReason);
        } else if (updatedTask?.frontmatter.workflow) {
          // Mark hop as failed in workflow state
          updatedTask.frontmatter.workflow.state.hops[hopId] = {
            ...updatedTask.frontmatter.workflow.state.hops[hopId]!,
            status: "failed",
            completedAt: new Date().toISOString(),
          };
          await persistWorkflowState(updatedTask, updatedTask.frontmatter.workflow.state);
        }

        // Emit enforcement event with hopId
        await logger.log("completion.enforcement", "scheduler", {
          taskId: task.frontmatter.id,
          payload: {
            hopId,
            agent: hop.role,
            sessionId: outcome.sessionId,
            durationMs: outcome.durationMs,
            correlationId,
            reason: "agent_exited_without_completion",
            dispatchFailures: updatedTask?.frontmatter.metadata.dispatchFailures,
          },
        });
      } catch (err) {
        log.error({ err, taskId: task.frontmatter.id, hopId, op: "dagEnforcement" }, "DAG enforcement failed");
      }

      // --- Trace capture (Phase 26) --- best-effort, never blocks transitions
      try {
        const freshTaskForTrace = await store.get(task.frontmatter.id);
        const traceDebug = freshTaskForTrace?.frontmatter.metadata?.debug === true;
        await captureTrace({
          taskId: task.frontmatter.id,
          sessionId: outcome.sessionId,
          agentId: hop.role,
          durationMs: outcome.durationMs,
          store,
          logger,
          debug: traceDebug,
        });
      } catch (err) {
        log.warn({ err, taskId: task.frontmatter.id, hopId, op: "traceCapture" }, "trace capture failed (best-effort)");
      }
    },
  });

  if (!spawnResult.success) {
    // On failure: hop stays "ready" for retry
    await logger.log("dag.dispatch_failed", "system", {
      taskId: task.frontmatter.id,
      payload: {
        hopId,
        error: spawnResult.error,
        correlationId,
      },
    });
    return false;
  }

  // On success: set hop to dispatched and persist atomically
  workflow.state.hops[hopId] = {
    ...workflow.state.hops[hopId]!,
    status: "dispatched",
    startedAt: new Date().toISOString(),
    agent: hop.role,
    correlationId: spawnResult.sessionId,
  };

  await persistWorkflowState(task, workflow.state);

  // Log dispatch event
  await logger.log("dag.hop_dispatched", hop.role, {
    taskId: task.frontmatter.id,
    payload: {
      hopId,
      agent: hop.role,
      sessionId: spawnResult.sessionId,
      correlationId,
    },
  });

  return true;
}
