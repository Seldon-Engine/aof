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
import {
  deliverCallbacks,
  retryPendingDeliveries,
  buildCallbackPrompt,
} from "../callback-delivery.js";
import type { Task } from "../../schemas/task.js";

// Minimal mock task store
function createMockTaskStore(task: Task | null) {
  return {
    get: vi.fn().mockResolvedValue(task),
    list: vi.fn().mockResolvedValue(task ? [task] : []),
    projectRoot: "/tmp/mock",
    projectId: "test",
    tasksDir: "/tmp/mock/tasks",
    init: vi.fn(),
    create: vi.fn(),
    transition: vi.fn(),
  } as any;
}

// Minimal mock logger
function createMockLogger() {
  return {
    log: vi.fn(),
    emit: vi.fn(),
  } as any;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "TASK-2026-03-10-001",
    title: "Test task",
    status: "done",
    priority: "normal",
    routing: { role: "developer" },
    createdAt: "2026-03-09T12:00:00Z",
    updatedAt: "2026-03-10T12:00:00Z",
    createdBy: "test",
    body: "Task body content\n\n## Outputs\n\nResult: success\nData: 42\n\n## Notes\n\nSome notes.",
    ...overrides,
  } as Task;
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
    const task = makeTask({ status: "cancelled" as any });
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
    const task = makeTask({ status: "in-progress" as any });
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

  it("skips subscriptions where lastAttemptAt is less than 30s ago", async () => {
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
