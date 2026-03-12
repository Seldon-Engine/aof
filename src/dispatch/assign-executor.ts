/**
 * Assign action executor — handles task assignment and dispatch.
 * 
 * Extracted from task-dispatcher.ts (AOF-m2j) to keep modules under 300 LOC.
 */

import { randomUUID } from "node:crypto";
import type { Task, TaskStatus } from "../schemas/task.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import type { DispatchConfig, SchedulerAction } from "./task-dispatcher.js";
import { acquireLease, releaseLease } from "../store/lease.js";
import { isLeaseActive, startLeaseRenewal, stopLeaseRenewal } from "./lease-manager.js";
import { updateThrottleState } from "./throttle.js";
import { serializeTask } from "../store/task-store.js";
import { join, relative } from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import writeFileAtomic from "write-file-atomic";
import { ProjectManifest } from "../schemas/project.js";
import type { TaskContext } from "./executor.js";
import { classifySpawnError } from "./scheduler-helpers.js";
import { trackDispatchFailure, shouldTransitionToDeadletter, transitionToDeadletter } from "./failure-tracker.js";
import { captureTrace } from "../trace/trace-writer.js";
import { deliverCallbacks, deliverAllGranularityCallbacks } from "./callback-delivery.js";
import { SubscriptionStore } from "../store/subscription-store.js";

/**
 * Load project manifest from disk.
 * When projectId matches store.projectId, reads from store.projectRoot/project.yaml.
 * Otherwise falls back to store.projectRoot/projects/<projectId>/project.yaml.
 */
export async function loadProjectManifest(
  store: ITaskStore,
  projectId: string
): Promise<ProjectManifest | null> {
  try {
    // If the projectId matches the store's own project, read directly from project root
    const projectPath = (store.projectId === projectId)
      ? join(store.projectRoot, "project.yaml")
      : join(store.projectRoot, "projects", projectId, "project.yaml");
    const content = await readFile(projectPath, "utf-8");
    const manifest = parseYaml(content) as ProjectManifest;
    return manifest;
  } catch {
    return null;
  }
}

/**
 * Execute a single assign action: acquire lease, spawn agent, handle errors.
 * 
 * @param action - Assign action to execute
 * @param store - Task store
 * @param logger - Event logger
 * @param config - Dispatch configuration
 * @param allTasks - All tasks in the system (for context lookup)
 * @param effectiveConcurrencyLimitRef - Reference to effective concurrency limit (mutable)
 * @returns { executed: boolean, failed: boolean }
 */
export async function executeAssignAction(
  action: SchedulerAction,
  store: ITaskStore,
  logger: EventLogger,
  config: DispatchConfig,
  allTasks: Task[],
  effectiveConcurrencyLimitRef: { value: number | null }
): Promise<{ executed: boolean; failed: boolean }> {
  let executed = false;
  let failed = false;

  if (!config.executor) {
    console.error(`[AOF] Cannot dispatch task ${action.taskId}: no executor configured (agent: ${action.agent})`);
    return { executed, failed };
  }

  // Generate correlation ID for end-to-end dispatch tracing (before try so catch can use it)
  const correlationId = randomUUID();

  try {
    const latest = await store.get(action.taskId);
    if (!latest) {
      console.warn(`[AOF] [TASK-056] Task ${action.taskId} not found, skipping dispatch`);
      return { executed, failed };
    }

    if (latest.frontmatter.status !== "ready") {
      console.warn(
        `[AOF] [TASK-056] Dispatch dedup: skipping ${action.taskId} (status ${latest.frontmatter.status})`,
      );
      return { executed, failed };
    }

    if (isLeaseActive(latest.frontmatter.lease)) {
      const lease = latest.frontmatter.lease;
      console.warn(
        `[AOF] [TASK-056] Dispatch dedup: skipping ${action.taskId} (active lease held by ${lease?.agent} until ${lease?.expiresAt})`,
      );
      return { executed, failed };
    }

    const task = allTasks.find(t => t.frontmatter.id === action.taskId);
    if (!task) {
      console.warn(`[AOF] Task ${action.taskId} not found in allTasks, skipping dispatch`);
      return { executed, failed };
    }

    // Log action start (non-fatal if logging fails)
    try {
      await logger.logAction("action.started", "scheduler", action.taskId, {
        action: action.type,
        agent: action.agent,
        correlationId,
      });
    } catch {
      // Logging errors should not crash the scheduler
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
      const serialized = serializeTask(leasedTask);
      const metadataPath = leasedTask.path ?? join(store.tasksDir, "in-progress", `${leasedTask.frontmatter.id}.md`);
      await writeFileAtomic(metadataPath, serialized);
    }

    // Build task context using post-lease task path (now in-progress/)
    const taskPath =
      leasedTask?.path ?? join(store.tasksDir, "in-progress", `${action.taskId}.md`);
    const context: TaskContext = {
      taskId: action.taskId,
      taskPath,
      agent: action.agent!,
      priority: leasedTask?.frontmatter.priority ?? task.frontmatter.priority,
      routing: leasedTask?.frontmatter.routing ?? task.frontmatter.routing,
      projectId: store.projectId,
      projectRoot: store.projectRoot,
      taskRelpath: relative(store.projectRoot, taskPath),
    };

    // Spawn agent session with correlation ID and fallback completion callback
    const result = await config.executor.spawnSession(context, {
      timeoutMs: config.spawnTimeoutMs ?? 30_000,
      correlationId,
      onRunComplete: async (outcome) => {
        // Always stop lease renewal — the agent is done regardless of outcome
        stopLeaseRenewal(store, action.taskId);

        // Re-read task to check current status
        const currentTask = await store.get(action.taskId);
        if (!currentTask) return;

        // If agent already transitioned the task (called aof_task_complete), capture trace and return
        if (currentTask.frontmatter.status !== "in-progress") {
          // --- Trace capture (Phase 26) --- best-effort, never blocks transitions
          try {
            const sid1 = outcome.sessionId;
            const aid1 = action.agent;
            if (sid1 && aid1) {
              const traceDebug = currentTask.frontmatter.metadata?.debug === true;
              await captureTrace({
                taskId: action.taskId,
                sessionId: sid1,
                agentId: aid1,
                durationMs: outcome.durationMs,
                store,
                logger,
                debug: traceDebug,
              });
            }
          } catch {
            // Trace capture must never crash the scheduler
          }

          // --- Callback delivery (Phase 30) --- best-effort, never blocks transitions
          const tasksDir = store.tasksDir;
          const taskDirResolver = async (tid: string): Promise<string> => {
            const t = await store.get(tid);
            if (!t) throw new Error(`Task not found: ${tid}`);
            return join(tasksDir, t.frontmatter.status, tid);
          };
          const subscriptionStore = new SubscriptionStore(taskDirResolver);
          const callbackOpts = {
            taskId: action.taskId,
            store,
            subscriptionStore,
            executor: config.executor!,
            logger,
          };
          try {
            await deliverCallbacks(callbackOpts);
          } catch {
            // Delivery must never crash the scheduler
          }
          // GRAN-02: Deliver all-granularity callbacks (separate try/catch per DLVR-04)
          try {
            await deliverAllGranularityCallbacks(callbackOpts);
          } catch {
            // All-granularity delivery must never crash the scheduler
          }
          return;
        }

        // Agent finished without calling aof_task_complete — enforcement
        const enforcementReason = outcome.success
          ? `Task failed: agent exited without calling aof_task_complete. Session lasted ${(outcome.durationMs / 1000).toFixed(1)}s. Run \`aof trace ${action.taskId}\` for session details.`
          : outcome.error
            ? `Agent error: ${outcome.error.kind}: ${outcome.error.message}`
            : outcome.aborted
              ? "Agent run was aborted"
              : "Agent run failed (unknown reason)";

        console.error(
          `[AOF] Task ${action.taskId} still in-progress after agent completed. ` +
          enforcementReason,
        );

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
          const msg = transitionErr instanceof Error ? transitionErr.message : String(transitionErr);
          console.error(`[AOF] Enforcement transition failed for ${action.taskId}: ${msg}`);
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
        } catch {
          // Logging errors should not crash the scheduler
        }

        // --- Trace capture (Phase 26) --- best-effort, never blocks transitions
        try {
          const sid = outcome.sessionId;
          const aid = action.agent;
          if (sid && aid) {
            const taskForTrace = await store.get(action.taskId);
            const traceDebug = taskForTrace?.frontmatter.metadata?.debug === true;
            await captureTrace({
              taskId: action.taskId,
              sessionId: sid,
              agentId: aid,
              durationMs: outcome.durationMs,
              store,
              logger,
              debug: traceDebug,
            });
          }
        } catch {
          // Trace capture must never crash the scheduler
        }

        // --- Callback delivery (Phase 30) --- best-effort, never blocks transitions
        const tasksDir2 = store.tasksDir;
        const taskDirResolver2 = async (tid: string): Promise<string> => {
          const t = await store.get(tid);
          if (!t) throw new Error(`Task not found: ${tid}`);
          return join(tasksDir2, t.frontmatter.status, tid);
        };
        const subscriptionStore2 = new SubscriptionStore(taskDirResolver2);
        const callbackOpts2 = {
          taskId: action.taskId,
          store,
          subscriptionStore: subscriptionStore2,
          executor: config.executor!,
          logger,
        };
        try {
          await deliverCallbacks(callbackOpts2);
        } catch {
          // Delivery must never crash the scheduler
        }
        // GRAN-02: Deliver all-granularity callbacks (separate try/catch per DLVR-04)
        try {
          await deliverAllGranularityCallbacks(callbackOpts2);
        } catch {
          // All-granularity delivery must never crash the scheduler
        }
      },
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
          const serialized = serializeTask(dispatchedTaskForSession);
          const sessionTaskPath = dispatchedTaskForSession.path ?? join(store.tasksDir, "in-progress", `${dispatchedTaskForSession.frontmatter.id}.md`);
          await writeFileAtomic(sessionTaskPath, serialized);
        }
      }

      try {
        await logger.logDispatch("dispatch.matched", "scheduler", action.taskId, {
          agent: action.agent,
          sessionId: result.sessionId,
          correlationId,
        });
      } catch {
        // Logging errors should not crash the scheduler
      }

      // Log action completion
      try {
        await logger.logAction("action.completed", "scheduler", action.taskId, {
          action: action.type,
          success: true,
          sessionId: result.sessionId,
          correlationId,
        });
      } catch {
        // Logging errors should not crash the scheduler
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
      // Check if this is a platform concurrency limit error
      if (result.platformLimit !== undefined) {
        const previousCap = effectiveConcurrencyLimitRef.value ?? config.maxConcurrentDispatches ?? 3;
        effectiveConcurrencyLimitRef.value = Math.min(result.platformLimit, config.maxConcurrentDispatches ?? 3);
        
        console.info(
          `[AOF] Platform concurrency limit detected: ${result.platformLimit}, ` +
          `effective cap now ${effectiveConcurrencyLimitRef.value} (was ${previousCap})`
        );
        
        // Emit event (non-fatal if logging fails)
        try {
          await logger.log("concurrency.platformLimit", "scheduler", {
            taskId: action.taskId,
            payload: {
              detectedLimit: result.platformLimit,
              effectiveCap: effectiveConcurrencyLimitRef.value,
              previousCap,
            },
          });
        } catch (logErr) {
          console.error(`[AOF] Failed to log concurrency.platformLimit event: ${(logErr as Error).message}`);
        }
        
        // Release lease — task transitions back to ready (not blocked)
        try {
          await releaseLease(store, action.taskId, action.agent!);
        } catch (releaseErr) {
          console.error(`[AOF] Failed to release lease for ${action.taskId}: ${(releaseErr as Error).message}`);
        }
        
        // No retry count increment - this is capacity exhaustion, not failure
        console.info(
          `[AOF] Task ${action.taskId} requeued to ready (platform capacity exhausted, ` +
          `will retry next poll)`
        );
        
        return { executed, failed };
      }
      
      const errorClass = classifySpawnError(result.error ?? "unknown");
      console.error(`[AOF] Spawn failed for ${action.taskId} (agent: ${action.agent}, class: ${errorClass}): ${result.error}`);

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
        const serialized = serializeTask(currentTask);
        const taskPath = currentTask.path ?? join(store.tasksDir, currentTask.frontmatter.status, `${currentTask.frontmatter.id}.md`);
        await writeFileAtomic(taskPath, serialized);
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
      } catch {
        // Logging errors should not crash the scheduler
      }

      try {
        await logger.logAction("action.completed", "scheduler", action.taskId, {
          action: action.type,
          success: false,
          error: result.error,
          errorMessage: result.error,
          correlationId,
        });
      } catch {
        // Logging errors should not crash the scheduler
      }

      // Don't count as executed when spawn fails
      // executed remains false, mark as failed
      failed = true;
    }
  } catch (err) {
    const error = err as Error;
    const errorMsg = error.message;
    const errorStack = error.stack ?? "No stack trace available";

    console.error(`[AOF] Exception dispatching ${action.taskId} (agent: ${action.agent}): ${errorMsg}`);

    try {
      await logger.logDispatch("dispatch.error", "scheduler", action.taskId, {
        error: errorMsg,
        errorMessage: errorMsg,
        errorStack: errorStack,
        correlationId,
      });
    } catch {
      // Logging errors should not crash the scheduler
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
    } catch {
      // Logging errors should not crash the scheduler
    }
    
    // Don't count as executed if exception occurred, mark as failed
    failed = true;
  }

  return { executed, failed };
}

/**
 * Build dispatch actions for ready tasks.
 * 
 * Checks dependencies, leases, throttles, and creates assign/alert/block actions.
 * 
 * @param readyTasks - Tasks in ready status
 * @param allTasks - All tasks in the system
 * @param store - Task store
 * @param config - Dispatch configuration
 * @param metrics - Dispatch metrics (concurrency, blocked tasks, occupied resources)
 * @param effectiveConcurrencyLimit - Current effective concurrency limit
 * @param childrenByParent - Map of parent task ID to child tasks
 * @returns Array of scheduler actions to execute
 */
