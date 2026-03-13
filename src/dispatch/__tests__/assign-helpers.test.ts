/**
 * Tests for assign-helpers.ts — handleRunComplete extracted from assign-executor.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the safe helpers that handleRunComplete delegates to
vi.mock("../trace-helpers.js", () => ({
  captureTraceSafely: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../callback-helpers.js", () => ({
  deliverAllCallbacksSafely: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lease-manager.js", () => ({
  stopLeaseRenewal: vi.fn(),
}));

// Mock failure-tracker functions used in enforcement path
vi.mock("../failure-tracker.js", () => ({
  trackDispatchFailure: vi.fn().mockResolvedValue(undefined),
  shouldTransitionToDeadletter: vi.fn().mockReturnValue(false),
  transitionToDeadletter: vi.fn().mockResolvedValue(undefined),
}));

// Mock serializeTask and writeFileAtomic
vi.mock("../../store/task-store.js", () => ({
  serializeTask: vi.fn().mockReturnValue("---\nid: test\n---\n"),
}));

vi.mock("write-file-atomic", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

import { captureTraceSafely } from "../trace-helpers.js";
import { deliverAllCallbacksSafely } from "../callback-helpers.js";
import { handleRunComplete, type OnRunCompleteContext } from "../assign-helpers.js";
import { trackDispatchFailure, shouldTransitionToDeadletter, transitionToDeadletter } from "../failure-tracker.js";
import type { AgentRunOutcome } from "../executor.js";

describe("handleRunComplete", () => {
  let mockStore: any;
  let mockLogger: any;
  let mockExecutor: any;
  let baseCtx: OnRunCompleteContext;

  beforeEach(() => {
    vi.clearAllMocks();

    mockStore = {
      tasksDir: "/tmp/tasks",
      get: vi.fn(),
      transition: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
      saveToPath: vi.fn().mockResolvedValue(undefined),
    };

    mockLogger = {
      log: vi.fn().mockResolvedValue(undefined),
    };

    mockExecutor = {};

    baseCtx = {
      action: {
        type: "assign" as const,
        taskId: "task-1",
        taskTitle: "Test Task",
        agent: "test-agent",
        reason: "ready",
      },
      store: mockStore,
      logger: mockLogger,
      config: { dataDir: "/tmp", dryRun: false, executor: mockExecutor, maxConcurrentDispatches: 3, defaultLeaseTtlMs: 60000 },
      correlationId: "corr-123",
      effectiveConcurrencyLimitRef: { value: null },
      allTasks: [],
      executor: mockExecutor,
    };
  });

  describe("success path (agent already transitioned)", () => {
    it("calls captureTraceSafely and deliverAllCallbacksSafely", async () => {
      const doneTask = {
        frontmatter: { status: "done", metadata: { debug: false } },
      };
      mockStore.get.mockResolvedValue(doneTask);

      const outcome: AgentRunOutcome = {
        taskId: "task-1",
        sessionId: "session-1",
        success: true,
        aborted: false,
        durationMs: 5000,
      };

      await handleRunComplete(baseCtx, outcome);

      expect(captureTraceSafely).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "task-1",
          sessionId: "session-1",
          agentId: "test-agent",
          durationMs: 5000,
          currentTask: doneTask,
        }),
      );
      expect(deliverAllCallbacksSafely).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "task-1",
          store: mockStore,
          executor: mockExecutor,
          logger: mockLogger,
        }),
      );
    });

    it("returns early when task is not found", async () => {
      mockStore.get.mockResolvedValue(null);

      const outcome: AgentRunOutcome = {
        taskId: "task-1",
        sessionId: "session-1",
        success: true,
        aborted: false,
        durationMs: 5000,
      };

      await handleRunComplete(baseCtx, outcome);

      expect(captureTraceSafely).not.toHaveBeenCalled();
      expect(deliverAllCallbacksSafely).not.toHaveBeenCalled();
    });
  });

  describe("enforcement path (agent exited without completing)", () => {
    it("transitions to blocked and calls trace+callbacks", async () => {
      const inProgressTask = {
        frontmatter: { status: "in-progress", metadata: {} },
        path: "/tmp/tasks/in-progress/task-1.md",
      };
      mockStore.get.mockResolvedValue(inProgressTask);

      const outcome: AgentRunOutcome = {
        taskId: "task-1",
        sessionId: "session-1",
        success: true,
        aborted: false,
        durationMs: 5000,
      };

      await handleRunComplete(baseCtx, outcome);

      // Should track failure and transition
      expect(trackDispatchFailure).toHaveBeenCalledWith(mockStore, "task-1", expect.stringContaining("agent exited without calling aof_task_complete"));
      expect(mockStore.transition).toHaveBeenCalledWith("task-1", "blocked", expect.any(Object));

      // Should still call trace and callbacks
      expect(captureTraceSafely).toHaveBeenCalled();
      expect(deliverAllCallbacksSafely).toHaveBeenCalled();
    });

    it("transitions to deadletter when threshold reached", async () => {
      const inProgressTask = {
        frontmatter: { status: "in-progress", metadata: {} },
        path: "/tmp/tasks/in-progress/task-1.md",
      };
      mockStore.get.mockResolvedValue(inProgressTask);
      vi.mocked(shouldTransitionToDeadletter).mockReturnValue(true);

      const outcome: AgentRunOutcome = {
        taskId: "task-1",
        sessionId: "session-1",
        success: true,
        aborted: false,
        durationMs: 5000,
      };

      await handleRunComplete(baseCtx, outcome);

      expect(transitionToDeadletter).toHaveBeenCalledWith(mockStore, mockLogger, "task-1", expect.any(String));
      expect(mockStore.transition).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("logs enforcement errors without throwing", async () => {
      const inProgressTask = {
        frontmatter: { status: "in-progress", metadata: {} },
        path: "/tmp/tasks/in-progress/task-1.md",
      };
      mockStore.get.mockResolvedValue(inProgressTask);
      vi.mocked(trackDispatchFailure).mockRejectedValue(new Error("track boom"));

      const outcome: AgentRunOutcome = {
        taskId: "task-1",
        sessionId: "session-1",
        success: true,
        aborted: false,
        durationMs: 5000,
      };

      // Should not throw
      await expect(handleRunComplete(baseCtx, outcome)).resolves.toBeUndefined();

      // Should still call trace and callbacks despite the enforcement error
      expect(captureTraceSafely).toHaveBeenCalled();
      expect(deliverAllCallbacksSafely).toHaveBeenCalled();
    });

    it("builds correct enforcement reason for agent error", async () => {
      const inProgressTask = {
        frontmatter: { status: "in-progress", metadata: {} },
        path: "/tmp/tasks/in-progress/task-1.md",
      };
      mockStore.get.mockResolvedValue(inProgressTask);

      const outcome: AgentRunOutcome = {
        taskId: "task-1",
        sessionId: "session-1",
        success: false,
        aborted: false,
        error: { kind: "timeout", message: "timed out" },
        durationMs: 5000,
      };

      await handleRunComplete(baseCtx, outcome);

      expect(trackDispatchFailure).toHaveBeenCalledWith(
        mockStore,
        "task-1",
        "Agent error: timeout: timed out",
      );
    });
  });
});
