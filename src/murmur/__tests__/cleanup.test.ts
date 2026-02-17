/**
 * Tests for murmur cleanup — stale review detection and state recovery.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanupStaleReview } from "../cleanup.js";
import type { MurmurState } from "../state-manager.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { EventLogger } from "../../events/logger.js";
import type { Task } from "../../schemas/task.js";

describe("cleanupStaleReview", () => {
  let mockStore: ITaskStore;
  let mockStateManager: {
    endReview: ReturnType<typeof vi.fn>;
  };
  let mockLogger: EventLogger;

  beforeEach(() => {
    mockStore = {
      get: vi.fn(),
    } as unknown as ITaskStore;

    mockStateManager = {
      endReview: vi.fn(),
    };

    mockLogger = {
      log: vi.fn(),
    } as unknown as EventLogger;
  });

  describe("no cleanup needed", () => {
    it("should not clean up when no review is in progress", async () => {
      const state: MurmurState = {
        teamId: "backend",
        lastReviewAt: null,
        completionsSinceLastReview: 0,
        failuresSinceLastReview: 0,
        currentReviewTaskId: null,
        reviewStartedAt: null,
        lastTriggeredBy: null,
      };

      const result = await cleanupStaleReview(
        "backend",
        state,
        mockStore,
        mockStateManager as any,
        mockLogger
      );

      expect(result.cleaned).toBe(false);
      expect(result.reason).toBeNull();
      expect(result.cleanedTaskId).toBeNull();
      expect(mockStateManager.endReview).not.toHaveBeenCalled();
    });

    it("should not clean up when review task is still in-progress", async () => {
      const state: MurmurState = {
        teamId: "backend",
        lastReviewAt: new Date().toISOString(),
        completionsSinceLastReview: 0,
        failuresSinceLastReview: 0,
        currentReviewTaskId: "TASK-2026-02-17-001",
        reviewStartedAt: new Date().toISOString(),
        lastTriggeredBy: "queueEmpty",
      };

      const mockTask: Partial<Task> = {
        frontmatter: {
          id: "TASK-2026-02-17-001",
          status: "in-progress",
        } as any,
      };

      vi.mocked(mockStore.get).mockResolvedValue(mockTask as Task);

      const result = await cleanupStaleReview(
        "backend",
        state,
        mockStore,
        mockStateManager as any,
        mockLogger
      );

      expect(result.cleaned).toBe(false);
      expect(result.reason).toBeNull();
      expect(result.cleanedTaskId).toBeNull();
      expect(mockStateManager.endReview).not.toHaveBeenCalled();
    });
  });

  describe("cleanup stale reviews", () => {
    it("should clean up when review task is done", async () => {
      const state: MurmurState = {
        teamId: "backend",
        lastReviewAt: new Date().toISOString(),
        completionsSinceLastReview: 0,
        failuresSinceLastReview: 0,
        currentReviewTaskId: "TASK-2026-02-17-001",
        reviewStartedAt: new Date().toISOString(),
        lastTriggeredBy: "queueEmpty",
      };

      const mockTask: Partial<Task> = {
        frontmatter: {
          id: "TASK-2026-02-17-001",
          status: "done",
        } as any,
      };

      vi.mocked(mockStore.get).mockResolvedValue(mockTask as Task);

      const result = await cleanupStaleReview(
        "backend",
        state,
        mockStore,
        mockStateManager as any,
        mockLogger
      );

      expect(result.cleaned).toBe(true);
      expect(result.reason).toBe("task_done");
      expect(result.cleanedTaskId).toBe("TASK-2026-02-17-001");
      expect(mockStateManager.endReview).toHaveBeenCalledWith("backend");
      expect(mockLogger.log).toHaveBeenCalledWith(
        "murmur.cleanup.stale",
        "scheduler",
        expect.objectContaining({
          taskId: "TASK-2026-02-17-001",
          payload: expect.objectContaining({
            team: "backend",
            reason: "task_done",
          }),
        })
      );
    });

    it("should clean up when review task is cancelled", async () => {
      const state: MurmurState = {
        teamId: "backend",
        lastReviewAt: new Date().toISOString(),
        completionsSinceLastReview: 0,
        failuresSinceLastReview: 0,
        currentReviewTaskId: "TASK-2026-02-17-002",
        reviewStartedAt: new Date().toISOString(),
        lastTriggeredBy: "queueEmpty",
      };

      const mockTask: Partial<Task> = {
        frontmatter: {
          id: "TASK-2026-02-17-002",
          status: "cancelled",
        } as any,
      };

      vi.mocked(mockStore.get).mockResolvedValue(mockTask as Task);

      const result = await cleanupStaleReview(
        "backend",
        state,
        mockStore,
        mockStateManager as any,
        mockLogger
      );

      expect(result.cleaned).toBe(true);
      expect(result.reason).toBe("task_cancelled");
      expect(result.cleanedTaskId).toBe("TASK-2026-02-17-002");
      expect(mockStateManager.endReview).toHaveBeenCalledWith("backend");
    });

    it("should clean up when review task is deadlettered", async () => {
      const state: MurmurState = {
        teamId: "backend",
        lastReviewAt: new Date().toISOString(),
        completionsSinceLastReview: 0,
        failuresSinceLastReview: 0,
        currentReviewTaskId: "TASK-2026-02-17-003",
        reviewStartedAt: new Date().toISOString(),
        lastTriggeredBy: "queueEmpty",
      };

      const mockTask: Partial<Task> = {
        frontmatter: {
          id: "TASK-2026-02-17-003",
          status: "deadletter",
        } as any,
      };

      vi.mocked(mockStore.get).mockResolvedValue(mockTask as Task);

      const result = await cleanupStaleReview(
        "backend",
        state,
        mockStore,
        mockStateManager as any,
        mockLogger
      );

      expect(result.cleaned).toBe(true);
      expect(result.reason).toBe("task_deadlettered");
      expect(result.cleanedTaskId).toBe("TASK-2026-02-17-003");
      expect(mockStateManager.endReview).toHaveBeenCalledWith("backend");
    });

    it("should clean up when review task doesn't exist", async () => {
      const state: MurmurState = {
        teamId: "backend",
        lastReviewAt: new Date().toISOString(),
        completionsSinceLastReview: 0,
        failuresSinceLastReview: 0,
        currentReviewTaskId: "TASK-2026-02-17-999",
        reviewStartedAt: new Date().toISOString(),
        lastTriggeredBy: "queueEmpty",
      };

      vi.mocked(mockStore.get).mockResolvedValue(undefined);

      const result = await cleanupStaleReview(
        "backend",
        state,
        mockStore,
        mockStateManager as any,
        mockLogger
      );

      expect(result.cleaned).toBe(true);
      expect(result.reason).toBe("task_not_found");
      expect(result.cleanedTaskId).toBe("TASK-2026-02-17-999");
      expect(mockStateManager.endReview).toHaveBeenCalledWith("backend");
      expect(mockLogger.log).toHaveBeenCalledWith(
        "murmur.cleanup.stale",
        "scheduler",
        expect.objectContaining({
          taskId: "TASK-2026-02-17-999",
          payload: expect.objectContaining({
            team: "backend",
            reason: "task_not_found",
          }),
        })
      );
    });

    it("should clean up when review has timed out", async () => {
      const thirtyOneMinutesAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();

      const state: MurmurState = {
        teamId: "backend",
        lastReviewAt: thirtyOneMinutesAgo,
        completionsSinceLastReview: 0,
        failuresSinceLastReview: 0,
        currentReviewTaskId: "TASK-2026-02-17-004",
        reviewStartedAt: thirtyOneMinutesAgo,
        lastTriggeredBy: "queueEmpty",
      };

      const mockTask: Partial<Task> = {
        frontmatter: {
          id: "TASK-2026-02-17-004",
          status: "in-progress",
        } as any,
      };

      vi.mocked(mockStore.get).mockResolvedValue(mockTask as Task);

      const result = await cleanupStaleReview(
        "backend",
        state,
        mockStore,
        mockStateManager as any,
        mockLogger,
        { reviewTimeoutMs: 30 * 60 * 1000 }
      );

      expect(result.cleaned).toBe(true);
      expect(result.reason).toBe("timeout");
      expect(result.cleanedTaskId).toBe("TASK-2026-02-17-004");
      expect(mockStateManager.endReview).toHaveBeenCalledWith("backend");
      expect(mockLogger.log).toHaveBeenCalledWith(
        "murmur.cleanup.stale",
        "scheduler",
        expect.objectContaining({
          taskId: "TASK-2026-02-17-004",
          payload: expect.objectContaining({
            team: "backend",
            reason: "timeout",
          }),
        })
      );
    });

    it("should not clean up when review hasn't timed out yet", async () => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      const state: MurmurState = {
        teamId: "backend",
        lastReviewAt: tenMinutesAgo,
        completionsSinceLastReview: 0,
        failuresSinceLastReview: 0,
        currentReviewTaskId: "TASK-2026-02-17-005",
        reviewStartedAt: tenMinutesAgo,
        lastTriggeredBy: "queueEmpty",
      };

      const mockTask: Partial<Task> = {
        frontmatter: {
          id: "TASK-2026-02-17-005",
          status: "in-progress",
        } as any,
      };

      vi.mocked(mockStore.get).mockResolvedValue(mockTask as Task);

      const result = await cleanupStaleReview(
        "backend",
        state,
        mockStore,
        mockStateManager as any,
        mockLogger,
        { reviewTimeoutMs: 30 * 60 * 1000 }
      );

      expect(result.cleaned).toBe(false);
      expect(result.reason).toBeNull();
      expect(result.cleanedTaskId).toBeNull();
      expect(mockStateManager.endReview).not.toHaveBeenCalled();
    });
  });

  describe("dry-run mode", () => {
    it("should not mutate state in dry-run mode", async () => {
      const state: MurmurState = {
        teamId: "backend",
        lastReviewAt: new Date().toISOString(),
        completionsSinceLastReview: 0,
        failuresSinceLastReview: 0,
        currentReviewTaskId: "TASK-2026-02-17-001",
        reviewStartedAt: new Date().toISOString(),
        lastTriggeredBy: "queueEmpty",
      };

      const mockTask: Partial<Task> = {
        frontmatter: {
          id: "TASK-2026-02-17-001",
          status: "done",
        } as any,
      };

      vi.mocked(mockStore.get).mockResolvedValue(mockTask as Task);

      const result = await cleanupStaleReview(
        "backend",
        state,
        mockStore,
        mockStateManager as any,
        mockLogger,
        { dryRun: true }
      );

      expect(result.cleaned).toBe(true);
      expect(result.reason).toBe("task_done");
      expect(result.cleanedTaskId).toBe("TASK-2026-02-17-001");
      expect(mockStateManager.endReview).not.toHaveBeenCalled();
      expect(mockLogger.log).toHaveBeenCalled(); // Events still logged
    });
  });

  describe("event logging", () => {
    it("should emit cleanup event with task status when task exists", async () => {
      const state: MurmurState = {
        teamId: "backend",
        lastReviewAt: new Date().toISOString(),
        completionsSinceLastReview: 0,
        failuresSinceLastReview: 0,
        currentReviewTaskId: "TASK-2026-02-17-001",
        reviewStartedAt: new Date().toISOString(),
        lastTriggeredBy: "queueEmpty",
      };

      const mockTask: Partial<Task> = {
        frontmatter: {
          id: "TASK-2026-02-17-001",
          status: "done",
        } as any,
      };

      vi.mocked(mockStore.get).mockResolvedValue(mockTask as Task);

      await cleanupStaleReview(
        "backend",
        state,
        mockStore,
        mockStateManager as any,
        mockLogger
      );

      expect(mockLogger.log).toHaveBeenCalledWith(
        "murmur.cleanup.stale",
        "scheduler",
        expect.objectContaining({
          taskId: "TASK-2026-02-17-001",
          payload: expect.objectContaining({
            team: "backend",
            reason: "task_done",
            taskStatus: "done",
          }),
        })
      );
    });

    it("should emit cleanup event with null task status when task doesn't exist", async () => {
      const state: MurmurState = {
        teamId: "backend",
        lastReviewAt: new Date().toISOString(),
        completionsSinceLastReview: 0,
        failuresSinceLastReview: 0,
        currentReviewTaskId: "TASK-2026-02-17-999",
        reviewStartedAt: new Date().toISOString(),
        lastTriggeredBy: "queueEmpty",
      };

      vi.mocked(mockStore.get).mockResolvedValue(undefined);

      await cleanupStaleReview(
        "backend",
        state,
        mockStore,
        mockStateManager as any,
        mockLogger
      );

      expect(mockLogger.log).toHaveBeenCalledWith(
        "murmur.cleanup.stale",
        "scheduler",
        expect.objectContaining({
          taskId: "TASK-2026-02-17-999",
          payload: expect.objectContaining({
            team: "backend",
            reason: "task_not_found",
            taskStatus: null,
          }),
        })
      );
    });

    it("should not crash if event logging fails", async () => {
      const state: MurmurState = {
        teamId: "backend",
        lastReviewAt: new Date().toISOString(),
        completionsSinceLastReview: 0,
        failuresSinceLastReview: 0,
        currentReviewTaskId: "TASK-2026-02-17-001",
        reviewStartedAt: new Date().toISOString(),
        lastTriggeredBy: "queueEmpty",
      };

      const mockTask: Partial<Task> = {
        frontmatter: {
          id: "TASK-2026-02-17-001",
          status: "done",
        } as any,
      };

      vi.mocked(mockStore.get).mockResolvedValue(mockTask as Task);
      vi.mocked(mockLogger.log).mockRejectedValue(new Error("Logging failed"));

      // Should not throw
      const result = await cleanupStaleReview(
        "backend",
        state,
        mockStore,
        mockStateManager as any,
        mockLogger
      );

      expect(result.cleaned).toBe(true);
      expect(mockStateManager.endReview).toHaveBeenCalledWith("backend");
    });
  });
});
