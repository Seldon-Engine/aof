/**
 * Callback delivery tests — unit tests for deliverCallbacks, retryPendingDeliveries,
 * and buildCallbackPrompt functions.
 *
 * Covers DLVR-01 (session spawn), DLVR-02 (retry), DLVR-03 (trace),
 * DLVR-04 (non-blocking), GRAN-01 (completion filter).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MockAdapter } from "../executor.js";
import { SubscriptionStore } from "../../store/subscription-store.js";
import { createMockStore, createMockLogger } from "../../testing/index.js";
import {
  deliverCallbacks,
  retryPendingDeliveries,
  buildCallbackPrompt,
  deliverAllGranularityCallbacks,
} from "../callback-delivery.js";
import type { Task } from "../../schemas/task.js";

// Mock captureTrace from trace-writer
vi.mock("../../trace/trace-writer.js", () => ({
  captureTrace: vi.fn().mockResolvedValue({ success: true, noopDetected: false, tracePath: "/tmp/trace-1.json" }),
}));

import { captureTrace } from "../../trace/trace-writer.js";
const mockCaptureTrace = vi.mocked(captureTrace);

// Typed mock task store with optional pre-loaded task
function createMockTaskStore(task: Task | null) {
  const store = createMockStore();
  store.get.mockResolvedValue(task);
  store.list.mockResolvedValue(task ? [task] : []);
  return store;
}

// Re-export shared createMockLogger (already imported above)

function makeTask(overrides: Partial<Task> = {}): Task {
  const base = {
    frontmatter: {
      schemaVersion: 2,
      id: "TASK-2026-03-10-001",
      project: "_inbox",
      title: "Test task",
      status: "done",
      priority: "normal",
      routing: { role: "developer", tags: [] },
      createdAt: "2026-03-09T12:00:00Z",
      updatedAt: "2026-03-10T12:00:00Z",
      createdBy: "test",
      dependsOn: [],
      contextTier: "seed",
      lastTransitionAt: "2026-03-10T12:00:00Z",
      metadata: {},
      gateHistory: [],
      tests: [],
    },
    body: "Task body content\n\n## Outputs\n\nResult: success\nData: 42\n\n## Notes\n\nSome notes.",
  };
  if (overrides.frontmatter) {
    base.frontmatter = { ...base.frontmatter, ...overrides.frontmatter } as typeof base.frontmatter;
  }
  if (overrides.body !== undefined) {
    base.body = overrides.body;
  }
  return base as Task;
}

describe("buildCallbackPrompt", () => {
  it("includes 'You are receiving a task notification callback' prefix", () => {
    const task = makeTask();
    const prompt = buildCallbackPrompt(task, {
      id: "sub-1",
      subscriberId: "agent:watcher",
      granularity: "completion" as const,
      status: "active" as const,
      createdAt: "2026-03-09T12:00:00Z",
      updatedAt: "2026-03-09T12:00:00Z",
      deliveryAttempts: 0,
    });
    expect(prompt).toContain("You are receiving a task notification callback");
  });

  it("extracts Outputs section from task body", () => {
    const task = makeTask();
    const prompt = buildCallbackPrompt(task, {
      id: "sub-1",
      subscriberId: "agent:watcher",
      granularity: "completion" as const,
      status: "active" as const,
      createdAt: "2026-03-09T12:00:00Z",
      updatedAt: "2026-03-09T12:00:00Z",
      deliveryAttempts: 0,
    });
    expect(prompt).toContain("Result: success");
    expect(prompt).toContain("Data: 42");
  });

  it("handles task with no Outputs section gracefully", () => {
    const task = makeTask({ body: "No outputs here" });
    const prompt = buildCallbackPrompt(task, {
      id: "sub-1",
      subscriberId: "agent:watcher",
      granularity: "completion" as const,
      status: "active" as const,
      createdAt: "2026-03-09T12:00:00Z",
      updatedAt: "2026-03-09T12:00:00Z",
      deliveryAttempts: 0,
    });
    expect(prompt).toContain("TASK-2026-03-10-001");
    expect(prompt).not.toContain("Result: success");
  });

  it("includes taskId, title, finalStatus, and subscriberId", () => {
    const task = makeTask({ frontmatter: { status: "cancelled" } } as any);
    const prompt = buildCallbackPrompt(task, {
      id: "sub-1",
      subscriberId: "agent:watcher",
      granularity: "completion" as const,
      status: "active" as const,
      createdAt: "2026-03-09T12:00:00Z",
      updatedAt: "2026-03-09T12:00:00Z",
      deliveryAttempts: 0,
    });
    expect(prompt).toContain("TASK-2026-03-10-001");
    expect(prompt).toContain("Test task");
    expect(prompt).toContain("cancelled");
    expect(prompt).toContain("agent:watcher");
  });
});

describe("deliverCallbacks", () => {
  let tmpDir: string;
  let subscriptionStore: SubscriptionStore;
  let executor: MockAdapter;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-cb-delivery-"));
    subscriptionStore = new SubscriptionStore(
      (id: string) => Promise.resolve(join(tmpDir, "tasks", "ready", id)),
    );
    executor = new MockAdapter();
    logger = createMockLogger();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("spawns a session to subscriber agent with structured prompt", async () => {
    const task = makeTask();
    const store = createMockTaskStore(task);
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");

    await deliverCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    expect(executor.spawned).toHaveLength(1);
    expect(executor.spawned[0].context.agent).toBe("agent:watcher");
    expect(executor.spawned[0].context.taskId).toBe("TASK-2026-03-10-001");
  });

  it("only fires for completion-granularity subscriptions (skips 'all')", async () => {
    const task = makeTask();
    const store = createMockTaskStore(task);
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:other", "all");

    await deliverCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    expect(executor.spawned).toHaveLength(1);
    expect(executor.spawned[0].context.agent).toBe("agent:watcher");
  });

  it("only fires for active subscriptions (skips delivered/failed/cancelled)", async () => {
    const task = makeTask();
    const store = createMockTaskStore(task);
    const sub = await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");
    await subscriptionStore.cancel("TASK-2026-03-10-001", sub.id);
    // Create another active one
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:active", "completion");

    await deliverCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    expect(executor.spawned).toHaveLength(1);
    expect(executor.spawned[0].context.agent).toBe("agent:active");
  });

  it("skips non-terminal tasks (returns early if status not in done/cancelled/deadletter)", async () => {
    const task = makeTask({ frontmatter: { status: "in-progress" } } as any);
    const store = createMockTaskStore(task);
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");

    await deliverCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    expect(executor.spawned).toHaveLength(0);
  });

  it("updates subscription status to 'delivered' with deliveredAt on success", async () => {
    const task = makeTask();
    const store = createMockTaskStore(task);
    const sub = await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");

    await deliverCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    const updated = await subscriptionStore.get("TASK-2026-03-10-001", sub.id);
    expect(updated!.status).toBe("delivered");
    expect(updated!.deliveredAt).toBeDefined();
  });

  it("increments deliveryAttempts and sets lastAttemptAt on failed delivery", async () => {
    const task = makeTask();
    const store = createMockTaskStore(task);
    executor.setShouldFail(true, "connection refused");
    const sub = await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");

    await deliverCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    const updated = await subscriptionStore.get("TASK-2026-03-10-001", sub.id);
    expect(updated!.status).toBe("active");
    expect(updated!.deliveryAttempts).toBe(1);
    expect(updated!.lastAttemptAt).toBeDefined();
  });

  it("marks subscription 'failed' after 3 failed attempts with failureReason", async () => {
    const task = makeTask();
    const store = createMockTaskStore(task);
    executor.setShouldFail(true, "connection refused");
    const sub = await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");

    // Pre-set deliveryAttempts to 2 (simulating 2 prior failures)
    await subscriptionStore.update("TASK-2026-03-10-001", sub.id, {
      deliveryAttempts: 2,
    });

    await deliverCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    const updated = await subscriptionStore.get("TASK-2026-03-10-001", sub.id);
    expect(updated!.status).toBe("failed");
    expect(updated!.failureReason).toBeDefined();
    expect(updated!.deliveryAttempts).toBe(3);
  });

  it("delivery error does not propagate to caller (best-effort)", async () => {
    const task = makeTask();
    const store = createMockTaskStore(task);
    executor.setShouldThrow(true, "catastrophic failure");
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");

    // Should not throw
    await expect(
      deliverCallbacks({
        taskId: "TASK-2026-03-10-001",
        store,
        subscriptionStore,
        executor,
        logger,
      }),
    ).resolves.toBeUndefined();
  });

  it("spawns callback session with 120s timeout and onRunComplete", async () => {
    const task = makeTask();
    const store = createMockTaskStore(task);
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");

    await deliverCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    expect(executor.spawned[0].opts?.timeoutMs).toBe(120_000);
    expect(executor.spawned[0].opts?.onRunComplete).toBeTypeOf("function");
  });
});

describe("retryPendingDeliveries", () => {
  let tmpDir: string;
  let subscriptionStore: SubscriptionStore;
  let executor: MockAdapter;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-cb-retry-"));
    subscriptionStore = new SubscriptionStore(
      (id: string) => Promise.resolve(join(tmpDir, "tasks", "ready", id)),
    );
    executor = new MockAdapter();
    logger = createMockLogger();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("retries active subscriptions with 0 < deliveryAttempts < 3 on terminal tasks", async () => {
    const task = makeTask();
    const store = createMockTaskStore(task);
    const sub = await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");
    // Simulate a prior failed attempt
    const oldTime = new Date(Date.now() - 60_000).toISOString();
    await subscriptionStore.update("TASK-2026-03-10-001", sub.id, {
      deliveryAttempts: 1,
      lastAttemptAt: oldTime,
    });

    await retryPendingDeliveries({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    expect(executor.spawned).toHaveLength(1);
  });

  it("skips subscriptions where lastAttemptAt is less than 30s ago (cooldown)", async () => {
    const task = makeTask();
    const store = createMockTaskStore(task);
    const sub = await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");
    // Simulate a recent failed attempt (just now)
    await subscriptionStore.update("TASK-2026-03-10-001", sub.id, {
      deliveryAttempts: 1,
      lastAttemptAt: new Date().toISOString(),
    });

    await retryPendingDeliveries({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    expect(executor.spawned).toHaveLength(0);
  });
});

describe("captureTrace integration in callback delivery", () => {
  let tmpDir: string;
  let subscriptionStore: SubscriptionStore;
  let executor: MockAdapter;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-cb-trace-"));
    subscriptionStore = new SubscriptionStore(
      (id: string) => Promise.resolve(join(tmpDir, "tasks", "ready", id)),
    );
    executor = new MockAdapter();
    logger = createMockLogger();
    mockCaptureTrace.mockClear();
    mockCaptureTrace.mockResolvedValue({ success: true, noopDetected: false, tracePath: "/tmp/trace-1.json" });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("calls captureTrace in onRunComplete with correct options", async () => {
    const task = makeTask();
    const store = createMockTaskStore(task);
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");

    await deliverCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    // Manually invoke onRunComplete (MockAdapter stores but doesn't call it)
    const onRunComplete = executor.spawned[0].opts?.onRunComplete;
    expect(onRunComplete).toBeTypeOf("function");

    await onRunComplete!({
      taskId: "TASK-2026-03-10-001",
      sessionId: "session-abc",
      success: true,
      aborted: false,
      durationMs: 5000,
    });

    expect(mockCaptureTrace).toHaveBeenCalledOnce();
    expect(mockCaptureTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "TASK-2026-03-10-001",
        sessionId: "session-abc",
        agentId: "agent:watcher",
        durationMs: 5000,
        store,
        logger,
        debug: false,
      }),
    );
  });

  it("delivery succeeds even when captureTrace throws", async () => {
    const task = makeTask();
    const store = createMockTaskStore(task);
    mockCaptureTrace.mockRejectedValue(new Error("trace write failed"));
    const sub = await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");

    await deliverCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    // Invoke onRunComplete -- captureTrace will throw
    const onRunComplete = executor.spawned[0].opts?.onRunComplete;
    await onRunComplete!({
      taskId: "TASK-2026-03-10-001",
      sessionId: "session-abc",
      success: true,
      aborted: false,
      durationMs: 5000,
    });

    // captureTrace was called (even though it failed)
    expect(mockCaptureTrace).toHaveBeenCalledOnce();

    // The delivery itself still succeeded (subscription marked delivered)
    const updated = await subscriptionStore.get("TASK-2026-03-10-001", sub.id);
    expect(updated!.status).toBe("delivered");
  });

  it("calls captureTrace with debug=false by default", async () => {
    const task = makeTask();
    const store = createMockTaskStore(task);
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");

    await deliverCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    const onRunComplete = executor.spawned[0].opts?.onRunComplete;
    await onRunComplete!({
      taskId: "TASK-2026-03-10-001",
      sessionId: "session-abc",
      success: true,
      aborted: false,
      durationMs: 3000,
    });

    expect(mockCaptureTrace).toHaveBeenCalledWith(
      expect.objectContaining({ debug: false }),
    );
  });
});

// ---------------------------------------------------------------------------
// All-granularity delivery tests (Phase 31)
// ---------------------------------------------------------------------------

describe("deliverAllGranularityCallbacks", () => {
  let tmpDir: string;
  let subscriptionStore: SubscriptionStore;
  let executor: MockAdapter;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-cb-all-"));
    subscriptionStore = new SubscriptionStore(
      (id: string) => Promise.resolve(join(tmpDir, "tasks", "ready", id)),
    );
    executor = new MockAdapter();
    logger = createMockLogger();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("delivers single callback with all 3 transitions since lastDeliveredAt in order", async () => {
    const task = makeTask({ frontmatter: { status: "in-progress" } } as any);
    const store = createMockTaskStore(task);
    const sub = await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "all");

    // Set lastDeliveredAt to before the transitions
    const baseTime = new Date("2026-03-10T10:00:00Z");
    await subscriptionStore.update("TASK-2026-03-10-001", sub.id, {
      lastDeliveredAt: baseTime.toISOString(),
    } as any);

    // Mock logger.query to return 3 transitions after lastDeliveredAt
    logger.query = vi.fn().mockResolvedValue([
      {
        eventId: 1, type: "task.transitioned", timestamp: "2026-03-10T10:01:00Z",
        actor: "system", taskId: "TASK-2026-03-10-001",
        payload: { from: "ready", to: "in-progress" },
      },
      {
        eventId: 2, type: "task.transitioned", timestamp: "2026-03-10T10:02:00Z",
        actor: "system", taskId: "TASK-2026-03-10-001",
        payload: { from: "in-progress", to: "blocked" },
      },
      {
        eventId: 3, type: "task.transitioned", timestamp: "2026-03-10T10:03:00Z",
        actor: "system", taskId: "TASK-2026-03-10-001",
        payload: { from: "blocked", to: "in-progress" },
      },
    ]);

    await deliverAllGranularityCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    expect(executor.spawned).toHaveLength(1);
    // The prompt should include all 3 transitions
    const prompt = executor.spawned[0].context.taskFileContents;
    expect(prompt).toContain("ready -> in-progress");
    expect(prompt).toContain("in-progress -> blocked");
    expect(prompt).toContain("blocked -> in-progress");
  });

  it("delivers no callback when no new transitions since lastDeliveredAt", async () => {
    const task = makeTask({ frontmatter: { status: "in-progress" } } as any);
    const store = createMockTaskStore(task);
    const sub = await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "all");

    await subscriptionStore.update("TASK-2026-03-10-001", sub.id, {
      lastDeliveredAt: "2026-03-10T12:00:00Z",
    } as any);

    // No transitions after lastDeliveredAt
    logger.query = vi.fn().mockResolvedValue([]);

    await deliverAllGranularityCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    expect(executor.spawned).toHaveLength(0);
  });

  it("advances lastDeliveredAt to latest transition timestamp after successful delivery", async () => {
    const task = makeTask({ frontmatter: { status: "in-progress" } } as any);
    const store = createMockTaskStore(task);
    const sub = await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "all");

    await subscriptionStore.update("TASK-2026-03-10-001", sub.id, {
      lastDeliveredAt: "2026-03-10T10:00:00Z",
    } as any);

    logger.query = vi.fn().mockResolvedValue([
      {
        eventId: 1, type: "task.transitioned", timestamp: "2026-03-10T10:05:00Z",
        actor: "system", taskId: "TASK-2026-03-10-001",
        payload: { from: "ready", to: "in-progress" },
      },
    ]);

    await deliverAllGranularityCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    const updated = await subscriptionStore.get("TASK-2026-03-10-001", sub.id);
    expect(updated!.lastDeliveredAt).toBe("2026-03-10T10:05:00Z");
  });

  it("gets all transitions from task creation when lastDeliveredAt is undefined", async () => {
    const task = makeTask({ frontmatter: { status: "in-progress" } } as any);
    const store = createMockTaskStore(task);
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "all");
    // No lastDeliveredAt set (undefined)

    logger.query = vi.fn().mockResolvedValue([
      {
        eventId: 1, type: "task.transitioned", timestamp: "2026-03-09T12:00:00Z",
        actor: "system", taskId: "TASK-2026-03-10-001",
        payload: { from: "pending", to: "ready" },
      },
      {
        eventId: 2, type: "task.transitioned", timestamp: "2026-03-10T10:00:00Z",
        actor: "system", taskId: "TASK-2026-03-10-001",
        payload: { from: "ready", to: "in-progress" },
      },
    ]);

    await deliverAllGranularityCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    expect(executor.spawned).toHaveLength(1);
    const prompt = executor.spawned[0].context.taskFileContents;
    expect(prompt).toContain("pending -> ready");
    expect(prompt).toContain("ready -> in-progress");
  });

  it("does NOT advance lastDeliveredAt on failed delivery (self-healing cursor)", async () => {
    const task = makeTask({ frontmatter: { status: "in-progress" } } as any);
    const store = createMockTaskStore(task);
    executor.setShouldFail(true, "connection refused");
    const sub = await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "all");

    await subscriptionStore.update("TASK-2026-03-10-001", sub.id, {
      lastDeliveredAt: "2026-03-10T10:00:00Z",
    } as any);

    logger.query = vi.fn().mockResolvedValue([
      {
        eventId: 1, type: "task.transitioned", timestamp: "2026-03-10T10:05:00Z",
        actor: "system", taskId: "TASK-2026-03-10-001",
        payload: { from: "ready", to: "in-progress" },
      },
    ]);

    await deliverAllGranularityCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    const updated = await subscriptionStore.get("TASK-2026-03-10-001", sub.id);
    // lastDeliveredAt should NOT have advanced
    expect(updated!.lastDeliveredAt).toBe("2026-03-10T10:00:00Z");
  });

  it("fires on terminal transitions too (superset of completion)", async () => {
    const task = makeTask({ frontmatter: { status: "done" } } as any);
    const store = createMockTaskStore(task);
    const sub = await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "all");

    await subscriptionStore.update("TASK-2026-03-10-001", sub.id, {
      lastDeliveredAt: "2026-03-10T10:00:00Z",
    } as any);

    logger.query = vi.fn().mockResolvedValue([
      {
        eventId: 1, type: "task.transitioned", timestamp: "2026-03-10T11:00:00Z",
        actor: "system", taskId: "TASK-2026-03-10-001",
        payload: { from: "in-progress", to: "done" },
      },
    ]);

    await deliverAllGranularityCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    expect(executor.spawned).toHaveLength(1);
    const prompt = executor.spawned[0].context.taskFileContents;
    expect(prompt).toContain("in-progress -> done");
  });
});

describe("buildCallbackPrompt with transitions", () => {
  it("includes transitions section when transitions array provided", () => {
    const task = makeTask();
    const sub = {
      id: "sub-1",
      subscriberId: "agent:watcher",
      granularity: "all" as const,
      status: "active" as const,
      createdAt: "2026-03-09T12:00:00Z",
      updatedAt: "2026-03-09T12:00:00Z",
      deliveryAttempts: 0,
    };
    const transitions = [
      { fromStatus: "ready", toStatus: "in-progress", timestamp: "2026-03-10T10:01:00Z" },
      { fromStatus: "in-progress", toStatus: "done", timestamp: "2026-03-10T10:02:00Z" },
    ];

    const prompt = buildCallbackPrompt(task, sub, undefined, transitions);
    expect(prompt).toContain("## Transitions");
    expect(prompt).toContain("ready -> in-progress");
    expect(prompt).toContain("in-progress -> done");
    expect(prompt).toContain("2026-03-10T10:01:00Z");
    expect(prompt).toContain("2026-03-10T10:02:00Z");
  });

  it("does not include transitions section when transitions not provided", () => {
    const task = makeTask();
    const sub = {
      id: "sub-1",
      subscriberId: "agent:watcher",
      granularity: "completion" as const,
      status: "active" as const,
      createdAt: "2026-03-09T12:00:00Z",
      updatedAt: "2026-03-09T12:00:00Z",
      deliveryAttempts: 0,
    };

    const prompt = buildCallbackPrompt(task, sub);
    expect(prompt).not.toContain("## Transitions");
  });
});

describe("TaskSubscription schema with lastDeliveredAt", () => {
  it("validates lastDeliveredAt as optional datetime string", async () => {
    const { TaskSubscription } = await import("../../schemas/subscription.js");
    const valid = TaskSubscription.parse({
      id: "123e4567-e89b-12d3-a456-426614174000",
      subscriberId: "agent:watcher",
      granularity: "all",
      status: "active",
      createdAt: "2026-03-09T12:00:00Z",
      updatedAt: "2026-03-09T12:00:00Z",
      deliveryAttempts: 0,
      lastDeliveredAt: "2026-03-10T10:00:00Z",
    });
    expect(valid.lastDeliveredAt).toBe("2026-03-10T10:00:00Z");

    // Also valid without lastDeliveredAt
    const withoutLDA = TaskSubscription.parse({
      id: "123e4567-e89b-12d3-a456-426614174000",
      subscriberId: "agent:watcher",
      granularity: "all",
      status: "active",
      createdAt: "2026-03-09T12:00:00Z",
      updatedAt: "2026-03-09T12:00:00Z",
      deliveryAttempts: 0,
    });
    expect(withoutLDA.lastDeliveredAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SAFE-01: Callback depth limiting tests (Phase 31-02)
// ---------------------------------------------------------------------------

describe("SAFE-01: callback depth limiting", () => {
  let tmpDir: string;
  let subscriptionStore: SubscriptionStore;
  let executor: MockAdapter;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-cb-depth-"));
    subscriptionStore = new SubscriptionStore(
      (id: string) => Promise.resolve(join(tmpDir, "tasks", "ready", id)),
    );
    executor = new MockAdapter();
    logger = createMockLogger();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("Test 1: deliverCallbacks skips delivery when task.frontmatter.callbackDepth >= 3", async () => {
    const task = makeTask({ frontmatter: { callbackDepth: 3 } } as any);
    const store = createMockTaskStore(task);
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");

    await deliverCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    expect(executor.spawned).toHaveLength(0);
  });

  it("Test 2: deliverCallbacks delivers normally when callbackDepth is 0 or undefined", async () => {
    // callbackDepth = 0
    const task0 = makeTask({ frontmatter: { callbackDepth: 0 } } as any);
    const store0 = createMockTaskStore(task0);
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");

    await deliverCallbacks({
      taskId: "TASK-2026-03-10-001",
      store: store0,
      subscriptionStore,
      executor,
      logger,
    });

    expect(executor.spawned).toHaveLength(1);

    // Reset
    executor.spawned.length = 0;

    // callbackDepth = undefined (default)
    const tmpDir2 = await mkdtemp(join(tmpdir(), "aof-cb-depth2-"));
    const subscriptionStore2 = new SubscriptionStore(
      (id: string) => Promise.resolve(join(tmpDir2, "tasks", "ready", id)),
    );
    const taskUndef = makeTask(); // no callbackDepth
    const storeUndef = createMockTaskStore(taskUndef);
    await subscriptionStore2.create("TASK-2026-03-10-001", "agent:watcher", "completion");

    await deliverCallbacks({
      taskId: "TASK-2026-03-10-001",
      store: storeUndef,
      subscriptionStore: subscriptionStore2,
      executor,
      logger,
    });

    expect(executor.spawned).toHaveLength(1);
    await rm(tmpDir2, { recursive: true, force: true });
  });

  it("Test 3: subscription.depth_exceeded event logged with depth and maxDepth payload", async () => {
    const task = makeTask({ frontmatter: { callbackDepth: 4 } } as any);
    const store = createMockTaskStore(task);
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");

    await deliverCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    expect(logger.log).toHaveBeenCalledWith(
      "subscription.depth_exceeded",
      "callback-delivery",
      expect.objectContaining({
        taskId: "TASK-2026-03-10-001",
        payload: expect.objectContaining({
          depth: 4,
          maxDepth: 3,
        }),
      }),
    );
  });

  it("Test 4: deliverSingleCallback includes callbackDepth + 1 in TaskContext metadata", async () => {
    const task = makeTask({ frontmatter: { callbackDepth: 1 } } as any);
    const store = createMockTaskStore(task);
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");

    await deliverCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    expect(executor.spawned).toHaveLength(1);
    const context = executor.spawned[0].context;
    expect((context as any).metadata?.callbackDepth).toBe(2);
  });

  it("Test 5: deliverAllGranularityCallbacks also checks depth before delivery", async () => {
    const task = makeTask({ frontmatter: { callbackDepth: 3, status: "in-progress" } } as any);
    const store = createMockTaskStore(task);
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "all");

    logger.query = vi.fn().mockResolvedValue([
      {
        eventId: 1, type: "task.transitioned", timestamp: "2026-03-10T10:01:00Z",
        actor: "system", taskId: "TASK-2026-03-10-001",
        payload: { from: "ready", to: "in-progress" },
      },
    ]);

    await deliverAllGranularityCallbacks({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    expect(executor.spawned).toHaveLength(0);
    expect(logger.log).toHaveBeenCalledWith(
      "subscription.depth_exceeded",
      "callback-delivery",
      expect.objectContaining({
        taskId: "TASK-2026-03-10-001",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// SAFE-02: Restart recovery tests (Phase 31-02)
// ---------------------------------------------------------------------------

describe("SAFE-02: restart recovery", () => {
  let tmpDir: string;
  let subscriptionStore: SubscriptionStore;
  let executor: MockAdapter;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-cb-recovery-"));
    subscriptionStore = new SubscriptionStore(
      (id: string) => Promise.resolve(join(tmpDir, "tasks", "ready", id)),
    );
    executor = new MockAdapter();
    logger = createMockLogger();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("Test 6: retryPendingDeliveries picks up subscriptions with deliveryAttempts === 0 on terminal tasks", async () => {
    const task = makeTask();
    const store = createMockTaskStore(task);
    // Create a subscription that was never attempted (deliveryAttempts = 0)
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");

    await retryPendingDeliveries({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    expect(executor.spawned).toHaveLength(1);
  });

  it("Test 7: retryPendingDeliveries emits subscription.recovery_attempted for never-attempted subscriptions", async () => {
    const task = makeTask();
    const store = createMockTaskStore(task);
    const sub = await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");

    await retryPendingDeliveries({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    expect(logger.log).toHaveBeenCalledWith(
      "subscription.recovery_attempted",
      "callback-delivery",
      expect.objectContaining({
        taskId: "TASK-2026-03-10-001",
        payload: expect.objectContaining({
          subscriptionId: sub.id,
        }),
      }),
    );
  });

  it("Test 8: retryPendingDeliveries handles both completion and all granularity subscriptions", async () => {
    const task = makeTask();
    const store = createMockTaskStore(task);
    // Create subscriptions of both granularities, never attempted
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:completion-watcher", "completion");
    await subscriptionStore.create("TASK-2026-03-10-001", "agent:all-watcher", "all");

    // For "all" granularity, mock the logger.query for transition events
    logger.query = vi.fn().mockResolvedValue([
      {
        eventId: 1, type: "task.transitioned", timestamp: "2026-03-10T11:00:00Z",
        actor: "system", taskId: "TASK-2026-03-10-001",
        payload: { from: "in-progress", to: "done" },
      },
    ]);

    await retryPendingDeliveries({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    // Both should be attempted
    expect(executor.spawned.length).toBeGreaterThanOrEqual(2);
  });

  it("Test 9: Subscription with deliveryAttempts = 2 from pre-restart still counts toward 3-attempt max", async () => {
    const task = makeTask();
    const store = createMockTaskStore(task);
    executor.setShouldFail(true, "connection refused");

    const sub = await subscriptionStore.create("TASK-2026-03-10-001", "agent:watcher", "completion");
    // Simulate 2 prior attempts from before restart
    const oldTime = new Date(Date.now() - 60_000).toISOString();
    await subscriptionStore.update("TASK-2026-03-10-001", sub.id, {
      deliveryAttempts: 2,
      lastAttemptAt: oldTime,
    });

    await retryPendingDeliveries({
      taskId: "TASK-2026-03-10-001",
      store,
      subscriptionStore,
      executor,
      logger,
    });

    // Should attempt (2 < 3) but the failure increments to 3 and marks failed
    const updated = await subscriptionStore.get("TASK-2026-03-10-001", sub.id);
    expect(updated!.deliveryAttempts).toBe(3);
    expect(updated!.status).toBe("failed");
  });
});
