/**
 * Murmur cleanup — stale review detection and state recovery.
 *
 * Prevents stuck reviews from permanently blocking murmur cycles.
 * Checks if in-progress reviews are actually still active and cleans up stale state.
 */

import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import type { MurmurStateManager } from "./state-manager.js";
import type { MurmurState } from "./state-manager.js";

export interface CleanupOptions {
  /** Review timeout in milliseconds (default: 30 minutes). */
  reviewTimeoutMs?: number;
  /** Dry-run mode: log actions but don't mutate state. */
  dryRun?: boolean;
}

export interface CleanupResult {
  /** Whether cleanup was performed. */
  cleaned: boolean;
  /** Reason for cleanup (null if no cleanup needed). */
  reason: string | null;
  /** Previous review task ID that was cleaned up (null if no cleanup). */
  cleanedTaskId: string | null;
}

/**
 * Check and clean up stale review state for a team.
 *
 * Inspects state.currentReviewTaskId and verifies:
 * - Task still exists
 * - Task is still in-progress
 * - Review hasn't timed out
 *
 * If any check fails, clears stale state and logs event.
 *
 * @param teamId - Team identifier
 * @param state - Current murmur state
 * @param store - Task store for checking task status
 * @param stateManager - State manager for clearing stale state
 * @param logger - Event logger for cleanup events
 * @param options - Cleanup options (timeout, dry-run)
 * @returns CleanupResult indicating whether cleanup occurred
 */
export async function cleanupStaleReview(
  teamId: string,
  state: MurmurState,
  store: ITaskStore,
  stateManager: MurmurStateManager,
  logger: EventLogger,
  options: CleanupOptions = {}
): Promise<CleanupResult> {
  const { reviewTimeoutMs = 30 * 60 * 1000, dryRun = false } = options;

  // No cleanup needed if no review is in progress
  if (state.currentReviewTaskId === null) {
    return {
      cleaned: false,
      reason: null,
      cleanedTaskId: null,
    };
  }

  const reviewTaskId = state.currentReviewTaskId;
  let cleanupReason: string | null = null;

  // Check if task still exists
  const task = await store.get(reviewTaskId);
  
  if (!task) {
    cleanupReason = "task_not_found";
  } else if (task.frontmatter.status === "done") {
    cleanupReason = "task_done";
  } else if (task.frontmatter.status === "cancelled") {
    cleanupReason = "task_cancelled";
  } else if (task.frontmatter.status === "deadletter") {
    cleanupReason = "task_deadlettered";
  } else if (state.reviewStartedAt) {
    // Check timeout
    const startedMs = new Date(state.reviewStartedAt).getTime();
    const elapsedMs = Date.now() - startedMs;
    
    if (elapsedMs >= reviewTimeoutMs) {
      cleanupReason = "timeout";
    }
  }

  // No cleanup needed
  if (cleanupReason === null) {
    return {
      cleaned: false,
      reason: null,
      cleanedTaskId: null,
    };
  }

  console.info(
    `[AOF] Murmur cleanup: detected stale review for ${teamId} (task=${reviewTaskId}, reason=${cleanupReason})`
  );

  // Log cleanup event
  try {
    await logger.log("murmur.cleanup.stale", "scheduler", {
      taskId: reviewTaskId,
      payload: {
        team: teamId,
        reason: cleanupReason,
        reviewStartedAt: state.reviewStartedAt,
        taskStatus: task?.frontmatter.status ?? null,
      },
    });
  } catch {
    // Logging errors should not crash cleanup
  }

  // Don't mutate in dry-run mode
  if (dryRun) {
    console.info(
      `[AOF] Murmur cleanup: would clear stale review for ${teamId} (dry-run)`
    );
    return {
      cleaned: true,
      reason: cleanupReason,
      cleanedTaskId: reviewTaskId,
    };
  }

  // Clear stale state
  await stateManager.endReview(teamId);

  console.info(
    `[AOF] Murmur cleanup: cleared stale review state for ${teamId}`
  );

  return {
    cleaned: true,
    reason: cleanupReason,
    cleanedTaskId: reviewTaskId,
  };
}
