/**
 * Tests for gate-to-DAG lazy migration.
 *
 * Covers: no-op, skip, linear conversion, field clearing, in-flight mapping,
 * canReject, timeout/escalateTo, condition conversion, validateDAG, idempotency.
 */

import { describe, it, expect, vi } from "vitest";
import { migrateGateToDAG } from "../gate-to-dag.js";
import { validateDAG } from "../../schemas/workflow-dag.js";
import type { Task } from "../../schemas/task.js";

/** Helper to build a minimal Task object for testing. */
function makeTask(overrides: Record<string, unknown> = {}): Task {
  const base = {
    schemaVersion: 1 as const,
    id: "TASK-2026-03-03-001",
    project: "test",
    title: "Test task",
    status: "ready" as const,
    priority: "normal" as const,
    routing: { tags: [] },
    createdAt: "2026-03-03T00:00:00.000Z",
    updatedAt: "2026-03-03T00:00:00.000Z",
    lastTransitionAt: "2026-03-03T00:00:00.000Z",
    createdBy: "test-agent",
    dependsOn: [],
    metadata: {},
    gateHistory: [],
    tests: [],
  };
  return {
    frontmatter: { ...base, ...overrides } as any,
    body: "# Test task body",
  };
}

describe("migrateGateToDAG", () => {
  it("Test 1: task with no gate and no workflow returns unchanged", () => {
    const task = makeTask();
    const result = migrateGateToDAG(task);
    expect(result.frontmatter.workflow).toBeUndefined();
    expect(result.frontmatter.gate).toBeUndefined();
  });

  it("Test 2: task already having workflow field returns unchanged", () => {
    const task = makeTask({
      workflow: {
        definition: { name: "existing", hops: [{ id: "a", role: "dev", dependsOn: [] }] },
        state: { status: "pending", hops: { a: { status: "ready" } } },
      },
    });
    const result = migrateGateToDAG(task);
    expect(result.frontmatter.workflow!.definition.name).toBe("existing");
  });

  it("Test 3: task with gate field converts gates to linear DAG hops", () => {
    const task = makeTask({
      gate: { current: "dev", entered: "2026-03-03T00:00:00.000Z" },
      gateHistory: [],
      routing: { tags: [], workflow: "my-flow" },
    });
    // Simulate workflow config with gates
    const workflowConfig = {
      name: "my-flow",
      gates: [
        { id: "dev", role: "swe-backend", description: "Development" },
        { id: "qa", role: "swe-qa", description: "QA review" },
        { id: "deploy", role: "ops", description: "Deploy" },
      ],
    };
    const result = migrateGateToDAG(task, workflowConfig);
    expect(result.frontmatter.workflow).toBeDefined();
    const hops = result.frontmatter.workflow!.definition.hops;
    expect(hops).toHaveLength(3);
    expect(hops[0]!.id).toBe("dev");
    expect(hops[0]!.dependsOn).toEqual([]);
    expect(hops[1]!.id).toBe("qa");
    expect(hops[1]!.dependsOn).toEqual(["dev"]);
    expect(hops[2]!.id).toBe("deploy");
    expect(hops[2]!.dependsOn).toEqual(["qa"]);
  });

  it("Test 4: gate fields cleared after conversion (mutual exclusivity)", () => {
    const task = makeTask({
      gate: { current: "dev", entered: "2026-03-03T00:00:00.000Z" },
      gateHistory: [
        { gate: "dev", role: "swe-backend", entered: "2026-03-03T00:00:00.000Z", blockers: [] },
      ],
      reviewContext: {
        fromGate: "qa",
        fromRole: "swe-qa",
        timestamp: "2026-03-03T00:00:00.000Z",
        blockers: [],
      },
      routing: { tags: [], workflow: "flow" },
    });
    const config = {
      name: "flow",
      gates: [
        { id: "dev", role: "swe-backend" },
        { id: "qa", role: "swe-qa" },
      ],
    };
    const result = migrateGateToDAG(task, config);
    expect(result.frontmatter.gate).toBeUndefined();
    expect(result.frontmatter.gateHistory).toEqual([]);
    expect(result.frontmatter.reviewContext).toBeUndefined();
  });

  it("Test 5: in-flight task at gate N maps statuses correctly (in-progress)", () => {
    const task = makeTask({
      status: "in-progress",
      gate: { current: "qa", entered: "2026-03-03T01:00:00.000Z" },
      gateHistory: [],
      routing: { tags: [], workflow: "flow" },
    });
    const config = {
      name: "flow",
      gates: [
        { id: "dev", role: "swe-backend" },
        { id: "qa", role: "swe-qa" },
        { id: "deploy", role: "ops" },
      ],
    };
    const result = migrateGateToDAG(task, config);
    const hopStates = result.frontmatter.workflow!.state.hops;
    expect(hopStates["dev"]!.status).toBe("complete");
    expect(hopStates["qa"]!.status).toBe("dispatched");
    expect(hopStates["deploy"]!.status).toBe("pending");
  });

  it("Test 6: in-flight task at gate N with non in-progress status maps gate N to ready", () => {
    const task = makeTask({
      status: "review",
      gate: { current: "qa", entered: "2026-03-03T01:00:00.000Z" },
      gateHistory: [],
      routing: { tags: [], workflow: "flow" },
    });
    const config = {
      name: "flow",
      gates: [
        { id: "dev", role: "swe-backend" },
        { id: "qa", role: "swe-qa" },
        { id: "deploy", role: "ops" },
      ],
    };
    const result = migrateGateToDAG(task, config);
    const hopStates = result.frontmatter.workflow!.state.hops;
    expect(hopStates["dev"]!.status).toBe("complete");
    expect(hopStates["qa"]!.status).toBe("ready");
    expect(hopStates["deploy"]!.status).toBe("pending");
  });

  it("Test 7: gate with canReject=true maps to hop with canReject and rejectionStrategy", () => {
    const task = makeTask({
      gate: { current: "dev", entered: "2026-03-03T00:00:00.000Z" },
      gateHistory: [],
      routing: { tags: [], workflow: "flow" },
    });
    const config = {
      name: "flow",
      gates: [{ id: "dev", role: "swe-backend", canReject: true }],
    };
    const result = migrateGateToDAG(task, config);
    const hop = result.frontmatter.workflow!.definition.hops[0]!;
    expect(hop.canReject).toBe(true);
    expect(hop.rejectionStrategy).toBe("origin");
  });

  it("Test 8: gate with timeout and escalateTo maps to hop fields", () => {
    const task = makeTask({
      gate: { current: "dev", entered: "2026-03-03T00:00:00.000Z" },
      gateHistory: [],
      routing: { tags: [], workflow: "flow" },
    });
    const config = {
      name: "flow",
      gates: [{ id: "dev", role: "swe-backend", timeout: "2h", escalateTo: "lead" }],
    };
    const result = migrateGateToDAG(task, config);
    const hop = result.frontmatter.workflow!.definition.hops[0]!;
    expect(hop.timeout).toBe("2h");
    expect(hop.escalateTo).toBe("lead");
  });

  it("Test 9: simple when expression converts to JSON DSL condition", () => {
    const task = makeTask({
      gate: { current: "dev", entered: "2026-03-03T00:00:00.000Z" },
      gateHistory: [],
      routing: { tags: [], workflow: "flow" },
    });
    const config = {
      name: "flow",
      gates: [{ id: "dev", role: "swe-backend", when: "tags.includes('urgent')" }],
    };
    const result = migrateGateToDAG(task, config);
    const hop = result.frontmatter.workflow!.definition.hops[0]!;
    expect(hop.condition).toEqual({ op: "has_tag", value: "urgent" });
  });

  it("Test 10: complex/unparseable when expression logs warning and skips condition", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const task = makeTask({
      gate: { current: "dev", entered: "2026-03-03T00:00:00.000Z" },
      gateHistory: [],
      routing: { tags: [], workflow: "flow" },
    });
    const config = {
      name: "flow",
      gates: [{ id: "dev", role: "swe-backend", when: "someComplexExpression(a, b, c)" }],
    };
    const result = migrateGateToDAG(task, config);
    const hop = result.frontmatter.workflow!.definition.hops[0]!;
    expect(hop.condition).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("Test 11: converted DAG passes validateDAG", () => {
    const task = makeTask({
      gate: { current: "dev", entered: "2026-03-03T00:00:00.000Z" },
      gateHistory: [],
      routing: { tags: [], workflow: "flow" },
    });
    const config = {
      name: "flow",
      gates: [
        { id: "dev", role: "swe-backend" },
        { id: "qa", role: "swe-qa" },
        { id: "deploy", role: "ops" },
      ],
    };
    const result = migrateGateToDAG(task, config);
    const errors = validateDAG(result.frontmatter.workflow!.definition);
    expect(errors).toEqual([]);
  });

  it("Test 12: migration is idempotent", () => {
    const task = makeTask({
      gate: { current: "dev", entered: "2026-03-03T00:00:00.000Z" },
      gateHistory: [],
      routing: { tags: [], workflow: "flow" },
    });
    const config = {
      name: "flow",
      gates: [
        { id: "dev", role: "swe-backend" },
        { id: "qa", role: "swe-qa" },
      ],
    };
    const first = migrateGateToDAG(task, config);
    // Second call on already-migrated task (now has workflow, no gate)
    const second = migrateGateToDAG(first, config);
    expect(second.frontmatter.workflow).toEqual(first.frontmatter.workflow);
  });
});
