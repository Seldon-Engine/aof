/**
 * Tests for createTestHarness and withTestProject.
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { createTestHarness, withTestProject, type TestHarness } from "../harness.js";

describe("createTestHarness", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
      harness = undefined;
    }
  });

  it("creates a tmpDir that exists on disk", async () => {
    harness = await createTestHarness();
    expect(existsSync(harness.tmpDir)).toBe(true);
  });

  it("returns a store with a valid tasksDir", async () => {
    harness = await createTestHarness();
    expect(harness.store).toBeDefined();
    expect(typeof harness.store.tasksDir).toBe("string");
  });

  it("returns an EventLogger", async () => {
    harness = await createTestHarness();
    expect(harness.logger).toBeDefined();
    expect(typeof harness.logger.log).toBe("function");
  });

  it("cleanup removes tmpDir", async () => {
    harness = await createTestHarness();
    const dir = harness.tmpDir;
    await harness.cleanup();
    expect(existsSync(dir)).toBe(false);
    harness = undefined; // already cleaned up
  });

  it("readEvents returns event entries from the eventsDir", async () => {
    harness = await createTestHarness();
    // Log an event, then read it back
    await harness.logger.log("task.created", "test-actor", { taskId: "t1" });
    const events = await harness.readEvents();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe("task.created");
  });

  it("readTasks returns tasks from the store tasksDir", async () => {
    harness = await createTestHarness();
    // Create a task via the store
    await harness.store.create({ title: "Test task", createdBy: "test" });
    const tasks = await harness.readTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });

  it("exposes getMetric as a function", async () => {
    harness = await createTestHarness();
    expect(typeof harness.getMetric).toBe("function");
  });

  it("accepts an optional prefix for tmpDir naming", async () => {
    harness = await createTestHarness("custom-prefix");
    expect(harness.tmpDir).toContain("custom-prefix");
  });
});

describe("withTestProject", () => {
  it("provides a harness and auto-cleans up", async () => {
    let capturedDir = "";
    await withTestProject(async (h) => {
      capturedDir = h.tmpDir;
      expect(existsSync(h.tmpDir)).toBe(true);
      expect(h.store).toBeDefined();
    });
    expect(existsSync(capturedDir)).toBe(false);
  });

  it("cleans up even if callback throws", async () => {
    let capturedDir = "";
    await expect(
      withTestProject(async (h) => {
        capturedDir = h.tmpDir;
        throw new Error("test error");
      }),
    ).rejects.toThrow("test error");
    expect(existsSync(capturedDir)).toBe(false);
  });
});
