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
 *
 * Two errorClass values short-circuit the dispatch-failure budget and
 * deadletter on first occurrence — retrying is deterministic wasted work
 * for both:
 *   - "permanent": deterministic config error (missing credentials, agent
 *     not found, permission denied). Original incident:
 *     .planning/debug/2026-04-28-aof-dispatch-ghosting-and-worker-hygiene.md
 *   - "model_silent_failure": OpenClaw embedded-runner swallowed an empty
 *     model completion (HTTP 200 + stop_reason="stop" + zero content). The
 *     model is producing nothing; retry will produce nothing again. Original
 *     incident: .planning/debug/2026-05-02-embedded-run-empty-response-and-error-propagation.md
 */
export function shouldTransitionToDeadletter(task: Task): boolean {
  const failures = (task.frontmatter.metadata.dispatchFailures as number | undefined) ?? 0;
  const errorClass = task.frontmatter.metadata.errorClass as string | undefined;
  if (errorClass === "permanent" || errorClass === "model_silent_failure") return true;
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
    errorClass === "permanent"
      ? "permanent_error"
      : errorClass === "model_silent_failure"
        ? "model_silent_failure"
        : "max_dispatch_failures";

  // BUG-005 + BUG-046a (Phase 46 / Bug 1A): stamp the deadletter cause
  // into the task's own frontmatter metadata atomically with the file
  // move. Coordinators triaging via `aof_status_report` or a direct
  // file read need the failure summary on the task itself; chasing the
  // cause through events.jsonl is operationally painful, especially
  // during incidents where many tasks deadletter for the same reason
  // (e.g. a shared upstream auth outage).
  //
  // Phase 46 collapsed this from two separate awaits (`store.save(task)`
  // then `store.transition(...)`) into a single `store.transition` call
  // with `metadataPatch`. The pre-Phase-46 split allowed a crash, ENOSPC,
  // or rename failure between the two operations to leave the file in
  // tasks/ready/ with frontmatter.status: deadletter — the spin-loop
  // bug from the 2026-04-24 incident (5 ghost tasks + 172 MB log).
  // Atomic application via the existing TaskLocks per-task mutex makes
  // the partial-state structurally impossible.
  await store.transition(taskId, "deadletter", {
    reason: deadletterReason,
    metadataPatch: {
      deadletterReason,
      deadletterLastError: lastFailureReason,
      deadletterErrorClass: errorClass,
      deadletterAt: deadletteredAt,
      deadletterFailureCount: failureCount,
    },
  });

  // Log deadletter event with full failure chain (FOUND-04)
  // Uses "task.deadlettered" as canonical event type (backward compat: "task.deadletter" still in schema)
  await eventLogger.log("task.deadlettered", "system", {
    taskId,
    payload: {
      reason: deadletterReason,
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
