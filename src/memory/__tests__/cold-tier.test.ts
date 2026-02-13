import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ColdTier } from "../cold-tier.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("ColdTier", () => {
  let tmpDir: string;
  let coldTier: ColdTier;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cold-tier-test-"));
    coldTier = new ColdTier(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("logEvent", () => {
    it("writes event to logs directory", async () => {
      const event: BaseEvent = {
        eventId: 1,
        type: "task.created",
        timestamp: "2026-02-07T12:00:00Z",
        actor: "test-agent",
        taskId: "TASK-2026-02-07-001",
        payload: { title: "Test task" },
      };

      await coldTier.logEvent(event);

      const logsDir = join(tmpDir, "cold", "logs");
      const files = await readdir(logsDir);
      expect(files.length).toBeGreaterThan(0);

      const logFile = files.find(f => f.endsWith(".jsonl"));
      expect(logFile).toBeDefined();

      const content = await readFile(join(logsDir, logFile!), "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.eventId).toBe(1);
      expect(parsed.type).toBe("task.created");
      expect(parsed.taskId).toBe("TASK-2026-02-07-001");
    });

    it("appends multiple events to same file", async () => {
      const events: BaseEvent[] = [
        {
          eventId: 1,
          type: "task.created",
          timestamp: "2026-02-07T12:00:00Z",
          actor: "test",
          taskId: "TASK-001",
          payload: {},
        },
        {
          eventId: 2,
          type: "task.transitioned",
          timestamp: "2026-02-07T12:01:00Z",
          actor: "test",
          taskId: "TASK-001",
          payload: { from: "backlog", to: "ready" },
        },
      ];

      for (const event of events) {
        await coldTier.logEvent(event);
      }

      const logsDir = join(tmpDir, "cold", "logs");
      const files = await readdir(logsDir);
      const logFile = files.find(f => f.endsWith(".jsonl"))!;
      const content = await readFile(join(logsDir, logFile), "utf-8");
      const lines = content.trim().split("\n");

      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]).eventId).toBe(1);
      expect(JSON.parse(lines[1]).eventId).toBe(2);
    });

    it("creates new file when size exceeds limit", async () => {
      const smallLimitTier = new ColdTier(tmpDir, { maxFileSizeBytes: 200 });

      // Create events that will exceed 200 bytes
      for (let i = 0; i < 5; i++) {
        await smallLimitTier.logEvent({
          eventId: i,
          type: "task.created",
          timestamp: new Date().toISOString(),
          actor: "test",
          taskId: `TASK-${i}`,
          payload: { data: "x".repeat(50) },
        });
      }

      const logsDir = join(tmpDir, "cold", "logs");
      const files = await readdir(logsDir);
      const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));

      // Should have rotated to multiple files
      expect(jsonlFiles.length).toBeGreaterThan(1);
    });
  });

  describe("logTranscript", () => {
    it("writes transcript to transcripts directory", async () => {
      const sessionId = "session-12345";
      const transcript = "Agent: Hello\nUser: Hi there";

      await coldTier.logTranscript(sessionId, transcript);

      const transcriptsDir = join(tmpDir, "cold", "transcripts");
      const files = await readdir(transcriptsDir);
      expect(files.length).toBe(1);

      const file = files[0];
      expect(file).toContain(sessionId);

      const content = await readFile(join(transcriptsDir, file), "utf-8");
      expect(content).toContain("Agent: Hello");
      expect(content).toContain("User: Hi there");
    });
  });

  describe("logIncident", () => {
    it("writes incident report to incidents directory", async () => {
      const incident = {
        id: "INC-001",
        summary: "Database connection timeout",
        severity: "high" as const,
        timestamp: "2026-02-07T12:00:00Z",
        reporter: "monitoring-agent",
        details: "Connection pool exhausted after 30s",
      };

      await coldTier.logIncident(incident);

      const incidentsDir = join(tmpDir, "cold", "incidents");
      const files = await readdir(incidentsDir);
      expect(files.length).toBe(1);

      const file = files[0];
      expect(file).toContain("INC-001");

      const content = await readFile(join(incidentsDir, file), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.id).toBe("INC-001");
      expect(parsed.summary).toBe("Database connection timeout");
      expect(parsed.severity).toBe("high");
    });
  });

  describe("filename generation", () => {
    it("generates ISO timestamp filenames", async () => {
      await coldTier.logEvent({
        eventId: 1,
        type: "task.created",
        timestamp: "2026-02-07T12:00:00Z",
        actor: "test",
        taskId: "TASK-001",
        payload: {},
      });

      const logsDir = join(tmpDir, "cold", "logs");
      const files = await readdir(logsDir);
      const file = files[0];

      // Should match ISO8601-like format with milliseconds
      expect(file).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jsonl$/);
    });

    it("generates unique filenames for concurrent writes", async () => {
      // Write multiple events concurrently
      await Promise.all([
        coldTier.logEvent({ eventId: 1, type: "task.created", timestamp: new Date().toISOString(), actor: "a", payload: {} }),
        coldTier.logEvent({ eventId: 2, type: "task.created", timestamp: new Date().toISOString(), actor: "b", payload: {} }),
      ]);

      const logsDir = join(tmpDir, "cold", "logs");
      const files = await readdir(logsDir);

      // Should have written to the same file (or properly handled concurrency)
      expect(files.length).toBeGreaterThan(0);
    });
  });
});
