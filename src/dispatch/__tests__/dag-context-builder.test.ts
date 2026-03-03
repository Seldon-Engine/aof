/**
 * Tests for dag-context-builder — HopContext construction for agent dispatch.
 *
 * Verifies that buildHopContext produces correct hop-scoped context from task
 * frontmatter, including upstream results from completed predecessors.
 */

import { describe, it, expect } from "vitest";
import { buildHopContext, type HopContext } from "../dag-context-builder.js";
import type { Task } from "../../schemas/task.js";
import type { TaskWorkflow } from "../../schemas/workflow-dag.js";

/**
 * Build a minimal Task object with workflow frontmatter for testing.
 */
function makeTask(workflow: TaskWorkflow): Task {
  return {
    frontmatter: {
      schemaVersion: 1 as const,
      id: "TASK-2026-03-03-001",
      project: "test",
      title: "Test task",
      status: "in-progress",
      priority: "normal",
      routing: {},
      createdAt: "2026-03-03T00:00:00Z",
      updatedAt: "2026-03-03T00:00:00Z",
      lastTransitionAt: "2026-03-03T00:00:00Z",
      createdBy: "test",
      dependsOn: [],
      metadata: {},
      gateHistory: [],
      tests: [],
      workflow,
    },
    body: "Test body",
    path: "/tmp/test-task.md",
  };
}

describe("buildHopContext", () => {
  it("returns HopContext with empty upstreamResults for root hop", () => {
    const task = makeTask({
      definition: {
        name: "test-workflow",
        hops: [
          { id: "implement", role: "swe", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
        ],
      },
      state: {
        status: "running",
        hops: {
          implement: { status: "ready" },
        },
      },
    });

    const ctx = buildHopContext(task, "implement");

    expect(ctx.hopId).toBe("implement");
    expect(ctx.role).toBe("swe");
    expect(ctx.autoAdvance).toBe(true);
    expect(ctx.upstreamResults).toEqual({});
  });

  it("populates upstreamResults from completed predecessors", () => {
    const task = makeTask({
      definition: {
        name: "test-workflow",
        hops: [
          { id: "implement", role: "swe", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
          { id: "review", role: "qa", dependsOn: ["implement"], joinType: "all", autoAdvance: true, canReject: false },
        ],
      },
      state: {
        status: "running",
        hops: {
          implement: {
            status: "complete",
            completedAt: "2026-03-03T01:00:00Z",
            result: { coverage: 95, notes: "All tests pass" },
          },
          review: { status: "ready" },
        },
      },
    });

    const ctx = buildHopContext(task, "review");

    expect(ctx.hopId).toBe("review");
    expect(ctx.role).toBe("qa");
    expect(ctx.upstreamResults).toEqual({
      implement: { coverage: 95, notes: "All tests pass" },
    });
  });

  it("omits incomplete predecessors from upstreamResults", () => {
    const task = makeTask({
      definition: {
        name: "test-workflow",
        hops: [
          { id: "implement", role: "swe", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
          { id: "lint", role: "swe", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
          { id: "review", role: "qa", dependsOn: ["implement", "lint"], joinType: "any", autoAdvance: true, canReject: false },
        ],
      },
      state: {
        status: "running",
        hops: {
          implement: {
            status: "complete",
            completedAt: "2026-03-03T01:00:00Z",
            result: { notes: "Done" },
          },
          lint: { status: "dispatched" }, // Not yet complete
          review: { status: "ready" },
        },
      },
    });

    const ctx = buildHopContext(task, "review");

    // Only "implement" is complete; "lint" is still dispatched
    expect(ctx.upstreamResults).toEqual({
      implement: { notes: "Done" },
    });
    expect(ctx.upstreamResults).not.toHaveProperty("lint");
  });

  it("throws descriptive error for hop not in definition", () => {
    const task = makeTask({
      definition: {
        name: "test-workflow",
        hops: [
          { id: "implement", role: "swe", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
        ],
      },
      state: {
        status: "running",
        hops: {
          implement: { status: "ready" },
        },
      },
    });

    expect(() => buildHopContext(task, "nonexistent")).toThrow(
      /hop.*nonexistent.*not found/i,
    );
  });

  it("includes description when hop has one", () => {
    const task = makeTask({
      definition: {
        name: "test-workflow",
        hops: [
          {
            id: "implement",
            role: "swe",
            dependsOn: [],
            joinType: "all",
            autoAdvance: true,
            canReject: false,
            description: "Implement the feature",
          },
        ],
      },
      state: {
        status: "running",
        hops: {
          implement: { status: "ready" },
        },
      },
    });

    const ctx = buildHopContext(task, "implement");
    expect(ctx.description).toBe("Implement the feature");
  });

  it("returns undefined description when hop has none", () => {
    const task = makeTask({
      definition: {
        name: "test-workflow",
        hops: [
          { id: "implement", role: "swe", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
        ],
      },
      state: {
        status: "running",
        hops: {
          implement: { status: "ready" },
        },
      },
    });

    const ctx = buildHopContext(task, "implement");
    expect(ctx.description).toBeUndefined();
  });

  it("includes autoAdvance=false when hop specifies it", () => {
    const task = makeTask({
      definition: {
        name: "test-workflow",
        hops: [
          { id: "review", role: "qa", dependsOn: [], joinType: "all", autoAdvance: false, canReject: false },
        ],
      },
      state: {
        status: "running",
        hops: {
          review: { status: "ready" },
        },
      },
    });

    const ctx = buildHopContext(task, "review");
    expect(ctx.autoAdvance).toBe(false);
  });

  it("excludes completed predecessors that have no result", () => {
    const task = makeTask({
      definition: {
        name: "test-workflow",
        hops: [
          { id: "implement", role: "swe", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
          { id: "review", role: "qa", dependsOn: ["implement"], joinType: "all", autoAdvance: true, canReject: false },
        ],
      },
      state: {
        status: "running",
        hops: {
          implement: {
            status: "complete",
            completedAt: "2026-03-03T01:00:00Z",
            // No result field
          },
          review: { status: "ready" },
        },
      },
    });

    const ctx = buildHopContext(task, "review");
    // implement is complete but has no result, so it should not appear in upstreamResults
    expect(ctx.upstreamResults).toEqual({});
  });
});

describe("HopContext type", () => {
  it("has correct shape", () => {
    const ctx: HopContext = {
      hopId: "test",
      role: "swe",
      upstreamResults: {},
      autoAdvance: true,
    };

    expect(ctx.hopId).toBe("test");
    expect(ctx.description).toBeUndefined();
    expect(ctx.role).toBe("swe");
    expect(ctx.upstreamResults).toEqual({});
    expect(ctx.autoAdvance).toBe(true);
  });
});
