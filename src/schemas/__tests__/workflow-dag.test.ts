import { describe, it, expect } from "vitest";
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
} from "../workflow-dag.js";

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
