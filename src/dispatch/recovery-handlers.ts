/**
 * Recovery action handlers — stale_heartbeat.
 *
 * Extracted from action-executor.ts for domain grouping and independent testability.
 */

import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import { createLogger } from "../logging/index.js";
import type { SchedulerConfig, SchedulerAction } from "./scheduler.js";
import { markRunArtifactExpired, readRunResult } from "../recovery/run-artifacts.js";
import { resolveCompletionTransitions } from "../protocol/completion-utils.js";
import { cascadeOnCompletion } from "./dep-cascader.js";
import type { ActionHandlerResult } from "./action-handler-types.js";

const log = createLogger("recovery-handlers");

/**
 * Handle stale_heartbeat action.
 *
 * Consults run_result.json for deterministic recovery:
 * - No run result: reclaim to ready, mark artifact expired
 * - Run result exists: apply outcome-driven transitions, cascade on done
 * - If adapter available and session ID known, force-complete the session first
 */
export async function handleStaleHeartbeat(
  action: SchedulerAction,
  store: ITaskStore,
  logger: EventLogger,
  config: SchedulerConfig
): Promise<ActionHandlerResult> {
  const staleTask = await store.get(action.taskId);
  if (!staleTask) {
    log.warn({ taskId: action.taskId, op: "staleHeartbeat" }, "stale heartbeat: task not found, skipping");
    return { executed: false, failed: false };
  }

  // Read correlation ID from task metadata for event logging
  const staleCorrelationId = staleTask.frontmatter.metadata?.correlationId as string | undefined;

  // If adapter available and session ID known, use adapter for force-completion
  const staleSessionId = staleTask.frontmatter.metadata?.sessionId as string | undefined;
  if (config.executor && staleSessionId) {
    try {
      await config.executor.forceCompleteSession(staleSessionId);
      log.info({ taskId: action.taskId, sessionId: staleSessionId, op: "forceCompleteSession" }, "force-completed session for stale heartbeat");

      // Log session force-completion event
      try {
        await logger.log("session.force_completed", "scheduler", {
          taskId: action.taskId,
          payload: { sessionId: staleSessionId, correlationId: staleCorrelationId, reason: "stale_heartbeat" },
        });
      } catch (err) {
        log.warn({ err, taskId: action.taskId, op: "eventLog" }, "event logger write failed (best-effort)");
      }
    } catch (err) {
      log.warn({ err, taskId: action.taskId, sessionId: staleSessionId, op: "forceCompleteSession" }, "force-complete session failed");
      // Continue with existing recovery logic even if force-complete fails
    }
  }

  const runResult = await readRunResult(store, action.taskId);
  const fromStatus = staleTask.frontmatter.status;

  if (!runResult) {
    // No run result -> reclaim to ready, mark artifact expired
    await store.transition(action.taskId, "ready", { reason: "stale_heartbeat_reclaim" });
    await markRunArtifactExpired(store, action.taskId, "stale_heartbeat");

    try {
      await logger.logTransition(action.taskId, fromStatus, "ready", "scheduler",
        `Stale heartbeat - no run_result - reclaimed to ready`);
    } catch (err) {
      log.warn({ err, taskId: action.taskId, op: "eventLog" }, "event logger write failed (best-effort)");
    }
  } else {
    // Run result exists -> apply outcome-driven transitions
    const transitions = resolveCompletionTransitions(staleTask, runResult.outcome);

    for (const targetStatus of transitions) {
      await store.transition(action.taskId, targetStatus, {
        reason: `stale_heartbeat_${runResult.outcome}`
      });

      try {
        await logger.logTransition(action.taskId, fromStatus, targetStatus, "scheduler",
          `Stale heartbeat - outcome ${runResult.outcome} - transition to ${targetStatus}`);
      } catch (err) {
        log.warn({ err, taskId: action.taskId, op: "eventLog" }, "event logger write failed (best-effort)");
      }
    }

    if (runResult.outcome === "done") {
      try {
        await cascadeOnCompletion(action.taskId, store, logger);
      } catch (err) {
        log.error({ err, taskId: action.taskId, op: "cascadeOnCompletion" }, "cascade on completion failed");
      }
    }
  }

  return { executed: false, failed: false };
}
