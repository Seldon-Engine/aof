/**
 * Assign helpers — extracted onRunComplete logic from assign-executor.ts.
 *
 * Contains handleRunComplete() which handles the three outcome paths:
 * 1. Agent-transitioned (already completed): trace + callbacks
 * 2. Enforcement (agent exited without completing): transitions + trace + callbacks
 * 3. Task not found: early return
 */

import { join } from "node:path";
import { createLogger } from "../logging/index.js";
import { serializeTask } from "../store/task-store.js";
import writeFileAtomic from "write-file-atomic";
import { trackDispatchFailure, shouldTransitionToDeadletter, transitionToDeadletter } from "./failure-tracker.js";
import { stopLeaseRenewal } from "./lease-manager.js";
import { captureTraceSafely } from "./trace-helpers.js";
import { deliverAllCallbacksSafely } from "./callback-helpers.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import type { GatewayAdapter } from "./executor.js";
import type { AgentRunOutcome } from "./executor.js";
import type { DispatchConfig, SchedulerAction } from "./types.js";
import type { Task } from "../schemas/task.js";

const log = createLogger("assign-helpers");

/** Context bundle for handleRunComplete — captures closure variables from executeAssignAction. */
export interface OnRunCompleteContext {
  action: SchedulerAction;
  store: ITaskStore;
  logger: EventLogger;
  config: DispatchConfig;
  correlationId: string;
  effectiveConcurrencyLimitRef: { value: number | null };
  allTasks: Task[];
  /** The executor, captured before closure to preserve type narrowing. */
  executor: GatewayAdapter;
}

/**
 * Handle agent run completion — extracted from the inline onRunComplete callback.
 *
 * Three paths:
 * 1. Task already transitioned by agent -> capture trace + deliver callbacks
 * 2. Task still in-progress (enforcement) -> transition to blocked/deadletter, trace + callbacks
 * 3. Task not found -> early return
 */
export async function handleRunComplete(
  ctx: OnRunCompleteContext,
  outcome: AgentRunOutcome,
): Promise<void> {
  const { action, store, logger, config, correlationId, executor } = ctx;

  // Always stop lease renewal -- the agent is done regardless of outcome
  stopLeaseRenewal(store, action.taskId);

  // Re-read task to check current status
  const currentTask = await store.get(action.taskId);
  if (!currentTask) return;

  // Path 1: Agent already transitioned the task (called aof_task_complete)
  if (currentTask.frontmatter.status !== "in-progress") {
    await captureTraceSafely({
      taskId: action.taskId,
      sessionId: outcome.sessionId,
      agentId: action.agent,
      durationMs: outcome.durationMs,
      store,
      logger,
      currentTask,
    });

    await deliverAllCallbacksSafely({
      taskId: action.taskId,
      store,
      executor,
      logger,
    });

    return;
  }

  // Path 2: Enforcement — agent finished without calling aof_task_complete
  const enforcementReason = outcome.success
    ? `Task failed: agent exited without calling aof_task_complete. Session lasted ${(outcome.durationMs / 1000).toFixed(1)}s. Run \`aof trace ${action.taskId}\` for session details.`
    : outcome.error
      ? `Agent error: ${outcome.error.kind}: ${outcome.error.message}`
      : outcome.aborted
        ? "Agent run was aborted"
        : "Agent run failed (unknown reason)";

  log.error({ taskId: action.taskId, correlationId, op: "completionEnforcement" }, "task still in-progress after agent completed");

  try {
    // Store enforcement metadata on task
    const taskForMeta = await store.get(action.taskId);
    if (taskForMeta) {
      taskForMeta.frontmatter.metadata = {
        ...taskForMeta.frontmatter.metadata,
        enforcementReason,
        enforcementAt: new Date().toISOString(),
      };
      const serialized = serializeTask(taskForMeta);
      const metaPath = taskForMeta.path ?? join(store.tasksDir, "in-progress", `${action.taskId}.md`);
      await writeFileAtomic(metaPath, serialized);
    }

    // Track dispatch failure (increments counter)
    await trackDispatchFailure(store, action.taskId, enforcementReason);

    // Check deadletter threshold
    const updatedTask = await store.get(action.taskId);
    if (updatedTask && shouldTransitionToDeadletter(updatedTask)) {
      await transitionToDeadletter(store, logger, action.taskId, enforcementReason);
    } else {
      await store.transition(action.taskId, "blocked", { reason: enforcementReason });
    }
  } catch (transitionErr) {
    log.error({ err: transitionErr, taskId: action.taskId, op: "enforcementTransition" }, "enforcement transition failed");
  }

  // Log enforcement event (non-fatal)
  try {
    const updatedTask = await store.get(action.taskId);
    await logger.log("completion.enforcement", "scheduler", {
      taskId: action.taskId,
      payload: {
        agent: action.agent,
        sessionId: outcome.sessionId,
        durationMs: outcome.durationMs,
        correlationId,
        reason: "agent_exited_without_completion",
        dispatchFailures: updatedTask?.frontmatter.metadata.dispatchFailures,
      },
    });
  } catch (err) {
    log.warn({ err, taskId: action.taskId, op: "logCompletionEnforcement" }, "event logger write failed (best-effort)");
  }

  // Trace capture — via safe helper
  const taskForTrace = await store.get(action.taskId);
  await captureTraceSafely({
    taskId: action.taskId,
    sessionId: outcome.sessionId,
    agentId: action.agent,
    durationMs: outcome.durationMs,
    store,
    logger,
    currentTask: taskForTrace ?? undefined,
  });

  // Callback delivery — via safe helper
  await deliverAllCallbacksSafely({
    taskId: action.taskId,
    store,
    executor,
    logger,
  });
}
