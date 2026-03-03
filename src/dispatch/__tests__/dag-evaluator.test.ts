/**
 * DAG evaluator tests — comprehensive coverage for evaluateDAG() including
 * primary event application, skip cascading, condition evaluation, join types,
 * DAG completion, and immutability.
 *
 * @module dag-evaluator.test
 */

import { describe, it, expect } from "vitest";
import {
  evaluateDAG,
  type DAGEvaluationInput,
  type DAGEvaluationResult,
  type HopEvent,
  type HopTransition,
  type EvalContext,
} from "../dag-evaluator.js";
import type {
  WorkflowDefinition,
  WorkflowState,
  HopState,
  ConditionExprType,
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
// Workflow Fixtures
// ---------------------------------------------------------------------------

/** Linear: A -> B -> C */
const LINEAR_DEF: WorkflowDefinition = {
  name: "linear",
  hops: [
    { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "B", role: "dev", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "C", role: "dev", dependsOn: ["B"], joinType: "all", autoAdvance: true, canReject: false },
  ],
};

/** Diamond: A -> B, A -> C, B & C -> D (AND-join) */
const DIAMOND_DEF: WorkflowDefinition = {
  name: "diamond",
  hops: [
    { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "B", role: "dev", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "C", role: "dev", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "D", role: "dev", dependsOn: ["B", "C"], joinType: "all", autoAdvance: true, canReject: false },
  ],
};

/** Diamond with OR-join: A -> B, A -> C, B & C -> D (OR-join) */
const DIAMOND_OR_DEF: WorkflowDefinition = {
  name: "diamond-or",
  hops: [
    { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "B", role: "dev", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "C", role: "dev", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "D", role: "dev", dependsOn: ["B", "C"], joinType: "any", autoAdvance: true, canReject: false },
  ],
};

/** Chain: A -> B -> C -> D (for deep cascade tests) */
const CHAIN_DEF: WorkflowDefinition = {
  name: "chain",
  hops: [
    { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "B", role: "dev", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "C", role: "dev", dependsOn: ["B"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "D", role: "dev", dependsOn: ["C"], joinType: "all", autoAdvance: true, canReject: false },
  ],
};

/** Parallel branches: A -> B, C -> D (two independent branches) */
const PARALLEL_DEF: WorkflowDefinition = {
  name: "parallel",
  hops: [
    { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "B", role: "dev", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "C", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "D", role: "dev", dependsOn: ["C"], joinType: "all", autoAdvance: true, canReject: false },
  ],
};

// ---------------------------------------------------------------------------
// Tests: Primary Event Application
// ---------------------------------------------------------------------------

describe("evaluateDAG", () => {
  describe("Primary Event Application", () => {
    it("applies a complete event to a dispatched hop", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched", startedAt: "2026-01-01T00:00:00.000Z" },
          B: { status: "pending" },
          C: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_DEF, state, {
        hopId: "A",
        outcome: "complete",
        result: { output: "done" },
      }));

      expect(result.state.hops.A.status).toBe("complete");
      expect(result.state.hops.A.completedAt).toBeDefined();
      expect(result.state.hops.A.result).toEqual({ output: "done" });
      expect(result.changes).toContainEqual(
        expect.objectContaining({ hopId: "A", from: "dispatched", to: "complete" }),
      );
    });

    it("applies a failed event to a dispatched hop", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
          C: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_DEF, state, {
        hopId: "A",
        outcome: "failed",
      }));

      expect(result.state.hops.A.status).toBe("failed");
      expect(result.state.hops.A.completedAt).toBeDefined();
      expect(result.changes).toContainEqual(
        expect.objectContaining({ hopId: "A", from: "dispatched", to: "failed" }),
      );
    });

    it("applies a skipped event to a pending hop", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "pending" },
          C: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_DEF, state, {
        hopId: "B",
        outcome: "skipped",
      }));

      expect(result.state.hops.B.status).toBe("skipped");
      expect(result.state.hops.B.completedAt).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: Immutability
  // ---------------------------------------------------------------------------

  describe("Immutability", () => {
    it("does not mutate the input state", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
          C: { status: "pending" },
        },
      };

      const original = structuredClone(state);

      evaluateDAG(makeInput(LINEAR_DEF, state, {
        hopId: "A",
        outcome: "complete",
      }));

      expect(state).toEqual(original);
    });

    it("returns a new state object (not the same reference)", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_DEF, state, {
        hopId: "A",
        outcome: "complete",
      }));

      expect(result.state).not.toBe(state);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: Skip Cascade (EXEC-05)
  // ---------------------------------------------------------------------------

  describe("Skip Cascade", () => {
    it("cascades skip to direct downstream when hop fails", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
          C: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_DEF, state, {
        hopId: "A",
        outcome: "failed",
      }));

      expect(result.state.hops.B.status).toBe("skipped");
      expect(result.changes).toContainEqual(
        expect.objectContaining({ hopId: "B", from: "pending", to: "skipped", reason: "cascade" }),
      );
    });

    it("cascades skip recursively through a chain (A -> B -> C -> D)", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
          C: { status: "pending" },
          D: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(CHAIN_DEF, state, {
        hopId: "A",
        outcome: "failed",
      }));

      expect(result.state.hops.B.status).toBe("skipped");
      expect(result.state.hops.C.status).toBe("skipped");
      expect(result.state.hops.D.status).toBe("skipped");

      // All three cascade-skipped hops should be in the changes array
      const cascadeChanges = result.changes.filter((c) => c.reason === "cascade");
      expect(cascadeChanges).toHaveLength(3);
    });

    it("does not cascade skip when at least one predecessor completed", () => {
      // Diamond: A -> B, A -> C, B & C -> D
      // A complete, B failed. D should NOT skip because C (from A) can still complete.
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "dispatched" },
          C: { status: "pending" },
          D: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(DIAMOND_DEF, state, {
        hopId: "B",
        outcome: "failed",
      }));

      // D should still be pending (C still depends on A which is complete)
      expect(result.state.hops.D.status).not.toBe("skipped");
    });

    it("cascade-skips diamond join when ALL predecessors are terminal non-success", () => {
      // Diamond: A -> B, A -> C, B & C -> D
      // B skipped, C already failed -> D should cascade skip
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "dispatched" },
          C: { status: "failed" },
          D: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(DIAMOND_DEF, state, {
        hopId: "B",
        outcome: "skipped",
      }));

      expect(result.state.hops.D.status).toBe("skipped");
    });

    it("does not re-skip already terminal hops", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "skipped", completedAt: "2026-01-01T00:00:00.000Z" },
          C: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_DEF, state, {
        hopId: "A",
        outcome: "failed",
      }));

      // B was already skipped -- should not appear again in cascade changes
      const bCascades = result.changes.filter((c) => c.hopId === "B" && c.reason === "cascade");
      expect(bCascades).toHaveLength(0);
    });

    it("cascades skip from a skipped primary event (not just failed)", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
          C: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_DEF, state, {
        hopId: "A",
        outcome: "skipped",
      }));

      expect(result.state.hops.B.status).toBe("skipped");
      expect(result.state.hops.C.status).toBe("skipped");
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: Condition Evaluation
  // ---------------------------------------------------------------------------

  describe("Condition Evaluation", () => {
    it("skips a hop when condition evaluates to false", () => {
      const condDef: WorkflowDefinition = {
        name: "cond",
        hops: [
          { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
          {
            id: "B",
            role: "dev",
            dependsOn: ["A"],
            joinType: "all",
            autoAdvance: true,
            canReject: false,
            condition: { op: "eq", field: "task.priority", value: "high" } as ConditionExprType,
          },
        ],
      };

      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
        },
      };

      // task.priority is "medium" (default), condition checks for "high" -> false
      const result = evaluateDAG(makeInput(condDef, state, {
        hopId: "A",
        outcome: "complete",
      }, makeContext()));

      expect(result.state.hops.B.status).toBe("skipped");
      expect(result.changes).toContainEqual(
        expect.objectContaining({ hopId: "B", to: "skipped", reason: "condition" }),
      );
    });

    it("leaves hop eligible when condition evaluates to true", () => {
      const condDef: WorkflowDefinition = {
        name: "cond",
        hops: [
          { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
          {
            id: "B",
            role: "dev",
            dependsOn: ["A"],
            joinType: "all",
            autoAdvance: true,
            canReject: false,
            condition: { op: "eq", field: "task.priority", value: "medium" } as ConditionExprType,
          },
        ],
      };

      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(condDef, state, {
        hopId: "A",
        outcome: "complete",
      }, makeContext()));

      // B should become ready since condition is true and predecessor is complete
      expect(result.state.hops.B.status).toBe("ready");
    });

    it("cascades skips from condition-skipped hops downstream", () => {
      const condDef: WorkflowDefinition = {
        name: "cond-cascade",
        hops: [
          { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
          {
            id: "B",
            role: "dev",
            dependsOn: ["A"],
            joinType: "all",
            autoAdvance: true,
            canReject: false,
            condition: { op: "false" } as ConditionExprType,
          },
          { id: "C", role: "dev", dependsOn: ["B"], joinType: "all", autoAdvance: true, canReject: false },
        ],
      };

      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
          C: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(condDef, state, {
        hopId: "A",
        outcome: "complete",
      }));

      expect(result.state.hops.B.status).toBe("skipped");
      expect(result.state.hops.C.status).toBe("skipped");
    });

    it("evaluates condition using live hop states", () => {
      const condDef: WorkflowDefinition = {
        name: "hop-status-cond",
        hops: [
          { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
          {
            id: "B",
            role: "dev",
            dependsOn: ["A"],
            joinType: "all",
            autoAdvance: true,
            canReject: false,
            condition: { op: "hop_status", hop: "A", status: "complete" } as ConditionExprType,
          },
        ],
      };

      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
        },
      };

      // A completes -> hop_status("A", "complete") should be true -> B should be ready
      const result = evaluateDAG(makeInput(condDef, state, {
        hopId: "A",
        outcome: "complete",
      }));

      expect(result.state.hops.B.status).toBe("ready");
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: Readiness Determination (EXEC-07)
  // ---------------------------------------------------------------------------

  describe("Readiness — AND-join", () => {
    it("marks hop ready when ALL predecessors are complete", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "dispatched" },
          C: { status: "complete" },
          D: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(DIAMOND_DEF, state, {
        hopId: "B",
        outcome: "complete",
      }));

      // B now complete, C already complete -> D (AND-join) should be ready
      expect(result.state.hops.D.status).toBe("ready");
      expect(result.readyHops).toContain("D");
    });

    it("AND-join with mixed complete and skipped predecessors becomes ready", () => {
      // Per CONTEXT.md: skipped predecessors count as "satisfied" for AND-join
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "complete" },
          C: { status: "dispatched" },
          D: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(DIAMOND_DEF, state, {
        hopId: "C",
        outcome: "skipped",
      }));

      // B complete, C skipped -> AND-join D should be ready (at least one complete)
      expect(result.state.hops.D.status).toBe("ready");
    });

    it("AND-join does NOT become ready when some predecessors are still pending", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
          C: { status: "pending" },
          D: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(DIAMOND_DEF, state, {
        hopId: "A",
        outcome: "complete",
      }));

      // B and C are now unblocked from A but not yet complete, D should not be ready
      expect(result.state.hops.D.status).not.toBe("ready");
    });
  });

  describe("Readiness — OR-join", () => {
    it("marks OR-join ready when ANY predecessor completes", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "dispatched" },
          C: { status: "pending" },
          D: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(DIAMOND_OR_DEF, state, {
        hopId: "B",
        outcome: "complete",
      }));

      // B complete -> D (OR-join) should be ready (C still pending is fine)
      expect(result.state.hops.D.status).toBe("ready");
      expect(result.readyHops).toContain("D");
    });

    it("OR-join does NOT become ready on skip (only complete triggers)", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "dispatched" },
          C: { status: "pending" },
          D: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(DIAMOND_OR_DEF, state, {
        hopId: "B",
        outcome: "skipped",
      }));

      // B skipped -> D (OR-join) should NOT be ready (skip doesn't trigger OR-join)
      // C is still pending, so D waits
      expect(result.state.hops.D.status).not.toBe("ready");
    });

    it("OR-join cascade-skips when ALL predecessors are terminal non-success", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "failed" },
          C: { status: "dispatched" },
          D: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(DIAMOND_OR_DEF, state, {
        hopId: "C",
        outcome: "skipped",
      }));

      // B failed, C skipped -> ALL predecessors terminal, none complete -> D should cascade-skip
      expect(result.state.hops.D.status).toBe("skipped");
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: DAG Completion
  // ---------------------------------------------------------------------------

  describe("DAG Completion", () => {
    it("marks DAG complete when all hops are complete or skipped", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "dispatched" },
        },
        startedAt: "2026-01-01T00:00:00.000Z",
      };

      const simpleDef: WorkflowDefinition = {
        name: "simple",
        hops: [
          { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
          { id: "B", role: "dev", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: false },
        ],
      };

      const result = evaluateDAG(makeInput(simpleDef, state, {
        hopId: "B",
        outcome: "complete",
      }));

      expect(result.state.status).toBe("complete");
      expect(result.dagStatus).toBe("complete");
      expect(result.taskStatus).toBe("done");
      expect(result.state.completedAt).toBeDefined();
    });

    it("marks DAG failed when all terminal and at least one failed", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
          C: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_DEF, state, {
        hopId: "A",
        outcome: "failed",
      }));

      // A failed -> B skipped -> C skipped -> all terminal, one failed -> DAG failed
      expect(result.state.status).toBe("failed");
      expect(result.dagStatus).toBe("failed");
      expect(result.taskStatus).toBe("failed");
      expect(result.state.completedAt).toBeDefined();
    });

    it("DAG stays running when some hops are still pending/ready/dispatched", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
          C: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_DEF, state, {
        hopId: "A",
        outcome: "complete",
      }));

      // B is now ready, C still pending -> DAG is not complete
      expect(result.state.status).toBe("running");
      expect(result.dagStatus).toBeUndefined();
      expect(result.taskStatus).toBeUndefined();
    });

    it("DAG complete with all skipped (no failures)", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
          C: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_DEF, state, {
        hopId: "A",
        outcome: "skipped",
      }));

      // A skipped -> B skipped -> C skipped -> all terminal, no failures -> DAG complete
      expect(result.state.status).toBe("complete");
      expect(result.dagStatus).toBe("complete");
      expect(result.taskStatus).toBe("done");
    });

    it("parallel branch failure does not stop other branches", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
          C: { status: "complete" },
          D: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(PARALLEL_DEF, state, {
        hopId: "A",
        outcome: "failed",
      }));

      // A failed -> B cascade-skipped, but C and D are independent
      expect(result.state.hops.B.status).toBe("skipped");
      // D should be pending still (C is its predecessor, C is complete so D should be ready)
      // Actually, C is complete -> D should become ready in readiness determination
      expect(result.state.hops.D.status).toBe("ready");
      // DAG not complete because D is ready (not terminal)
      expect(result.dagStatus).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: Change Tracking
  // ---------------------------------------------------------------------------

  describe("Change Tracking", () => {
    it("records all transitions in changes array", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
          C: { status: "pending" },
          D: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(CHAIN_DEF, state, {
        hopId: "A",
        outcome: "failed",
      }));

      // Should have: A failed + B/C/D cascade-skipped = 4 changes
      expect(result.changes).toHaveLength(4);
      expect(result.changes[0]).toMatchObject({ hopId: "A", from: "dispatched", to: "failed" });
    });

    it("includes readyHops in result", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
          C: { status: "pending" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_DEF, state, {
        hopId: "A",
        outcome: "complete",
      }));

      expect(result.readyHops).toContain("B");
      expect(result.readyHops).not.toContain("C"); // C depends on B which is not yet complete
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: Edge Cases
  // ---------------------------------------------------------------------------

  describe("Edge Cases", () => {
    it("handles completing the last hop in a linear chain", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "complete" },
          B: { status: "complete" },
          C: { status: "dispatched" },
        },
      };

      const result = evaluateDAG(makeInput(LINEAR_DEF, state, {
        hopId: "C",
        outcome: "complete",
      }));

      expect(result.state.status).toBe("complete");
      expect(result.dagStatus).toBe("complete");
      expect(result.readyHops).toHaveLength(0);
    });

    it("handles event with result data that is preserved in state", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
          B: { status: "pending" },
        },
      };

      const simpleDef: WorkflowDefinition = {
        name: "simple",
        hops: [
          { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
          { id: "B", role: "dev", dependsOn: ["A"], joinType: "all", autoAdvance: true, canReject: false },
        ],
      };

      const result = evaluateDAG(makeInput(simpleDef, state, {
        hopId: "A",
        outcome: "complete",
        result: { approved: true, score: 95 },
      }));

      expect(result.state.hops.A.result).toEqual({ approved: true, score: 95 });
    });

    it("does not mark root hops as ready (handled at init time)", () => {
      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "ready" },
          B: { status: "dispatched" },
          C: { status: "pending" },
          D: { status: "pending" },
        },
      };

      // Complete B in the parallel def. A is still ready (root), should not be re-marked
      const result = evaluateDAG(makeInput(PARALLEL_DEF, state, {
        hopId: "B",
        outcome: "complete",
      }));

      // A should still be ready (not re-transitioned)
      expect(result.state.hops.A.status).toBe("ready");
      // No change for A in the changes array
      const aChanges = result.changes.filter((c) => c.hopId === "A");
      expect(aChanges).toHaveLength(0);
    });

    it("handles single-hop workflow completion", () => {
      const singleDef: WorkflowDefinition = {
        name: "single",
        hops: [
          { id: "A", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
        ],
      };

      const state: WorkflowState = {
        status: "running",
        hops: {
          A: { status: "dispatched" },
        },
      };

      const result = evaluateDAG(makeInput(singleDef, state, {
        hopId: "A",
        outcome: "complete",
      }));

      expect(result.state.status).toBe("complete");
      expect(result.dagStatus).toBe("complete");
      expect(result.taskStatus).toBe("done");
    });
  });
});
