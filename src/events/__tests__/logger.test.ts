/**
 * Tests for event logger — context budget event logging.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventLogger } from "../logger.js";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("EventLogger - context.budget", () => {
  let eventsDir: string;
  let logger: EventLogger;

  beforeEach(() => {
    eventsDir = join(tmpdir(), `aof-test-events-${Date.now()}`);
    logger = new EventLogger(eventsDir);
  });

  afterEach(async () => {
    await rm(eventsDir, { recursive: true, force: true });
  });

  it("logs context.budget event with minimal payload", async () => {
    await logger.logContextBudget("TEST-001", "agent-main", {
      totalChars: 5000,
      estimatedTokens: 1250,
      status: "ok",
    });

    const date = new Date().toISOString().slice(0, 10);
    const filePath = join(eventsDir, `${date}.jsonl`);
    const content = await readFile(filePath, "utf-8");
    const event = JSON.parse(content.trim());

    expect(event.type).toBe("context.budget");
    expect(event.actor).toBe("agent-main");
    expect(event.taskId).toBe("TEST-001");
    expect(event.payload.totalChars).toBe(5000);
    expect(event.payload.estimatedTokens).toBe(1250);
    expect(event.payload.status).toBe("ok");
    expect(event.payload.policy).toBeUndefined();
  });

  it("logs context.budget event with policy", async () => {
    await logger.logContextBudget("TEST-002", "agent-swe", {
      totalChars: 15000,
      estimatedTokens: 3750,
      status: "warn",
      policy: {
        target: 10000,
        warn: 20000,
        critical: 30000,
      },
    });

    const date = new Date().toISOString().slice(0, 10);
    const filePath = join(eventsDir, `${date}.jsonl`);
    const content = await readFile(filePath, "utf-8");
    const event = JSON.parse(content.trim());

    expect(event.type).toBe("context.budget");
    expect(event.taskId).toBe("TEST-002");
    expect(event.payload.status).toBe("warn");
    expect(event.payload.policy).toEqual({
      target: 10000,
      warn: 20000,
      critical: 30000,
    });
  });

  it("logs multiple context budget events", async () => {
    await logger.logContextBudget("TEST-001", "agent-main", {
      totalChars: 5000,
      estimatedTokens: 1250,
      status: "ok",
    });

    await logger.logContextBudget("TEST-002", "agent-swe", {
      totalChars: 25000,
      estimatedTokens: 6250,
      status: "critical",
    });

    const date = new Date().toISOString().slice(0, 10);
    const filePath = join(eventsDir, `${date}.jsonl`);
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines).toHaveLength(2);
    const event1 = JSON.parse(lines[0]!);
    const event2 = JSON.parse(lines[1]!);

    expect(event1.payload.status).toBe("ok");
    expect(event2.payload.status).toBe("critical");
  });

  it("includes monotonic eventId", async () => {
    await logger.logContextBudget("TEST-001", "agent-main", {
      totalChars: 5000,
      estimatedTokens: 1250,
      status: "ok",
    });

    await logger.logContextBudget("TEST-002", "agent-main", {
      totalChars: 6000,
      estimatedTokens: 1500,
      status: "ok",
    });

    const date = new Date().toISOString().slice(0, 10);
    const filePath = join(eventsDir, `${date}.jsonl`);
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");

    const event1 = JSON.parse(lines[0]!);
    const event2 = JSON.parse(lines[1]!);

    expect(event2.eventId).toBeGreaterThan(event1.eventId);
  });
});
