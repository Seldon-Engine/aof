/**
 * Tests for murmur trigger evaluator.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { evaluateTriggers, type TaskStats, type TriggerResult } from "../trigger-evaluator.js";
import type { MurmurState } from "../state-manager.js";
import type { MurmurTrigger } from "../../schemas/org-chart.js";

describe("evaluateTriggers", () => {
  let baseState: MurmurState;

  beforeEach(() => {
    baseState = {
      teamId: "test-team",
      lastReviewAt: new Date("2026-02-17T10:00:00Z").toISOString(),
      completionsSinceLastReview: 0,
      failuresSinceLastReview: 0,
      currentReviewTaskId: null,
      lastTriggeredBy: null,
    };
  });

  describe("queueEmpty trigger", () => {
    test("fires when both ready and in-progress queues are empty", () => {
      const triggers: MurmurTrigger[] = [{ kind: "queueEmpty" }];
      const taskStats: TaskStats = { ready: 0, inProgress: 0 };

      const result = evaluateTriggers(triggers, baseState, taskStats);

      expect(result.shouldFire).toBe(true);
      expect(result.triggeredBy).toBe("queueEmpty");
      expect(result.reason).toContain("empty");
    });

    test("does not fire when ready queue has tasks", () => {
      const triggers: MurmurTrigger[] = [{ kind: "queueEmpty" }];
      const taskStats: TaskStats = { ready: 3, inProgress: 0 };

      const result = evaluateTriggers(triggers, baseState, taskStats);

      expect(result.shouldFire).toBe(false);
      expect(result.triggeredBy).toBe(null);
    });

    test("does not fire when in-progress queue has tasks", () => {
      const triggers: MurmurTrigger[] = [{ kind: "queueEmpty" }];
      const taskStats: TaskStats = { ready: 0, inProgress: 2 };

      const result = evaluateTriggers(triggers, baseState, taskStats);

      expect(result.shouldFire).toBe(false);
      expect(result.triggeredBy).toBe(null);
    });

    test("does not fire when both queues have tasks", () => {
      const triggers: MurmurTrigger[] = [{ kind: "queueEmpty" }];
      const taskStats: TaskStats = { ready: 5, inProgress: 3 };

      const result = evaluateTriggers(triggers, baseState, taskStats);

      expect(result.shouldFire).toBe(false);
      expect(result.triggeredBy).toBe(null);
    });
  });

  describe("completionBatch trigger", () => {
    test("fires when completions meet threshold", () => {
      const triggers: MurmurTrigger[] = [{ kind: "completionBatch", threshold: 5 }];
      const state: MurmurState = { ...baseState, completionsSinceLastReview: 5 };
      const taskStats: TaskStats = { ready: 10, inProgress: 2 };

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(true);
      expect(result.triggeredBy).toBe("completionBatch");
      expect(result.reason).toContain("5");
      expect(result.reason).toContain("threshold");
    });

    test("fires when completions exceed threshold", () => {
      const triggers: MurmurTrigger[] = [{ kind: "completionBatch", threshold: 5 }];
      const state: MurmurState = { ...baseState, completionsSinceLastReview: 8 };
      const taskStats: TaskStats = { ready: 10, inProgress: 2 };

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(true);
      expect(result.triggeredBy).toBe("completionBatch");
    });

    test("does not fire when completions below threshold", () => {
      const triggers: MurmurTrigger[] = [{ kind: "completionBatch", threshold: 5 }];
      const state: MurmurState = { ...baseState, completionsSinceLastReview: 3 };
      const taskStats: TaskStats = { ready: 10, inProgress: 2 };

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(false);
      expect(result.triggeredBy).toBe(null);
    });

    test("does not fire when threshold is missing", () => {
      const triggers: MurmurTrigger[] = [{ kind: "completionBatch" }];
      const state: MurmurState = { ...baseState, completionsSinceLastReview: 100 };
      const taskStats: TaskStats = { ready: 10, inProgress: 2 };

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(false);
      expect(result.triggeredBy).toBe(null);
    });
  });

  describe("interval trigger", () => {
    test("fires when interval has elapsed", () => {
      const triggers: MurmurTrigger[] = [{ kind: "interval", intervalMs: 60000 }]; // 1 minute
      const pastTime = new Date(Date.now() - 120000).toISOString(); // 2 minutes ago
      const state: MurmurState = { ...baseState, lastReviewAt: pastTime };
      const taskStats: TaskStats = { ready: 10, inProgress: 2 };

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(true);
      expect(result.triggeredBy).toBe("interval");
      expect(result.reason).toContain("elapsed");
    });

    test("fires immediately when no review has occurred", () => {
      const triggers: MurmurTrigger[] = [{ kind: "interval", intervalMs: 60000 }];
      const state: MurmurState = { ...baseState, lastReviewAt: null };
      const taskStats: TaskStats = { ready: 10, inProgress: 2 };

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(true);
      expect(result.triggeredBy).toBe("interval");
      expect(result.reason).toContain("No review");
    });

    test("does not fire when interval has not elapsed", () => {
      const triggers: MurmurTrigger[] = [{ kind: "interval", intervalMs: 60000 }]; // 1 minute
      const recentTime = new Date(Date.now() - 30000).toISOString(); // 30 seconds ago
      const state: MurmurState = { ...baseState, lastReviewAt: recentTime };
      const taskStats: TaskStats = { ready: 10, inProgress: 2 };

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(false);
      expect(result.triggeredBy).toBe(null);
    });

    test("does not fire when intervalMs is missing", () => {
      const triggers: MurmurTrigger[] = [{ kind: "interval" }];
      const state: MurmurState = { ...baseState, lastReviewAt: null };
      const taskStats: TaskStats = { ready: 10, inProgress: 2 };

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(false);
      expect(result.triggeredBy).toBe(null);
    });
  });

  describe("failureBatch trigger", () => {
    test("fires when failures meet threshold", () => {
      const triggers: MurmurTrigger[] = [{ kind: "failureBatch", threshold: 3 }];
      const state: MurmurState = { ...baseState, failuresSinceLastReview: 3 };
      const taskStats: TaskStats = { ready: 10, inProgress: 2 };

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(true);
      expect(result.triggeredBy).toBe("failureBatch");
      expect(result.reason).toContain("3");
      expect(result.reason).toContain("failures");
    });

    test("fires when failures exceed threshold", () => {
      const triggers: MurmurTrigger[] = [{ kind: "failureBatch", threshold: 3 }];
      const state: MurmurState = { ...baseState, failuresSinceLastReview: 5 };
      const taskStats: TaskStats = { ready: 10, inProgress: 2 };

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(true);
      expect(result.triggeredBy).toBe("failureBatch");
    });

    test("does not fire when failures below threshold", () => {
      const triggers: MurmurTrigger[] = [{ kind: "failureBatch", threshold: 3 }];
      const state: MurmurState = { ...baseState, failuresSinceLastReview: 1 };
      const taskStats: TaskStats = { ready: 10, inProgress: 2 };

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(false);
      expect(result.triggeredBy).toBe(null);
    });

    test("does not fire when threshold is missing", () => {
      const triggers: MurmurTrigger[] = [{ kind: "failureBatch" }];
      const state: MurmurState = { ...baseState, failuresSinceLastReview: 100 };
      const taskStats: TaskStats = { ready: 10, inProgress: 2 };

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(false);
      expect(result.triggeredBy).toBe(null);
    });
  });

  describe("idempotency guard", () => {
    test("never fires when review is already in progress", () => {
      const triggers: MurmurTrigger[] = [
        { kind: "queueEmpty" },
        { kind: "completionBatch", threshold: 1 },
        { kind: "interval", intervalMs: 1 },
        { kind: "failureBatch", threshold: 1 },
      ];

      const state: MurmurState = {
        ...baseState,
        currentReviewTaskId: "murmur-123",
        completionsSinceLastReview: 100,
        failuresSinceLastReview: 100,
        lastReviewAt: new Date(Date.now() - 1000000).toISOString(),
      };

      const taskStats: TaskStats = { ready: 0, inProgress: 0 };

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(false);
      expect(result.triggeredBy).toBe(null);
      expect(result.reason).toBe(null);
    });
  });

  describe("multiple triggers", () => {
    test("first trigger wins when multiple could fire", () => {
      const triggers: MurmurTrigger[] = [
        { kind: "completionBatch", threshold: 5 },
        { kind: "queueEmpty" }, // Would also fire
        { kind: "failureBatch", threshold: 2 }, // Would also fire
      ];

      const state: MurmurState = {
        ...baseState,
        completionsSinceLastReview: 10, // Exceeds threshold
        failuresSinceLastReview: 3, // Exceeds threshold
      };

      const taskStats: TaskStats = { ready: 0, inProgress: 0 }; // Empty queue

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(true);
      expect(result.triggeredBy).toBe("completionBatch");
    });

    test("evaluates triggers in order until one fires", () => {
      const triggers: MurmurTrigger[] = [
        { kind: "queueEmpty" }, // Won't fire
        { kind: "completionBatch", threshold: 5 }, // Won't fire
        { kind: "failureBatch", threshold: 2 }, // WILL fire
        { kind: "interval", intervalMs: 1 }, // Would also fire, but ignored
      ];

      const state: MurmurState = {
        ...baseState,
        completionsSinceLastReview: 2, // Below threshold
        failuresSinceLastReview: 3, // Exceeds threshold
        lastReviewAt: new Date(Date.now() - 1000000).toISOString(),
      };

      const taskStats: TaskStats = { ready: 5, inProgress: 2 }; // Not empty

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(true);
      expect(result.triggeredBy).toBe("failureBatch");
    });

    test("returns no fire when no triggers match", () => {
      const triggers: MurmurTrigger[] = [
        { kind: "queueEmpty" },
        { kind: "completionBatch", threshold: 10 },
        { kind: "failureBatch", threshold: 5 },
      ];

      const state: MurmurState = {
        ...baseState,
        completionsSinceLastReview: 3,
        failuresSinceLastReview: 2,
      };

      const taskStats: TaskStats = { ready: 5, inProgress: 2 };

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(false);
      expect(result.triggeredBy).toBe(null);
      expect(result.reason).toBe(null);
    });
  });

  describe("edge cases", () => {
    test("handles empty trigger array", () => {
      const triggers: MurmurTrigger[] = [];
      const taskStats: TaskStats = { ready: 0, inProgress: 0 };

      const result = evaluateTriggers(triggers, baseState, taskStats);

      expect(result.shouldFire).toBe(false);
      expect(result.triggeredBy).toBe(null);
    });

    test("handles completions exactly at threshold", () => {
      const triggers: MurmurTrigger[] = [{ kind: "completionBatch", threshold: 5 }];
      const state: MurmurState = { ...baseState, completionsSinceLastReview: 5 };
      const taskStats: TaskStats = { ready: 10, inProgress: 2 };

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(true);
    });

    test("handles failures exactly at threshold", () => {
      const triggers: MurmurTrigger[] = [{ kind: "failureBatch", threshold: 3 }];
      const state: MurmurState = { ...baseState, failuresSinceLastReview: 3 };
      const taskStats: TaskStats = { ready: 10, inProgress: 2 };

      const result = evaluateTriggers(triggers, state, taskStats);

      expect(result.shouldFire).toBe(true);
    });
  });
});
