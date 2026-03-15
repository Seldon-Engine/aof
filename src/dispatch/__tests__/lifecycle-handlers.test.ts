/**
 * Unit tests for lifecycle action handlers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleExpireLease,
  handlePromote,
  handleRequeue,
  handleDeadletter,
} from "../lifecycle-handlers.js";
import type { SchedulerAction, SchedulerConfig } from "../scheduler.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { EventLogger } from "../../events/logger.js";
import type { Task } from "../../schemas/task.js";
import { createMockStore, createMockLogger } from "../../testing/index.js";

// Mock write-file-atomic to avoid filesystem writes
vi.mock("write-file-atomic", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

// Mock task-store serialization
vi.mock("../../store/task-store.js", () => ({
  serializeTask: vi.fn().mockReturnValue("---\nid: task-1\n---\n"),
}));

// Mock failure-tracker to spy on transitionToDeadletter
vi.mock("../failure-tracker.js", () => ({
  transitionToDeadletter: vi.fn().mockResolvedValue(undefined),
}));

// Mock scheduler-helpers
vi.mock("../scheduler-helpers.js", async () => {
  const actual = await vi.importActual<typeof import("../scheduler-helpers.js")>("../scheduler-helpers.js");
  return {
    ...actual,
    shouldAllowSpawnFailedRequeue: vi.fn().mockReturnValue({ allow: true, shouldDeadletter: false, reason: "test" }),
  };
});

import { transitionToDeadletter } from "../failure-tracker.js";
import { shouldAllowSpawnFailedRequeue } from "../scheduler-helpers.js";

function makeStore(task?: Partial<Task>): ITaskStore {
  const defaultTask: Task = {
    frontmatter: {
      id: "task-1",
      title: "Test",
      status: "in-progress",
      createdBy: "test",
      createdAt: new Date().toISOString(),
      dependsOn: [],
    },
    body: "",
    path: "/tmp/tasks/in-progress/task-1.md",
    ...task,
  };
  const store = createMockStore();
  store.get.mockResolvedValue(defaultTask);
  store.transition.mockResolvedValue(undefined);
  return store as unknown as ITaskStore;
}

function makeLogger(): EventLogger {
  return createMockLogger() as unknown as EventLogger;
}

function makeAction(overrides?: Partial<SchedulerAction>): SchedulerAction {
  return {
    type: "expire_lease",
    taskId: "task-1",
    taskTitle: "Test",
    reason: "lease expired",
    ...overrides,
  };
}

describe("handleExpireLease", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transitions in-progress task to ready on lease expiry", async () => {
    const store = makeStore();
    const logger = makeLogger();
    const config: SchedulerConfig = { dataDir: "/tmp", dryRun: false, defaultLeaseTtlMs: 60000 };

    const result = await handleExpireLease(makeAction(), store, logger, [], config);

    expect(store.transition).toHaveBeenCalledWith("task-1", "ready", { reason: "lease_expired" });
    expect(result.leasesExpired).toBe(1);
    expect(result.tasksRequeued).toBe(1);
    expect(result.executed).toBe(false);
  });

  it("handles spawn-failed blocked tasks (deadletter path)", async () => {
    const store = makeStore({
      frontmatter: {
        id: "task-1",
        title: "Test",
        status: "blocked",
        createdBy: "test",
        createdAt: new Date().toISOString(),
        dependsOn: [],
        metadata: { blockReason: "spawn_failed: error" },
      },
    });
    const logger = makeLogger();
    const config: SchedulerConfig = { dataDir: "/tmp", dryRun: false, defaultLeaseTtlMs: 60000 };

    vi.mocked(shouldAllowSpawnFailedRequeue).mockReturnValue({ allow: false, shouldDeadletter: true, reason: "max retries exceeded" });

    await handleExpireLease(makeAction(), store, logger, [], config);

    expect(transitionToDeadletter).toHaveBeenCalledWith(store, logger, "task-1", expect.any(String));
  });

  it("handles dependency-blocked tasks with deps satisfied", async () => {
    const depTask: Task = {
      frontmatter: { id: "dep-1", title: "Dep", status: "done", createdBy: "test", createdAt: new Date().toISOString(), dependsOn: [] },
      body: "",
    };
    const store = makeStore({
      frontmatter: {
        id: "task-1",
        title: "Test",
        status: "blocked",
        createdBy: "test",
        createdAt: new Date().toISOString(),
        dependsOn: ["dep-1"],
      },
    });
    const logger = makeLogger();
    const config: SchedulerConfig = { dataDir: "/tmp", dryRun: false, defaultLeaseTtlMs: 60000 };

    await handleExpireLease(makeAction(), store, logger, [depTask], config);

    expect(store.transition).toHaveBeenCalledWith("task-1", "ready", { reason: "lease_expired_requeue" });
  });

  it("wraps in lockManager when present", async () => {
    const withLock = vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn());
    const store = makeStore();
    const logger = makeLogger();
    const config: SchedulerConfig = {
      dataDir: "/tmp", dryRun: false, defaultLeaseTtlMs: 60000,
      lockManager: { withLock } as any,
    };

    await handleExpireLease(makeAction(), store, logger, [], config);

    expect(withLock).toHaveBeenCalledWith("task-1", expect.any(Function));
  });

  it("works without lockManager", async () => {
    const store = makeStore();
    const logger = makeLogger();
    const config: SchedulerConfig = { dataDir: "/tmp", dryRun: false, defaultLeaseTtlMs: 60000 };

    const result = await handleExpireLease(makeAction(), store, logger, [], config);

    expect(result.leasesExpired).toBe(1);
  });

  it("swallows event logger failures at warn level", async () => {
    const store = makeStore();
    const logger = makeLogger();
    vi.mocked(logger.logTransition).mockRejectedValue(new Error("log boom"));
    const config: SchedulerConfig = { dataDir: "/tmp", dryRun: false, defaultLeaseTtlMs: 60000 };

    // Should not throw
    const result = await handleExpireLease(makeAction(), store, logger, [], config);
    expect(result.leasesExpired).toBe(1);
  });
});

describe("handlePromote", () => {
  it("transitions task from backlog to ready", async () => {
    const store = makeStore();
    const logger = makeLogger();

    const result = await handlePromote(
      makeAction({ type: "promote", reason: "deps satisfied" }),
      store,
      logger
    );

    expect(store.transition).toHaveBeenCalledWith("task-1", "ready", { reason: "dependency_satisfied" });
    expect(result.tasksPromoted).toBe(1);
    expect(result.executed).toBe(false);
  });

  it("swallows event logger failures", async () => {
    const store = makeStore();
    const logger = makeLogger();
    vi.mocked(logger.logTransition).mockRejectedValue(new Error("log boom"));

    const result = await handlePromote(
      makeAction({ type: "promote" }),
      store,
      logger
    );

    expect(result.tasksPromoted).toBe(1);
  });
});

describe("handleRequeue", () => {
  it("updates metadata and transitions to ready", async () => {
    const store = makeStore({
      frontmatter: {
        id: "task-1",
        title: "Test",
        status: "blocked",
        createdBy: "test",
        createdAt: new Date().toISOString(),
        dependsOn: [],
      },
    });
    const logger = makeLogger();

    const result = await handleRequeue(
      makeAction({ type: "requeue", reason: "manual requeue" }),
      store,
      logger
    );

    expect(store.transition).toHaveBeenCalledWith("task-1", "ready", { reason: "manual requeue" });
    expect(result.executed).toBe(false);
    expect(result.failed).toBe(false);
  });
});

describe("handleDeadletter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls transitionToDeadletter with reason", async () => {
    const store = makeStore();
    const logger = makeLogger();

    await handleDeadletter(
      makeAction({ type: "deadletter", reason: "max retries" }),
      store,
      logger
    );

    expect(transitionToDeadletter).toHaveBeenCalledWith(store, logger, "task-1", "max retries");
  });
});
