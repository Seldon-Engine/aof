/**
 * Tests for dag-transition-handler — DAG hop completion and dispatch orchestration.
 *
 * Verifies handleDAGHopCompletion and dispatchDAGHop with mocked dependencies
 * for unit isolation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "../../schemas/task.js";
import type { TaskWorkflow } from "../../schemas/workflow-dag.js";
import type { RunResult } from "../../schemas/run-result.js";
import type { EventLogger } from "../../events/logger.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { GatewayAdapter, TaskContext } from "../executor.js";
import { createMockStore, createMockLogger } from "../../testing/index.js";

// Mock evaluateDAG
vi.mock("../dag-evaluator.js", () => ({
  evaluateDAG: vi.fn(),
}));

// Mock writeFileAtomic
vi.mock("write-file-atomic", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

// Mock serializeTask
vi.mock("../../store/task-store.js", () => ({
  serializeTask: vi.fn().mockReturnValue("---\nmocked: true\n---\n\nbody\n"),
}));

// Mock node:fs/promises for mkdir
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { handleDAGHopCompletion, dispatchDAGHop } from "../dag-transition-handler.js";
import { evaluateDAG } from "../dag-evaluator.js";
import writeFileAtomic from "write-file-atomic";
import { mkdir } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function makeTask(workflow: TaskWorkflow, overrides?: Partial<Task>): Task {
  return {
    frontmatter: {
      schemaVersion: 1 as const,
      id: "TASK-2026-03-03-001",
      project: "test",
      title: "Test task",
      status: "in-progress",
      priority: "normal",
      routing: { tags: ["feature"] },
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
    path: "/tmp/tasks/test-task.md",
    ...overrides,
  };
}

function makeRunResult(overrides?: Partial<RunResult>): RunResult {
  return {
    taskId: "TASK-2026-03-03-001",
    agentId: "swe-agent",
    completedAt: "2026-03-03T01:00:00Z",
    outcome: "done",
    summaryRef: "summary.md",
    handoffRef: "handoff.md",
    deliverables: [],
    tests: { passed: 1, failed: 0, skipped: 0, total: 1 },
    blockers: [],
    notes: "",
    ...overrides,
  } as RunResult;
}

function makeLogger(): EventLogger {
  return createMockLogger() as unknown as EventLogger;
}

function makeStore(): ITaskStore {
  return createMockStore() as unknown as ITaskStore;
}

function makeExecutor(success = true): GatewayAdapter {
  return {
    spawnSession: vi.fn().mockResolvedValue(
      success
        ? { success: true, sessionId: "session-123" }
        : { success: false, error: "Spawn failed" },
    ),
    getSessionStatus: vi.fn(),
    forceCompleteSession: vi.fn(),
  } as unknown as GatewayAdapter;
}

// ---------------------------------------------------------------------------
// handleDAGHopCompletion
// ---------------------------------------------------------------------------

describe("handleDAGHopCompletion", () => {
  const mockedEvaluateDAG = vi.mocked(evaluateDAG);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps done run result to complete event, evaluates DAG, persists state, returns readyHops", async () => {
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
          implement: { status: "dispatched", startedAt: "2026-03-03T00:30:00Z", agent: "swe" },
          review: { status: "pending" },
        },
      },
    });

    const runResult = makeRunResult({ outcome: "done", notes: "All done" });

    mockedEvaluateDAG.mockReturnValue({
      state: {
        status: "running",
        hops: {
          implement: { status: "complete", completedAt: "2026-03-03T01:00:00Z", result: { notes: "All done" } },
          review: { status: "ready" },
        },
      },
      changes: [
        { hopId: "implement", from: "dispatched", to: "complete" },
        { hopId: "review", from: "pending", to: "ready" },
      ],
      readyHops: ["review"],
    });

    const logger = makeLogger();
    const store = makeStore();

    const result = await handleDAGHopCompletion(store, logger, task, runResult);

    // evaluateDAG should have been called with complete event
    expect(mockedEvaluateDAG).toHaveBeenCalledOnce();
    const evalInput = mockedEvaluateDAG.mock.calls[0]![0];
    expect(evalInput.event.hopId).toBe("implement");
    expect(evalInput.event.outcome).toBe("complete");

    // State should have been persisted atomically
    expect(store.save).toHaveBeenCalled();

    // Result should have readyHops
    expect(result.readyHops).toEqual(["review"]);
    expect(result.dagComplete).toBe(false);
    expect(result.reviewRequired).toBe(false);

    // Logger should have been called
    expect(logger.log).toHaveBeenCalled();
  });

  it("maps blocked run result to failed event, evaluates DAG with skip cascade", async () => {
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
          implement: { status: "dispatched", agent: "swe" },
          review: { status: "pending" },
        },
      },
    });

    const runResult = makeRunResult({ outcome: "blocked", notes: "External dependency missing" });

    mockedEvaluateDAG.mockReturnValue({
      state: {
        status: "failed",
        hops: {
          implement: { status: "failed", result: { notes: "External dependency missing" } },
          review: { status: "skipped" },
        },
        completedAt: "2026-03-03T01:00:00Z",
      },
      changes: [
        { hopId: "implement", from: "dispatched", to: "failed" },
        { hopId: "review", from: "pending", to: "skipped", reason: "cascade" },
      ],
      readyHops: [],
      dagStatus: "failed",
      taskStatus: "failed",
    });

    const logger = makeLogger();
    const store = makeStore();

    const result = await handleDAGHopCompletion(store, logger, task, runResult);

    // evaluateDAG should have been called with failed event
    const evalInput = mockedEvaluateDAG.mock.calls[0]![0];
    expect(evalInput.event.outcome).toBe("failed");

    // Should indicate DAG is complete (failed)
    expect(result.dagComplete).toBe(true);
    expect(result.readyHops).toEqual([]);
  });

  it("includes run result notes in hop event result", async () => {
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
          implement: { status: "dispatched", agent: "swe" },
        },
      },
    });

    const runResult = makeRunResult({ outcome: "done", notes: "Feature implemented with 95% coverage" });

    mockedEvaluateDAG.mockReturnValue({
      state: { status: "running", hops: { implement: { status: "complete" } } },
      changes: [],
      readyHops: [],
    });

    const logger = makeLogger();
    const store = makeStore();

    await handleDAGHopCompletion(store, logger, task, runResult);

    const evalInput = mockedEvaluateDAG.mock.calls[0]![0];
    expect(evalInput.event.result).toEqual({ notes: "Feature implemented with 95% coverage" });
  });

  it("returns empty readyHops when no dispatched hop found (defensive)", async () => {
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
          implement: { status: "ready" }, // Not dispatched
        },
      },
    });

    const runResult = makeRunResult();
    const logger = makeLogger();
    const store = makeStore();

    const result = await handleDAGHopCompletion(store, logger, task, runResult);

    expect(result.readyHops).toEqual([]);
    expect(result.dagComplete).toBe(false);
    expect(result.reviewRequired).toBe(false);

    // evaluateDAG should NOT have been called
    expect(mockedEvaluateDAG).not.toHaveBeenCalled();
  });

  it("returns dagComplete=true when evaluateDAG returns taskStatus", async () => {
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
          implement: { status: "dispatched", agent: "swe" },
        },
      },
    });

    const runResult = makeRunResult({ outcome: "done" });

    mockedEvaluateDAG.mockReturnValue({
      state: {
        status: "complete",
        hops: { implement: { status: "complete" } },
        completedAt: "2026-03-03T01:00:00Z",
      },
      changes: [{ hopId: "implement", from: "dispatched", to: "complete" }],
      readyHops: [],
      dagStatus: "complete",
      taskStatus: "done",
    });

    const logger = makeLogger();
    const store = makeStore();

    const result = await handleDAGHopCompletion(store, logger, task, runResult);

    expect(result.dagComplete).toBe(true);
  });

  it("returns reviewRequired=true when autoAdvance=false on completed hop", async () => {
    const task = makeTask({
      definition: {
        name: "test-workflow",
        hops: [
          { id: "implement", role: "swe", dependsOn: [], joinType: "all", autoAdvance: false, canReject: false },
          { id: "review", role: "qa", dependsOn: ["implement"], joinType: "all", autoAdvance: true, canReject: false },
        ],
      },
      state: {
        status: "running",
        hops: {
          implement: { status: "dispatched", agent: "swe" },
          review: { status: "pending" },
        },
      },
    });

    const runResult = makeRunResult({ outcome: "done" });

    mockedEvaluateDAG.mockReturnValue({
      state: {
        status: "running",
        hops: {
          implement: { status: "complete" },
          review: { status: "ready" },
        },
      },
      changes: [
        { hopId: "implement", from: "dispatched", to: "complete" },
        { hopId: "review", from: "pending", to: "ready" },
      ],
      readyHops: ["review"],
    });

    const logger = makeLogger();
    const store = makeStore();

    const result = await handleDAGHopCompletion(store, logger, task, runResult);

    expect(result.reviewRequired).toBe(true);
  });

  it("reviewRequired is false when autoAdvance=false but hop failed", async () => {
    const task = makeTask({
      definition: {
        name: "test-workflow",
        hops: [
          { id: "implement", role: "swe", dependsOn: [], joinType: "all", autoAdvance: false, canReject: false },
        ],
      },
      state: {
        status: "running",
        hops: {
          implement: { status: "dispatched", agent: "swe" },
        },
      },
    });

    const runResult = makeRunResult({ outcome: "blocked" });

    mockedEvaluateDAG.mockReturnValue({
      state: {
        status: "failed",
        hops: { implement: { status: "failed" } },
        completedAt: "2026-03-03T01:00:00Z",
      },
      changes: [{ hopId: "implement", from: "dispatched", to: "failed" }],
      readyHops: [],
      dagStatus: "failed",
      taskStatus: "failed",
    });

    const logger = makeLogger();
    const store = makeStore();

    const result = await handleDAGHopCompletion(store, logger, task, runResult);

    // Failed hop should not trigger reviewRequired even if autoAdvance=false
    expect(result.reviewRequired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dispatchDAGHop
// ---------------------------------------------------------------------------

describe("dispatchDAGHop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds context, spawns session, sets hop to dispatched on success, persists state", async () => {
    const task = makeTask({
      definition: {
        name: "test-workflow",
        hops: [
          { id: "implement", role: "swe", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false, description: "Implement feature" },
        ],
      },
      state: {
        status: "running",
        hops: {
          implement: { status: "ready" },
        },
      },
    });

    const executor = makeExecutor(true);
    const logger = makeLogger();
    const store = makeStore();
    const config = { spawnTimeoutMs: 30_000 };

    const success = await dispatchDAGHop(store, logger, config, executor, task, "implement");

    expect(success).toBe(true);

    // Executor should have been called with TaskContext containing hopContext
    expect(executor.spawnSession).toHaveBeenCalledOnce();
    const [ctx, opts] = (executor.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(ctx.taskId).toBe("TASK-2026-03-03-001");
    expect(ctx.agent).toBe("swe");
    expect(ctx.hopContext).toBeDefined();
    expect(ctx.hopContext.hopId).toBe("implement");
    expect(ctx.hopContext.role).toBe("swe");
    expect(ctx.hopContext.description).toBe("Implement feature");
    expect(opts.timeoutMs).toBe(30_000);

    // State should have been persisted with dispatched status
    expect(store.save).toHaveBeenCalled();

    // Hop should now be dispatched
    expect(task.frontmatter.workflow!.state.hops.implement.status).toBe("dispatched");
    expect(task.frontmatter.workflow!.state.hops.implement.startedAt).toBeDefined();
    expect(task.frontmatter.workflow!.state.hops.implement.agent).toBe("swe");
    expect(task.frontmatter.workflow!.state.hops.implement.correlationId).toBe("session-123");

    // Logger should have been called
    expect(logger.log).toHaveBeenCalled();
  });

  it("returns false on spawn failure, hop stays ready", async () => {
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

    const executor = makeExecutor(false);
    const logger = makeLogger();
    const store = makeStore();
    const config = { spawnTimeoutMs: 30_000 };

    const success = await dispatchDAGHop(store, logger, config, executor, task, "implement");

    expect(success).toBe(false);

    // Hop should still be "ready" (not dispatched)
    expect(task.frontmatter.workflow!.state.hops.implement.status).toBe("ready");

    // State should NOT have been persisted (no writeFileAtomic call)
    expect(store.save).not.toHaveBeenCalled();

    // Logger should still log the failure
    expect(logger.log).toHaveBeenCalled();
  });

  it("sets hop to dispatched ONLY after spawnSession succeeds", async () => {
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

    const executor = makeExecutor(true);
    const logger = makeLogger();
    const store = makeStore();
    const config = { spawnTimeoutMs: 30_000 };

    // Before dispatch, hop is ready
    expect(task.frontmatter.workflow!.state.hops.implement.status).toBe("ready");

    await dispatchDAGHop(store, logger, config, executor, task, "implement");

    // After successful dispatch, hop is dispatched
    expect(task.frontmatter.workflow!.state.hops.implement.status).toBe("dispatched");
  });

  it("creates artifact directory at work/<hopId>/ before spawning session", async () => {
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

    const executor = makeExecutor(true);
    const logger = makeLogger();
    const store = makeStore();
    const config = { spawnTimeoutMs: 30_000 };

    await dispatchDAGHop(store, logger, config, executor, task, "implement");

    // mkdir should have been called with recursive: true
    const mockedMkdir = vi.mocked(mkdir);
    expect(mockedMkdir).toHaveBeenCalledOnce();
    expect(mockedMkdir).toHaveBeenCalledWith(
      "/tmp/tasks/work/implement",
      { recursive: true },
    );
  });

  it("uses recursive directory creation (mkdir -p equivalent)", async () => {
    const task = makeTask({
      definition: {
        name: "test-workflow",
        hops: [
          { id: "deep-hop", role: "swe", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
        ],
      },
      state: {
        status: "running",
        hops: {
          "deep-hop": { status: "ready" },
        },
      },
    });

    const executor = makeExecutor(true);
    const logger = makeLogger();
    const store = makeStore();
    const config = { spawnTimeoutMs: 30_000 };

    await dispatchDAGHop(store, logger, config, executor, task, "deep-hop");

    const mockedMkdir = vi.mocked(mkdir);
    // Verify recursive flag is set
    expect(mockedMkdir.mock.calls[0]![1]).toEqual({ recursive: true });
  });

  it("derives directory path from task.path: join(dirname(task.path!), 'work', hopId)", async () => {
    const task = makeTask(
      {
        definition: {
          name: "test-workflow",
          hops: [
            { id: "build", role: "swe", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
          ],
        },
        state: {
          status: "running",
          hops: {
            build: { status: "ready" },
          },
        },
      },
      { path: "/projects/myapp/tasks/TASK-2026-03-03-001.md" },
    );

    const executor = makeExecutor(true);
    const logger = makeLogger();
    const store = makeStore();
    const config = { spawnTimeoutMs: 30_000 };

    await dispatchDAGHop(store, logger, config, executor, task, "build");

    const mockedMkdir = vi.mocked(mkdir);
    // dirname of /projects/myapp/tasks/TASK-2026-03-03-001.md is /projects/myapp/tasks
    expect(mockedMkdir).toHaveBeenCalledWith(
      "/projects/myapp/tasks/work/build",
      { recursive: true },
    );
  });

  it("calls mkdir BEFORE spawnSession", async () => {
    const callOrder: string[] = [];

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

    const mockedMkdir = vi.mocked(mkdir);
    mockedMkdir.mockImplementation(async () => {
      callOrder.push("mkdir");
      return undefined;
    });

    const executor = {
      spawnSession: vi.fn().mockImplementation(async () => {
        callOrder.push("spawnSession");
        return { success: true, sessionId: "session-123" };
      }),
      getSessionStatus: vi.fn(),
      forceCompleteSession: vi.fn(),
    } as unknown as GatewayAdapter;

    const logger = makeLogger();
    const store = makeStore();
    const config = { spawnTimeoutMs: 30_000 };

    await dispatchDAGHop(store, logger, config, executor, task, "implement");

    expect(callOrder).toEqual(["mkdir", "spawnSession"]);
  });
});

// ---------------------------------------------------------------------------
// handleDAGHopCompletion — Rejection Integration
// ---------------------------------------------------------------------------

describe("handleDAGHopCompletion — rejection", () => {
  const mockedEvaluateDAG = vi.mocked(evaluateDAG);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps needs_review + canReject=true to rejected event", async () => {
    const task = makeTask({
      definition: {
        name: "test-workflow",
        hops: [
          { id: "implement", role: "swe", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
          { id: "review", role: "qa", dependsOn: ["implement"], joinType: "all", autoAdvance: true, canReject: true, rejectionStrategy: "origin" },
        ],
      },
      state: {
        status: "running",
        hops: {
          implement: { status: "complete" },
          review: { status: "dispatched", startedAt: "2026-03-03T00:30:00Z", agent: "qa" },
        },
      },
    });

    const runResult = makeRunResult({ outcome: "needs_review", notes: "Code quality issues" });

    mockedEvaluateDAG.mockReturnValue({
      state: {
        status: "running",
        hops: {
          implement: { status: "ready" },
          review: { status: "pending", rejectionCount: 1 },
        },
      },
      changes: [
        { hopId: "review", from: "dispatched", to: "pending", reason: "rejection_cascade_origin" },
        { hopId: "implement", from: "complete", to: "ready", reason: "rejection_cascade_origin" },
      ],
      readyHops: ["implement"],
    });

    const logger = makeLogger();
    const store = makeStore();

    const result = await handleDAGHopCompletion(store, logger, task, runResult);

    // evaluateDAG should have been called with rejected event
    const evalInput = mockedEvaluateDAG.mock.calls[0]![0];
    expect(evalInput.event.outcome).toBe("rejected");

    // Should log rejection event
    expect(logger.log).toHaveBeenCalledWith(
      "dag.hop_rejected",
      expect.any(String),
      expect.objectContaining({
        taskId: task.frontmatter.id,
      }),
    );

    // reviewRequired should be false on rejection (rejection IS the review outcome)
    expect(result.reviewRequired).toBe(false);

    // Ready hops should be returned
    expect(result.readyHops).toEqual(["implement"]);
  });

  it("maps needs_review + canReject=false to complete event", async () => {
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
          implement: { status: "complete" },
          review: { status: "dispatched", startedAt: "2026-03-03T00:30:00Z", agent: "qa" },
        },
      },
    });

    const runResult = makeRunResult({ outcome: "needs_review", notes: "Looks good" });

    mockedEvaluateDAG.mockReturnValue({
      state: {
        status: "complete",
        hops: {
          implement: { status: "complete" },
          review: { status: "complete" },
        },
        completedAt: "2026-03-03T01:00:00Z",
      },
      changes: [{ hopId: "review", from: "dispatched", to: "complete" }],
      readyHops: [],
      dagStatus: "complete",
      taskStatus: "done",
    });

    const logger = makeLogger();
    const store = makeStore();

    await handleDAGHopCompletion(store, logger, task, runResult);

    // evaluateDAG should have been called with complete event (not rejected)
    const evalInput = mockedEvaluateDAG.mock.calls[0]![0];
    expect(evalInput.event.outcome).toBe("complete");
  });
});
