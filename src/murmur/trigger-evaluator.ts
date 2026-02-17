/**
 * Murmur trigger evaluator — determines when to fire orchestration reviews.
 *
 * Evaluates trigger conditions (queueEmpty, completionBatch, interval, failureBatch)
 * against current team state and task statistics. First trigger that fires wins.
 */

import type { MurmurState } from "./state-manager.js";
import type { MurmurTrigger } from "../schemas/org-chart.js";

/** Result of trigger evaluation. */
export interface TriggerResult {
  /** Whether a murmur review should fire. */
  shouldFire: boolean;
  /** Trigger kind that fired (null if none fired). */
  triggeredBy: string | null;
  /** Human-readable reason for firing (null if none fired). */
  reason: string | null;
}

/** Task statistics for trigger evaluation. */
export interface TaskStats {
  /** Number of tasks in "ready" state. */
  ready: number;
  /** Number of tasks in "in-progress" state. */
  inProgress: number;
}

/**
 * Evaluate triggers for a team.
 *
 * Checks trigger conditions in order; first one that fires wins (short-circuit).
 * NEVER fires if state.currentReviewTaskId is non-null (idempotency guard).
 *
 * @param triggers - Trigger configurations from org chart
 * @param state - Current murmur state for the team
 * @param taskStats - Task queue statistics
 * @returns TriggerResult indicating whether to fire and which trigger caused it
 */
export function evaluateTriggers(
  triggers: MurmurTrigger[],
  state: MurmurState,
  taskStats: TaskStats
): TriggerResult {
  // Idempotency guard: never fire if a review is already in progress
  if (state.currentReviewTaskId !== null) {
    return {
      shouldFire: false,
      triggeredBy: null,
      reason: null,
    };
  }

  // Evaluate triggers in order; first one that fires wins
  for (const trigger of triggers) {
    const result = evaluateSingleTrigger(trigger, state, taskStats);
    if (result.shouldFire) {
      return result;
    }
  }

  // No triggers fired
  return {
    shouldFire: false,
    triggeredBy: null,
    reason: null,
  };
}

/**
 * Evaluate a single trigger condition.
 *
 * @param trigger - Trigger configuration
 * @param state - Current murmur state
 * @param taskStats - Task queue statistics
 * @returns TriggerResult for this specific trigger
 */
function evaluateSingleTrigger(
  trigger: MurmurTrigger,
  state: MurmurState,
  taskStats: TaskStats
): TriggerResult {
  switch (trigger.kind) {
    case "queueEmpty":
      return evaluateQueueEmpty(taskStats);

    case "completionBatch":
      return evaluateCompletionBatch(trigger, state);

    case "interval":
      return evaluateInterval(trigger, state);

    case "failureBatch":
      return evaluateFailureBatch(trigger, state);

    default:
      // Unknown trigger kind — never fire
      return {
        shouldFire: false,
        triggeredBy: null,
        reason: null,
      };
  }
}

/**
 * Evaluate queueEmpty trigger: fire if both ready and in-progress queues are empty.
 */
function evaluateQueueEmpty(taskStats: TaskStats): TriggerResult {
  const isEmpty = taskStats.ready === 0 && taskStats.inProgress === 0;
  
  if (isEmpty) {
    return {
      shouldFire: true,
      triggeredBy: "queueEmpty",
      reason: "Both ready and in-progress queues are empty",
    };
  }

  return {
    shouldFire: false,
    triggeredBy: null,
    reason: null,
  };
}

/**
 * Evaluate completionBatch trigger: fire if completions exceed threshold.
 */
function evaluateCompletionBatch(
  trigger: MurmurTrigger,
  state: MurmurState
): TriggerResult {
  // Threshold is required for completionBatch
  if (trigger.threshold === undefined) {
    return {
      shouldFire: false,
      triggeredBy: null,
      reason: null,
    };
  }

  if (state.completionsSinceLastReview >= trigger.threshold) {
    return {
      shouldFire: true,
      triggeredBy: "completionBatch",
      reason: `Completed ${state.completionsSinceLastReview} tasks (threshold: ${trigger.threshold})`,
    };
  }

  return {
    shouldFire: false,
    triggeredBy: null,
    reason: null,
  };
}

/**
 * Evaluate interval trigger: fire if enough time has elapsed since last review.
 */
function evaluateInterval(
  trigger: MurmurTrigger,
  state: MurmurState
): TriggerResult {
  // intervalMs is required for interval trigger
  if (trigger.intervalMs === undefined) {
    return {
      shouldFire: false,
      triggeredBy: null,
      reason: null,
    };
  }

  // If no review has ever happened, fire immediately
  if (state.lastReviewAt === null) {
    return {
      shouldFire: true,
      triggeredBy: "interval",
      reason: "No review has occurred yet",
    };
  }

  const lastReviewMs = new Date(state.lastReviewAt).getTime();
  const elapsedMs = Date.now() - lastReviewMs;

  if (elapsedMs >= trigger.intervalMs) {
    return {
      shouldFire: true,
      triggeredBy: "interval",
      reason: `${Math.floor(elapsedMs / 1000)}s elapsed since last review (interval: ${Math.floor(trigger.intervalMs / 1000)}s)`,
    };
  }

  return {
    shouldFire: false,
    triggeredBy: null,
    reason: null,
  };
}

/**
 * Evaluate failureBatch trigger: fire if failures exceed threshold.
 */
function evaluateFailureBatch(
  trigger: MurmurTrigger,
  state: MurmurState
): TriggerResult {
  // Threshold is required for failureBatch
  if (trigger.threshold === undefined) {
    return {
      shouldFire: false,
      triggeredBy: null,
      reason: null,
    };
  }

  if (state.failuresSinceLastReview >= trigger.threshold) {
    return {
      shouldFire: true,
      triggeredBy: "failureBatch",
      reason: `${state.failuresSinceLastReview} task failures (threshold: ${trigger.threshold})`,
    };
  }

  return {
    shouldFire: false,
    triggeredBy: null,
    reason: null,
  };
}
