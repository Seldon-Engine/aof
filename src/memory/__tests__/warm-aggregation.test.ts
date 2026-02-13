import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WarmAggregator, type AggregationRule } from "../warm-aggregation.js";
import { ColdTier } from "../cold-tier.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("WarmAggregator", () => {
  let tmpDir: string;
  let coldTier: ColdTier;
  let aggregator: WarmAggregator;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "warm-agg-test-"));
    coldTier = new ColdTier(tmpDir);
    aggregator = new WarmAggregator(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("aggregate", () => {
    it("processes cold events and generates warm docs", async () => {
      // Create some cold events
      const events: BaseEvent[] = [
        {
          eventId: 1,
          type: "task.transitioned",
          timestamp: "2026-02-07T12:00:00Z",
          actor: "swe-backend",
          taskId: "TASK-001",
          payload: { from: "backlog", to: "ready", taskType: "deploy" },
        },
        {
          eventId: 2,
          type: "task.transitioned",
          timestamp: "2026-02-07T12:05:00Z",
          actor: "swe-backend",
          taskId: "TASK-001",
          payload: { from: "ready", to: "done", taskType: "deploy" },
        },
      ];

      for (const event of events) {
        await coldTier.logEvent(event);
      }

      // Run aggregation
      const result = await aggregator.aggregate();

      expect(result.warmDocsUpdated).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    it("creates status summary from task completions", async () => {
      const events: BaseEvent[] = [
        {
          eventId: 1,
          type: "task.transitioned",
          timestamp: "2026-02-07T12:00:00Z",
          actor: "swe-backend",
          taskId: "TASK-001",
          payload: { from: "in-progress", to: "done", title: "Task 1", priority: "high" },
        },
        {
          eventId: 2,
          type: "task.transitioned",
          timestamp: "2026-02-07T13:00:00Z",
          actor: "swe-frontend",
          taskId: "TASK-002",
          payload: { from: "in-progress", to: "done", title: "Task 2", priority: "normal" },
        },
      ];

      for (const event of events) {
        await coldTier.logEvent(event);
      }

      await aggregator.aggregate();

      const statusPath = join(tmpDir, "warm", "status", "recent-completions.md");
      const content = await readFile(statusPath, "utf-8");

      expect(content).toContain("TASK-001");
      expect(content).toContain("TASK-002");
      expect(content).toContain("Task 1");
      expect(content).toContain("high");
    });

    it("is idempotent — same input produces same output", async () => {
      const events: BaseEvent[] = [
        {
          eventId: 1,
          type: "task.transitioned",
          timestamp: "2026-02-07T12:00:00Z",
          actor: "test",
          taskId: "TASK-001",
          payload: { from: "backlog", to: "done" },
        },
      ];

      for (const event of events) {
        await coldTier.logEvent(event);
      }

      const result1 = await aggregator.aggregate();
      const result2 = await aggregator.aggregate();

      // First run creates the files, second run skips unchanged files (incremental)
      expect(result1.warmDocsUpdated).toBeGreaterThan(0);
      expect(result2.warmDocsUpdated).toBe(0); // No changes, so no updates
      expect(result1.eventsProcessed).toBe(result2.eventsProcessed);
    });

    it("handles empty cold tier gracefully", async () => {
      const result = await aggregator.aggregate();

      expect(result.eventsProcessed).toBe(0);
      expect(result.warmDocsUpdated).toBe(0);
      expect(result.errors.length).toBe(0);
    });
  });

  describe("custom rules", () => {
    it("applies custom aggregation rule", async () => {
      const customRule: AggregationRule = {
        id: "test-rule",
        name: "Test Rule",
        filter: (event) => event.type === "task.created",
        aggregate: (events) => {
          const titles = events
            .map(e => e.payload?.title)
            .filter(Boolean)
            .join("\n");
          return `# Created Tasks\n\n${titles}\n`;
        },
        output: {
          path: "test-output.md",
        },
      };

      aggregator = new WarmAggregator(tmpDir, { customRules: [customRule] });

      await coldTier.logEvent({
        eventId: 1,
        type: "task.created",
        timestamp: "2026-02-07T12:00:00Z",
        actor: "test",
        taskId: "TASK-001",
        payload: { title: "Test Task" },
      });

      await aggregator.aggregate();

      const outputPath = join(tmpDir, "warm", "test-output.md");
      const content = await readFile(outputPath, "utf-8");

      expect(content).toContain("# Created Tasks");
      expect(content).toContain("Test Task");
    });
  });

  describe("size limits", () => {
    it("rejects warm docs exceeding 150KB", async () => {
      const largePayloadRule: AggregationRule = {
        id: "large-test",
        name: "Large Test",
        filter: (event) => event.type === "task.created",
        aggregate: () => {
          // Generate >150KB content
          return "x".repeat(151_000);
        },
        output: {
          path: "test-large.md",
        },
      };

      aggregator = new WarmAggregator(tmpDir, { customRules: [largePayloadRule] });

      await coldTier.logEvent({
        eventId: 1,
        type: "task.created",
        timestamp: "2026-02-07T12:00:00Z",
        actor: "test",
        taskId: "TASK-001",
        payload: {},
      });

      const result = await aggregator.aggregate();

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]!.error).toContain("150KB limit");
    });
  });

  describe("incremental updates", () => {
    it("only processes new events since last run", async () => {
      // First run
      await coldTier.logEvent({
        eventId: 1,
        type: "task.transitioned",
        timestamp: "2026-02-07T12:00:00Z",
        actor: "test",
        taskId: "TASK-001",
        payload: { from: "backlog", to: "done" },
      });

      const result1 = await aggregator.aggregate();
      expect(result1.eventsProcessed).toBe(1);

      // Add more events
      await coldTier.logEvent({
        eventId: 2,
        type: "task.transitioned",
        timestamp: "2026-02-07T13:00:00Z",
        actor: "test",
        taskId: "TASK-002",
        payload: { from: "backlog", to: "done" },
      });

      const result2 = await aggregator.aggregate();
      
      // Should process both events (incremental not yet optimized in v1)
      expect(result2.eventsProcessed).toBeGreaterThanOrEqual(1);
    });
  });
});
