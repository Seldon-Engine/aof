/**
 * Integration tests for deliverAllGranularityCallbacks wiring in assign-executor.
 * Verifies GRAN-02: all-granularity subscribers receive real-time notifications.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import { EventLogger } from "../../events/logger.js";
import { executeAssignAction } from "../assign-executor.js";
import type { DispatchConfig, SchedulerAction } from "../task-dispatcher.js";
import type { GatewayAdapter, SpawnResult, TaskContext } from "../executor.js";

// Mock callback-delivery module to spy on function calls
vi.mock("../callback-delivery.js", async () => {
  const actual = await vi.importActual<typeof import("../callback-delivery.js")>("../callback-delivery.js");
  return {
    ...actual,
    deliverCallbacks: vi.fn().mockResolvedValue(undefined),
    deliverAllGranularityCallbacks: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock trace-writer to avoid filesystem side effects
vi.mock("../../trace/trace-writer.js", () => ({
  captureTrace: vi.fn().mockResolvedValue(undefined),
}));

import { deliverCallbacks, deliverAllGranularityCallbacks } from "../callback-delivery.js";

describe("assign-executor callback wiring (GRAN-02)", () => {
  let tmpDir: string;
  let store: FilesystemTaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-assign-exec-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    logger = new EventLogger(join(tmpDir, "events"));

    // Reset mocks
    vi.mocked(deliverCallbacks).mockReset().mockResolvedValue(undefined);
    vi.mocked(deliverAllGranularityCallbacks).mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeExecutor(opts?: {
    onRunComplete?: (outcome: any) => Promise<void>;
    taskTransitioned?: boolean;
  }): GatewayAdapter {
    const taskTransitioned = opts?.taskTransitioned ?? true;
    return {
      spawnSession: vi.fn().mockImplementation(async (context: TaskContext, spawnOpts: any) => {
        // If taskTransitioned is true, simulate the agent completing the task
        // before calling onRunComplete
        if (taskTransitioned && spawnOpts?.onRunComplete) {
          // The task is already in a terminal status (the test setup handles this)
          await spawnOpts.onRunComplete({
            success: true,
            sessionId: "test-session",
            durationMs: 1000,
          });
        } else if (!taskTransitioned && spawnOpts?.onRunComplete) {
          // Agent exits without transitioning - enforcement path
          await spawnOpts.onRunComplete({
            success: true,
            sessionId: "test-session",
            durationMs: 1000,
          });
        }
        return { success: true, sessionId: "test-session" } as SpawnResult;
      }),
    };
  }

  it("calls deliverAllGranularityCallbacks in branch 1 (agent-transitioned path)", async () => {
    // Create a task and move it to ready
    const task = await store.create({
      title: "Test GRAN-02 branch 1",
      body: "Test body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    // Create executor that simulates agent transitioning task to done
    const executor: GatewayAdapter = {
      spawnSession: vi.fn().mockImplementation(async (_context: TaskContext, spawnOpts: any) => {
        // Simulate agent transitioning task before onRunComplete
        await store.transition(task.frontmatter.id, "in-progress");
        await store.transition(task.frontmatter.id, "review");
        await store.transition(task.frontmatter.id, "done");

        if (spawnOpts?.onRunComplete) {
          await spawnOpts.onRunComplete({
            success: true,
            sessionId: "test-session",
            durationMs: 1000,
          });
        }
        return { success: true, sessionId: "test-session" } as SpawnResult;
      }),
    };

    const config: DispatchConfig = {
      dataDir: store.projectRoot,
      dryRun: false,
      executor,
      maxConcurrentDispatches: 3,
      defaultLeaseTtlMs: 60000,
    };

    const action: SchedulerAction = {
      type: "assign",
      taskId: task.frontmatter.id,
      agent: "test-agent",
    };

    await executeAssignAction(action, store, logger, config, [task], { value: null });

    expect(deliverCallbacks).toHaveBeenCalledTimes(1);
    expect(deliverAllGranularityCallbacks).toHaveBeenCalledTimes(1);

    // Verify same taskId is passed to both
    const dcArgs = vi.mocked(deliverCallbacks).mock.calls[0]![0];
    const dagcArgs = vi.mocked(deliverAllGranularityCallbacks).mock.calls[0]![0];
    expect(dcArgs.taskId).toBe(task.frontmatter.id);
    expect(dagcArgs.taskId).toBe(task.frontmatter.id);
  });

  it("calls deliverAllGranularityCallbacks in branch 2 (enforcement path)", async () => {
    // Create a task and move it to ready
    const task = await store.create({
      title: "Test GRAN-02 branch 2",
      body: "Test body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    // Create executor that does NOT transition task (enforcement path)
    const executor: GatewayAdapter = {
      spawnSession: vi.fn().mockImplementation(async (_context: TaskContext, spawnOpts: any) => {
        // Do NOT transition task — triggers enforcement
        if (spawnOpts?.onRunComplete) {
          await spawnOpts.onRunComplete({
            success: true,
            sessionId: "test-session",
            durationMs: 1000,
          });
        }
        return { success: true, sessionId: "test-session" } as SpawnResult;
      }),
    };

    const config: DispatchConfig = {
      dataDir: store.projectRoot,
      dryRun: false,
      executor,
      maxConcurrentDispatches: 3,
      defaultLeaseTtlMs: 60000,
    };

    const action: SchedulerAction = {
      type: "assign",
      taskId: task.frontmatter.id,
      agent: "test-agent",
    };

    await executeAssignAction(action, store, logger, config, [task], { value: null });

    // Both should be called in the enforcement path too
    expect(deliverCallbacks).toHaveBeenCalledTimes(1);
    expect(deliverAllGranularityCallbacks).toHaveBeenCalledTimes(1);
  });

  it("does not crash scheduler when deliverAllGranularityCallbacks throws", async () => {
    vi.mocked(deliverAllGranularityCallbacks).mockRejectedValue(new Error("GRAN callback boom"));

    const task = await store.create({
      title: "Test GRAN-02 error isolation",
      body: "Test body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    const executor: GatewayAdapter = {
      spawnSession: vi.fn().mockImplementation(async (_context: TaskContext, spawnOpts: any) => {
        // Simulate agent transitioning task
        await store.transition(task.frontmatter.id, "in-progress");
        await store.transition(task.frontmatter.id, "review");
        await store.transition(task.frontmatter.id, "done");

        if (spawnOpts?.onRunComplete) {
          await spawnOpts.onRunComplete({
            success: true,
            sessionId: "test-session",
            durationMs: 1000,
          });
        }
        return { success: true, sessionId: "test-session" } as SpawnResult;
      }),
    };

    const config: DispatchConfig = {
      dataDir: store.projectRoot,
      dryRun: false,
      executor,
      maxConcurrentDispatches: 3,
      defaultLeaseTtlMs: 60000,
    };

    const action: SchedulerAction = {
      type: "assign",
      taskId: task.frontmatter.id,
      agent: "test-agent",
    };

    // Should not throw even though deliverAllGranularityCallbacks throws
    const result = await executeAssignAction(action, store, logger, config, [task], { value: null });
    expect(result.executed).toBe(true);
    expect(result.failed).toBe(false);
  });
});
