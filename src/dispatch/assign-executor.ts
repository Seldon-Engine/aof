/**
 * Assign action executor — handles task assignment and dispatch.
 * 
 * Extracted from task-dispatcher.ts (AOF-m2j) to keep modules under 300 LOC.
 */

import { randomUUID } from "node:crypto";
import type { Task, TaskStatus } from "../schemas/task.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import { createLogger } from "../logging/index.js";
import type { DispatchConfig, SchedulerAction } from "./types.js";
import { acquireLease, releaseLease } from "../store/lease.js";
import { isLeaseActive, startLeaseRenewal } from "./lease-manager.js";
import { updateThrottleState } from "./throttle.js";
import { join, relative } from "node:path";
import { loadProjectManifest } from "../projects/manifest.js";
import type { TaskContext } from "./executor.js";
import { classifySpawnError } from "./scheduler-helpers.js";
import { transitionToDeadletter } from "./failure-tracker.js";
import { handleRunComplete } from "./assign-helpers.js";

const log = createLogger("assign-executor");

export { loadProjectManifest } from "../projects/manifest.js";

/**
 * Execute a single assign action: acquire lease, spawn agent, handle errors.
 */
export async function executeAssignAction(
  action: SchedulerAction,
  store: ITaskStore,
  logger: EventLogger,
  config: DispatchConfig,
  allTasks: Task[]
): Promise<{ executed: boolean; failed: boolean }> {
  if (!config.executor) {
    log.error({ taskId: action.taskId, agent: action.agent, op: "dispatch" }, "cannot dispatch task: no executor configured");
    return { executed: false, failed: false };
  }

  // Capture executor before closure to preserve type narrowing
  const executor = config.executor;

  const executeBody = async (): Promise<{ executed: boolean; failed: boolean }> => {
  let executed = false;
  let failed = false;

  // Generate correlation ID for end-to-end dispatch tracing (before try so catch can use it)
  const correlationId = randomUUID();

  try {
    const latest = await store.get(action.taskId);
    if (!latest) {
      log.warn({ taskId: action.taskId, op: "dispatch" }, "task not found, skipping dispatch");
      return { executed, failed };
    }

    if (latest.frontmatter.status !== "ready") {
      log.warn({ taskId: action.taskId, status: latest.frontmatter.status, op: "dispatchDedup" }, "dispatch dedup: skipping task (status changed)");
      return { executed, failed };
    }

    if (isLeaseActive(latest.frontmatter.lease)) {
      const lease = latest.frontmatter.lease;
      log.warn({ taskId: action.taskId, leaseAgent: lease?.agent, leaseExpiresAt: lease?.expiresAt, op: "dispatchDedup" }, "dispatch dedup: skipping task (active lease)");
      return { executed, failed };
    }

    const task = allTasks.find(t => t.frontmatter.id === action.taskId);
    if (!task) {
      log.warn({ taskId: action.taskId, op: "dispatch" }, "task not found in allTasks, skipping dispatch");
      return { executed, failed };
    }

    // Log action start (non-fatal if logging fails)
    try {
      await logger.logAction("action.started", "scheduler", action.taskId, {
        action: action.type,
        agent: action.agent,
        correlationId,
      });
    } catch (err) {
      log.warn({ err, taskId: action.taskId, op: "logActionStarted" }, "event logger write failed (best-effort)");
    }

    // Acquire lease first (this also transitions ready → in-progress)
    const leasedTask = await acquireLease(store, action.taskId, action.agent!, {
      ttlMs: config.defaultLeaseTtlMs,
    });

    // Store correlation ID in task metadata before spawn
    if (leasedTask) {
      leasedTask.frontmatter.metadata = {
        ...leasedTask.frontmatter.metadata,
        correlationId,
      };
      await store.save(leasedTask);
    }

    // Build task context using post-lease task path (now in-progress/)
    const taskPath =
      leasedTask?.path ?? join(store.tasksDir, "in-progress", `${action.taskId}.md`);
    const taskMetadata = leasedTask?.frontmatter.metadata ?? task.frontmatter.metadata ?? {};
    const timeoutMsRaw = (taskMetadata as Record<string, unknown>).timeoutMs;
    const timeoutMs = typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? timeoutMsRaw
      : undefined;
    const context: TaskContext = {
      taskId: action.taskId,
      taskPath,
      agent: action.agent!,
      priority: leasedTask?.frontmatter.priority ?? task.frontmatter.priority,
      routing: leasedTask?.frontmatter.routing ?? task.frontmatter.routing,
      // BUG-044: TaskContext.projectId is `string | undefined`; coerce
      // null (unscoped base store) to undefined.
      projectId: store.projectId ?? undefined,
      projectRoot: store.projectRoot,
      taskRelpath: relative(store.projectRoot, taskPath),
      ...(timeoutMs !== undefined && { timeoutMs }),
    };

    // Build context for onRunComplete handler
    const runCompleteCtx = {
      action,
      store,
      logger,
      config,
      correlationId,
      allTasks,
      executor,
    };

    // Spawn agent session with correlation ID and fallback completion callback.
    // Per-task timeoutMs (from aof_dispatch) overrides scheduler's spawnTimeoutMs.
    const result = await executor.spawnSession(context, {
      timeoutMs: context.timeoutMs ?? config.spawnTimeoutMs ?? 300_000,
      correlationId,
      onRunComplete: (outcome) => handleRunComplete(runCompleteCtx, outcome),
    });

    if (result.success) {
      // Store sessionId in task metadata alongside correlationId
      if (result.sessionId) {
        const dispatchedTaskForSession = await store.get(action.taskId);
        if (dispatchedTaskForSession) {
          dispatchedTaskForSession.frontmatter.metadata = {
            ...dispatchedTaskForSession.frontmatter.metadata,
            sessionId: result.sessionId,
          };
          await store.save(dispatchedTaskForSession);
        }
      }

      try {
        await logger.logDispatch("dispatch.matched", "scheduler", action.taskId, {
          agent: action.agent,
          sessionId: result.sessionId,
          correlationId,
        });
      } catch (err) {
        log.warn({ err, taskId: action.taskId, op: "logDispatchMatched" }, "event logger write failed (best-effort)");
      }

      // Log action completion
      try {
        await logger.logAction("action.completed", "scheduler", action.taskId, {
          action: action.type,
          success: true,
          sessionId: result.sessionId,
          correlationId,
        });
      } catch (err) {
        log.warn({ err, taskId: action.taskId, op: "logActionCompleted" }, "event logger write failed (best-effort)");
      }

      startLeaseRenewal(store, action.taskId, action.agent!, config.defaultLeaseTtlMs);
      executed = true;

      // AOF-adf: Update throttle state after successful dispatch
      const dispatchedTask = await store.get(action.taskId);
      if (dispatchedTask) {
        const dispatchTeam = dispatchedTask.frontmatter.routing.team;
        updateThrottleState(dispatchTeam);
      }
    } else {
      // no-plugin-attached → hold task in ready/, no retry increment.
      // Per PROJECT.md core value "tasks never get dropped", a briefly absent
      // plugin (gateway restart) must not punish the task.
      if (result.error === "no-plugin-attached") {
        log.info({ taskId: action.taskId, op: "hold" }, "holding task: no plugin attached");

        // Release lease — task transitions back to ready (not blocked)
        try {
          await releaseLease(store, action.taskId, action.agent!);
        } catch (releaseErr) {
          log.error({ err: releaseErr, taskId: action.taskId, op: "releaseLease" }, "failed to release lease");
        }

        // Emit event (non-fatal if logging fails)
        try {
          await logger.log("dispatch.held", "scheduler", {
            taskId: action.taskId,
            payload: {
              reason: "no-plugin-attached",
              agent: action.agent,
              correlationId,
            },
          });
        } catch (logErr) {
          log.warn({ err: logErr, taskId: action.taskId, op: "logDispatchHeld" }, "event logger write failed (best-effort)");
        }

        // No retry count increment — this is hold, not failure
        // executed=false, failed=false — neither counted
        return { executed, failed };
      }

      const errorClass = classifySpawnError(result.error ?? "unknown");
      log.error({ taskId: action.taskId, agent: action.agent, errorClass, spawnError: result.error, op: "spawn" }, "spawn failed");

      // Track retry count and timestamp in metadata
      const currentTask = await store.get(action.taskId);
      const retryCount = ((currentTask?.frontmatter.metadata?.retryCount as number) ?? 0) + 1;

      // Update metadata before transition
      if (currentTask) {
        currentTask.frontmatter.metadata = {
          ...currentTask.frontmatter.metadata,
          retryCount,
          lastBlockedAt: new Date().toISOString(),
          blockReason: `spawn_failed: ${result.error}`,
          lastError: result.error,
          errorClass,
        };

        // Write updated task with metadata before transition
        await store.save(currentTask);
      }

      // Permanent errors → deadletter immediately
      if (errorClass === "permanent") {
        await transitionToDeadletter(store, logger, action.taskId, result.error ?? "permanent spawn error");
      } else {
        // Transient — move to blocked for backoff retry
        await store.transition(action.taskId, "blocked", {
          reason: `spawn_failed: ${result.error}`,
        });
      }
      
      try {
        await logger.logDispatch("dispatch.error", "scheduler", action.taskId, {
          agent: action.agent,
          error: result.error,
          errorMessage: result.error,
          correlationId,
        });
      } catch (err) {
        log.warn({ err, taskId: action.taskId, op: "logDispatchError" }, "event logger write failed (best-effort)");
      }

      try {
        await logger.logAction("action.completed", "scheduler", action.taskId, {
          action: action.type,
          success: false,
          error: result.error,
          errorMessage: result.error,
          correlationId,
        });
      } catch (err) {
        log.warn({ err, taskId: action.taskId, op: "logActionCompleted" }, "event logger write failed (best-effort)");
      }

      // Don't count as executed when spawn fails
      // executed remains false, mark as failed
      failed = true;
    }
  } catch (err) {
    const error = err as Error;
    const errorMsg = error.message;
    const errorStack = error.stack ?? "No stack trace available";

    log.error({ err, taskId: action.taskId, agent: action.agent, correlationId, op: "dispatch" }, "exception dispatching task");

    try {
      await logger.logDispatch("dispatch.error", "scheduler", action.taskId, {
        error: errorMsg,
        errorMessage: errorMsg,
        errorStack: errorStack,
        correlationId,
      });
    } catch (logErr) {
      log.warn({ err: logErr, taskId: action.taskId, op: "logDispatchError" }, "event logger write failed (best-effort)");
    }

    try {
      await logger.logAction("action.completed", "scheduler", action.taskId, {
        action: action.type,
        success: false,
        error: errorMsg,
        errorMessage: errorMsg,
        errorStack: errorStack,
        correlationId,
      });
    } catch (logErr) {
      log.warn({ err: logErr, taskId: action.taskId, op: "logActionCompleted" }, "event logger write failed (best-effort)");
    }
    
    // Don't count as executed if exception occurred, mark as failed
    failed = true;
  }

  return { executed, failed };
  }; // end executeBody

  if (config.lockManager) {
    return config.lockManager.withLock(action.taskId, executeBody);
  }
  return executeBody();
}
