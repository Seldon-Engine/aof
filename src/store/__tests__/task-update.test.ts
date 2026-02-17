import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../task-store.js";
import { EventLogger } from "../../events/logger.js";
import type { ITaskStore } from "../interfaces.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("TaskStore.update()", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let eventsDir: string;
  let logger: EventLogger;
  let capturedEvents: BaseEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-test-update-"));
    eventsDir = join(tmpDir, "events");
    capturedEvents = [];
    
    logger = new EventLogger(eventsDir, {
      onEvent: (event) => {
        capturedEvents.push(event);
      },
    });
    
    store = new FilesystemTaskStore(tmpDir, { logger });
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("successfully updates task title", async () => {
    const task = await store.create({
      title: "Original Title",
      body: "Original body",
      createdBy: "test",
    });

    const updated = await store.update(task.frontmatter.id, {
      title: "Updated Title",
    });

    expect(updated.frontmatter.title).toBe("Updated Title");
    expect(updated.body).toBe("Original body");
    expect(updated.frontmatter.updatedAt).not.toBe(task.frontmatter.updatedAt);
  });

  it("successfully updates task description (body)", async () => {
    const task = await store.create({
      title: "Test Task",
      body: "Original body",
      createdBy: "test",
    });

    const updated = await store.update(task.frontmatter.id, {
      description: "Updated body content",
    });

    expect(updated.body).toBe("Updated body content");
    expect(updated.frontmatter.title).toBe("Test Task");
    expect(updated.frontmatter.contentHash).not.toBe(task.frontmatter.contentHash);
  });

  it("successfully updates task priority", async () => {
    const task = await store.create({
      title: "Test Task",
      priority: "normal",
      createdBy: "test",
    });

    const updated = await store.update(task.frontmatter.id, {
      priority: "high",
    });

    expect(updated.frontmatter.priority).toBe("high");
  });

  it("successfully updates routing fields", async () => {
    const task = await store.create({
      title: "Test Task",
      createdBy: "test",
      routing: {
        role: "swe-backend",
        team: "core",
        tags: ["api"],
      },
    });

    const updated = await store.update(task.frontmatter.id, {
      routing: {
        role: "swe-frontend",
        team: "ui",
        agent: "agent-123",
        tags: ["ui", "react"],
      },
    });

    expect(updated.frontmatter.routing.role).toBe("swe-frontend");
    expect(updated.frontmatter.routing.team).toBe("ui");
    expect(updated.frontmatter.routing.agent).toBe("agent-123");
    expect(updated.frontmatter.routing.tags).toEqual(["ui", "react"]);
  });

  it("supports partial updates (only specified fields change)", async () => {
    const task = await store.create({
      title: "Original Title",
      body: "Original body",
      priority: "normal",
      createdBy: "test",
      routing: {
        role: "swe-backend",
        tags: ["api"],
      },
    });

    const updated = await store.update(task.frontmatter.id, {
      title: "New Title",
      // priority and routing not specified, should remain unchanged
    });

    expect(updated.frontmatter.title).toBe("New Title");
    expect(updated.body).toBe("Original body");
    expect(updated.frontmatter.priority).toBe("normal");
    expect(updated.frontmatter.routing.role).toBe("swe-backend");
    expect(updated.frontmatter.routing.tags).toEqual(["api"]);
  });

  it("supports partial routing updates", async () => {
    const task = await store.create({
      title: "Test Task",
      createdBy: "test",
      routing: {
        role: "swe-backend",
        team: "core",
        tags: ["api"],
      },
    });

    const updated = await store.update(task.frontmatter.id, {
      routing: {
        team: "platform",
        // role and tags not specified, should remain unchanged
      },
    });

    expect(updated.frontmatter.routing.role).toBe("swe-backend");
    expect(updated.frontmatter.routing.team).toBe("platform");
    expect(updated.frontmatter.routing.tags).toEqual(["api"]);
  });

  it("rejects update to task in 'done' state", async () => {
    const task = await store.create({
      title: "Test Task",
      createdBy: "test",
    });

    // Transition to done
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    await store.transition(task.frontmatter.id, "review");
    await store.transition(task.frontmatter.id, "done");

    await expect(
      store.update(task.frontmatter.id, { title: "New Title" })
    ).rejects.toThrow(/terminal state/);
  });

  it("throws error for non-existent task ID", async () => {
    await expect(
      store.update("TASK-9999-99-99-999", { title: "New Title" })
    ).rejects.toThrow(/not found/);
  });

  it("emits task.updated event with change details", async () => {
    const task = await store.create({
      title: "Original Title",
      body: "Original body",
      priority: "normal",
      createdBy: "test",
    });

    // Clear captured events from create
    capturedEvents = [];

    await store.update(task.frontmatter.id, {
      title: "New Title",
      priority: "high",
    });

    const updateEvents = capturedEvents.filter((e) => e.type === "task.updated");
    expect(updateEvents).toHaveLength(1);

    const event = updateEvents[0]!;
    expect(event.taskId).toBe(task.frontmatter.id);
    expect(event.payload.changes).toBeDefined();
    
    const changes = event.payload.changes as Record<string, unknown>;
    expect(changes.title).toBeDefined();
    expect(changes.priority).toBeDefined();
  });

  it("does not emit event if no fields are updated", async () => {
    const task = await store.create({
      title: "Test Task",
      createdBy: "test",
    });

    // Clear captured events from create
    capturedEvents = [];

    // Update with empty patch
    await store.update(task.frontmatter.id, {});

    const updateEvents = capturedEvents.filter((e) => e.type === "task.updated");
    expect(updateEvents).toHaveLength(0);
  });

  it("updates timestamp even for empty patches", async () => {
    const task = await store.create({
      title: "Test Task",
      createdBy: "test",
    });

    const originalUpdatedAt = task.frontmatter.updatedAt;

    // Wait a bit to ensure timestamp changes
    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = await store.update(task.frontmatter.id, {});

    expect(updated.frontmatter.updatedAt).not.toBe(originalUpdatedAt);
  });

  it("persists updates across store reloads", async () => {
    const task = await store.create({
      title: "Original Title",
      body: "Original body",
      createdBy: "test",
    });

    await store.update(task.frontmatter.id, {
      title: "Updated Title",
      priority: "high",
    });

    // Create new store instance pointing to same directory
    const store2 = new FilesystemTaskStore(tmpDir);
    await store2.init();

    const reloaded = await store2.get(task.frontmatter.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.frontmatter.title).toBe("Updated Title");
    expect(reloaded!.frontmatter.priority).toBe("high");
    expect(reloaded!.body).toBe("Original body");
  });

  it("updates multiple fields atomically", async () => {
    const task = await store.create({
      title: "Original Title",
      body: "Original body",
      priority: "normal",
      createdBy: "test",
      routing: {
        role: "swe-backend",
      },
    });

    const updated = await store.update(task.frontmatter.id, {
      title: "New Title",
      description: "New body",
      priority: "critical",
      routing: {
        role: "swe-frontend",
        team: "ui",
        tags: ["urgent"],
      },
    });

    expect(updated.frontmatter.title).toBe("New Title");
    expect(updated.body).toBe("New body");
    expect(updated.frontmatter.priority).toBe("critical");
    expect(updated.frontmatter.routing.role).toBe("swe-frontend");
    expect(updated.frontmatter.routing.team).toBe("ui");
    expect(updated.frontmatter.routing.tags).toEqual(["urgent"]);

    // Verify via reload
    const reloaded = await store.get(task.frontmatter.id);
    expect(reloaded!.frontmatter.title).toBe("New Title");
    expect(reloaded!.body).toBe("New body");
  });
});
