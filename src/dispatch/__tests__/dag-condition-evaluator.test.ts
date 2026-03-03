/**
 * Tests for DAG condition evaluator — interprets ConditionExprType expressions
 * to determine whether a hop should execute or be skipped.
 *
 * Covers all 14 ConditionExprType operators, dot-path field resolution,
 * condition context building, and edge cases for missing/undefined fields.
 *
 * @module dag-condition-evaluator.test
 */

import { describe, it, expect } from "vitest";
import {
  evaluateCondition,
  getField,
  buildConditionContext,
} from "../dag-condition-evaluator.js";
import type { ConditionExprType, WorkflowState, HopState } from "../../schemas/workflow-dag.js";

// ---------------------------------------------------------------------------
// Helper: minimal ConditionContext builder for tests
// ---------------------------------------------------------------------------

interface TaskMeta {
  status: string;
  tags: string[];
  priority: string;
  routing: Record<string, unknown>;
}

function makeContext(
  overrides: {
    context?: Record<string, unknown>;
    hopStates?: Record<string, HopState>;
    task?: Partial<TaskMeta>;
  } = {},
) {
  return {
    context: overrides.context ?? {},
    hopStates: overrides.hopStates ?? {},
    task: {
      status: "in-progress",
      tags: [],
      priority: "normal",
      routing: {},
      ...overrides.task,
    },
  };
}

// ---------------------------------------------------------------------------
// getField — dot-path field resolution
// ---------------------------------------------------------------------------

describe("getField", () => {
  it("resolves a simple top-level field", () => {
    expect(getField({ name: "alice" }, "name")).toBe("alice");
  });

  it("resolves a nested dot-path", () => {
    expect(getField({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
  });

  it("returns undefined for missing nested field", () => {
    expect(getField({ a: { b: 1 } }, "a.b.c")).toBeUndefined();
  });

  it("returns undefined for empty object", () => {
    expect(getField({}, "x.y.z")).toBeUndefined();
  });

  it("returns undefined for null root", () => {
    expect(getField(null as unknown as Record<string, unknown>, "a")).toBeUndefined();
  });

  it("returns undefined for undefined root", () => {
    expect(getField(undefined as unknown as Record<string, unknown>, "a")).toBeUndefined();
  });

  it("resolves through arrays as object properties", () => {
    expect(getField({ items: [10, 20, 30] }, "items")).toEqual([10, 20, 30]);
  });

  it("handles single-segment path", () => {
    expect(getField({ x: 99 }, "x")).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// buildConditionContext — merges hop results + task metadata
// ---------------------------------------------------------------------------

describe("buildConditionContext", () => {
  it("builds context with hop results under hops.{hopId} prefix", () => {
    const state: WorkflowState = {
      status: "running",
      hops: {
        review: {
          status: "complete",
          result: { approved: true, score: 95 },
        },
        implement: {
          status: "complete",
          result: { linesChanged: 42 },
        },
      },
    };

    const taskMeta: TaskMeta = {
      status: "in-progress",
      tags: ["urgent"],
      priority: "high",
      routing: { team: "backend" },
    };

    const ctx = buildConditionContext(state, taskMeta);

    // Hop results accessible via dot-path
    expect(getField(ctx, "hops.review.result.approved")).toBe(true);
    expect(getField(ctx, "hops.review.result.score")).toBe(95);
    expect(getField(ctx, "hops.implement.result.linesChanged")).toBe(42);

    // Task metadata accessible via dot-path
    expect(getField(ctx, "task.status")).toBe("in-progress");
    expect(getField(ctx, "task.priority")).toBe("high");
    expect(getField(ctx, "task.tags")).toEqual(["urgent"]);
  });

  it("handles hops with no result data", () => {
    const state: WorkflowState = {
      status: "running",
      hops: {
        pending_hop: { status: "pending" },
      },
    };

    const taskMeta: TaskMeta = {
      status: "open",
      tags: [],
      priority: "normal",
      routing: {},
    };

    const ctx = buildConditionContext(state, taskMeta);
    expect(getField(ctx, "hops.pending_hop.result")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// evaluateCondition — Comparison operators
// ---------------------------------------------------------------------------

describe("evaluateCondition — comparison operators", () => {
  describe("eq", () => {
    it("returns true when field equals value", () => {
      const ctx = makeContext({ context: { status: "done" } });
      const expr: ConditionExprType = { op: "eq", field: "status", value: "done" };
      expect(evaluateCondition(expr, ctx)).toBe(true);
    });

    it("returns false when field does not equal value", () => {
      const ctx = makeContext({ context: { status: "open" } });
      const expr: ConditionExprType = { op: "eq", field: "status", value: "done" };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });

    it("returns false when field is undefined (value is not undefined)", () => {
      const ctx = makeContext({ context: {} });
      const expr: ConditionExprType = { op: "eq", field: "missing", value: "done" };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });

    it("returns true when both field and value are undefined", () => {
      const ctx = makeContext({ context: {} });
      const expr: ConditionExprType = { op: "eq", field: "missing", value: undefined };
      expect(evaluateCondition(expr, ctx)).toBe(true);
    });

    it("uses strict equality (number vs string)", () => {
      const ctx = makeContext({ context: { count: 5 } });
      const expr: ConditionExprType = { op: "eq", field: "count", value: "5" };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });
  });

  describe("neq", () => {
    it("returns true when field does not equal value", () => {
      const ctx = makeContext({ context: { status: "open" } });
      const expr: ConditionExprType = { op: "neq", field: "status", value: "done" };
      expect(evaluateCondition(expr, ctx)).toBe(true);
    });

    it("returns false when field equals value", () => {
      const ctx = makeContext({ context: { status: "done" } });
      const expr: ConditionExprType = { op: "neq", field: "status", value: "done" };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });

    it("returns true when field is undefined (undefined !== anything)", () => {
      const ctx = makeContext({ context: {} });
      const expr: ConditionExprType = { op: "neq", field: "missing", value: "done" };
      expect(evaluateCondition(expr, ctx)).toBe(true);
    });
  });

  describe("gt", () => {
    it("returns true when field > value", () => {
      const ctx = makeContext({ context: { score: 90 } });
      const expr: ConditionExprType = { op: "gt", field: "score", value: 80 };
      expect(evaluateCondition(expr, ctx)).toBe(true);
    });

    it("returns false when field === value", () => {
      const ctx = makeContext({ context: { score: 80 } });
      const expr: ConditionExprType = { op: "gt", field: "score", value: 80 };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });

    it("returns false when field is undefined", () => {
      const ctx = makeContext({ context: {} });
      const expr: ConditionExprType = { op: "gt", field: "score", value: 80 };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });
  });

  describe("gte", () => {
    it("returns true when field >= value", () => {
      const ctx = makeContext({ context: { score: 80 } });
      const expr: ConditionExprType = { op: "gte", field: "score", value: 80 };
      expect(evaluateCondition(expr, ctx)).toBe(true);
    });

    it("returns false when field < value", () => {
      const ctx = makeContext({ context: { score: 79 } });
      const expr: ConditionExprType = { op: "gte", field: "score", value: 80 };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });

    it("returns false when field is undefined", () => {
      const ctx = makeContext({ context: {} });
      const expr: ConditionExprType = { op: "gte", field: "score", value: 80 };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });
  });

  describe("lt", () => {
    it("returns true when field < value", () => {
      const ctx = makeContext({ context: { score: 70 } });
      const expr: ConditionExprType = { op: "lt", field: "score", value: 80 };
      expect(evaluateCondition(expr, ctx)).toBe(true);
    });

    it("returns false when field === value", () => {
      const ctx = makeContext({ context: { score: 80 } });
      const expr: ConditionExprType = { op: "lt", field: "score", value: 80 };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });

    it("returns false when field is undefined", () => {
      const ctx = makeContext({ context: {} });
      const expr: ConditionExprType = { op: "lt", field: "score", value: 80 };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });
  });

  describe("lte", () => {
    it("returns true when field <= value", () => {
      const ctx = makeContext({ context: { score: 80 } });
      const expr: ConditionExprType = { op: "lte", field: "score", value: 80 };
      expect(evaluateCondition(expr, ctx)).toBe(true);
    });

    it("returns false when field > value", () => {
      const ctx = makeContext({ context: { score: 81 } });
      const expr: ConditionExprType = { op: "lte", field: "score", value: 80 };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });

    it("returns false when field is undefined", () => {
      const ctx = makeContext({ context: {} });
      const expr: ConditionExprType = { op: "lte", field: "score", value: 80 };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// evaluateCondition — Collection operators
// ---------------------------------------------------------------------------

describe("evaluateCondition — collection operators", () => {
  describe("in", () => {
    it("returns true when field value is in the array", () => {
      const ctx = makeContext({ context: { role: "admin" } });
      const expr: ConditionExprType = { op: "in", field: "role", value: ["admin", "superadmin"] };
      expect(evaluateCondition(expr, ctx)).toBe(true);
    });

    it("returns false when field value is not in the array", () => {
      const ctx = makeContext({ context: { role: "viewer" } });
      const expr: ConditionExprType = { op: "in", field: "role", value: ["admin", "superadmin"] };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });

    it("returns false when field is undefined", () => {
      const ctx = makeContext({ context: {} });
      const expr: ConditionExprType = { op: "in", field: "role", value: ["admin"] };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });
  });

  describe("has_tag", () => {
    it("returns true when tag is present", () => {
      const ctx = makeContext({ task: { tags: ["urgent", "backend"] } });
      const expr: ConditionExprType = { op: "has_tag", value: "urgent" };
      expect(evaluateCondition(expr, ctx)).toBe(true);
    });

    it("returns false when tag is not present", () => {
      const ctx = makeContext({ task: { tags: ["backend"] } });
      const expr: ConditionExprType = { op: "has_tag", value: "urgent" };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });

    it("returns false when tags array is empty", () => {
      const ctx = makeContext({ task: { tags: [] } });
      const expr: ConditionExprType = { op: "has_tag", value: "urgent" };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });

    it("returns false when tags is missing", () => {
      const ctx = makeContext({});
      // Remove tags from task to simulate missing
      (ctx.task as Record<string, unknown>).tags = undefined;
      const expr: ConditionExprType = { op: "has_tag", value: "urgent" };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// evaluateCondition — DAG-aware operators
// ---------------------------------------------------------------------------

describe("evaluateCondition — DAG-aware operators", () => {
  describe("hop_status", () => {
    it("returns true when hop has the expected status", () => {
      const ctx = makeContext({
        hopStates: {
          review: { status: "complete" },
        },
      });
      const expr: ConditionExprType = { op: "hop_status", hop: "review", status: "complete" };
      expect(evaluateCondition(expr, ctx)).toBe(true);
    });

    it("returns false when hop has a different status", () => {
      const ctx = makeContext({
        hopStates: {
          review: { status: "pending" },
        },
      });
      const expr: ConditionExprType = { op: "hop_status", hop: "review", status: "complete" };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });

    it("returns false when hop does not exist", () => {
      const ctx = makeContext({ hopStates: {} });
      const expr: ConditionExprType = { op: "hop_status", hop: "nonexistent", status: "complete" };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });

    it("reads from hopStates (live state), not from context field lookup", () => {
      // Even if context has a different value, hop_status reads from hopStates
      const ctx = makeContext({
        context: { "hops.review.status": "pending" },
        hopStates: { review: { status: "complete" } },
      });
      const expr: ConditionExprType = { op: "hop_status", hop: "review", status: "complete" };
      expect(evaluateCondition(expr, ctx)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// evaluateCondition — Logical operators
// ---------------------------------------------------------------------------

describe("evaluateCondition — logical operators", () => {
  describe("and", () => {
    it("returns true when all sub-conditions are true", () => {
      const ctx = makeContext({ context: { a: 1, b: 2 } });
      const expr: ConditionExprType = {
        op: "and",
        conditions: [
          { op: "eq", field: "a", value: 1 },
          { op: "eq", field: "b", value: 2 },
        ],
      };
      expect(evaluateCondition(expr, ctx)).toBe(true);
    });

    it("returns false when any sub-condition is false", () => {
      const ctx = makeContext({ context: { a: 1, b: 3 } });
      const expr: ConditionExprType = {
        op: "and",
        conditions: [
          { op: "eq", field: "a", value: 1 },
          { op: "eq", field: "b", value: 2 },
        ],
      };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });

    it("returns true for empty conditions array (vacuous truth)", () => {
      const ctx = makeContext();
      const expr: ConditionExprType = { op: "and", conditions: [] };
      expect(evaluateCondition(expr, ctx)).toBe(true);
    });
  });

  describe("or", () => {
    it("returns true when any sub-condition is true", () => {
      const ctx = makeContext({ context: { a: 1, b: 3 } });
      const expr: ConditionExprType = {
        op: "or",
        conditions: [
          { op: "eq", field: "a", value: 1 },
          { op: "eq", field: "b", value: 2 },
        ],
      };
      expect(evaluateCondition(expr, ctx)).toBe(true);
    });

    it("returns false when all sub-conditions are false", () => {
      const ctx = makeContext({ context: { a: 0, b: 3 } });
      const expr: ConditionExprType = {
        op: "or",
        conditions: [
          { op: "eq", field: "a", value: 1 },
          { op: "eq", field: "b", value: 2 },
        ],
      };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });

    it("returns false for empty conditions array", () => {
      const ctx = makeContext();
      const expr: ConditionExprType = { op: "or", conditions: [] };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });
  });

  describe("not", () => {
    it("negates a true condition to false", () => {
      const ctx = makeContext({ context: { a: 1 } });
      const expr: ConditionExprType = {
        op: "not",
        condition: { op: "eq", field: "a", value: 1 },
      };
      expect(evaluateCondition(expr, ctx)).toBe(false);
    });

    it("negates a false condition to true", () => {
      const ctx = makeContext({ context: { a: 2 } });
      const expr: ConditionExprType = {
        op: "not",
        condition: { op: "eq", field: "a", value: 1 },
      };
      expect(evaluateCondition(expr, ctx)).toBe(true);
    });
  });

  describe("nested logical operators", () => {
    it("handles deeply nested and/or/not composition", () => {
      const ctx = makeContext({ context: { a: 1, b: 2, c: 3 } });
      // (a === 1 AND (b === 2 OR c === 99)) AND NOT(a === 0)
      const expr: ConditionExprType = {
        op: "and",
        conditions: [
          { op: "eq", field: "a", value: 1 },
          {
            op: "or",
            conditions: [
              { op: "eq", field: "b", value: 2 },
              { op: "eq", field: "c", value: 99 },
            ],
          },
          {
            op: "not",
            condition: { op: "eq", field: "a", value: 0 },
          },
        ],
      };
      expect(evaluateCondition(expr, ctx)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// evaluateCondition — Literal operators
// ---------------------------------------------------------------------------

describe("evaluateCondition — literal operators", () => {
  it("true returns true", () => {
    const ctx = makeContext();
    const expr: ConditionExprType = { op: "true" };
    expect(evaluateCondition(expr, ctx)).toBe(true);
  });

  it("false returns false", () => {
    const ctx = makeContext();
    const expr: ConditionExprType = { op: "false" };
    expect(evaluateCondition(expr, ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateCondition — Unknown operator
// ---------------------------------------------------------------------------

describe("evaluateCondition — unknown operator", () => {
  it("returns false for unknown op", () => {
    const ctx = makeContext();
    const expr = { op: "nonexistent" } as unknown as ConditionExprType;
    expect(evaluateCondition(expr, ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateCondition — dot-path integration with context
// ---------------------------------------------------------------------------

describe("evaluateCondition — dot-path integration", () => {
  it("evaluates condition against nested context fields", () => {
    const ctx = makeContext({
      context: {
        hops: {
          review: {
            result: { approved: true },
          },
        },
      },
    });
    const expr: ConditionExprType = { op: "eq", field: "hops.review.result.approved", value: true };
    expect(evaluateCondition(expr, ctx)).toBe(true);
  });

  it("handles missing nested path gracefully", () => {
    const ctx = makeContext({ context: {} });
    const expr: ConditionExprType = { op: "eq", field: "hops.review.result.approved", value: true };
    expect(evaluateCondition(expr, ctx)).toBe(false);
  });
});
