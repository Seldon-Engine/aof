/**
 * Assign helpers — extracted onRunComplete logic from assign-executor.ts.
 *
 * Contains handleRunComplete() which handles the three outcome paths:
 * 1. Agent-transitioned (already completed): trace + callbacks
 * 2. Enforcement (agent exited without completing): transitions + trace + callbacks
 * 3. Task not found: early return
 */

import { createLogger } from "../logging/index.js";
import { trackDispatchFailure, shouldTransitionToDeadletter, transitionToDeadletter } from "./failure-tracker.js";
import { classifySpawnError, isLikelyModelSilentFailure } from "./scheduler-helpers.js";
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

  // Path 2: Enforcement — agent finished without calling aof_task_complete.
  //
  // Detect the embedded-run silent-failure mode (clean meta + short run)
  // BEFORE composing the enforcement message: OpenClaw's runEmbeddedPiAgent
  // swallows `incomplete turn detected: payloads=0` (model returned HTTP 200
  // with stop_reason="stop" and zero content) and returns clean meta to us.
  // Without detection, the task gets the generic "agent exited without
  // calling aof_task_complete" treatment and burns the dispatchFailures
  // budget while the model is silently producing nothing.
  // See .planning/debug/2026-05-02-embedded-run-empty-response-and-error-propagation.md
  const silentModelFailure = !!outcome.success && isLikelyModelSilentFailure(outcome);

  const enforcementReason = silentModelFailure
    ? `Likely model silent failure: agent run completed cleanly in ${(outcome.durationMs / 1000).toFixed(1)}s without invoking aof_task_complete. The model probably returned an empty completion (stop_reason="stop", zero content); OpenClaw's embedded runner does not propagate this as an error. Deadlettered on first occurrence — retrying a silently-failing model is wasted work.`
    : outcome.success
      ? `Task failed: agent exited without calling aof_task_complete. Session lasted ${(outcome.durationMs / 1000).toFixed(1)}s. Run \`aof trace ${action.taskId}\` for session details.`
      : outcome.error
        ? `Agent error: ${outcome.error.kind}: ${outcome.error.message}`
        : outcome.aborted
          ? "Agent run was aborted"
          : "Agent run failed (unknown reason)";

  // Classify the failure for the deadletter decision in shouldTransitionToDeadletter.
  // - permanent: deterministic config errors (credentials, agent-not-found) — see
  //   .planning/debug/2026-04-28-aof-dispatch-ghosting-and-worker-hygiene.md
  // - model_silent_failure: NEW — OpenClaw embedded-run swallowed an empty completion
  //   (see Phase 49E-7). Both classes deadletter on first occurrence.
  const errorClass = silentModelFailure
    ? "model_silent_failure"
    : outcome.error
      ? classifySpawnError(outcome.error.message)
      : undefined;

  if (silentModelFailure) {
    log.error(
      {
        taskId: action.taskId,
        correlationId,
        durationMs: outcome.durationMs,
        sessionId: outcome.sessionId,
        op: "silentModelFailure",
      },
      "embedded-run silent-failure detected — deadlettering immediately",
    );
  } else {
    log.error({ taskId: action.taskId, correlationId, op: "completionEnforcement" }, "task still in-progress after agent completed");
  }

  try {
    // Store enforcement metadata on task
    const taskForMeta = await store.get(action.taskId);
    if (taskForMeta) {
      taskForMeta.frontmatter.metadata = {
        ...taskForMeta.frontmatter.metadata,
        enforcementReason,
        enforcementAt: new Date().toISOString(),
        ...(errorClass && { errorClass }),
      };
      await store.save(taskForMeta);
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
