/**
 * Alert action handlers — alert, block, sla_violation, murmur_create_task.
 *
 * Extracted from action-executor.ts for domain grouping and independent testability.
 */

import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import { createLogger } from "../logging/index.js";
import type { SchedulerConfig, SchedulerAction } from "./types.js";
import type { ActionHandlerResult } from "./action-handler-types.js";

const log = createLogger("alert-handlers");

/**
 * Handle alert action — log scheduler alert event.
 */
export async function handleAlert(
  action: SchedulerAction,
  logger: EventLogger
): Promise<ActionHandlerResult> {
  log.warn({ taskId: action.taskId, actionType: action.type, reason: action.reason }, "scheduler alert");
  try {
    await logger.log("scheduler_alert", "scheduler", {
      taskId: action.taskId,
      payload: {
        agent: action.agent,
        reason: action.reason,
      },
    });
  } catch (err) {
    log.warn({ err, taskId: action.taskId, op: "eventLog" }, "event logger write failed (best-effort)");
  }
  return { executed: false, failed: false };
}

/**
 * Handle block action — transition task to blocked status.
 */
export async function handleBlock(
  action: SchedulerAction,
  store: ITaskStore,
  logger: EventLogger
): Promise<ActionHandlerResult> {
  await store.transition(action.taskId, "blocked", {
    reason: action.reason,
    blockers: action.blockers,
  });
  try {
    await logger.logTransition(action.taskId, "ready", "blocked", "scheduler",
      action.reason);
  } catch (err) {
    log.warn({ err, taskId: action.taskId, op: "eventLog" }, "event logger write failed (best-effort)");
  }
  return { executed: false, failed: false };
}

/**
 * Handle sla_violation action — log SLA violation event and emit alert if not rate-limited.
 */
export async function handleSlaViolation(
  action: SchedulerAction,
  logger: EventLogger,
  config: SchedulerConfig
): Promise<ActionHandlerResult> {
  // Log to events.jsonl
  try {
    await logger.log("sla.violation", "scheduler", {
      taskId: action.taskId,
      payload: {
        duration: action.duration,
        limit: action.limit,
        agent: action.agent,
        timestamp: Date.now(),
      },
    });
  } catch (err) {
    log.warn({ err, taskId: action.taskId, op: "eventLog" }, "event logger write failed (best-effort)");
  }

  // Emit alert if not rate-limited
  if (action.reason?.includes("alert will be sent")) {
    config.slaChecker?.recordAlert(action.taskId);

    const durationHrs = ((action.duration ?? 0) / 3600000).toFixed(1);
    const limitHrs = ((action.limit ?? 0) / 3600000).toFixed(1);

    log.error({ taskId: action.taskId, taskTitle: action.taskTitle, durationHrs, limitHrs, agent: action.agent ?? "unassigned" }, "SLA violation: check if agent is stuck or task needs SLA override");
  }
  return { executed: false, failed: false };
}

/**
 * Handle murmur_create_task action — log murmur task creation event.
 */
export async function handleMurmurCreateTask(
  action: SchedulerAction,
  logger: EventLogger
): Promise<ActionHandlerResult> {
  try {
    log.info({ taskId: action.taskId, sourceTaskId: action.sourceTaskId, op: "murmurCreateTask" }, "murmur orchestration: creating review task");
    await logger.log("murmur_task_created", "scheduler", {
      taskId: action.taskId,
      payload: {
        sourceTaskId: action.sourceTaskId,
        murmurCandidateId: action.murmurCandidateId,
        agent: action.agent,
      },
    });
    return { executed: false, failed: false };
  } catch (err) {
    const error = err as Error;
    log.error({ err: error, sourceTaskId: action.sourceTaskId, op: "murmurCreateTask" }, "failed to create murmur review task");
    return { executed: false, failed: true };
  }
}
