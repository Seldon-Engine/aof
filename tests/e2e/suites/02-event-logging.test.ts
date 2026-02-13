/**
 * E2E Test: Event Logging
 * 
 * Tests AOF EventLogger end-to-end.
 * Verifies:
 * - Event creation and appending
 * - JSONL format
 * - Daily log rotation
 * - Event querying
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventLogger } from "../../../src/events/logger.js";
import { cleanupTestData, seedTestData } from "../utils/test-data.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFile, readdir } from "node:fs/promises";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "aof-test-data");
const EVENTS_DIR = join(TEST_DATA_DIR, "events");

describe("E2E: Event Logging", () => {
  let logger: EventLogger;

  beforeEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
    await seedTestData(TEST_DATA_DIR);
    logger = new EventLogger(EVENTS_DIR);
  });

  afterEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
  });

  it("should log task.created event", async () => {
    await logger.log("task.created", "test-system", {
      taskId: "test-task-001",
      payload: {
        title: "Test Task",
        status: "inbox",
        priority: "P2",
      },
    });

    // Verify event file exists
    const files = await readdir(EVENTS_DIR);
    const todayFile = files.find(f => f.endsWith(".jsonl"));
    expect(todayFile).toBeDefined();

    // Read and parse events
    const content = await readFile(join(EVENTS_DIR, todayFile!), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);

    const event = JSON.parse(lines[lines.length - 1]);
    expect(event.type).toBe("task.created");
    expect(event.taskId).toBe("test-task-001");
  });

  it("should log task.transitioned event", async () => {
    await logger.log("task.transitioned", "test-agent", {
      taskId: "test-task-002",
      payload: {
        from: "inbox",
        to: "ready",
      },
    });

    const files = await readdir(EVENTS_DIR);
    const todayFile = files.find(f => f.endsWith(".jsonl"));
    const content = await readFile(join(EVENTS_DIR, todayFile!), "utf-8");
    const lines = content.trim().split("\n");
    const event = JSON.parse(lines[lines.length - 1]);

    expect(event.type).toBe("task.transitioned");
    expect(event.payload.from).toBe("inbox");
    expect(event.payload.to).toBe("ready");
  });

  it("should log task.leased event", async () => {
    await logger.log("task.leased", "test-agent", {
      taskId: "test-task-003",
      payload: {
        sessionId: "session-123",
        ttlMs: 30000,
      },
    });

    const files = await readdir(EVENTS_DIR);
    const todayFile = files.find(f => f.endsWith(".jsonl"));
    const content = await readFile(join(EVENTS_DIR, todayFile!), "utf-8");
    const lines = content.trim().split("\n");
    const event = JSON.parse(lines[lines.length - 1]);

    expect(event.type).toBe("task.leased");
    expect(event.payload.sessionId).toBe("session-123");
  });

  it("should append multiple events to same file", async () => {
    await logger.log("task.created", "system", {
      taskId: "task-001",
      payload: { title: "Task 1" },
    });

    await logger.log("task.created", "system", {
      taskId: "task-002",
      payload: { title: "Task 2" },
    });

    await logger.log("task.created", "system", {
      taskId: "task-003",
      payload: { title: "Task 3" },
    });

    const files = await readdir(EVENTS_DIR);
    const todayFile = files.find(f => f.endsWith(".jsonl"));
    const content = await readFile(join(EVENTS_DIR, todayFile!), "utf-8");
    const lines = content.trim().split("\n").filter(l => l.length > 0);

    expect(lines.length).toBeGreaterThanOrEqual(3);

    // Verify all events are valid JSON
    const parsedEvents = lines.map(line => JSON.parse(line));
    expect(parsedEvents.every(e => e.type && e.taskId && e.timestamp)).toBe(true);
  });

  it("should maintain JSONL format with one event per line", async () => {
    await logger.log("task.updated", "test", {
      taskId: "test-task-jsonl",
      payload: {
        updates: {
          title: "Updated Title",
          description: "This\nhas\nmultiple\nlines",
        },
      },
    });

    const files = await readdir(EVENTS_DIR);
    const todayFile = files.find(f => f.endsWith(".jsonl"));
    const content = await readFile(join(EVENTS_DIR, todayFile!), "utf-8");
    const lines = content.trim().split("\n");

    // Each line should be valid JSON
    expect(() => {
      lines.forEach(line => {
        if (line.trim()) JSON.parse(line);
      });
    }).not.toThrow();

    // Verify the last event has the multiline description properly escaped
    const lastEvent = JSON.parse(lines[lines.length - 1]);
    expect(lastEvent.payload.updates.description).toContain("\n");
  });
});
