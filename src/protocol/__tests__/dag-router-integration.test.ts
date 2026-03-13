/**
 * Integration tests for DAG branch in handleSessionEnd.
 *
 * Verifies dual-mode routing: DAG tasks route to handleDAGHopCompletion,
 * gate tasks flow through existing applyCompletionOutcome unchanged.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "../../schemas/task.js";
import type { TaskWorkflow } from "../../schemas/workflow-dag.js";
import type { RunResult } from "../../schemas/run-result.js";
import type { EventType } from "../../schemas/event.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { GatewayAdapter, TaskContext, SpawnResult, SessionStatus } from "../../dispatch/executor.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock structured logger to suppress output during tests
vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() }),
}));

// Mock dag-transition-handler
const mockHandleDAGHopCompletion = vi.fn();
const mockDispatchDAGHop = vi.fn();
vi.mock("../../dispatch/dag-transition-handler.js", () => ({
  handleDAGHopCompletion: (...args: unknown[]) => mockHandleDAGHopCompletion(...args),
  dispatchDAGHop: (...args: unknown[]) => mockDispatchDAGHop(...args),
}));

// Mock run-artifacts
const mockReadRunResult = vi.fn();
const mockCompleteRunArtifact = vi.fn();
vi.mock("../../recovery/run-artifacts.js", () => ({
  readRunResult: (...args: unknown[]) => mockReadRunResult(...args),
  writeRunResult: vi.fn(),
  completeRunArtifact: (...args: unknown[]) => mockCompleteRunArtifact(...args),
  checkStaleHeartbeats: vi.fn().mockResolvedValue([]),
  markRunArtifactExpired: vi.fn(),
}));

// Mock router-helpers -- keep applyCompletionOutcome trackable
const mockApplyCompletionOutcome = vi.fn();
vi.mock("../router-helpers.js", () => ({
  resolveAuthorizedAgent: vi.fn(),
  checkAuthorization: vi.fn().mockResolvedValue(true),
  applyCompletionOutcome: (...args: unknown[]) => mockApplyCompletionOutcome(...args),
  transitionTask: vi.fn(),
  logTransition: vi.fn(),
  notifyTransition: vi.fn(),
}));

// Mock dep-cascader
const mockCascadeOnCompletion = vi.fn();
vi.mock("../../dispatch/dep-cascader.js", () => ({
  cascadeOnCompletion: (...args: unknown[]) => mockCascadeOnCompletion(...args),
  cascadeOnBlock: vi.fn(),
}));

// Mock delegation
vi.mock("../../delegation/index.js", () => ({
  writeHandoffArtifacts: vi.fn(),
}));

// Mock parsers
vi.mock("../parsers.js", () => ({
  parseProtocolMessage: vi.fn(),
}));

// Mock formatters
vi.mock("../formatters.js", () => ({
  buildStatusReason: vi.fn().mockReturnValue("test reason"),
  shouldAppendWorkLog: vi.fn().mockReturnValue(false),
  buildWorkLogEntry: vi.fn(),
  appendSection: vi.fn(),
}));

// Mock task-lock
vi.mock("../task-lock.js", () => ({
  InMemoryTaskLockManager: class {
    async withLock<T>(_taskId: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    }
  },
}));

import { ProtocolRouter } from "../router.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(): ITaskStore {
  return {
    init: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    updateBody: vi.fn(),
    transition: vi.fn().mockImplementation(async (id: string, status: string) => ({
      frontmatter: { id, status },
    })),
    delete: vi.fn(),
    tasksDir: "/tmp/tasks",
  } as unknown as ITaskStore;
}

function makeLogger() {
  return {
    log: vi.fn().mockResolvedValue(undefined),
    logSchedulerPoll: vi.fn(),
    logSystem: vi.fn(),
    logTransition: vi.fn(),
  } as unknown as { log: (type: EventType, actor: string, opts?: Record<string, unknown>) => Promise<void> };
}

function makeExecutor(): GatewayAdapter {
  return {
    spawnSession: vi.fn().mockResolvedValue({ success: true, sessionId: "ses-001" }),
    getSessionStatus: vi.fn().mockResolvedValue({ active: false }),
    forceComplete: vi.fn(),
  } as unknown as GatewayAdapter;
}

const baseWorkflow: TaskWorkflow = {
  definition: {
    name: "test-wf",
    version: 1,
    hops: [
      { id: "hop-1", role: "swe", dependsOn: [], autoAdvance: true },
      { id: "hop-2", role: "qa", dependsOn: ["hop-1"], autoAdvance: true },
    ],
    edges: [{ from: "hop-1", to: "hop-2" }],
  },
  state: {
    hops: {
      "hop-1": { status: "dispatched", startedAt: "2026-03-03T00:00:00Z", agent: "swe" },
      "hop-2": { status: "pending" },
    },
  },
};

function makeDAGTask(overrides?: Partial<Task["frontmatter"]>): Task {
  return {
    frontmatter: {
      schemaVersion: 1 as const,
      id: "TASK-2026-03-03-001",
      project: "test",
      title: "DAG task",
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
      workflow: structuredClone(baseWorkflow),
      ...overrides,
    },
    body: "Test body",
    path: "/tmp/tasks/in-progress/TASK-2026-03-03-001.md",
  };
}

function makeGateTask(): Task {
  return {
    frontmatter: {
      schemaVersion: 1 as const,
      id: "TASK-2026-03-03-002",
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
      gate: { current: "dev", entered: "2026-03-03T00:00:00Z" },
    },
    body: "Gate body",
    path: "/tmp/tasks/in-progress/TASK-2026-03-03-002.md",
  };
}

function makePlainTask(): Task {
  return {
    frontmatter: {
      schemaVersion: 1 as const,
      id: "TASK-2026-03-03-003",
      project: "test",
      title: "Plain task",
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
    },
    body: "Plain body",
    path: "/tmp/tasks/in-progress/TASK-2026-03-03-003.md",
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
    notes: "All done",
    ...overrides,
  } as RunResult;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleSessionEnd — dual-mode DAG/gate routing", () => {
  let store: ITaskStore;
  let logger: ReturnType<typeof makeLogger>;
  let executor: GatewayAdapter;
  let router: ProtocolRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
    logger = makeLogger();
    executor = makeExecutor();

    router = new ProtocolRouter({
      store,
      logger: logger as any,
      executor,
    });
  });

  it("routes gate task through existing applyCompletionOutcome unchanged (SAFE-02)", async () => {
    const gateTask = makeGateTask();
    const runResult = makeRunResult({ taskId: gateTask.frontmatter.id, outcome: "done" });

    (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([gateTask]);
    mockReadRunResult.mockResolvedValue(runResult);
    mockApplyCompletionOutcome.mockResolvedValue(undefined);
    mockCompleteRunArtifact.mockResolvedValue(undefined);
    mockCascadeOnCompletion.mockResolvedValue(undefined);

    await router.handleSessionEnd();

    expect(mockApplyCompletionOutcome).toHaveBeenCalledOnce();
    expect(mockHandleDAGHopCompletion).not.toHaveBeenCalled();
    expect(mockCompleteRunArtifact).toHaveBeenCalledOnce();
  });

  it("routes DAG task to handleDAGHopCompletion instead of applyCompletionOutcome", async () => {
    const dagTask = makeDAGTask();
    const runResult = makeRunResult();

    (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([dagTask]);
    mockReadRunResult.mockResolvedValue(runResult);
    mockHandleDAGHopCompletion.mockResolvedValue({
      readyHops: ["hop-2"],
      dagComplete: false,
      reviewRequired: false,
    });
    mockDispatchDAGHop.mockResolvedValue(true);
    mockCompleteRunArtifact.mockResolvedValue(undefined);

    await router.handleSessionEnd();

    expect(mockHandleDAGHopCompletion).toHaveBeenCalledOnce();
    expect(mockApplyCompletionOutcome).not.toHaveBeenCalled();
    expect(mockCompleteRunArtifact).toHaveBeenCalledOnce();
  });

  it("dispatches first ready hop immediately after DAG completion (EXEC-03)", async () => {
    const dagTask = makeDAGTask();
    const runResult = makeRunResult();

    (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([dagTask]);
    mockReadRunResult.mockResolvedValue(runResult);
    mockHandleDAGHopCompletion.mockResolvedValue({
      readyHops: ["hop-2", "hop-3"],
      dagComplete: false,
      reviewRequired: false,
    });
    mockDispatchDAGHop.mockResolvedValue(true);
    mockCompleteRunArtifact.mockResolvedValue(undefined);

    await router.handleSessionEnd();

    // Only first ready hop dispatched immediately
    expect(mockDispatchDAGHop).toHaveBeenCalledOnce();
    expect(mockDispatchDAGHop).toHaveBeenCalledWith(
      store,
      expect.anything(), // logger
      expect.objectContaining({}), // config
      executor,
      dagTask,
      "hop-2", // first ready hop
    );
  });

  it("transitions task to review when reviewRequired is true", async () => {
    const dagTask = makeDAGTask();
    const runResult = makeRunResult();

    (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([dagTask]);
    mockReadRunResult.mockResolvedValue(runResult);
    mockHandleDAGHopCompletion.mockResolvedValue({
      readyHops: ["hop-2"],
      dagComplete: false,
      reviewRequired: true,
    });
    mockCompleteRunArtifact.mockResolvedValue(undefined);

    await router.handleSessionEnd();

    expect(store.transition).toHaveBeenCalledWith(
      dagTask.frontmatter.id,
      "review",
      expect.objectContaining({ reason: expect.stringContaining("review") }),
    );
    // Should NOT dispatch next hop when review required
    expect(mockDispatchDAGHop).not.toHaveBeenCalled();
  });

  it("transitions task to done when DAG completes with done status", async () => {
    const dagTask = makeDAGTask();
    const runResult = makeRunResult();

    (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([dagTask]);
    mockReadRunResult.mockResolvedValue(runResult);
    mockHandleDAGHopCompletion.mockResolvedValue({
      readyHops: [],
      dagComplete: true,
      reviewRequired: false,
    });
    mockCompleteRunArtifact.mockResolvedValue(undefined);

    // Re-read fresh task to get taskStatus from evaluator
    (store.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...dagTask,
      frontmatter: {
        ...dagTask.frontmatter,
        workflow: {
          ...dagTask.frontmatter.workflow!,
          state: {
            hops: {
              "hop-1": { status: "complete" },
              "hop-2": { status: "complete" },
            },
          },
        },
      },
    });

    await router.handleSessionEnd();

    // Task should go through review -> done (respecting valid transitions)
    expect(store.transition).toHaveBeenCalledWith(
      dagTask.frontmatter.id,
      "review",
      expect.objectContaining({ reason: expect.stringContaining("DAG") }),
    );
  });

  it("transitions task to blocked when DAG completes with all hops failed/skipped", async () => {
    const dagTask = makeDAGTask();
    const runResult = makeRunResult({ outcome: "blocked" });

    (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([dagTask]);
    mockReadRunResult.mockResolvedValue(runResult);
    mockHandleDAGHopCompletion.mockResolvedValue({
      readyHops: [],
      dagComplete: true,
      reviewRequired: false,
    });
    mockCompleteRunArtifact.mockResolvedValue(undefined);

    await router.handleSessionEnd();

    // DAG failed -> transition to blocked (valid from in-progress)
    expect(store.transition).toHaveBeenCalledWith(
      dagTask.frontmatter.id,
      "blocked",
      expect.objectContaining({ reason: expect.stringContaining("DAG") }),
    );
  });

  it("routes plain task (neither gate nor DAG) through applyCompletionOutcome", async () => {
    const plainTask = makePlainTask();
    const runResult = makeRunResult({ taskId: plainTask.frontmatter.id });

    (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([plainTask]);
    mockReadRunResult.mockResolvedValue(runResult);
    mockApplyCompletionOutcome.mockResolvedValue(undefined);
    mockCompleteRunArtifact.mockResolvedValue(undefined);

    await router.handleSessionEnd();

    expect(mockApplyCompletionOutcome).toHaveBeenCalledOnce();
    expect(mockHandleDAGHopCompletion).not.toHaveBeenCalled();
  });

  it("catches and logs errors from DAG path without crashing", async () => {
    const dagTask = makeDAGTask();
    const runResult = makeRunResult();

    (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([dagTask]);
    mockReadRunResult.mockResolvedValue(runResult);
    mockHandleDAGHopCompletion.mockRejectedValue(new Error("DAG eval blew up"));
    mockCompleteRunArtifact.mockResolvedValue(undefined);

    // Should not throw
    await expect(router.handleSessionEnd()).resolves.toBeUndefined();
  });

  it("skips immediate dispatch when executor is not available", async () => {
    // Router without executor
    const routerNoExec = new ProtocolRouter({
      store,
      logger: logger as any,
    });

    const dagTask = makeDAGTask();
    const runResult = makeRunResult();

    (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([dagTask]);
    mockReadRunResult.mockResolvedValue(runResult);
    mockHandleDAGHopCompletion.mockResolvedValue({
      readyHops: ["hop-2"],
      dagComplete: false,
      reviewRequired: false,
    });
    mockCompleteRunArtifact.mockResolvedValue(undefined);

    await routerNoExec.handleSessionEnd();

    expect(mockHandleDAGHopCompletion).toHaveBeenCalledOnce();
    // No executor -> no dispatch
    expect(mockDispatchDAGHop).not.toHaveBeenCalled();
  });

  it("skips task with no run result", async () => {
    const dagTask = makeDAGTask();

    (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([dagTask]);
    mockReadRunResult.mockResolvedValue(null);

    await router.handleSessionEnd();

    expect(mockHandleDAGHopCompletion).not.toHaveBeenCalled();
    expect(mockApplyCompletionOutcome).not.toHaveBeenCalled();
  });
});
