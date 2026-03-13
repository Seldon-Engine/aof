/**
 * Action execution orchestrator for scheduler.
 *
 * Delegates each action type to domain-grouped handler modules
 * (lifecycle, recovery, alerts) and tracks execution statistics.
 */

import type { Task } from "../schemas/task.js";
import type { ITaskStore } from "../store/interfaces.js";
import { EventLogger } from "../events/logger.js";
import { createLogger } from "../logging/index.js";
import type { SchedulerConfig, SchedulerAction } from "./scheduler.js";
import { handleExpireLease, handlePromote, handleRequeue, handleDeadletter, handleAssign } from "./lifecycle-handlers.js";
import { handleStaleHeartbeat } from "./recovery-handlers.js";
import { handleAlert, handleBlock, handleSlaViolation, handleMurmurCreateTask } from "./alert-handlers.js";

const log = createLogger("action-executor");

export interface ActionExecutionStats {
  actionsExecuted: number;
  actionsFailed: number;
  leasesExpired: number;
  tasksRequeued: number;
  tasksPromoted: number;
  updatedConcurrencyLimit: number | null;
}

/**
 * Execute scheduler actions.
 *
 * Processes actions in sequence, delegating each type to its handler module
 * and accumulating execution statistics.
 */
export async function executeActions(
  actions: SchedulerAction[],
  allTasks: Task[],
  store: ITaskStore,
  logger: EventLogger,
  config: SchedulerConfig,
  effectiveConcurrencyLimitRef: { value: number | null },
  metrics?: import("../metrics/exporter.js").AOFMetrics
): Promise<ActionExecutionStats> {
  let actionsExecuted = 0;
  let actionsFailed = 0;
  let leasesExpired = 0;
  let tasksRequeued = 0;
  let tasksPromoted = 0;

  if (!config.dryRun) {
    for (const action of actions) {
      try {
        let executed = false;
        let failed = false;

        switch (action.type) {
          case "expire_lease": {
            const r = await handleExpireLease(action, store, logger, allTasks, config);
            leasesExpired += r.leasesExpired ?? 0;
            tasksRequeued += r.tasksRequeued ?? 0;
            break;
          }
          case "stale_heartbeat": {
            await handleStaleHeartbeat(action, store, logger, config);
            break;
          }
          case "requeue": {
            await handleRequeue(action, store, logger);
            break;
          }
          case "promote": {
            const r = await handlePromote(action, store, logger);
            tasksPromoted += r.tasksPromoted ?? 0;
            break;
          }
          case "assign": {
            const r = await handleAssign(action, store, logger, config, allTasks, effectiveConcurrencyLimitRef);
            executed = r.executed;
            failed = r.failed;
            break;
          }
          case "deadletter": {
            await handleDeadletter(action, store, logger);
            break;
          }
          case "alert": {
            await handleAlert(action, logger);
            break;
          }
          case "block": {
            await handleBlock(action, store, logger);
            break;
          }
          case "sla_violation": {
            await handleSlaViolation(action, logger, config);
            break;
          }
          case "murmur_create_task": {
            const r = await handleMurmurCreateTask(action, logger);
            failed = r.failed;
            break;
          }
          default:
            log.warn({ actionType: (action as SchedulerAction).type, taskId: action.taskId }, "unknown action type");
            failed = true;
        }

        if (executed) actionsExecuted++;
        if (failed) actionsFailed++;
      } catch (err) {
        const error = err as Error;
        log.error({ err: error, taskId: action.taskId, actionType: action.type, op: "executeAction" }, "failed to execute action");
        try {
          await logger.log("scheduler_action_failed", "scheduler", {
            taskId: action.taskId,
            payload: { type: action.type, error: error.message },
          });
        } catch (logErr) {
          log.warn({ err: logErr, taskId: action.taskId, op: "eventLog" }, "event logger write failed (best-effort)");
        }
        actionsFailed++;
      }
    }
  }

  return {
    actionsExecuted,
    actionsFailed,
    leasesExpired,
    tasksRequeued,
    tasksPromoted,
    updatedConcurrencyLimit: effectiveConcurrencyLimitRef.value,
  };
}
