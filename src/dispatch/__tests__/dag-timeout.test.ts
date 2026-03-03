/**
 * TDD tests for DAG hop timeout checking and escalation.
 *
 * Tests checkHopTimeouts() scanning behavior and escalateHopTimeout()
 * escalation logic including one-shot rule, force-complete, and re-dispatch.
 *
 * @module dag-timeout.test
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "../../schemas/task.js";
import type { TaskWorkflow } from "../../schemas/workflow-dag.js";
import type { GatewayAdapter, SpawnResult } from "../executor.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { SchedulerConfig } from "../scheduler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(
  hopDefs: Array<{ id: string; role: string; dependsOn?: string[]; timeout?: string; escalateTo?: string }>,
  hopStates: Record<string, { status: string; startedAt?: string; agent?: string; correlationId?: string; escalated?: boolean; [k: string]: unknown }>,
): TaskWorkflow {
  return {
    definition: {
      name: "test-wf",
      hops: hopDefs.map((h) => ({
        id: h.id,
        role: h.role,
        dependsOn: h.dependsOn ?? [],
        autoAdvance: true,
        ...(h.timeout ? { timeout: h.timeout } : {}),
        ...(h.escalateTo ? { escalateTo: h.escalateTo } : {}),
      })),
    },
    state: {
      status: "running",
      hops: hopStates as any,
    },
  };
}

function makeDAGTask(
  id: string,
  hopDefs: Array<{ id: string; role: string; dependsOn?: string[]; timeout?: string; escalateTo?: string }>,
  hopStates: Record<string, { status: string; startedAt?: string; agent?: string; correlationId?: string; escalated?: boolean; [k: string]: unknown }>,
  overrides?: Partial<Task["frontmatter"]>,
): Task {
  return {
    frontmatter: {
      schemaVersion: 1 as const,
      id,
      project: "test",
      title: `DAG task ${id}`,
      status: "in-progress",
      priority: "normal",
      routing: { tags: [] },
      createdAt: "2026-03-03T00:00:00Z",
      updatedAt: "2026-03-03T00:00:00Z",
      lastTransitionAt: "2026-03-03T00:00:00Z",
      createdBy: "test",
      dependsOn: [],
      metadata: {},
      gateHistory: [],
      tests: [],
      workflow: makeWorkflow(hopDefs, hopStates),
      ...overrides,
    },
    body: "Test body",
    path: `/tmp/tasks/in-progress/${id}.md`,
  };
}

function makeStore(tasks: Task[]): ITaskStore {
  const taskMap = new Map(tasks.map((t) => [t.frontmatter.id, t]));
  return {
    init: vi.fn(),
    get: vi.fn().mockImplementation(async (id: string) => taskMap.get(id) ?? null),
    list: vi.fn().mockImplementation(async (filter?: { status?: string }) => {
      if (filter?.status) {
        return tasks.filter((t) => t.frontmatter.status === filter.status);
      }
      return tasks;
    }),
    create: vi.fn(),
    updateBody: vi.fn(),
    transition: vi.fn(),
    delete: vi.fn(),
    tasksDir: "/tmp/tasks",
    projectRoot: "/tmp/aof",
    projectId: "test",
  } as any;
}

function makeLogger() {
  return {
    log: vi.fn().mockResolvedValue(undefined),
    logSchedulerPoll: vi.fn().mockResolvedValue(undefined),
    logSystem: vi.fn(),
    logTransition: vi.fn(),
  } as any;
}

function makeExecutor(overrides?: Partial<GatewayAdapter>): GatewayAdapter {
  return {
    spawnSession: vi.fn().mockResolvedValue({ success: true, sessionId: "ses-escalated-001" } as SpawnResult),
    getSessionStatus: vi.fn(),
    forceCompleteSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GatewayAdapter;
}

function makeConfig(executor?: GatewayAdapter, opts?: Partial<SchedulerConfig>): SchedulerConfig {
  return {
    dataDir: "/tmp/aof",
    dryRun: false,
    defaultLeaseTtlMs: 600_000,
    executor,
    ...opts,
  } as SchedulerConfig;
}

/** Returns ISO string for a time N ms in the past. */
function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

// ---------------------------------------------------------------------------
// checkHopTimeouts Tests
// ---------------------------------------------------------------------------

describe("checkHopTimeouts", () => {
  let checkHopTimeouts: typeof import("../escalation.js").checkHopTimeouts;

  beforeEach(async () => {
    vi.resetModules();

    // Mock write-file-atomic to prevent actual file writes
    vi.doMock("write-file-atomic", () => ({
      default: vi.fn().mockResolvedValue(undefined),
    }));

    const mod = await import("../escalation.js");
    checkHopTimeouts = mod.checkHopTimeouts;
  });

  it("returns escalation action for dispatched hop exceeding timeout", async () => {
    const executor = makeExecutor();
    const task = makeDAGTask(
      "TASK-001",
      [{ id: "review", role: "swe-qa", timeout: "1h", escalateTo: "swe-pm" }],
      { review: { status: "dispatched", startedAt: ago(2 * 60 * 60 * 1000), agent: "swe-qa", correlationId: "corr-1" } },
    );
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig(executor);

    const actions = await checkHopTimeouts(store, logger, config);

    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("alert");
    expect(actions[0]!.taskId).toBe("TASK-001");
    expect(actions[0]!.reason).toContain("timeout");
  });

  it("skips dispatched hop with no timeout configured", async () => {
    const task = makeDAGTask(
      "TASK-001",
      [{ id: "review", role: "swe-qa" }], // no timeout
      { review: { status: "dispatched", startedAt: ago(2 * 60 * 60 * 1000), agent: "swe-qa" } },
    );
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig();

    const actions = await checkHopTimeouts(store, logger, config);

    expect(actions).toHaveLength(0);
  });

  it("skips dispatched hop that has NOT exceeded timeout", async () => {
    const task = makeDAGTask(
      "TASK-001",
      [{ id: "review", role: "swe-qa", timeout: "1h", escalateTo: "swe-pm" }],
      { review: { status: "dispatched", startedAt: ago(30 * 60 * 1000), agent: "swe-qa" } }, // 30m ago, timeout 1h
    );
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig();

    const actions = await checkHopTimeouts(store, logger, config);

    expect(actions).toHaveLength(0);
  });

  it("skips task with no workflow (gate-based)", async () => {
    const task: Task = {
      frontmatter: {
        schemaVersion: 1 as const,
        id: "TASK-001",
        project: "test",
        title: "Gate task",
        status: "in-progress",
        priority: "normal",
        routing: { tags: [] },
        createdAt: "2026-03-03T00:00:00Z",
        updatedAt: "2026-03-03T00:00:00Z",
        lastTransitionAt: "2026-03-03T00:00:00Z",
        createdBy: "test",
        dependsOn: [],
        metadata: {},
        gateHistory: [],
        tests: [],
        // no workflow field
      },
      body: "Test body",
      path: "/tmp/tasks/in-progress/TASK-001.md",
    };
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig();

    const actions = await checkHopTimeouts(store, logger, config);

    expect(actions).toHaveLength(0);
  });

  it("skips hops with status other than dispatched", async () => {
    const task = makeDAGTask(
      "TASK-001",
      [
        { id: "hop-a", role: "swe", timeout: "1h", escalateTo: "swe-pm" },
        { id: "hop-b", role: "swe", timeout: "1h", escalateTo: "swe-pm", dependsOn: ["hop-a"] },
      ],
      {
        "hop-a": { status: "complete", startedAt: ago(2 * 60 * 60 * 1000), agent: "swe" },
        "hop-b": { status: "pending" },
      },
    );
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig();

    const actions = await checkHopTimeouts(store, logger, config);

    expect(actions).toHaveLength(0);
  });

  it("skips hop with missing startedAt (defensive)", async () => {
    const task = makeDAGTask(
      "TASK-001",
      [{ id: "review", role: "swe-qa", timeout: "1h", escalateTo: "swe-pm" }],
      { review: { status: "dispatched" } }, // no startedAt
    );
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig();

    const actions = await checkHopTimeouts(store, logger, config);

    expect(actions).toHaveLength(0);
  });

  it("skips hop with invalid timeout format and logs warning", async () => {
    const task = makeDAGTask(
      "TASK-001",
      [{ id: "review", role: "swe-qa", timeout: "invalid" }],
      { review: { status: "dispatched", startedAt: ago(2 * 60 * 60 * 1000), agent: "swe-qa" } },
    );
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const actions = await checkHopTimeouts(store, logger, config);
    warnSpy.mockRestore();

    expect(actions).toHaveLength(0);
  });

  it("handles multiple tasks with multiple hops", async () => {
    const executor = makeExecutor();
    const task1 = makeDAGTask(
      "TASK-001",
      [{ id: "review", role: "swe-qa", timeout: "1h", escalateTo: "swe-pm" }],
      { review: { status: "dispatched", startedAt: ago(2 * 60 * 60 * 1000), agent: "swe-qa", correlationId: "c1" } },
    );
    const task2 = makeDAGTask(
      "TASK-002",
      [{ id: "deploy", role: "swe-ops", timeout: "30m", escalateTo: "swe-lead" }],
      { deploy: { status: "dispatched", startedAt: ago(60 * 60 * 1000), agent: "swe-ops", correlationId: "c2" } },
    );
    const store = makeStore([task1, task2]);
    const logger = makeLogger();
    const config = makeConfig(executor);

    const actions = await checkHopTimeouts(store, logger, config);

    expect(actions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// escalateHopTimeout — escalation behavior
// ---------------------------------------------------------------------------

describe("escalateHopTimeout behavior (via checkHopTimeouts)", () => {
  let checkHopTimeouts: typeof import("../escalation.js").checkHopTimeouts;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock("write-file-atomic", () => ({
      default: vi.fn().mockResolvedValue(undefined),
    }));

    const mod = await import("../escalation.js");
    checkHopTimeouts = mod.checkHopTimeouts;
  });

  it("force-completes timed-out session before escalating", async () => {
    const executor = makeExecutor();
    const task = makeDAGTask(
      "TASK-001",
      [{ id: "review", role: "swe-qa", timeout: "1h", escalateTo: "swe-pm" }],
      { review: { status: "dispatched", startedAt: ago(2 * 60 * 60 * 1000), agent: "swe-qa", correlationId: "corr-abc" } },
    );
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig(executor);

    await checkHopTimeouts(store, logger, config);

    expect(executor.forceCompleteSession).toHaveBeenCalledWith("corr-abc");
  });

  it("spawns new session with escalateTo role after force-complete", async () => {
    const executor = makeExecutor();
    const task = makeDAGTask(
      "TASK-001",
      [{ id: "review", role: "swe-qa", timeout: "1h", escalateTo: "swe-pm" }],
      { review: { status: "dispatched", startedAt: ago(2 * 60 * 60 * 1000), agent: "swe-qa", correlationId: "corr-abc" } },
    );
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig(executor);

    await checkHopTimeouts(store, logger, config);

    // Verify spawnSession was called with escalateTo role
    expect(executor.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "TASK-001",
        agent: "swe-pm",
        routing: expect.objectContaining({ role: "swe-pm" }),
      }),
      expect.any(Object),
    );
  });

  it("logs dag.hop_timeout_escalation event with from/to roles", async () => {
    const executor = makeExecutor();
    const task = makeDAGTask(
      "TASK-001",
      [{ id: "review", role: "swe-qa", timeout: "1h", escalateTo: "swe-pm" }],
      { review: { status: "dispatched", startedAt: ago(2 * 60 * 60 * 1000), agent: "swe-qa", correlationId: "corr-abc" } },
    );
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig(executor);

    await checkHopTimeouts(store, logger, config);

    // Find the escalation log call
    const logCalls = logger.log.mock.calls;
    const escalationLog = logCalls.find(
      (call: unknown[]) => call[0] === "dag.hop_timeout_escalation",
    );
    expect(escalationLog).toBeDefined();
    expect(escalationLog![2].payload.fromRole).toBe("swe-qa");
    expect(escalationLog![2].payload.toRole).toBe("swe-pm");
  });

  it("returns alert action with escalation info", async () => {
    const executor = makeExecutor();
    const task = makeDAGTask(
      "TASK-001",
      [{ id: "review", role: "swe-qa", timeout: "1h", escalateTo: "swe-pm" }],
      { review: { status: "dispatched", startedAt: ago(2 * 60 * 60 * 1000), agent: "swe-qa", correlationId: "corr-abc" } },
    );
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig(executor);

    const actions = await checkHopTimeouts(store, logger, config);

    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("alert");
    expect(actions[0]!.reason).toContain("escalated");
    expect(actions[0]!.reason).toContain("swe-pm");
    expect(actions[0]!.agent).toBe("swe-pm");
  });

  it("logs dag.hop_timeout when no escalateTo configured (alert only, no state change)", async () => {
    const executor = makeExecutor();
    const task = makeDAGTask(
      "TASK-001",
      [{ id: "review", role: "swe-qa", timeout: "1h" }], // no escalateTo
      { review: { status: "dispatched", startedAt: ago(2 * 60 * 60 * 1000), agent: "swe-qa", correlationId: "corr-abc" } },
    );
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig(executor);

    const actions = await checkHopTimeouts(store, logger, config);

    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("alert");
    expect(actions[0]!.reason).toContain("no escalation");

    // Should NOT call forceCompleteSession or spawnSession
    expect(executor.forceCompleteSession).not.toHaveBeenCalled();
    expect(executor.spawnSession).not.toHaveBeenCalled();

    // Should log dag.hop_timeout (not escalation)
    const logCalls = logger.log.mock.calls;
    const timeoutLog = logCalls.find(
      (call: unknown[]) => call[0] === "dag.hop_timeout",
    );
    expect(timeoutLog).toBeDefined();
  });

  it("does NOT re-escalate already-escalated hops (one-shot rule)", async () => {
    const executor = makeExecutor();
    const task = makeDAGTask(
      "TASK-001",
      [{ id: "review", role: "swe-qa", timeout: "1h", escalateTo: "swe-pm" }],
      {
        review: {
          status: "dispatched",
          startedAt: ago(2 * 60 * 60 * 1000),
          agent: "swe-pm",
          correlationId: "corr-abc",
          escalated: true, // already escalated
        },
      },
    );
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig(executor);

    const actions = await checkHopTimeouts(store, logger, config);

    // Should return alert but NOT re-escalate
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("alert");

    // Should NOT force-complete or spawn new session
    expect(executor.forceCompleteSession).not.toHaveBeenCalled();
    expect(executor.spawnSession).not.toHaveBeenCalled();

    // Should log dag.hop_timeout (alert only, no escalation)
    const logCalls = logger.log.mock.calls;
    const timeoutLog = logCalls.find(
      (call: unknown[]) => call[0] === "dag.hop_timeout",
    );
    expect(timeoutLog).toBeDefined();
  });

  it("skips force-complete when no executor available", async () => {
    const task = makeDAGTask(
      "TASK-001",
      [{ id: "review", role: "swe-qa", timeout: "1h", escalateTo: "swe-pm" }],
      { review: { status: "dispatched", startedAt: ago(2 * 60 * 60 * 1000), agent: "swe-qa", correlationId: "corr-abc" } },
    );
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig(undefined); // no executor

    const actions = await checkHopTimeouts(store, logger, config);

    // Should still return alert (no escalation possible without executor for re-dispatch)
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("alert");
  });

  it("skips force-complete when no correlationId on hop", async () => {
    const executor = makeExecutor();
    const task = makeDAGTask(
      "TASK-001",
      [{ id: "review", role: "swe-qa", timeout: "1h", escalateTo: "swe-pm" }],
      { review: { status: "dispatched", startedAt: ago(2 * 60 * 60 * 1000), agent: "swe-qa" } }, // no correlationId
    );
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig(executor);

    const actions = await checkHopTimeouts(store, logger, config);

    // Should still escalate but skip forceComplete
    expect(actions).toHaveLength(1);
    expect(executor.forceCompleteSession).not.toHaveBeenCalled();
    // But spawn should still be called for re-dispatch
    expect(executor.spawnSession).toHaveBeenCalled();
  });

  it("dryRun mode returns alert actions but does NOT force-complete, modify state, or dispatch", async () => {
    const executor = makeExecutor();
    const task = makeDAGTask(
      "TASK-001",
      [{ id: "review", role: "swe-qa", timeout: "1h", escalateTo: "swe-pm" }],
      { review: { status: "dispatched", startedAt: ago(2 * 60 * 60 * 1000), agent: "swe-qa", correlationId: "corr-abc" } },
    );
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig(executor, { dryRun: true });

    const actions = await checkHopTimeouts(store, logger, config);

    // Should return alert
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("alert");

    // Should NOT force-complete or spawn
    expect(executor.forceCompleteSession).not.toHaveBeenCalled();
    expect(executor.spawnSession).not.toHaveBeenCalled();
  });

  it("sets hop to ready on spawn failure so poll cycle retries", async () => {
    const executor = makeExecutor({
      spawnSession: vi.fn().mockResolvedValue({ success: false, error: "spawn failed" }),
      forceCompleteSession: vi.fn().mockResolvedValue(undefined),
    } as any);
    const task = makeDAGTask(
      "TASK-001",
      [{ id: "review", role: "swe-qa", timeout: "1h", escalateTo: "swe-pm" }],
      { review: { status: "dispatched", startedAt: ago(2 * 60 * 60 * 1000), agent: "swe-qa", correlationId: "corr-abc" } },
    );
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig(executor);

    await checkHopTimeouts(store, logger, config);

    // After spawn failure, hop should be set to "ready" with escalated=true
    const hopState = task.frontmatter.workflow!.state.hops["review"];
    expect(hopState!.status).toBe("ready");
    expect(hopState!.escalated).toBe(true);
  });

  it("updates hop state with escalateTo agent, new startedAt, new correlationId on success", async () => {
    const executor = makeExecutor();
    const originalStartedAt = ago(2 * 60 * 60 * 1000);
    const task = makeDAGTask(
      "TASK-001",
      [{ id: "review", role: "swe-qa", timeout: "1h", escalateTo: "swe-pm" }],
      { review: { status: "dispatched", startedAt: originalStartedAt, agent: "swe-qa", correlationId: "corr-old" } },
    );
    const store = makeStore([task]);
    const logger = makeLogger();
    const config = makeConfig(executor);

    await checkHopTimeouts(store, logger, config);

    const hopState = task.frontmatter.workflow!.state.hops["review"];
    expect(hopState!.status).toBe("dispatched");
    expect(hopState!.agent).toBe("swe-pm");
    expect(hopState!.escalated).toBe(true);
    expect(hopState!.correlationId).toBe("ses-escalated-001");
    // startedAt should be updated (different from original)
    expect(hopState!.startedAt).not.toBe(originalStartedAt);
  });
});
