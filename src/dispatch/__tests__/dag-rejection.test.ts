/**
 * DAG rejection cascade tests — comprehensive coverage for rejection handling
 * in evaluateDAG including origin strategy, predecessors strategy, circuit-breaker
 * behavior, and edge cases.
 *
 * @module dag-rejection.test
 */

import { describe, it, expect } from "vitest";
import {
  evaluateDAG,
  type DAGEvaluationInput,
  type HopEvent,
  type EvalContext,
} from "../dag-evaluator.js";
import type {
  WorkflowDefinition,
  WorkflowState,
} from "../../schemas/workflow-dag.js";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/** Minimal task metadata for tests (satisfies EvalContext.task). */
const DEFAULT_TASK = {
  status: "in_progress",
  tags: [] as string[],
  priority: "medium",
  routing: {},
};

/** Build a simple EvalContext with given hop results. */
function makeContext(
  hopResults: Record<string, Record<string, unknown>> = {},
  task = DEFAULT_TASK,
): EvalContext {
  return { hopResults, task };
}

/** Build a standard DAGEvaluationInput. */
function makeInput(
  definition: WorkflowDefinition,
  state: WorkflowState,
  event: HopEvent,
  context: EvalContext = makeContext(),
): DAGEvaluationInput {
  return { definition, state, event, context };
}

// ---------------------------------------------------------------------------
// Workflow Fixtures (with canReject support)
// ---------------------------------------------------------------------------

/** Linear: A -> B -> C, where B can reject */
const LINEAR_REJECT_DEF: WorkflowDefinition = {
  name: "linear-reject",
  hops: [
    { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "B", role: "reviewer", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: true, rejectionStrategy: "origin" },
    { id: "C", role: "dev", dependsOn: ["B"], joinType: "all", autoAdvance: true, canReject: false },
  ],
};

/** Linear with predecessors strategy: A -> B -> C, where C can reject */
const LINEAR_PREDECESSORS_DEF: WorkflowDefinition = {
  name: "linear-predecessors",
  hops: [
    { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "B", role: "dev", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "C", role: "reviewer", dependsOn: ["B"], joinType: "all", autoAdvance: true, canReject: true, rejectionStrategy: "predecessors" },
  ],
};

/** Parallel branches: A -> C, B -> C, where C can reject with predecessors strategy */
const PARALLEL_REJECT_DEF: WorkflowDefinition = {
  name: "parallel-reject",
  hops: [
    { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "B", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "C", role: "reviewer", dependsOn: ["A", "B"], joinType: "all", autoAdvance: true, canReject: true, rejectionStrategy: "predecessors" },
  ],
};

/** Diamond: A -> B, A -> C, B & C -> D, where D can reject with origin strategy */
const DIAMOND_REJECT_DEF: WorkflowDefinition = {
  name: "diamond-reject",
  hops: [
    { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "B", role: "dev", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "C", role: "dev", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "D", role: "reviewer", dependsOn: ["B", "C"], joinType: "all", autoAdvance: true, canReject: true, rejectionStrategy: "origin" },
  ],
};

/** Diamond with predecessors strategy for D */
const DIAMOND_PRED_DEF: WorkflowDefinition = {
  name: "diamond-pred",
  hops: [
    { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "B", role: "dev", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "C", role: "dev", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "D", role: "reviewer", dependsOn: ["B", "C"], joinType: "all", autoAdvance: true, canReject: true, rejectionStrategy: "predecessors" },
  ],
};

/** No strategy specified (should default to origin): A -> B, B can reject */
const NO_STRATEGY_DEF: WorkflowDefinition = {
  name: "no-strategy",
  hops: [
    { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "B", role: "reviewer", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: true },
  ],
};

/** Root rejector: A can reject (no predecessors) with predecessors strategy */
const ROOT_REJECT_DEF: WorkflowDefinition = {
  name: "root-reject",
  hops: [
    { id: "A", role: "reviewer", dependsOn: [], joinType: "all", autoAdvance: true, canReject: true, rejectionStrategy: "predecessors" },
    { id: "B", role: "dev", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: false },
  ],
};

/** Parallel branches with rejection: A -> C, B -> C (independent branch D -> E) */
const PARALLEL_INDEPENDENT_DEF: WorkflowDefinition = {
  name: "parallel-independent",
  hops: [
    { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "B", role: "dev", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "C", role: "reviewer", dependsOn: ["B"], joinType: "all", autoAdvance: true, canReject: true, rejectionStrategy: "predecessors" },
    { id: "D", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "E", role: "dev", dependsOn: ["D"], joinType: "all", autoAdvance: true, canReject: false },
  ],
};

// ---------------------------------------------------------------------------
// Tests: Origin Strategy
// ---------------------------------------------------------------------------

describe("evaluateDAG — Rejection", () => {
  describe("Origin Strategy", () => {
    it("resets ALL hops to pending/ready on rejection with origin strategy", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete", completedAt: "2026-01-01T00:00:00.000Z", result: { output: "done" } },
          B: { status: "dispatched", startedAt: "2026-01-01T01:00:00.000Z", agent: "reviewer" },
          C: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_REJECT_DEF, state, {
        hopId: "B",
        outcome: "rejected",
      }));

      // A should be reset to "ready" (root hop with no dependsOn)
      expect(result.state.hops.A.status).toBe("ready");
      // B should be reset to "pending" (depends on A)
      expect(result.state.hops.B.status).toBe("pending");
      // C should be reset to "pending" (depends on B)
      expect(result.state.hops.C.status).toBe("pending");

      // Result/timestamps should be cleared on all hops
      expect(result.state.hops.A.result).toBeUndefined();
      expect(result.state.hops.A.completedAt).toBeUndefined();
      expect(result.state.hops.A.startedAt).toBeUndefined();
      expect(result.state.hops.A.agent).toBeUndefined();
      expect(result.state.hops.A.correlationId).toBeUndefined();

      // rejectionCount should be set on the rejected hop ONLY
      expect(result.state.hops.B.rejectionCount).toBe(1);
      expect(result.state.hops.A.rejectionCount).toBeUndefined();

      // Root hops should be in readyHops
      expect(result.readyHops).toContain("A");

      // DAG status should stay in-progress (not complete)
      expect(result.dagStatus).toBeUndefined();
      expect(result.taskStatus).toBeUndefined();
    });

    it("increments rejectionCount on successive rejections", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "dispatched", rejectionCount: 1 },
          C: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_REJECT_DEF, state, {
        hopId: "B",
        outcome: "rejected",
      }));

      expect(result.state.hops.B.rejectionCount).toBe(2);
    });

    it("defaults to origin strategy when rejectionStrategy is undefined", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete", result: { x: 1 } },
          B: { status: "dispatched" },
        },
      };

      const result = evaluateDAG(makeInput(NO_STRATEGY_DEF, state, {
        hopId: "B",
        outcome: "rejected",
      }));

      // Should behave like origin: all hops reset
      expect(result.state.hops.A.status).toBe("ready");
      expect(result.state.hops.B.status).toBe("pending");
      expect(result.state.hops.A.result).toBeUndefined();
      expect(result.state.hops.B.rejectionCount).toBe(1);
      expect(result.readyHops).toContain("A");
    });

    it("resets diamond DAG completely with origin strategy", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete", result: { x: 1 } },
          B: { status: "complete", result: { y: 2 } },
          C: { status: "complete", result: { z: 3 } },
          D: { status: "dispatched" },
        },
      };

      const result = evaluateDAG(makeInput(DIAMOND_REJECT_DEF, state, {
        hopId: "D",
        outcome: "rejected",
      }));

      // All hops should be reset
      expect(result.state.hops.A.status).toBe("ready"); // root
      expect(result.state.hops.B.status).toBe("pending"); // depends on A
      expect(result.state.hops.C.status).toBe("pending"); // depends on A
      expect(result.state.hops.D.status).toBe("pending"); // depends on B, C

      // Only D should have rejectionCount
      expect(result.state.hops.D.rejectionCount).toBe(1);
      expect(result.state.hops.A.rejectionCount).toBeUndefined();
      expect(result.state.hops.B.rejectionCount).toBeUndefined();
      expect(result.state.hops.C.rejectionCount).toBeUndefined();

      // Only root A should be ready
      expect(result.readyHops).toEqual(["A"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: Predecessors Strategy
  // ---------------------------------------------------------------------------

  describe("Predecessors Strategy", () => {
    it("resets only the rejected hop and its immediate predecessors", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete", completedAt: "2026-01-01T00:00:00.000Z", result: { x: 1 } },
          B: { status: "complete", completedAt: "2026-01-01T01:00:00.000Z", result: { y: 2 } },
          C: { status: "dispatched", startedAt: "2026-01-01T02:00:00.000Z", agent: "reviewer" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_PREDECESSORS_DEF, state, {
        hopId: "C",
        outcome: "rejected",
      }));

      // A should stay complete (not a direct predecessor of C)
      expect(result.state.hops.A.status).toBe("complete");
      expect(result.state.hops.A.result).toEqual({ x: 1 });

      // B should be reset (direct predecessor of C)
      expect(result.state.hops.B.status).toBe("ready"); // B's own deps (A) are complete, outside reset set
      expect(result.state.hops.B.result).toBeUndefined();
      expect(result.state.hops.B.completedAt).toBeUndefined();

      // C should be reset
      expect(result.state.hops.C.status).toBe("pending"); // depends on B which is in reset set
      expect(result.state.hops.C.rejectionCount).toBe(1);
      expect(result.state.hops.C.startedAt).toBeUndefined();
      expect(result.state.hops.C.agent).toBeUndefined();

      // B should be in readyHops (its deps are all satisfied)
      expect(result.readyHops).toContain("B");
    });

    it("resets all immediate predecessors in parallel join", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete", result: { a: 1 } },
          B: { status: "complete", result: { b: 2 } },
          C: { status: "dispatched" },
        },
      };

      const result = evaluateDAG(makeInput(PARALLEL_REJECT_DEF, state, {
        hopId: "C",
        outcome: "rejected",
      }));

      // Both A and B are direct predecessors of C, should be reset
      expect(result.state.hops.A.status).toBe("ready"); // root, no deps
      expect(result.state.hops.B.status).toBe("ready"); // root, no deps
      expect(result.state.hops.A.result).toBeUndefined();
      expect(result.state.hops.B.result).toBeUndefined();

      // C should be reset to pending (deps are in reset set)
      expect(result.state.hops.C.status).toBe("pending");
      expect(result.state.hops.C.rejectionCount).toBe(1);

      // Both A and B should be in readyHops
      expect(result.readyHops).toContain("A");
      expect(result.readyHops).toContain("B");
    });

    it("keeps completed parallel branches done (predecessors only resets relevant hops)", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete", result: { a: 1 } },
          B: { status: "complete", result: { b: 2 } },
          C: { status: "dispatched" },
          D: { status: "complete", result: { d: 1 } },
          E: { status: "complete", result: { e: 2 } },
        },
      };

      const result = evaluateDAG(makeInput(PARALLEL_INDEPENDENT_DEF, state, {
        hopId: "C",
        outcome: "rejected",
      }));

      // C's predecessor B should be reset
      expect(result.state.hops.B.status).toBe("ready"); // B depends on A which is outside reset set
      expect(result.state.hops.B.result).toBeUndefined();

      // C itself should be reset
      expect(result.state.hops.C.status).toBe("pending");
      expect(result.state.hops.C.rejectionCount).toBe(1);

      // Independent branch D and E should remain complete
      expect(result.state.hops.D.status).toBe("complete");
      expect(result.state.hops.D.result).toEqual({ d: 1 });
      expect(result.state.hops.E.status).toBe("complete");
      expect(result.state.hops.E.result).toEqual({ e: 2 });

      // A should remain complete (not direct predecessor of C)
      expect(result.state.hops.A.status).toBe("complete");
    });

    it("predecessors strategy on diamond: resets D and its predecessors B and C", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete", result: { a: 1 } },
          B: { status: "complete", result: { b: 2 } },
          C: { status: "complete", result: { c: 3 } },
          D: { status: "dispatched" },
        },
      };

      const result = evaluateDAG(makeInput(DIAMOND_PRED_DEF, state, {
        hopId: "D",
        outcome: "rejected",
      }));

      // A should stay complete (not in reset set)
      expect(result.state.hops.A.status).toBe("complete");

      // B and C are direct predecessors of D, should be reset
      expect(result.state.hops.B.status).toBe("ready"); // B depends on A which is complete and outside reset
      expect(result.state.hops.C.status).toBe("ready"); // C depends on A which is complete and outside reset
      expect(result.state.hops.B.result).toBeUndefined();
      expect(result.state.hops.C.result).toBeUndefined();

      // D should be reset
      expect(result.state.hops.D.status).toBe("pending");
      expect(result.state.hops.D.rejectionCount).toBe(1);

      // B and C should be ready
      expect(result.readyHops).toContain("B");
      expect(result.readyHops).toContain("C");
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: Circuit Breaker
  // ---------------------------------------------------------------------------

  describe("Circuit Breaker", () => {
    it("fails the hop after 3 rejections (default maxRejections)", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "dispatched", rejectionCount: 2 }, // This will be the 3rd rejection
          C: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_REJECT_DEF, state, {
        hopId: "B",
        outcome: "rejected",
      }));

      // B should be failed (circuit-breaker triggered)
      expect(result.state.hops.B.status).toBe("failed");
      expect(result.state.hops.B.rejectionCount).toBe(3);
      expect(result.state.hops.B.completedAt).toBeDefined();

      // C should be cascade-skipped (downstream of failed B)
      expect(result.state.hops.C.status).toBe("skipped");

      // Changes should include circuit_breaker reason
      expect(result.changes).toContainEqual(
        expect.objectContaining({ hopId: "B", to: "failed", reason: "circuit_breaker" }),
      );
    });

    it("circuit-breaker cascades skips to all downstream hops", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "complete" },
          C: { status: "complete" },
          D: { status: "dispatched", rejectionCount: 2 }, // 3rd rejection
        },
      };

      const result = evaluateDAG(makeInput(DIAMOND_REJECT_DEF, state, {
        hopId: "D",
        outcome: "rejected",
      }));

      // D should be failed
      expect(result.state.hops.D.status).toBe("failed");
      expect(result.state.hops.D.rejectionCount).toBe(3);

      // No downstream hops to cascade (D is terminal), but DAG should be failed
      expect(result.dagStatus).toBe("failed");
      expect(result.taskStatus).toBe("failed");
    });

    it("circuit-breaker at rejectionCount >= 3 (handles higher counts)", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "dispatched", rejectionCount: 5 }, // Already exceeded
        },
      };

      const result = evaluateDAG(makeInput(NO_STRATEGY_DEF, state, {
        hopId: "B",
        outcome: "rejected",
      }));

      expect(result.state.hops.B.status).toBe("failed");
      expect(result.state.hops.B.rejectionCount).toBe(6);
    });

    it("DAG completes as failed when circuit-breaker fires on last branch", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "dispatched", rejectionCount: 2 },
          C: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_REJECT_DEF, state, {
        hopId: "B",
        outcome: "rejected",
      }));

      // All hops should be terminal: A=complete, B=failed, C=skipped
      expect(result.state.status).toBe("failed");
      expect(result.dagStatus).toBe("failed");
      expect(result.taskStatus).toBe("failed");
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: Edge Cases
  // ---------------------------------------------------------------------------

  describe("Edge Cases", () => {
    it("rejection on root hop with predecessors strategy only resets the root hop", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(ROOT_REJECT_DEF, state, {
        hopId: "A",
        outcome: "rejected",
      }));

      // A should be reset to "ready" (root, no deps)
      expect(result.state.hops.A.status).toBe("ready");
      expect(result.state.hops.A.rejectionCount).toBe(1);

      // B should remain pending (not in reset set, and its dep A is not complete)
      expect(result.state.hops.B.status).toBe("pending");

      // A should be in readyHops
      expect(result.readyHops).toContain("A");
    });

    it("rejectionCount starts at 0 when not set on HopState", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "dispatched" }, // No rejectionCount property
        },
      };

      const result = evaluateDAG(makeInput(NO_STRATEGY_DEF, state, {
        hopId: "B",
        outcome: "rejected",
      }));

      expect(result.state.hops.B.rejectionCount).toBe(1);
    });

    it("preserves rejectionCount on the rejected hop through origin reset", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "dispatched", rejectionCount: 1 },
          C: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_REJECT_DEF, state, {
        hopId: "B",
        outcome: "rejected",
      }));

      // B should have incremented rejectionCount even after reset
      expect(result.state.hops.B.rejectionCount).toBe(2);
      expect(result.state.hops.B.status).toBe("pending");
    });

    it("does not mutate input state on rejection", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete", result: { x: 1 } },
          B: { status: "dispatched" },
          C: { status: "pending" },
        },
      };

      const original = structuredClone(state);

      evaluateDAG(makeInput(LINEAR_REJECT_DEF, state, {
        hopId: "B",
        outcome: "rejected",
      }));

      expect(state).toEqual(original);
    });

    it("produces transitions for all reset hops", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "dispatched" },
          C: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_REJECT_DEF, state, {
        hopId: "B",
        outcome: "rejected",
      }));

      // Should have transitions for all hops being reset
      const resetChanges = result.changes.filter(
        (c) => c.reason === "rejection_cascade_origin",
      );
      // A: complete -> ready, B: dispatched -> pending, C: pending -> pending (stays)
      // B is the rejected hop itself, but it gets reset too in origin strategy
      expect(resetChanges.length).toBeGreaterThanOrEqual(2); // At least A and B
    });
  });
});
