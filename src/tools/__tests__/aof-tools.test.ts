import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestHarness, type TestHarness } from "../../testing/index.js";
import { aofTaskUpdate, aofTaskComplete, aofStatusReport } from "../aof-tools.js";
import { serializeTask } from "../../store/task-store.js";
import type { ToolResponseEnvelope } from "../envelope.js";

describe("AOF tool handlers", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness("aof-tools-test");
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const readLastEvent = async (): Promise<{ type: string; payload: Record<string, unknown> }> => {
    const eventsDir = harness.eventsDir;
    const files = await readdir(eventsDir);
    const content = await readFile(join(eventsDir, files[0]!), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const event = JSON.parse(lines[lines.length - 1]!);
    return { type: event.type, payload: event.payload };
  };

  it("updates task body and transitions status", async () => {
    const task = await harness.store.create({ title: "Update me", createdBy: "main" });
    await harness.store.transition(task.frontmatter.id, "ready");

    const result = await aofTaskUpdate(
      { store: harness.store, logger: harness.logger },
      {
        taskId: task.frontmatter.id,
        body: "New body",
        status: "in-progress",
        actor: "swe-backend",
        reason: "work started",
      },
    );

    expect(result.status).toBe("in-progress");

    const updated = await harness.store.get(task.frontmatter.id);
    expect(updated?.body).toBe("New body");

    const lastEvent = await readLastEvent();
    expect(lastEvent.type).toBe("task.transitioned");
    expect(lastEvent.payload.to).toBe("in-progress");
  });

  it("marks task complete and logs completion", async () => {
    const task = await harness.store.create({ title: "Complete me", createdBy: "main" });
    await harness.store.transition(task.frontmatter.id, "ready");
    await harness.store.transition(task.frontmatter.id, "in-progress");
    await harness.store.transition(task.frontmatter.id, "review");

    const result = await aofTaskComplete(
      { store: harness.store, logger: harness.logger },
      {
        taskId: task.frontmatter.id,
        actor: "swe-backend",
        summary: "All done",
      },
    );

    expect(result.status).toBe("done");

    const lastEvent = await readLastEvent();
    expect(lastEvent.type).toBe("task.completed");
  });

  it("tool handlers self-heal duplicate task cards and proceed against the canonical copy", async () => {
    // Prior behavior was to throw "Duplicate task ID detected" and jam
    // the caller. After recovery (task-store.ts get()), the stale copy
    // is removed and tools operate against the most-recent copy.
    const task = await harness.store.create({ title: "Duplicate logical task", createdBy: "main" });
    await harness.store.transition(task.frontmatter.id, "ready");

    // Plant a stale done/ copy (older mtime) — the ready/ copy must win.
    const staleDone = {
      frontmatter: {
        ...task.frontmatter,
        status: "done" as const,
      },
      body: task.body,
    };
    const stalePath = join(harness.tmpDir, "tasks", "done", `${task.frontmatter.id}.md`);
    await writeFile(stalePath, serializeTask(staleDone), "utf-8");
    const { utimes, stat } = await import("node:fs/promises");
    const readyPath = join(harness.tmpDir, "tasks", "ready", `${task.frontmatter.id}.md`);
    await utimes(stalePath, 1_000_000, 1_000_000);
    await utimes(readyPath, 2_000_000, 2_000_000);

    // Update proceeds against ready/ (canonical), drives task to in-progress.
    const updated = await aofTaskUpdate(
      { store: harness.store, logger: harness.logger },
      {
        taskId: task.frontmatter.id,
        status: "in-progress",
        actor: "swe-backend",
      },
    );
    expect(updated.status).toBe("in-progress");

    // Stale done/ copy has been removed by self-heal.
    const staleStillThere = await stat(stalePath).then(() => true).catch(() => false);
    expect(staleStillThere).toBe(false);

    // Completion proceeds cleanly on the single canonical copy.
    const completed = await aofTaskComplete(
      { store: harness.store, logger: harness.logger },
      {
        taskId: task.frontmatter.id,
        actor: "swe-backend",
        summary: "All done",
      },
    );
    expect(completed.status).toBe("done");
  });

  it("reports task status counts", async () => {
    const taskA = await harness.store.create({ title: "A", createdBy: "main" });
    await harness.store.transition(taskA.frontmatter.id, "ready");
    const taskB = await harness.store.create({ title: "B", createdBy: "main" });
    await harness.store.transition(taskB.frontmatter.id, "ready");
    await harness.store.transition(taskB.frontmatter.id, "in-progress");

    const report = await aofStatusReport({ store: harness.store, logger: harness.logger }, { actor: "main" });

    expect(report.total).toBe(2);
    expect(report.byStatus.ready).toBe(1);
    expect(report.byStatus["in-progress"]).toBe(1);
  });

  describe("envelope format", () => {
    it("aofTaskUpdate returns envelope with summary", async () => {
      const task = await harness.store.create({ title: "Test task", createdBy: "main" });
      await harness.store.transition(task.frontmatter.id, "ready");

      const result = await aofTaskUpdate(
        { store: harness.store, logger: harness.logger },
        {
          taskId: task.frontmatter.id,
          status: "in-progress",
          actor: "swe-backend",
        },
      );

      const envelope = result as unknown as ToolResponseEnvelope;
      expect(envelope.summary).toBeDefined();
      expect(envelope.summary).toContain(task.frontmatter.id);
      expect(envelope.summary).toContain("in-progress");
      expect(envelope.meta?.taskId).toBe(task.frontmatter.id);
      expect(envelope.meta?.status).toBe("in-progress");
    });

    it("aofTaskComplete returns envelope with summary", async () => {
      const task = await harness.store.create({ title: "Complete task", createdBy: "main" });
      await harness.store.transition(task.frontmatter.id, "ready");
      await harness.store.transition(task.frontmatter.id, "in-progress");
      await harness.store.transition(task.frontmatter.id, "review");

      const result = await aofTaskComplete(
        { store: harness.store, logger: harness.logger },
        {
          taskId: task.frontmatter.id,
          actor: "swe-backend",
        },
      );

      const envelope = result as unknown as ToolResponseEnvelope;
      expect(envelope.summary).toBeDefined();
      expect(envelope.summary).toContain("completed");
      expect(envelope.meta?.taskId).toBe(task.frontmatter.id);
      expect(envelope.meta?.status).toBe("done");
    });

    it("aofStatusReport returns envelope in full mode by default", async () => {
      const task = await harness.store.create({ title: "Task A", createdBy: "main" });
      await harness.store.transition(task.frontmatter.id, "ready");

      const result = await aofStatusReport({ store: harness.store, logger: harness.logger }, { actor: "main" });

      const envelope = result as unknown as ToolResponseEnvelope;
      expect(envelope.summary).toBeDefined();
      expect(envelope.details).toBeDefined();
      expect(envelope.summary).toContain("1 task");
    });

    it("aofStatusReport returns compact envelope when compact=true", async () => {
      const taskA = await harness.store.create({ title: "Task A", createdBy: "main" });
      await harness.store.transition(taskA.frontmatter.id, "ready");
      const taskB = await harness.store.create({ title: "Task B", createdBy: "main" });
      await harness.store.transition(taskB.frontmatter.id, "ready");
      await harness.store.transition(taskB.frontmatter.id, "in-progress");

      const result = await aofStatusReport(
        { store: harness.store, logger: harness.logger },
        { actor: "main", compact: true },
      );

      const envelope = result as unknown as ToolResponseEnvelope;
      expect(envelope.summary).toBeDefined();
      expect(envelope.details).toBeUndefined();
      expect(envelope.summary).toContain("2 tasks");
      expect(envelope.summary).toContain("ready: 1");
      expect(envelope.summary).toContain("in-progress: 1");
    });

    it("aofStatusReport respects limit parameter", async () => {
      // Create 5 tasks
      for (let i = 0; i < 5; i++) {
        const task = await harness.store.create({ title: `Task ${i}`, createdBy: "main" });
        await harness.store.transition(task.frontmatter.id, "ready");
      }

      const result = await aofStatusReport(
        { store: harness.store, logger: harness.logger },
        { actor: "main", limit: 3 },
      );

      const envelope = result as unknown as ToolResponseEnvelope;
      expect(envelope.summary).toContain("5 tasks");
      expect(envelope.details).toBeDefined();
      // Details should only list 3 tasks
      const taskLines = envelope.details!.split("\n").filter(line => line.startsWith("- "));
      expect(taskLines.length).toBe(3);
    });

    it("aofStatusReport compact mode with limit", async () => {
      // Create 5 tasks
      for (let i = 0; i < 5; i++) {
        const task = await harness.store.create({ title: `Task ${i}`, createdBy: "main" });
        await harness.store.transition(task.frontmatter.id, "ready");
      }

      const result = await aofStatusReport(
        { store: harness.store, logger: harness.logger },
        { actor: "main", compact: true, limit: 2 },
      );

      const envelope = result as unknown as ToolResponseEnvelope;
      expect(envelope.summary).toContain("5 tasks");
      expect(envelope.details).toBeUndefined();
    });

    it("aofStatusReport handles empty task list", async () => {
      const result = await aofStatusReport({ store: harness.store, logger: harness.logger }, { actor: "main" });

      const envelope = result as unknown as ToolResponseEnvelope;
      expect(envelope.summary).toContain("0 tasks");
      expect(envelope.details).toBeDefined();
    });

    it("aofStatusReport compact mode with empty task list", async () => {
      const result = await aofStatusReport(
        { store: harness.store, logger: harness.logger },
        { actor: "main", compact: true },
      );

      const envelope = result as unknown as ToolResponseEnvelope;
      expect(envelope.summary).toContain("0 tasks");
      expect(envelope.details).toBeUndefined();
    });
  });
});
