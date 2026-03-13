/**
 * Unit tests for alert action handlers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleAlert,
  handleBlock,
  handleSlaViolation,
  handleMurmurCreateTask,
} from "../alert-handlers.js";
import type { SchedulerAction, SchedulerConfig } from "../scheduler.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { EventLogger } from "../../events/logger.js";

function makeStore(): ITaskStore {
  return {
    get: vi.fn().mockResolvedValue(null),
    transition: vi.fn().mockResolvedValue(undefined),
    tasksDir: "/tmp/tasks",
  } as unknown as ITaskStore;
}

function makeLogger(): EventLogger {
  return {
    logTransition: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventLogger;
}

describe("handleAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs scheduler_alert event", async () => {
    const logger = makeLogger();

    const result = await handleAlert(
      { type: "alert", taskId: "task-1", taskTitle: "Test", reason: "something wrong", agent: "agent-1" },
      logger
    );

    expect(logger.log).toHaveBeenCalledWith("scheduler_alert", "scheduler", {
      taskId: "task-1",
      payload: { agent: "agent-1", reason: "something wrong" },
    });
    expect(result.executed).toBe(false);
    expect(result.failed).toBe(false);
  });

  it("swallows event logger failures", async () => {
    const logger = makeLogger();
    vi.mocked(logger.log).mockRejectedValue(new Error("log boom"));

    const result = await handleAlert(
      { type: "alert", taskId: "task-1", taskTitle: "Test", reason: "test" },
      logger
    );

    expect(result.failed).toBe(false);
  });
});

describe("handleBlock", () => {
  it("transitions task to blocked status", async () => {
    const store = makeStore();
    const logger = makeLogger();

    const result = await handleBlock(
      { type: "block", taskId: "task-1", taskTitle: "Test", reason: "deps missing", blockers: ["dep-1"] },
      store,
      logger
    );

    expect(store.transition).toHaveBeenCalledWith("task-1", "blocked", {
      reason: "deps missing",
      blockers: ["dep-1"],
    });
    expect(result.executed).toBe(false);
  });

  it("swallows event logger failures", async () => {
    const store = makeStore();
    const logger = makeLogger();
    vi.mocked(logger.logTransition).mockRejectedValue(new Error("log boom"));

    const result = await handleBlock(
      { type: "block", taskId: "task-1", taskTitle: "Test", reason: "test" },
      store,
      logger
    );

    expect(result.failed).toBe(false);
  });
});

describe("handleSlaViolation", () => {
  it("logs sla.violation event", async () => {
    const logger = makeLogger();
    const config: SchedulerConfig = { dataDir: "/tmp", dryRun: false, defaultLeaseTtlMs: 60000 };

    const result = await handleSlaViolation(
      { type: "sla_violation", taskId: "task-1", taskTitle: "Test", reason: "over limit", duration: 7200000, limit: 3600000 },
      logger,
      config
    );

    expect(logger.log).toHaveBeenCalledWith("sla.violation", "scheduler", expect.objectContaining({
      taskId: "task-1",
    }));
    expect(result.executed).toBe(false);
  });

  it("emits alert when not rate-limited", async () => {
    const recordAlert = vi.fn();
    const logger = makeLogger();
    const config: SchedulerConfig = {
      dataDir: "/tmp", dryRun: false, defaultLeaseTtlMs: 60000,
      slaChecker: { recordAlert } as any,
    };

    await handleSlaViolation(
      { type: "sla_violation", taskId: "task-1", taskTitle: "Test", reason: "alert will be sent", duration: 7200000, limit: 3600000, agent: "agent-1" },
      logger,
      config
    );

    expect(recordAlert).toHaveBeenCalledWith("task-1");
  });

  it("swallows event logger failures", async () => {
    const logger = makeLogger();
    vi.mocked(logger.log).mockRejectedValue(new Error("log boom"));
    const config: SchedulerConfig = { dataDir: "/tmp", dryRun: false, defaultLeaseTtlMs: 60000 };

    const result = await handleSlaViolation(
      { type: "sla_violation", taskId: "task-1", taskTitle: "Test", reason: "test" },
      logger,
      config
    );

    expect(result.failed).toBe(false);
  });
});

describe("handleMurmurCreateTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs murmur_task_created event", async () => {
    const logger = makeLogger();

    const result = await handleMurmurCreateTask(
      { type: "murmur_create_task", taskId: "task-1", taskTitle: "Test", reason: "murmur", sourceTaskId: "src-1", murmurCandidateId: "cand-1", agent: "agent-1" },
      logger
    );

    expect(logger.log).toHaveBeenCalledWith("murmur_task_created", "scheduler", expect.objectContaining({
      taskId: "task-1",
    }));
    expect(result.executed).toBe(false);
    expect(result.failed).toBe(false);
  });

  it("returns failed=true when logger throws", async () => {
    const logger = makeLogger();
    vi.mocked(logger.log).mockRejectedValue(new Error("log boom"));

    const result = await handleMurmurCreateTask(
      { type: "murmur_create_task", taskId: "task-1", taskTitle: "Test", reason: "test", sourceTaskId: "src-1" },
      logger
    );

    expect(result.failed).toBe(true);
  });
});
