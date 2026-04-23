/**
 * Dispatch failure tracking and deadletter transitions.
 * 
 * Tracks dispatch failures in task metadata. After 3 failures,
 * transitions task to deadletter status and moves file to tasks/deadletter/.
 * 
 * See AOF-p3k task brief for requirements.
 */

import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import { createLogger } from "../logging/index.js";
import type { Task } from "../schemas/task.js";

const log = createLogger("failure-tracker");

const MAX_DISPATCH_FAILURES = 3;

/**
 * Track a dispatch failure for a task.
 * Increments dispatchFailures counter and records failure reason.
 */
export async function trackDispatchFailure(
  store: ITaskStore,
  taskId: string,
  reason: string
): Promise<void> {
  const task = await store.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const failures = (task.frontmatter.metadata.dispatchFailures as number | undefined) ?? 0;
  
  // Update task metadata
  task.frontmatter.metadata.dispatchFailures = failures + 1;
  task.frontmatter.metadata.lastDispatchFailureReason = reason;
  task.frontmatter.metadata.lastDispatchFailureAt = Date.now();
  task.frontmatter.updatedAt = new Date().toISOString();

  // Write updated task back to file
  await store.save(task);
}

/**
 * Check if a task should transition to deadletter based on failure count.
 */
export function shouldTransitionToDeadletter(task: Task): boolean {
  const failures = (task.frontmatter.metadata.dispatchFailures as number | undefined) ?? 0;
  return failures >= MAX_DISPATCH_FAILURES;
}

/**
 * Transition a task to deadletter status.
 *
 * - Updates task status to "deadletter"
 * - Moves task file to tasks/deadletter/
 * - Logs deadletter event with full failure chain (FOUND-04)
 * - Emits ops alert (console + events.jsonl)
 */
export async function transitionToDeadletter(
  store: ITaskStore,
  eventLogger: EventLogger,
  taskId: string,
  lastFailureReason: string
): Promise<void> {
  const task = await store.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const failureCount = (task.frontmatter.metadata.dispatchFailures as number | undefined) ?? 0;
  const retryCount = (task.frontmatter.metadata.retryCount as number | undefined) ?? 0;
  const errorClass = (task.frontmatter.metadata.errorClass as string | undefined) ?? "unknown";
  const agent = task.frontmatter.routing?.agent;
  const deadletteredAt = new Date().toISOString();
  const deadletterReason =
    errorClass === "permanent" ? "permanent_error" : "max_dispatch_failures";

  // BUG-005: stamp the deadletter cause into the task's own frontmatter
  // metadata, not just the event log. Coordinators triaging a deadlettered
  // task via `aof_status_report` or a direct file read need the failure
  // summary on the task itself; chasing the cause through events.jsonl is
  // operationally painful, especially during incidents where many tasks
  // deadletter for the same reason (e.g. a shared upstream auth outage).
  task.frontmatter.metadata = {
    ...task.frontmatter.metadata,
    deadletterReason,
    deadletterLastError: lastFailureReason,
    deadletterErrorClass: errorClass,
    deadletterAt: deadletteredAt,
    deadletterFailureCount: failureCount,
  };
  await store.save(task);

  // Transition task to deadletter status
  await store.transition(taskId, "deadletter");

  // Log deadletter event with full failure chain (FOUND-04)
  // Uses "task.deadlettered" as canonical event type (backward compat: "task.deadletter" still in schema)
  await eventLogger.log("task.deadlettered", "system", {
    taskId,
    payload: {
      reason: errorClass === "permanent" ? "permanent_error" : "max_dispatch_failures",
      failureCount,
      retryCount,
      lastFailureReason,
      errorClass,
      agent: agent ?? "unassigned",
      failureHistory: {
        dispatchFailures: failureCount,
        retryCount,
        lastError: (task.frontmatter.metadata.lastError as string | undefined) ?? lastFailureReason,
        lastBlockedAt: (task.frontmatter.metadata.lastBlockedAt as string | undefined) ?? "unknown",
        lastDispatchFailureAt: (task.frontmatter.metadata.lastDispatchFailureAt as number | undefined) ?? "unknown",
      },
    },
  });

  // Emit ops alert with full diagnostic context
  // AOF-1m9: Mandatory ops alerting for deadletter transitions
  log.error({ taskId, taskTitle: task.frontmatter.title, failureCount, retryCount, errorClass, lastFailureReason, agent: agent ?? "unassigned" }, "DEADLETTER: task transitioned to deadletter, investigate failure cause before resurrection");
}

/**
 * Reset dispatch failure count (used when resurrecting a task).
 */
export async function resetDispatchFailures(
  store: ITaskStore,
  taskId: string
): Promise<void> {
  const task = await store.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  // Reset failure tracking (XRAY-006: include retryCount)
  task.frontmatter.metadata.dispatchFailures = 0;
  delete task.frontmatter.metadata.retryCount;
  delete task.frontmatter.metadata.lastDispatchFailureReason;
  delete task.frontmatter.metadata.lastDispatchFailureAt;
  delete task.frontmatter.metadata.errorClass;
  task.frontmatter.updatedAt = new Date().toISOString();

  // Write updated task back to file
  await store.save(task);
}
