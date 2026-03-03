import { describe, it, expect } from "vitest";
import YAML from "yaml";
import {
  ConditionExpr,
  Hop,
  WorkflowDefinition,
  HopStatus,
  HopState,
  WorkflowStatus,
  WorkflowState,
  TaskWorkflow,
  validateDAG,
  initializeWorkflowState,
  measureConditionComplexity,
  collectHopReferences,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_NODES,
} from "../workflow-dag.js";
import type { ConditionExprType } from "../workflow-dag.js";
import { EventType } from "../event.js";
import { TaskFrontmatter } from "../task.js";
import {
  ConditionExpr as BarrelConditionExpr,
  Hop as BarrelHop,
  WorkflowDefinition as BarrelWorkflowDefinition,
  HopStatus as BarrelHopStatus,
  HopState as BarrelHopState,
  WorkflowStatus as BarrelWorkflowStatus,
  WorkflowState as BarrelWorkflowState,
  TaskWorkflow as BarrelTaskWorkflow,
  validateDAG as barrelValidateDAG,
  initializeWorkflowState as barrelInitializeWorkflowState,
} from "../index.js";

// ---------------------------------------------------------------------------
// ConditionExpr
// ---------------------------------------------------------------------------
describe("ConditionExpr", () => {
  it("parses comparison operators (eq, neq)", () => {
    expect(
      ConditionExpr.parse({ op: "eq", field: "status", value: "open" }),
    ).toEqual({ op: "eq", field: "status", value: "open" });
    expect(
      ConditionExpr.parse({ op: "neq", field: "status", value: "closed" }),
    ).toEqual({ op: "neq", field: "status", value: "closed" });
  });

  it("parses numeric comparison operators (gt, gte, lt, lte)", () => {
    expect(
      ConditionExpr.parse({ op: "gt", field: "priority", value: 3 }),
    ).toEqual({ op: "gt", field: "priority", value: 3 });
    expect(
      ConditionExpr.parse({ op: "gte", field: "priority", value: 1 }),
    ).toEqual({ op: "gte", field: "priority", value: 1 });
    expect(
      ConditionExpr.parse({ op: "lt", field: "priority", value: 5 }),
    ).toEqual({ op: "lt", field: "priority", value: 5 });
    expect(
      ConditionExpr.parse({ op: "lte", field: "priority", value: 10 }),
    ).toEqual({ op: "lte", field: "priority", value: 10 });
  });

  it("parses collection operators (in, has_tag)", () => {
    expect(
      ConditionExpr.parse({ op: "in", field: "status", value: ["a", "b"] }),
    ).toEqual({ op: "in", field: "status", value: ["a", "b"] });
    expect(
      ConditionExpr.parse({ op: "has_tag", value: "backend" }),
    ).toEqual({ op: "has_tag", value: "backend" });
  });

  it("parses hop_status operator", () => {
    expect(
      ConditionExpr.parse({ op: "hop_status", hop: "review", status: "complete" }),
    ).toEqual({ op: "hop_status", hop: "review", status: "complete" });
  });

  it("parses logical operators (and, or, not) recursively", () => {
    const andExpr = {
      op: "and",
      conditions: [
        { op: "eq", field: "a", value: 1 },
        { op: "gt", field: "b", value: 2 },
      ],
    };
    expect(ConditionExpr.parse(andExpr)).toEqual(andExpr);

    const orExpr = {
      op: "or",
      conditions: [
        { op: "has_tag", value: "urgent" },
        { op: "hop_status", hop: "review", status: "complete" },
      ],
    };
    expect(ConditionExpr.parse(orExpr)).toEqual(orExpr);

    const notExpr = {
      op: "not",
      condition: { op: "eq", field: "status", value: "blocked" },
    };
    expect(ConditionExpr.parse(notExpr)).toEqual(notExpr);
  });

  it("parses literal operators (true, false)", () => {
    expect(ConditionExpr.parse({ op: "true" })).toEqual({ op: "true" });
    expect(ConditionExpr.parse({ op: "false" })).toEqual({ op: "false" });
  });

  it("rejects invalid operator", () => {
    expect(() => ConditionExpr.parse({ op: "invalid" })).toThrow();
  });

  it("rejects missing required fields", () => {
    // eq needs field + value
    expect(() => ConditionExpr.parse({ op: "eq" })).toThrow();
    // has_tag needs value
    expect(() => ConditionExpr.parse({ op: "has_tag" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Hop
// ---------------------------------------------------------------------------
describe("Hop", () => {
  it("parses a minimal hop (id + role only)", () => {
    const result = Hop.parse({ id: "implement", role: "swe-backend" });
    expect(result.id).toBe("implement");
    expect(result.role).toBe("swe-backend");
    expect(result.dependsOn).toEqual([]);
    expect(result.joinType).toBe("all");
    expect(result.autoAdvance).toBe(true);
    expect(result.canReject).toBe(false);
  });

  it("parses a full hop with all fields", () => {
    const raw = {
      id: "review",
      role: "swe-architect",
      dependsOn: ["implement"],
      joinType: "any" as const,
      autoAdvance: false,
      condition: { op: "has_tag" as const, value: "needs-review" },
      description: "Architecture review hop",
      canReject: true,
      rejectionStrategy: "origin" as const,
      timeout: "2h",
      escalateTo: "tech-lead",
    };

    const result = Hop.parse(raw);
    expect(result.id).toBe("review");
    expect(result.role).toBe("swe-architect");
    expect(result.dependsOn).toEqual(["implement"]);
    expect(result.joinType).toBe("any");
    expect(result.autoAdvance).toBe(false);
    expect(result.condition).toEqual({ op: "has_tag", value: "needs-review" });
    expect(result.description).toBe("Architecture review hop");
    expect(result.canReject).toBe(true);
    expect(result.rejectionStrategy).toBe("origin");
    expect(result.timeout).toBe("2h");
    expect(result.escalateTo).toBe("tech-lead");
  });

  it("rejects hop with empty id", () => {
    expect(() => Hop.parse({ id: "", role: "swe" })).toThrow();
  });

  it("rejects hop with empty role", () => {
    expect(() => Hop.parse({ id: "x", role: "" })).toThrow();
  });

  it("rejects invalid rejectionStrategy", () => {
    expect(() =>
      Hop.parse({ id: "x", role: "swe", rejectionStrategy: "nowhere" }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// WorkflowDefinition
// ---------------------------------------------------------------------------
describe("WorkflowDefinition", () => {
  it("parses a valid definition with name and hops", () => {
    const raw = {
      name: "standard-sdlc",
      hops: [
        { id: "implement", role: "swe-backend" },
        { id: "review", role: "swe-architect", dependsOn: ["implement"] },
      ],
    };

    const result = WorkflowDefinition.parse(raw);
    expect(result.name).toBe("standard-sdlc");
    expect(result.hops).toHaveLength(2);
  });

  it("rejects empty hops array", () => {
    expect(() =>
      WorkflowDefinition.parse({ name: "empty", hops: [] }),
    ).toThrow();
  });

  it("rejects empty name", () => {
    expect(() =>
      WorkflowDefinition.parse({ name: "", hops: [{ id: "a", role: "r" }] }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// HopStatus / HopState / WorkflowStatus / WorkflowState
// ---------------------------------------------------------------------------
describe("HopStatus", () => {
  const validStatuses = [
    "pending",
    "ready",
    "dispatched",
    "complete",
    "failed",
    "skipped",
  ];

  it("has exactly 6 states", () => {
    expect(HopStatus.options).toHaveLength(6);
  });

  it.each(validStatuses)("accepts '%s'", (status) => {
    expect(HopStatus.parse(status)).toBe(status);
  });

  it("rejects invalid status", () => {
    expect(() => HopStatus.parse("running")).toThrow();
    expect(() => HopStatus.parse("done")).toThrow();
  });
});

describe("HopState", () => {
  it("parses minimal state (status only)", () => {
    const result = HopState.parse({ status: "pending" });
    expect(result.status).toBe("pending");
  });

  it("parses full state with all optional fields", () => {
    const raw = {
      status: "complete",
      startedAt: "2026-03-02T10:00:00Z",
      completedAt: "2026-03-02T11:00:00Z",
      agent: "swe-backend",
      correlationId: "corr-123",
      result: { output: "success", lines: 42 },
    };

    const result = HopState.parse(raw);
    expect(result.status).toBe("complete");
    expect(result.startedAt).toBe("2026-03-02T10:00:00Z");
    expect(result.completedAt).toBe("2026-03-02T11:00:00Z");
    expect(result.agent).toBe("swe-backend");
    expect(result.correlationId).toBe("corr-123");
    expect(result.result).toEqual({ output: "success", lines: 42 });
  });

  it("accepts optional rejectionCount (non-negative integer)", () => {
    const result = HopState.parse({ status: "pending", rejectionCount: 3 });
    expect(result.rejectionCount).toBe(3);
  });

  it("accepts rejectionCount of 0", () => {
    const result = HopState.parse({ status: "pending", rejectionCount: 0 });
    expect(result.rejectionCount).toBe(0);
  });

  it("rejects negative rejectionCount", () => {
    expect(() => HopState.parse({ status: "pending", rejectionCount: -1 })).toThrow();
  });

  it("rejects non-integer rejectionCount", () => {
    expect(() => HopState.parse({ status: "pending", rejectionCount: 1.5 })).toThrow();
  });

  it("accepts optional escalated boolean", () => {
    const result = HopState.parse({ status: "pending", escalated: true });
    expect(result.escalated).toBe(true);
  });

  it("defaults rejectionCount and escalated to undefined when omitted", () => {
    const result = HopState.parse({ status: "pending" });
    expect(result.rejectionCount).toBeUndefined();
    expect(result.escalated).toBeUndefined();
  });
});

describe("WorkflowStatus", () => {
  it("accepts all valid statuses", () => {
    expect(WorkflowStatus.parse("pending")).toBe("pending");
    expect(WorkflowStatus.parse("running")).toBe("running");
    expect(WorkflowStatus.parse("complete")).toBe("complete");
    expect(WorkflowStatus.parse("failed")).toBe("failed");
  });

  it("has exactly 4 states", () => {
    expect(WorkflowStatus.options).toHaveLength(4);
  });

  it("rejects invalid status", () => {
    expect(() => WorkflowStatus.parse("done")).toThrow();
  });
});

describe("WorkflowState", () => {
  it("parses minimal state", () => {
    const raw = {
      status: "pending",
      hops: {
        implement: { status: "ready" },
      },
    };

    const result = WorkflowState.parse(raw);
    expect(result.status).toBe("pending");
    expect(result.hops.implement.status).toBe("ready");
  });

  it("parses full state with timestamps", () => {
    const raw = {
      status: "running",
      hops: {
        implement: {
          status: "complete",
          startedAt: "2026-03-02T10:00:00Z",
          completedAt: "2026-03-02T11:00:00Z",
        },
        review: { status: "dispatched" },
      },
      startedAt: "2026-03-02T10:00:00Z",
    };

    const result = WorkflowState.parse(raw);
    expect(result.status).toBe("running");
    expect(result.startedAt).toBe("2026-03-02T10:00:00Z");
    expect(result.completedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TaskWorkflow
// ---------------------------------------------------------------------------
describe("TaskWorkflow", () => {
  it("parses a complete TaskWorkflow with definition and state", () => {
    const raw = {
      definition: {
        name: "sdlc",
        hops: [
          { id: "implement", role: "swe-backend" },
          { id: "review", role: "swe-architect", dependsOn: ["implement"] },
        ],
      },
      state: {
        status: "running",
        hops: {
          implement: { status: "complete" },
          review: { status: "dispatched" },
        },
      },
    };

    const result = TaskWorkflow.parse(raw);
    expect(result.definition.name).toBe("sdlc");
    expect(result.state.status).toBe("running");
    expect(result.state.hops.implement.status).toBe("complete");
  });

  it("parses TaskWorkflow with optional templateName string", () => {
    const raw = {
      definition: {
        name: "sdlc",
        hops: [
          { id: "implement", role: "swe-backend" },
          { id: "review", role: "swe-architect", dependsOn: ["implement"] },
        ],
      },
      state: {
        status: "pending",
        hops: {
          implement: { status: "ready" },
          review: { status: "pending" },
        },
      },
      templateName: "standard-sdlc",
    };

    const result = TaskWorkflow.parse(raw);
    expect(result.templateName).toBe("standard-sdlc");
  });

  it("parses TaskWorkflow without templateName (backward compat)", () => {
    const raw = {
      definition: {
        name: "sdlc",
        hops: [
          { id: "implement", role: "swe-backend" },
        ],
      },
      state: {
        status: "pending",
        hops: {
          implement: { status: "ready" },
        },
      },
    };

    const result = TaskWorkflow.parse(raw);
    expect(result.templateName).toBeUndefined();
  });

  it("rejects TaskWorkflow without definition", () => {
    expect(() =>
      TaskWorkflow.parse({
        state: { status: "pending", hops: {} },
      }),
    ).toThrow();
  });

  it("rejects TaskWorkflow without state", () => {
    expect(() =>
      TaskWorkflow.parse({
        definition: { name: "x", hops: [{ id: "a", role: "r" }] },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateDAG
// ---------------------------------------------------------------------------
describe("validateDAG", () => {
  it("returns [] for valid linear DAG (A -> B -> C)", () => {
    const definition = WorkflowDefinition.parse({
      name: "linear",
      hops: [
        { id: "A", role: "r" },
        { id: "B", role: "r", dependsOn: ["A"] },
        { id: "C", role: "r", dependsOn: ["B"] },
      ],
    });
    expect(validateDAG(definition)).toEqual([]);
  });

  it("returns [] for valid diamond DAG", () => {
    const definition = WorkflowDefinition.parse({
      name: "diamond",
      hops: [
        { id: "A", role: "r" },
        { id: "B", role: "r", dependsOn: ["A"] },
        { id: "C", role: "r", dependsOn: ["A"] },
        { id: "D", role: "r", dependsOn: ["B", "C"] },
      ],
    });
    expect(validateDAG(definition)).toEqual([]);
  });

  it("returns [] for valid parallel fan-out", () => {
    const definition = WorkflowDefinition.parse({
      name: "fan-out",
      hops: [
        { id: "A", role: "r" },
        { id: "B", role: "r", dependsOn: ["A"] },
        { id: "C", role: "r", dependsOn: ["A"] },
        { id: "D", role: "r", dependsOn: ["A"] },
      ],
    });
    expect(validateDAG(definition)).toEqual([]);
  });

  it("returns error for cycle (A -> B -> C -> A)", () => {
    const definition = WorkflowDefinition.parse({
      name: "cyclic",
      hops: [
        { id: "A", role: "r", dependsOn: ["C"] },
        { id: "B", role: "r", dependsOn: ["A"] },
        { id: "C", role: "r", dependsOn: ["B"] },
      ],
    });
    const errors = validateDAG(definition);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /cycle/i.test(e))).toBe(true);
  });

  it("returns error for self-referencing hop", () => {
    const definition = WorkflowDefinition.parse({
      name: "self-ref",
      hops: [
        { id: "A", role: "r", dependsOn: ["A"] },
      ],
    });
    const errors = validateDAG(definition);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("returns error for duplicate hop IDs", () => {
    const definition = WorkflowDefinition.parse({
      name: "dups",
      hops: [
        { id: "A", role: "r" },
        { id: "A", role: "r2" },
      ],
    });
    const errors = validateDAG(definition);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /duplicate/i.test(e))).toBe(true);
  });

  it("returns error for dangling dependsOn reference", () => {
    const definition = WorkflowDefinition.parse({
      name: "dangling",
      hops: [
        { id: "A", role: "r" },
        { id: "B", role: "r", dependsOn: ["nonexistent"] },
      ],
    });
    const errors = validateDAG(definition);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /nonexistent/i.test(e))).toBe(true);
  });

  it("returns error for unreachable hops", () => {
    // C depends on B, but B depends on A, and D is disconnected from any root
    // Actually: A is root, B depends on A. D depends on E which doesn't exist => dangling ref
    // Better: create a disconnected subgraph where all nodes in it have dependencies
    const definition = WorkflowDefinition.parse({
      name: "unreachable",
      hops: [
        { id: "A", role: "r" },
        { id: "B", role: "r", dependsOn: ["A"] },
        { id: "C", role: "r", dependsOn: ["D"] },
        { id: "D", role: "r", dependsOn: ["C"] },
      ],
    });
    const errors = validateDAG(definition);
    expect(errors.length).toBeGreaterThan(0);
    // Should report either cycle or unreachable (both C and D are in a cycle and disconnected)
  });

  it("returns error for no root hops (all hops have dependsOn)", () => {
    const definition = WorkflowDefinition.parse({
      name: "no-root",
      hops: [
        { id: "A", role: "r", dependsOn: ["B"] },
        { id: "B", role: "r", dependsOn: ["A"] },
      ],
    });
    const errors = validateDAG(definition);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /root/i.test(e) || /cycle/i.test(e))).toBe(true);
  });

  it("validates timeout format (valid: '1h', '30m', '2d')", () => {
    const definition = WorkflowDefinition.parse({
      name: "timeouts",
      hops: [
        { id: "A", role: "r", timeout: "1h" },
        { id: "B", role: "r", dependsOn: ["A"], timeout: "30m" },
        { id: "C", role: "r", dependsOn: ["B"], timeout: "2d" },
      ],
    });
    expect(validateDAG(definition)).toEqual([]);
  });

  it("returns error for invalid timeout format", () => {
    const definition = WorkflowDefinition.parse({
      name: "bad-timeout",
      hops: [
        { id: "A", role: "r", timeout: "abc" },
      ],
    });
    const errors = validateDAG(definition);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /timeout/i.test(e))).toBe(true);
  });

  it("returns error for invalid timeout format '1x'", () => {
    const definition = WorkflowDefinition.parse({
      name: "bad-timeout-unit",
      hops: [
        { id: "A", role: "r", timeout: "1x" },
      ],
    });
    const errors = validateDAG(definition);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /timeout/i.test(e))).toBe(true);
  });

  it("returns error for empty escalateTo string", () => {
    const definition = WorkflowDefinition.parse({
      name: "empty-escalate",
      hops: [
        { id: "A", role: "r", escalateTo: "" },
      ],
    });
    const errors = validateDAG(definition);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /escalateTo/i.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// measureConditionComplexity
// ---------------------------------------------------------------------------
describe("measureConditionComplexity", () => {
  it("returns { maxDepth: 0, totalNodes: 1 } for a leaf condition", () => {
    const leaf: ConditionExprType = { op: "eq", field: "x", value: 1 };
    expect(measureConditionComplexity(leaf)).toEqual({ maxDepth: 0, totalNodes: 1 });
  });

  it("returns correct depth and count for nested and/or", () => {
    // and(or(leaf, leaf), leaf, leaf) => 1(and) + 1(or) + 2(or-leaves) + 2(and-leaves) = 6 nodes
    // maxDepth: and=0, or=1, leaves-under-or=2
    const expr: ConditionExprType = {
      op: "and",
      conditions: [
        {
          op: "or",
          conditions: [
            { op: "eq", field: "a", value: 1 },
            { op: "eq", field: "b", value: 2 },
          ],
        },
        { op: "eq", field: "c", value: 3 },
        { op: "eq", field: "d", value: 4 },
      ],
    };
    const result = measureConditionComplexity(expr);
    expect(result.maxDepth).toBe(2);
    expect(result.totalNodes).toBe(6);
  });

  it("returns correct depth for 'not' wrapper", () => {
    const expr: ConditionExprType = {
      op: "not",
      condition: { op: "eq", field: "x", value: 1 },
    };
    expect(measureConditionComplexity(expr)).toEqual({ maxDepth: 1, totalNodes: 2 });
  });

  it("returns { maxDepth: 0, totalNodes: 1 } for literal true", () => {
    const expr: ConditionExprType = { op: "true" };
    expect(measureConditionComplexity(expr)).toEqual({ maxDepth: 0, totalNodes: 1 });
  });

  it("returns { maxDepth: 0, totalNodes: 1 } for hop_status leaf", () => {
    const expr: ConditionExprType = { op: "hop_status", hop: "review", status: "complete" };
    expect(measureConditionComplexity(expr)).toEqual({ maxDepth: 0, totalNodes: 1 });
  });
});

// ---------------------------------------------------------------------------
// collectHopReferences
// ---------------------------------------------------------------------------
describe("collectHopReferences", () => {
  it("collects hop from hop_status operator", () => {
    const expr: ConditionExprType = { op: "hop_status", hop: "review", status: "complete" };
    expect(collectHopReferences(expr)).toEqual(["review"]);
  });

  it("collects hop from field path 'hops.X.result.y'", () => {
    const expr: ConditionExprType = { op: "eq", field: "hops.deploy.result.success", value: true };
    expect(collectHopReferences(expr)).toEqual(["deploy"]);
  });

  it("does not collect from non-hops field paths", () => {
    const expr: ConditionExprType = { op: "eq", field: "task.status", value: "open" };
    expect(collectHopReferences(expr)).toEqual([]);
  });

  it("collects from nested and/or conditions", () => {
    const expr: ConditionExprType = {
      op: "and",
      conditions: [
        { op: "hop_status", hop: "A", status: "complete" },
        { op: "eq", field: "hops.B.result.x", value: 1 },
      ],
    };
    const refs = collectHopReferences(expr);
    expect(refs).toContain("A");
    expect(refs).toContain("B");
  });

  it("collects from not conditions", () => {
    const expr: ConditionExprType = {
      op: "not",
      condition: { op: "hop_status", hop: "review", status: "failed" },
    };
    expect(collectHopReferences(expr)).toEqual(["review"]);
  });
});

// ---------------------------------------------------------------------------
// validateDAG — condition depth/complexity and hop reference validation
// ---------------------------------------------------------------------------
describe("validateDAG — condition validation", () => {
  it("rejects conditions exceeding MAX_CONDITION_DEPTH (5)", () => {
    // Build a condition with depth 6 (one deeper than allowed)
    let expr: ConditionExprType = { op: "eq", field: "x", value: 1 };
    for (let i = 0; i < 6; i++) {
      expr = { op: "and", conditions: [expr] };
    }

    const definition = WorkflowDefinition.parse({
      name: "deep",
      hops: [{ id: "A", role: "r", condition: expr }],
    });
    const errors = validateDAG(definition);
    expect(errors.some((e) => /nesting depth/.test(e))).toBe(true);
  });

  it("rejects conditions exceeding MAX_CONDITION_NODES (50)", () => {
    // Build a flat and with 51 leaf conditions
    const leaves: ConditionExprType[] = [];
    for (let i = 0; i < 51; i++) {
      leaves.push({ op: "eq", field: "x", value: i });
    }
    const expr: ConditionExprType = { op: "and", conditions: leaves };

    const definition = WorkflowDefinition.parse({
      name: "wide",
      hops: [{ id: "A", role: "r", condition: expr }],
    });
    const errors = validateDAG(definition);
    expect(errors.some((e) => /node count/.test(e))).toBe(true);
  });

  it("passes for conditions within depth and node limits", () => {
    const expr: ConditionExprType = {
      op: "and",
      conditions: [
        { op: "eq", field: "x", value: 1 },
        { op: "or", conditions: [{ op: "eq", field: "y", value: 2 }] },
      ],
    };

    const definition = WorkflowDefinition.parse({
      name: "ok",
      hops: [{ id: "A", role: "r", condition: expr }],
    });
    const errors = validateDAG(definition);
    expect(errors).toEqual([]);
  });

  it("rejects hop_status referencing non-existent hop", () => {
    const expr: ConditionExprType = { op: "hop_status", hop: "nonexistent", status: "complete" };

    const definition = WorkflowDefinition.parse({
      name: "bad-ref",
      hops: [
        { id: "A", role: "r" },
        { id: "B", role: "r", dependsOn: ["A"], condition: expr },
      ],
    });
    const errors = validateDAG(definition);
    expect(errors.some((e) => /non-existent hop "nonexistent"/.test(e))).toBe(true);
  });

  it("rejects field path 'hops.missing.result.x' referencing non-existent hop", () => {
    const expr: ConditionExprType = { op: "eq", field: "hops.missing.result.x", value: 1 };

    const definition = WorkflowDefinition.parse({
      name: "bad-field-ref",
      hops: [
        { id: "A", role: "r" },
        { id: "B", role: "r", dependsOn: ["A"], condition: expr },
      ],
    });
    const errors = validateDAG(definition);
    expect(errors.some((e) => /non-existent hop "missing"/.test(e))).toBe(true);
  });

  it("passes for valid hop_status references", () => {
    const expr: ConditionExprType = { op: "hop_status", hop: "A", status: "complete" };

    const definition = WorkflowDefinition.parse({
      name: "valid-ref",
      hops: [
        { id: "A", role: "r" },
        { id: "B", role: "r", dependsOn: ["A"], condition: expr },
      ],
    });
    const errors = validateDAG(definition);
    expect(errors).toEqual([]);
  });

  it("MAX_CONDITION_DEPTH is 5", () => {
    expect(MAX_CONDITION_DEPTH).toBe(5);
  });

  it("MAX_CONDITION_NODES is 50", () => {
    expect(MAX_CONDITION_NODES).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// initializeWorkflowState
// ---------------------------------------------------------------------------
describe("initializeWorkflowState", () => {
  it("sets root hops (no dependsOn) to 'ready'", () => {
    const definition = WorkflowDefinition.parse({
      name: "init-test",
      hops: [
        { id: "A", role: "r" },
        { id: "B", role: "r", dependsOn: ["A"] },
        { id: "C", role: "r" },
      ],
    });

    const state = initializeWorkflowState(definition);
    expect(state.hops.A.status).toBe("ready");
    expect(state.hops.C.status).toBe("ready");
  });

  it("sets dependent hops to 'pending'", () => {
    const definition = WorkflowDefinition.parse({
      name: "init-test",
      hops: [
        { id: "A", role: "r" },
        { id: "B", role: "r", dependsOn: ["A"] },
        { id: "C", role: "r", dependsOn: ["B"] },
      ],
    });

    const state = initializeWorkflowState(definition);
    expect(state.hops.B.status).toBe("pending");
    expect(state.hops.C.status).toBe("pending");
  });

  it("sets workflow-level status to 'pending'", () => {
    const definition = WorkflowDefinition.parse({
      name: "init-test",
      hops: [{ id: "A", role: "r" }],
    });

    const state = initializeWorkflowState(definition);
    expect(state.status).toBe("pending");
  });

  it("includes all hops from definition in state map", () => {
    const definition = WorkflowDefinition.parse({
      name: "init-test",
      hops: [
        { id: "A", role: "r" },
        { id: "B", role: "r", dependsOn: ["A"] },
        { id: "C", role: "r", dependsOn: ["A"] },
        { id: "D", role: "r", dependsOn: ["B", "C"] },
      ],
    });

    const state = initializeWorkflowState(definition);
    expect(Object.keys(state.hops).sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("produces a state that passes WorkflowState.parse()", () => {
    const definition = WorkflowDefinition.parse({
      name: "init-test",
      hops: [
        { id: "A", role: "r" },
        { id: "B", role: "r", dependsOn: ["A"] },
      ],
    });

    const state = initializeWorkflowState(definition);
    expect(() => WorkflowState.parse(state)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TaskFrontmatter integration
// ---------------------------------------------------------------------------
describe("TaskFrontmatter integration", () => {
  const baseTask = {
    schemaVersion: 1,
    id: "TASK-2026-03-02-001",
    project: "AOF",
    title: "DAG integration test task",
    status: "ready",
    priority: "normal",
    createdAt: "2026-03-02T10:00:00Z",
    updatedAt: "2026-03-02T10:00:00Z",
    lastTransitionAt: "2026-03-02T10:00:00Z",
    createdBy: "test-agent",
  };

  const sampleWorkflow = {
    definition: {
      name: "diamond-sdlc",
      hops: [
        { id: "implement", role: "swe-backend" },
        { id: "test", role: "swe-qa", dependsOn: ["implement"] },
        { id: "review", role: "swe-architect", dependsOn: ["implement"] },
        { id: "deploy", role: "swe-devops", dependsOn: ["test", "review"] },
      ],
    },
    state: {
      status: "pending",
      hops: {
        implement: { status: "ready" },
        test: { status: "pending" },
        review: { status: "pending" },
        deploy: { status: "pending" },
      },
    },
  };

  it("rejects task with both gate and workflow (mutual exclusivity)", () => {
    const withBoth = {
      ...baseTask,
      gate: { current: "implement", entered: "2026-03-02T10:00:00Z" },
      workflow: sampleWorkflow,
    };
    const result = TaskFrontmatter.safeParse(withBoth);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(" ");
      expect(messages.toLowerCase()).toContain("mutual");
    }
  });

  it("accepts task with gate fields and no workflow (backward compat)", () => {
    const gateOnly = {
      ...baseTask,
      gate: { current: "dev", entered: "2026-03-02T10:00:00Z" },
      gateHistory: [
        {
          gate: "triage",
          role: "swe-lead",
          entered: "2026-03-02T09:00:00Z",
          exited: "2026-03-02T10:00:00Z",
          outcome: "complete",
        },
      ],
    };
    const result = TaskFrontmatter.safeParse(gateOnly);
    expect(result.success).toBe(true);
  });

  it("accepts task with no gate and no workflow (bare task)", () => {
    const result = TaskFrontmatter.safeParse(baseTask);
    expect(result.success).toBe(true);
  });

  it("accepts task with workflow field and no gate (DAG task)", () => {
    const dagTask = { ...baseTask, workflow: sampleWorkflow };
    const result = TaskFrontmatter.safeParse(dagTask);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workflow?.definition.name).toBe("diamond-sdlc");
      expect(result.data.workflow?.state.status).toBe("pending");
      expect(result.data.workflow?.state.hops.implement.status).toBe("ready");
    }
  });

  it("round-trips workflow data through YAML without data loss", () => {
    const dagTask = {
      ...baseTask,
      workflow: {
        definition: {
          name: "condition-dag",
          hops: [
            { id: "implement", role: "swe-backend" },
            {
              id: "security-review",
              role: "swe-security",
              dependsOn: ["implement"],
              condition: {
                op: "and",
                conditions: [
                  { op: "has_tag", value: "security-sensitive" },
                  { op: "hop_status", hop: "implement", status: "complete" },
                ],
              },
            },
            { id: "deploy", role: "swe-devops", dependsOn: ["implement", "security-review"], joinType: "any" },
          ],
        },
        state: {
          status: "running",
          hops: {
            implement: {
              status: "complete",
              startedAt: "2026-03-02T10:00:00Z",
              completedAt: "2026-03-02T11:00:00Z",
              agent: "swe-backend-1",
            },
            "security-review": { status: "ready" },
            deploy: { status: "pending" },
          },
          startedAt: "2026-03-02T10:00:00Z",
        },
      },
    };

    // Parse to validate
    const parsed = TaskFrontmatter.parse(dagTask);

    // Serialize to YAML and back
    const yamlStr = YAML.stringify(parsed, { lineWidth: 120 });
    const roundTripped = YAML.parse(yamlStr);
    const reparsed = TaskFrontmatter.parse(roundTripped);

    // Verify DAG structure preserved
    expect(reparsed.workflow?.definition.name).toBe("condition-dag");
    expect(reparsed.workflow?.definition.hops).toHaveLength(3);
    expect(reparsed.workflow?.definition.hops.map((h) => h.id)).toEqual([
      "implement",
      "security-review",
      "deploy",
    ]);

    // Verify hop statuses preserved
    expect(reparsed.workflow?.state.status).toBe("running");
    expect(reparsed.workflow?.state.hops.implement.status).toBe("complete");
    expect(reparsed.workflow?.state.hops.implement.completedAt).toBe("2026-03-02T11:00:00Z");
    expect(reparsed.workflow?.state.hops["security-review"].status).toBe("ready");
    expect(reparsed.workflow?.state.hops.deploy.status).toBe("pending");

    // Verify condition expression preserved
    const secReview = reparsed.workflow?.definition.hops.find((h) => h.id === "security-review");
    expect(secReview?.condition).toEqual({
      op: "and",
      conditions: [
        { op: "has_tag", value: "security-sensitive" },
        { op: "hop_status", hop: "implement", status: "complete" },
      ],
    });

    // Verify joinType preserved
    const deploy = reparsed.workflow?.definition.hops.find((h) => h.id === "deploy");
    expect(deploy?.joinType).toBe("any");

    // Verify startedAt preserved
    expect(reparsed.workflow?.state.startedAt).toBe("2026-03-02T10:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// EventType — DAG safety event types (Phase 13)
// ---------------------------------------------------------------------------
describe("EventType — DAG safety events", () => {
  it("includes dag.hop_timeout", () => {
    expect(EventType.options).toContain("dag.hop_timeout");
  });

  it("includes dag.hop_timeout_escalation", () => {
    expect(EventType.options).toContain("dag.hop_timeout_escalation");
  });

  it("includes dag.hop_rejected", () => {
    expect(EventType.options).toContain("dag.hop_rejected");
  });

  it("includes dag.hop_rejection_cascade", () => {
    expect(EventType.options).toContain("dag.hop_rejection_cascade");
  });
});

// ---------------------------------------------------------------------------
// Barrel exports
// ---------------------------------------------------------------------------
describe("barrel exports", () => {
  it("exports ConditionExpr from barrel", () => {
    expect(BarrelConditionExpr).toBeDefined();
  });

  it("exports Hop from barrel", () => {
    expect(BarrelHop).toBeDefined();
  });

  it("exports WorkflowDefinition from barrel", () => {
    expect(BarrelWorkflowDefinition).toBeDefined();
  });

  it("exports HopStatus from barrel", () => {
    expect(BarrelHopStatus).toBeDefined();
  });

  it("exports HopState from barrel", () => {
    expect(BarrelHopState).toBeDefined();
  });

  it("exports WorkflowStatus from barrel", () => {
    expect(BarrelWorkflowStatus).toBeDefined();
  });

  it("exports WorkflowState from barrel", () => {
    expect(BarrelWorkflowState).toBeDefined();
  });

  it("exports TaskWorkflow from barrel", () => {
    expect(BarrelTaskWorkflow).toBeDefined();
  });

  it("exports validateDAG from barrel", () => {
    expect(barrelValidateDAG).toBeDefined();
    expect(typeof barrelValidateDAG).toBe("function");
  });

  it("exports initializeWorkflowState from barrel", () => {
    expect(barrelInitializeWorkflowState).toBeDefined();
    expect(typeof barrelInitializeWorkflowState).toBe("function");
  });
});
