/**
 * Lifecycle action handlers — expire_lease, promote, requeue, deadletter, assign.
 *
 * Extracted from action-executor.ts for domain grouping and independent testability.
 */

import type { Task } from "../schemas/task.js";
import type { ITaskStore } from "../store/interfaces.js";
import { serializeTask } from "../store/task-store.js";
import type { EventLogger } from "../events/logger.js";
import { createLogger } from "../logging/index.js";
import type { SchedulerConfig, SchedulerAction } from "./scheduler.js";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { executeAssignAction } from "./assign-executor.js";
import { shouldAllowSpawnFailedRequeue, DEFAULT_MAX_DISPATCH_RETRIES } from "./scheduler-helpers.js";
import { transitionToDeadletter } from "./failure-tracker.js";
import type { ActionHandlerResult } from "./action-handler-types.js";

const log = createLogger("lifecycle-handlers");

/**
 * Handle expire_lease action.
 *
 * Handles lease expiry for in-progress tasks (requeue to ready) and
 * blocked tasks (spawn-failed deadletter/retry, dependency checking).
 * Wraps in lockManager when available for serialization with concurrent protocol messages.
 */
export async function handleExpireLease(
  action: SchedulerAction,
  store: ITaskStore,
  logger: EventLogger,
  allTasks: Task[],
  config: SchedulerConfig
): Promise<ActionHandlerResult> {
  const result: ActionHandlerResult = { executed: false, failed: false, leasesExpired: 0, tasksRequeued: 0 };

  const expireBody = async () => {
    const expiringTask = await store.get(action.taskId);
    if (expiringTask) {
      // Clear the lease first
      expiringTask.frontmatter.lease = undefined;
      const serialized = serializeTask(expiringTask);
      const taskPath = expiringTask.path ?? join(store.tasksDir, expiringTask.frontmatter.status, `${expiringTask.frontmatter.id}.md`);
      await writeFileAtomic(taskPath, serialized);

      // BUG-AUDIT-002: For blocked tasks, check spawn failure + dependencies before requeueing
      if (expiringTask.frontmatter.status === "blocked") {
        const blockReason = expiringTask.frontmatter.metadata?.blockReason as string | undefined;
        const isSpawnFailed = blockReason?.includes("spawn_failed") ?? false;

        if (isSpawnFailed) {
          // Spawn-failed task: use shared guard to prevent infinite retry loop
          const maxRetries = config.maxDispatchRetries ?? DEFAULT_MAX_DISPATCH_RETRIES;
          const guard = shouldAllowSpawnFailedRequeue(expiringTask, maxRetries);

          if (guard.shouldDeadletter) {
            const lastError = (expiringTask.frontmatter.metadata?.lastError as string) ?? blockReason ?? "unknown";
            await transitionToDeadletter(store, logger, action.taskId, lastError);
            try {
              await logger.logTransition(action.taskId, "blocked", "deadletter", "scheduler",
                `Lease expired on spawn-failed task — ${guard.reason}`);
            } catch (err) {
              log.warn({ err, taskId: action.taskId, op: "eventLog" }, "event logger write failed (best-effort)");
            }
          } else if (guard.allow) {
            await store.transition(action.taskId, "ready", {
              reason: "lease_expired_spawn_retry"
            });
            try {
              await logger.logTransition(action.taskId, "blocked", "ready", "scheduler",
                `Lease expired — ${guard.reason}`);
            } catch (err) {
              log.warn({ err, taskId: action.taskId, op: "eventLog" }, "event logger write failed (best-effort)");
            }
          } else {
            // Backoff not elapsed — stay blocked, just clear the lease
            log.info({ taskId: action.taskId, reason: guard.reason, op: "leaseExpiry" }, "lease expired on spawn-failed task, backoff pending");
          }
        } else {
          // Non-spawn-failure blocked task: check dependencies
          const deps = expiringTask.frontmatter.dependsOn ?? [];
          const allDepsResolved = deps.length === 0 || deps.every(depId => {
            const dep = allTasks.find(t => t.frontmatter.id === depId);
            return dep?.frontmatter.status === "done";
          });

          if (allDepsResolved) {
            await store.transition(action.taskId, "ready", {
              reason: "lease_expired_requeue"
            });
            try {
              await logger.logTransition(action.taskId, "blocked", "ready", "scheduler",
                `Lease expired and dependencies satisfied - requeued`);
            } catch (err) {
              log.warn({ err, taskId: action.taskId, op: "eventLog" }, "event logger write failed (best-effort)");
            }
          } else {
            log.warn({ taskId: action.taskId, op: "leaseExpiry" }, "lease expired on blocked task but dependencies not satisfied, staying blocked");
          }
        }
      } else {
        // In-progress task - transition back to ready
        await store.transition(action.taskId, "ready", { reason: "lease_expired" });

        try {
          await logger.logTransition(action.taskId, "in-progress", "ready", "scheduler",
            `Lease expired - task requeued`);
        } catch (err) {
          log.warn({ err, taskId: action.taskId, op: "eventLog" }, "event logger write failed (best-effort)");
        }
      }
      result.leasesExpired = 1;
      result.tasksRequeued = 1;
    }
  };

  if (config.lockManager) {
    await config.lockManager.withLock(action.taskId, expireBody);
  } else {
    await expireBody();
  }

  return result;
}

/**
 * Handle promote action — transition task from backlog to ready.
 */
export async function handlePromote(
  action: SchedulerAction,
  store: ITaskStore,
  logger: EventLogger
): Promise<ActionHandlerResult> {
  await store.transition(action.taskId, "ready", { reason: "dependency_satisfied" });
  try {
    await logger.logTransition(action.taskId, "backlog", "ready", "scheduler",
      action.reason ?? "All dependencies satisfied");
  } catch (err) {
    log.warn({ err, taskId: action.taskId, op: "eventLog" }, "event logger write failed (best-effort)");
  }
  return { executed: false, failed: false, tasksPromoted: 1 };
}

/**
 * Handle requeue action — update metadata and transition blocked task to ready.
 */
export async function handleRequeue(
  action: SchedulerAction,
  store: ITaskStore,
  logger: EventLogger
): Promise<ActionHandlerResult> {
  // BUG-002: Update metadata before transition
  const requeuedTask = await store.get(action.taskId);
  if (requeuedTask) {
    requeuedTask.frontmatter.metadata = {
      ...requeuedTask.frontmatter.metadata,
      lastRequeuedAt: new Date().toISOString(),
      requeueReason: action.reason,
    };

    // Write updated task with metadata before transition
    const serialized = serializeTask(requeuedTask);
    const taskPath = requeuedTask.path ?? join(store.tasksDir, requeuedTask.frontmatter.status, `${requeuedTask.frontmatter.id}.md`);
    await writeFileAtomic(taskPath, serialized);
  }

  await store.transition(action.taskId, "ready", { reason: action.reason });

  try {
    await logger.logTransition(action.taskId, "blocked", "ready", "scheduler", action.reason);
  } catch (err) {
    log.warn({ err, taskId: action.taskId, op: "eventLog" }, "event logger write failed (best-effort)");
  }
  return { executed: false, failed: false };
}

/**
 * Handle deadletter action — transition task to deadletter status.
 */
export async function handleDeadletter(
  action: SchedulerAction,
  store: ITaskStore,
  logger: EventLogger
): Promise<ActionHandlerResult> {
  const lastError = action.reason ?? "unknown";
  await transitionToDeadletter(store, logger, action.taskId, lastError);
  return { executed: false, failed: false };
}

/**
 * Handle assign action — thin delegation to executeAssignAction.
 */
export async function handleAssign(
  action: SchedulerAction,
  store: ITaskStore,
  logger: EventLogger,
  config: SchedulerConfig,
  allTasks: Task[],
  effectiveConcurrencyLimitRef: { value: number | null }
): Promise<ActionHandlerResult> {
  const assignResult = await executeAssignAction(
    action,
    store,
    logger,
    config,
    allTasks,
    effectiveConcurrencyLimitRef
  );
  return { executed: assignResult.executed, failed: assignResult.failed };
}
