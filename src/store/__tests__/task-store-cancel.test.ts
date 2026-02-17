import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../task-store.js";
import { EventLogger } from "../../events/logger.js";
import type { ITaskStore } from "../interfaces.js";
import type { BaseEvent } from "../../schemas/event.js";
import type { TaskStatus } from "../../schemas/task.js";

describe("TaskStore.cancel()", () => {
  let tmpDir: string;
  let eventsDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let events: BaseEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-cancel-test-"));
    eventsDir = join(tmpDir, "events");
    events = [];
    
    logger = new EventLogger(eventsDir, {
      onEvent: (event) => {
        events.push(event);
      },
    });
    
    store = new FilesystemTaskStore(tmpDir, { logger });
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("cancels a task from backlog state", async () => {
    const task = await store.create({
      title: "Test cancel from backlog",
      body: "Task content",
      createdBy: "test-agent",
    });

    const cancelled = await store.cancel(task.frontmatter.id, "Not needed anymore");

    expect(cancelled.frontmatter.status).toBe("cancelled");
    expect(cancelled.frontmatter.metadata.cancellationReason).toBe("Not needed anymore");
    expect(cancelled.frontmatter.lease).toBeUndefined();

    // Verify task moved to cancelled directory
    const loaded = await store.get(task.frontmatter.id);
    expect(loaded).toBeDefined();
    expect(loaded!.frontmatter.status).toBe("cancelled");
  });

  it("cancels a task from ready state", async () => {
    const task = await store.create({
      title: "Test cancel from ready",
      createdBy: "test-agent",
    });

    await store.transition(task.frontmatter.id, "ready");
    const cancelled = await store.cancel(task.frontmatter.id, "Requirements changed");

    expect(cancelled.frontmatter.status).toBe("cancelled");
    expect(cancelled.frontmatter.metadata.cancellationReason).toBe("Requirements changed");
  });

  it("cancels a task from in-progress state and clears lease", async () => {
    const task = await store.create({
      title: "Test cancel from in-progress",
      createdBy: "test-agent",
    });

    // Transition to ready, then in-progress (which would set a lease in real usage)
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress", { agent: "worker-1" });

    // Manually set a lease for testing
    const inProgress = await store.get(task.frontmatter.id);
    if (inProgress) {
      inProgress.frontmatter.lease = {
        agent: "worker-1",
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        renewCount: 0,
      };
      await store.updateBody(task.frontmatter.id, inProgress.body);
      // Re-read to get updated lease
      const updated = await store.get(task.frontmatter.id);
      // Write the task with the lease
      const { writeFile } = await import("node:fs/promises");
      const { serializeTask } = await import("../task-store.js");
      if (updated && updated.path) {
        await writeFile(updated.path, serializeTask(updated));
      }
    }

    const cancelled = await store.cancel(task.frontmatter.id, "User cancelled");

    expect(cancelled.frontmatter.status).toBe("cancelled");
    expect(cancelled.frontmatter.lease).toBeUndefined();
    expect(cancelled.frontmatter.metadata.cancellationReason).toBe("User cancelled");
  });

  it("cancels a task from blocked state", async () => {
    const task = await store.create({
      title: "Test cancel from blocked",
      createdBy: "test-agent",
    });

    await store.transition(task.frontmatter.id, "blocked");
    const cancelled = await store.cancel(task.frontmatter.id);

    expect(cancelled.frontmatter.status).toBe("cancelled");
    // No reason provided
    expect(cancelled.frontmatter.metadata.cancellationReason).toBeUndefined();
  });

  it("cancels a task from review state", async () => {
    const task = await store.create({
      title: "Test cancel from review",
      createdBy: "test-agent",
    });

    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    await store.transition(task.frontmatter.id, "review");

    const cancelled = await store.cancel(task.frontmatter.id, "Design changed");

    expect(cancelled.frontmatter.status).toBe("cancelled");
    expect(cancelled.frontmatter.metadata.cancellationReason).toBe("Design changed");
  });

  it("rejects cancellation of already-done task", async () => {
    const task = await store.create({
      title: "Test reject cancel of done",
      createdBy: "test-agent",
    });

    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    await store.transition(task.frontmatter.id, "review");
    await store.transition(task.frontmatter.id, "done");

    await expect(
      store.cancel(task.frontmatter.id, "Too late")
    ).rejects.toThrow("Cannot cancel task");
    await expect(
      store.cancel(task.frontmatter.id, "Too late")
    ).rejects.toThrow("already in terminal state 'done'");
  });

  it("rejects cancellation of already-cancelled task", async () => {
    const task = await store.create({
      title: "Test reject cancel of cancelled",
      createdBy: "test-agent",
    });

    await store.cancel(task.frontmatter.id, "First cancellation");

    await expect(
      store.cancel(task.frontmatter.id, "Second cancellation")
    ).rejects.toThrow("Cannot cancel task");
    await expect(
      store.cancel(task.frontmatter.id, "Second cancellation")
    ).rejects.toThrow("already in terminal state 'cancelled'");
  });

  it("stores cancellation reason in metadata", async () => {
    const task = await store.create({
      title: "Test reason storage",
      createdBy: "test-agent",
      metadata: { existingKey: "existingValue" },
    });

    const cancelled = await store.cancel(task.frontmatter.id, "Business decision");

    expect(cancelled.frontmatter.metadata.cancellationReason).toBe("Business decision");
    // Existing metadata should be preserved
    expect(cancelled.frontmatter.metadata.existingKey).toBe("existingValue");

    // Verify persistence
    const loaded = await store.get(task.frontmatter.id);
    expect(loaded!.frontmatter.metadata.cancellationReason).toBe("Business decision");
    expect(loaded!.frontmatter.metadata.existingKey).toBe("existingValue");
  });

  it("emits task.cancelled event", async () => {
    const task = await store.create({
      title: "Test event emission",
      createdBy: "test-agent",
    });

    await store.cancel(task.frontmatter.id, "Event test");

    const cancelledEvents = events.filter(e => e.type === "task.cancelled");
    expect(cancelledEvents).toHaveLength(1);
    
    const event = cancelledEvents[0]!;
    expect(event.taskId).toBe(task.frontmatter.id);
    expect(event.payload.reason).toBe("Event test");
    expect(event.payload.from).toBe("backlog");
  });

  it("emits event with correct previous status", async () => {
    const task = await store.create({
      title: "Test event from in-progress",
      createdBy: "test-agent",
    });

    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");

    // Clear events from transitions
    events.length = 0;

    await store.cancel(task.frontmatter.id, "Abort mission");

    const cancelledEvents = events.filter(e => e.type === "task.cancelled");
    expect(cancelledEvents).toHaveLength(1);
    expect(cancelledEvents[0]!.payload.from).toBe("in-progress");
  });

  it("moves companion directories on cancellation", async () => {
    const task = await store.create({
      title: "Test directory move",
      createdBy: "test-agent",
    });

    // Verify initial directories exist
    const { stat } = await import("node:fs/promises");
    const initialDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id);
    await expect(stat(initialDir)).resolves.toBeDefined();

    await store.cancel(task.frontmatter.id, "Directory test");

    // Verify directories moved to cancelled
    const cancelledDir = join(tmpDir, "tasks", "cancelled", task.frontmatter.id);
    await expect(stat(cancelledDir)).resolves.toBeDefined();
    await expect(stat(join(cancelledDir, "inputs"))).resolves.toBeDefined();
    await expect(stat(join(cancelledDir, "outputs"))).resolves.toBeDefined();

    // Old directory should not exist
    await expect(stat(initialDir)).rejects.toThrow();
  });

  it("updates timestamps on cancellation", async () => {
    const task = await store.create({
      title: "Test timestamps",
      createdBy: "test-agent",
    });

    const originalUpdatedAt = task.frontmatter.updatedAt;
    const originalTransitionAt = task.frontmatter.lastTransitionAt;

    // Wait a tiny bit to ensure timestamp difference
    await new Promise(resolve => setTimeout(resolve, 10));

    const cancelled = await store.cancel(task.frontmatter.id);

    expect(cancelled.frontmatter.updatedAt).not.toBe(originalUpdatedAt);
    expect(cancelled.frontmatter.lastTransitionAt).not.toBe(originalTransitionAt);
    expect(new Date(cancelled.frontmatter.updatedAt).getTime()).toBeGreaterThan(
      new Date(originalUpdatedAt).getTime()
    );
  });

  it("throws error when cancelling non-existent task", async () => {
    await expect(
      store.cancel("TASK-2099-12-31-999", "Does not exist")
    ).rejects.toThrow("Task not found: TASK-2099-12-31-999");
  });
});
