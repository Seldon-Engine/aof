/**
 * Shared completion transition logic.
 * Table-driven mapping from RunResult outcomes to task state transitions.
 */

import type { Task, TaskStatus } from "../schemas/task.js";
import type { RunResult } from "../schemas/run-result.js";

/**
 * Resolve target status transitions for a given completion outcome.
 * 
 * Returns an array of status transitions to apply in sequence.
 * Empty array means no transition needed (task already in target state).
 * 
 * @example
 * // Task with outcome "done" and reviewRequired=true
 * resolveCompletionTransitions(task, "done") // => ["review"]
 * 
 * // Task with outcome "done" and reviewRequired=false
 * resolveCompletionTransitions(task, "done") // => ["review", "done"]
 * 
 * // Task with outcome "partial"
 * resolveCompletionTransitions(task, "partial") // => ["review"]
 */
export function resolveCompletionTransitions(
  task: Task,
  outcome: RunResult["outcome"],
): TaskStatus[] {
  const reviewRequired = task.frontmatter.metadata?.reviewRequired !== false;

  if (outcome === "done") {
    if (task.frontmatter.status === "done") return [];
    if (reviewRequired) return ["review"];
    return ["review", "done"];
  }

  if (outcome === "blocked") return ["blocked"];
  if (outcome === "needs_review") return ["review"];
  if (outcome === "partial") return ["review"];

  return [];
}
