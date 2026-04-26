/**
 * Unit tests for recovery action handlers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleStaleHeartbeat } from "../recovery-handlers.js";
import type { SchedulerAction, SchedulerConfig } from "../scheduler.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { EventLogger } from "../../events/logger.js";
import { createMockStore, createMockLogger } from "../../testing/index.js";

// Mock run-artifacts
vi.mock("../../recovery/run-artifacts.js", () => ({
  readRunResult: vi.fn().mockResolvedValue(null),
  markRunArtifactExpired: vi.fn().mockResolvedValue(undefined),
}));

// Mock completion-utils
vi.mock("../../protocol/completion-utils.js", () => ({
  resolveCompletionTransitions: vi.fn().mockReturnValue(["done"]),
}));

// Mock dep-cascader
vi.mock("../dep-cascader.js", () => ({
  cascadeOnCompletion: vi.fn().mockResolvedValue(undefined),
}));

import { readRunResult, markRunArtifactExpired } from "../../recovery/run-artifacts.js";
import { resolveCompletionTransitions } from "../../protocol/completion-utils.js";
import { cascadeOnCompletion } from "../dep-cascader.js";

function makeStore(task?: any): ITaskStore {
  const defaultTask = {
    frontmatter: {
      id: "task-1",
      title: "Test",
      status: "in-progress",
      createdBy: "test",
      createdAt: new Date().toISOString(),
      dependsOn: [],
      metadata: {},
    },
    body: "",
  };
  const store = createMockStore();
  store.get.mockResolvedValue(task ?? defaultTask);
  store.transition.mockResolvedValue(undefined);
  return store as unknown as ITaskStore;
}

function makeLogger(): EventLogger {
  return createMockLogger() as unknown as EventLogger;
}

function makeAction(): SchedulerAction {
  return {
    type: "stale_heartbeat",
    taskId: "task-1",
    taskTitle: "Test",
    reason: "stale heartbeat",
  };
}

describe("handleStaleHeartbeat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reclaims to ready when no run_result exists", async () => {
    const store = makeStore();
    const logger = makeLogger();
    const config: SchedulerConfig = { dataDir: "/tmp", dryRun: false, defaultLeaseTtlMs: 60000 };

    vi.mocked(readRunResult).mockResolvedValue(null);

    const result = await handleStaleHeartbeat(makeAction(), store, logger, config);

    expect(store.transition).toHaveBeenCalledWith("task-1", "ready", { reason: "stale_heartbeat_reclaim" });
    expect(markRunArtifactExpired).toHaveBeenCalledWith(store, "task-1", "stale_heartbeat");
    expect(result.executed).toBe(false);
    expect(result.failed).toBe(false);
  });

  it("applies outcome-driven transitions when run_result exists", async () => {
    const store = makeStore();
    const logger = makeLogger();
    const config: SchedulerConfig = { dataDir: "/tmp", dryRun: false, defaultLeaseTtlMs: 60000 };

    vi.mocked(readRunResult).mockResolvedValue({ outcome: "done" } as any);
    vi.mocked(resolveCompletionTransitions).mockReturnValue(["review", "done"] as any);

    await handleStaleHeartbeat(makeAction(), store, logger, config);

    expect(store.transition).toHaveBeenCalledWith("task-1", "review", { reason: "stale_heartbeat_done" });
    expect(store.transition).toHaveBeenCalledWith("task-1", "done", { reason: "stale_heartbeat_done" });
  });

  it("cascades on done outcome", async () => {
    const store = makeStore();
    const logger = makeLogger();
    const config: SchedulerConfig = { dataDir: "/tmp", dryRun: false, defaultLeaseTtlMs: 60000 };

    vi.mocked(readRunResult).mockResolvedValue({ outcome: "done" } as any);
    vi.mocked(resolveCompletionTransitions).mockReturnValue(["done"] as any);

    await handleStaleHeartbeat(makeAction(), store, logger, config);

    expect(cascadeOnCompletion).toHaveBeenCalledWith("task-1", store, logger);
  });

  it("force-completes session when adapter available", async () => {
    const forceCompleteSession = vi.fn().mockResolvedValue(undefined);
    const store = makeStore({
      frontmatter: {
        id: "task-1",
        title: "Test",
        status: "in-progress",
        createdBy: "test",
        createdAt: new Date().toISOString(),
        dependsOn: [],
        metadata: { sessionId: "sess-123" },
      },
      body: "",
    });
    const logger = makeLogger();
    const config: SchedulerConfig = {
      dataDir: "/tmp",
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor: { forceCompleteSession, spawnSession: vi.fn() } as any,
    };

    vi.mocked(readRunResult).mockResolvedValue(null);

    await handleStaleHeartbeat(makeAction(), store, logger, config);

    expect(forceCompleteSession).toHaveBeenCalledWith("sess-123");
  });

  it("skips when task not found", async () => {
    const store = makeStore();
    vi.mocked(store.get).mockResolvedValue(null);
    const logger = makeLogger();
    const config: SchedulerConfig = { dataDir: "/tmp", dryRun: false, defaultLeaseTtlMs: 60000 };

    const result = await handleStaleHeartbeat(makeAction(), store, logger, config);

    expect(store.transition).not.toHaveBeenCalled();
    expect(result.executed).toBe(false);
  });

  it("swallows event logger failures", async () => {
    const store = makeStore();
    const logger = makeLogger();
    vi.mocked(logger.logTransition).mockRejectedValue(new Error("log boom"));
    const config: SchedulerConfig = { dataDir: "/tmp", dryRun: false, defaultLeaseTtlMs: 60000 };

    vi.mocked(readRunResult).mockResolvedValue(null);

    // Should not throw
    const result = await handleStaleHeartbeat(makeAction(), store, logger, config);
    expect(result.failed).toBe(false);
  });

  // Phase 999.3 — precondition guards (TASK-2026-04-15-010 race shape).
  it("skips when status is no longer in-progress (precondition guard)", async () => {
    const store = makeStore({
      frontmatter: {
        id: "task-1",
        title: "Test",
        status: "blocked", // race winner already moved it
        createdBy: "test",
        createdAt: new Date().toISOString(),
        dependsOn: [],
        metadata: {},
      },
      body: "",
    });
    const logger = makeLogger();
    const config: SchedulerConfig = { dataDir: "/tmp", dryRun: false, defaultLeaseTtlMs: 60000 };

    const result = await handleStaleHeartbeat(makeAction(), store, logger, config);

    expect(result).toEqual({ executed: false, failed: false });
    expect(store.transition).not.toHaveBeenCalled();
    expect(readRunResult).not.toHaveBeenCalled();
  });

  it("skips when lease was reassigned to a different agent (precondition guard)", async () => {
    const store = makeStore({
      frontmatter: {
        id: "task-1",
        title: "Test",
        status: "in-progress",
        createdBy: "test",
        createdAt: new Date().toISOString(),
        dependsOn: [],
        lease: {
          agent: "agent-2", // currently held by agent-2
          acquiredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          renewCount: 0,
        },
        metadata: {},
      },
      body: "",
    });
    const logger = makeLogger();
    const config: SchedulerConfig = { dataDir: "/tmp", dryRun: false, defaultLeaseTtlMs: 60000 };
    const action: SchedulerAction = {
      type: "stale_heartbeat",
      taskId: "task-1",
      taskTitle: "Test",
      agent: "agent-1", // queued for agent-1
      reason: "stale heartbeat",
    };

    const result = await handleStaleHeartbeat(action, store, logger, config);

    expect(result).toEqual({ executed: false, failed: false });
    expect(store.transition).not.toHaveBeenCalled();
    expect(readRunResult).not.toHaveBeenCalled();
  });
});
