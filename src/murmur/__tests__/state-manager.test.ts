/**
 * Tests for MurmurStateManager — persistent state tracking for orchestration reviews.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MurmurStateManager } from "../state-manager.js";
import type { MurmurState } from "../state-manager.js";

describe("MurmurStateManager", () => {
  const testStateDir = ".murmur-test";
  let manager: MurmurStateManager;

  beforeEach(async () => {
    // Clean up test directory
    await rm(testStateDir, { recursive: true, force: true });
    manager = new MurmurStateManager({ stateDir: testStateDir });
  });

  afterEach(async () => {
    // Clean up test directory
    await rm(testStateDir, { recursive: true, force: true });
  });

  describe("load", () => {
    it("should return default state when file doesn't exist", async () => {
      const state = await manager.load("team-alpha");

      expect(state).toEqual({
        teamId: "team-alpha",
        lastReviewAt: null,
        completionsSinceLastReview: 0,
        failuresSinceLastReview: 0,
        currentReviewTaskId: null,
        lastTriggeredBy: null,
      });
    });

    it("should load existing state from disk", async () => {
      // Save a state first
      const initialState: MurmurState = {
        teamId: "team-beta",
        lastReviewAt: "2026-02-17T10:00:00.000Z",
        completionsSinceLastReview: 5,
        failuresSinceLastReview: 2,
        currentReviewTaskId: "TASK-123",
        lastTriggeredBy: "completionBatch",
      };

      await manager.save("team-beta", initialState);

      // Load it back
      const loaded = await manager.load("team-beta");

      expect(loaded).toEqual(initialState);
    });

    it("should handle corrupt JSON gracefully and return defaults", async () => {
      const logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      const managerWithLogger = new MurmurStateManager({
        stateDir: testStateDir,
        logger,
      });

      // Create state directory and write corrupt JSON
      await mkdir(testStateDir, { recursive: true });
      const filePath = join(testStateDir, "team-corrupt.json");
      await writeFile(filePath, "{invalid json}", "utf-8");

      // Load should return defaults and log warning
      const state = await managerWithLogger.load("team-corrupt");

      expect(state).toEqual({
        teamId: "team-corrupt",
        lastReviewAt: null,
        completionsSinceLastReview: 0,
        failuresSinceLastReview: 0,
        currentReviewTaskId: null,
        lastTriggeredBy: null,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        "Failed to load murmur state, using defaults",
        expect.objectContaining({
          teamId: "team-corrupt",
          filePath,
        })
      );
    });

    it("should handle missing required fields gracefully", async () => {
      // Create state directory and write JSON with missing teamId
      await mkdir(testStateDir, { recursive: true });
      const filePath = join(testStateDir, "team-missing.json");
      await writeFile(filePath, JSON.stringify({ foo: "bar" }), "utf-8");

      const logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      const managerWithLogger = new MurmurStateManager({
        stateDir: testStateDir,
        logger,
      });

      // Load should return defaults and log warning
      const state = await managerWithLogger.load("team-missing");

      expect(state.teamId).toBe("team-missing");
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe("save", () => {
    it("should save state atomically to disk", async () => {
      const state: MurmurState = {
        teamId: "team-gamma",
        lastReviewAt: "2026-02-17T11:00:00.000Z",
        completionsSinceLastReview: 10,
        failuresSinceLastReview: 3,
        currentReviewTaskId: null,
        lastTriggeredBy: "interval",
      };

      await manager.save("team-gamma", state);

      // Verify file exists and contains correct data
      const filePath = join(testStateDir, "team-gamma.json");
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);

      expect(parsed).toEqual(state);
    });

    it("should create state directory if it doesn't exist", async () => {
      // Remove directory if it exists
      await rm(testStateDir, { recursive: true, force: true });

      const state: MurmurState = {
        teamId: "team-delta",
        lastReviewAt: null,
        completionsSinceLastReview: 0,
        failuresSinceLastReview: 0,
        currentReviewTaskId: null,
        lastTriggeredBy: null,
      };

      // Should not throw
      await manager.save("team-delta", state);

      // Verify file was created
      const filePath = join(testStateDir, "team-delta.json");
      const raw = await readFile(filePath, "utf-8");
      expect(JSON.parse(raw)).toEqual(state);
    });

    it("should reject state with mismatched teamId", async () => {
      const state: MurmurState = {
        teamId: "team-wrong",
        lastReviewAt: null,
        completionsSinceLastReview: 0,
        failuresSinceLastReview: 0,
        currentReviewTaskId: null,
        lastTriggeredBy: null,
      };

      await expect(manager.save("team-epsilon", state)).rejects.toThrow(
        "State teamId mismatch: expected team-epsilon, got team-wrong"
      );
    });
  });

  describe("incrementCompletions", () => {
    it("should increment completions counter", async () => {
      // Start with default state
      let state = await manager.load("team-zeta");
      expect(state.completionsSinceLastReview).toBe(0);

      // Increment twice
      await manager.incrementCompletions("team-zeta");
      await manager.incrementCompletions("team-zeta");

      // Verify counter increased
      state = await manager.load("team-zeta");
      expect(state.completionsSinceLastReview).toBe(2);
    });
  });

  describe("incrementFailures", () => {
    it("should increment failures counter", async () => {
      // Start with default state
      let state = await manager.load("team-eta");
      expect(state.failuresSinceLastReview).toBe(0);

      // Increment three times
      await manager.incrementFailures("team-eta");
      await manager.incrementFailures("team-eta");
      await manager.incrementFailures("team-eta");

      // Verify counter increased
      state = await manager.load("team-eta");
      expect(state.failuresSinceLastReview).toBe(3);
    });
  });

  describe("startReview", () => {
    it("should start a review and reset counters", async () => {
      // Set up state with some completions/failures
      await manager.incrementCompletions("team-theta");
      await manager.incrementCompletions("team-theta");
      await manager.incrementFailures("team-theta");

      // Start review
      await manager.startReview("team-theta", "TASK-456", "queueEmpty");

      // Verify state
      const state = await manager.load("team-theta");
      expect(state.currentReviewTaskId).toBe("TASK-456");
      expect(state.lastTriggeredBy).toBe("queueEmpty");
      expect(state.lastReviewAt).toBeTruthy();
      expect(state.completionsSinceLastReview).toBe(0);
      expect(state.failuresSinceLastReview).toBe(0);

      // Verify timestamp is recent (within 1 second)
      const reviewTime = new Date(state.lastReviewAt!);
      const now = new Date();
      expect(now.getTime() - reviewTime.getTime()).toBeLessThan(1000);
    });
  });

  describe("endReview", () => {
    it("should clear currentReviewTaskId", async () => {
      // Start a review first
      await manager.startReview("team-iota", "TASK-789", "interval");

      // Verify review is in progress
      let state = await manager.load("team-iota");
      expect(state.currentReviewTaskId).toBe("TASK-789");

      // End review
      await manager.endReview("team-iota");

      // Verify currentReviewTaskId is cleared
      state = await manager.load("team-iota");
      expect(state.currentReviewTaskId).toBeNull();
      // Other fields should remain
      expect(state.lastReviewAt).toBeTruthy();
      expect(state.lastTriggeredBy).toBe("interval");
    });
  });

  describe("isReviewInProgress", () => {
    it("should return false when no review is in progress", async () => {
      const inProgress = await manager.isReviewInProgress("team-kappa");
      expect(inProgress).toBe(false);
    });

    it("should return true when review is in progress", async () => {
      await manager.startReview("team-lambda", "TASK-999", "failureBatch");

      const inProgress = await manager.isReviewInProgress("team-lambda");
      expect(inProgress).toBe(true);
    });

    it("should return false after review ends", async () => {
      await manager.startReview("team-mu", "TASK-111", "completionBatch");
      expect(await manager.isReviewInProgress("team-mu")).toBe(true);

      await manager.endReview("team-mu");
      expect(await manager.isReviewInProgress("team-mu")).toBe(false);
    });
  });

  describe("concurrent access", () => {
    it("should handle concurrent increments correctly", async () => {
      // Simulate concurrent increments
      const promises = Array.from({ length: 10 }, () =>
        manager.incrementCompletions("team-concurrent")
      );

      await Promise.all(promises);

      // Verify final count
      const state = await manager.load("team-concurrent");
      expect(state.completionsSinceLastReview).toBe(10);
    });

    it("should handle mixed concurrent operations", async () => {
      // Mix of completions and failures
      const promises = [
        manager.incrementCompletions("team-mixed"),
        manager.incrementCompletions("team-mixed"),
        manager.incrementFailures("team-mixed"),
        manager.incrementCompletions("team-mixed"),
        manager.incrementFailures("team-mixed"),
      ];

      await Promise.all(promises);

      const state = await manager.load("team-mixed");
      expect(state.completionsSinceLastReview).toBe(3);
      expect(state.failuresSinceLastReview).toBe(2);
    });
  });

  describe("review lifecycle", () => {
    it("should handle complete review lifecycle", async () => {
      const teamId = "team-lifecycle";

      // 1. Initial state
      let state = await manager.load(teamId);
      expect(state.currentReviewTaskId).toBeNull();
      expect(state.lastReviewAt).toBeNull();

      // 2. Track some activity
      await manager.incrementCompletions(teamId);
      await manager.incrementCompletions(teamId);
      await manager.incrementFailures(teamId);

      state = await manager.load(teamId);
      expect(state.completionsSinceLastReview).toBe(2);
      expect(state.failuresSinceLastReview).toBe(1);

      // 3. Start review (should reset counters)
      await manager.startReview(teamId, "REVIEW-001", "completionBatch");

      state = await manager.load(teamId);
      expect(state.currentReviewTaskId).toBe("REVIEW-001");
      expect(state.lastTriggeredBy).toBe("completionBatch");
      expect(state.completionsSinceLastReview).toBe(0);
      expect(state.failuresSinceLastReview).toBe(0);
      expect(await manager.isReviewInProgress(teamId)).toBe(true);

      // 4. More activity during review
      await manager.incrementCompletions(teamId);

      // 5. End review
      await manager.endReview(teamId);

      state = await manager.load(teamId);
      expect(state.currentReviewTaskId).toBeNull();
      expect(state.completionsSinceLastReview).toBe(1);
      expect(state.lastReviewAt).toBeTruthy();
      expect(await manager.isReviewInProgress(teamId)).toBe(false);
    });
  });
});
