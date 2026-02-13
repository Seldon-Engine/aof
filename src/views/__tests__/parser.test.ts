import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseViewSnapshot } from "../parser.js";

describe("parseViewSnapshot", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `aof-parser-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("kanban parsing", () => {
    beforeEach(async () => {
      // Create kanban structure
      await mkdir(join(testDir, "backlog"), { recursive: true });
      await mkdir(join(testDir, "ready"), { recursive: true });
      await mkdir(join(testDir, "in-progress"), { recursive: true });
      await mkdir(join(testDir, "blocked"), { recursive: true });
      await mkdir(join(testDir, "review"), { recursive: true });
      await mkdir(join(testDir, "done"), { recursive: true });
    });

    it("parses empty kanban view", async () => {
      const snapshot = await parseViewSnapshot(testDir, "kanban");

      expect(snapshot.viewType).toBe("kanban");
      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.data.columns).toBeDefined();
      expect(snapshot.data.totalTasks).toBe(0);
    });

    it("parses kanban with tasks in multiple columns", async () => {
      // Add tasks to different columns
      await writeFile(
        join(testDir, "backlog", "TSK-001.md"),
        `---
id: TSK-001
title: First task
priority: high
---

# First task
Content`
      );

      await writeFile(
        join(testDir, "in-progress", "TSK-002.md"),
        `---
id: TSK-002
title: Second task
priority: critical
agent: swe-backend
---

# Second task
Content`
      );

      await writeFile(
        join(testDir, "done", "TSK-003.md"),
        `---
id: TSK-003
title: Third task
priority: normal
agent: swe-frontend
---

# Third task
Content`
      );

      const snapshot = await parseViewSnapshot(testDir, "kanban");

      expect(snapshot.viewType).toBe("kanban");
      expect(snapshot.data.totalTasks).toBe(3);

      const backlogCol = snapshot.data.columns.find(c => c.name === "backlog");
      expect(backlogCol).toBeDefined();
      expect(backlogCol!.count).toBe(1);
      expect(backlogCol!.tasks).toHaveLength(1);
      expect(backlogCol!.tasks[0].id).toBe("TSK-001");
      expect(backlogCol!.tasks[0].title).toBe("First task");
      expect(backlogCol!.tasks[0].priority).toBe("high");

      const inProgressCol = snapshot.data.columns.find(c => c.name === "in-progress");
      expect(inProgressCol).toBeDefined();
      expect(inProgressCol!.count).toBe(1);
      expect(inProgressCol!.tasks[0].assignee).toBe("swe-backend");

      const doneCol = snapshot.data.columns.find(c => c.name === "done");
      expect(doneCol).toBeDefined();
      expect(doneCol!.count).toBe(1);
    });

    it("handles tasks with missing frontmatter fields", async () => {
      await writeFile(
        join(testDir, "backlog", "TSK-MIN.md"),
        `---
id: TSK-MIN
title: Minimal task
---

# Minimal task`
      );

      const snapshot = await parseViewSnapshot(testDir, "kanban");

      const backlogCol = snapshot.data.columns.find(c => c.name === "backlog");
      expect(backlogCol).toBeDefined();
      expect(backlogCol!.tasks[0].id).toBe("TSK-MIN");
      expect(backlogCol!.tasks[0].assignee).toBeUndefined();
      expect(backlogCol!.tasks[0].priority).toBeUndefined();
    });

    it("ignores non-markdown files", async () => {
      await writeFile(join(testDir, "backlog", "TSK-001.md"), `---\nid: TSK-001\ntitle: Task\n---\n\n# Task`);
      await writeFile(join(testDir, "backlog", "README.txt"), "Not a task");
      await writeFile(join(testDir, "backlog", ".DS_Store"), "");

      const snapshot = await parseViewSnapshot(testDir, "kanban");

      expect(snapshot.data.totalTasks).toBe(1);
    });

    it("handles malformed frontmatter gracefully", async () => {
      await writeFile(
        join(testDir, "backlog", "TSK-BAD.md"),
        `---
invalid yaml: [unclosed
---

# Task`
      );

      await writeFile(
        join(testDir, "backlog", "TSK-GOOD.md"),
        `---
id: TSK-GOOD
title: Good task
---

# Good task`
      );

      const snapshot = await parseViewSnapshot(testDir, "kanban");

      // Should skip bad file and parse good one
      expect(snapshot.data.totalTasks).toBe(1);
      const backlogCol = snapshot.data.columns.find(c => c.name === "backlog");
      expect(backlogCol!.tasks[0].id).toBe("TSK-GOOD");
    });

    it("maintains column order", async () => {
      // Add tasks to various columns
      await writeFile(join(testDir, "done", "D.md"), `---\nid: D\ntitle: Done\n---\n# D`);
      await writeFile(join(testDir, "backlog", "B.md"), `---\nid: B\ntitle: Backlog\n---\n# B`);
      await writeFile(join(testDir, "ready", "R.md"), `---\nid: R\ntitle: Ready\n---\n# R`);

      const snapshot = await parseViewSnapshot(testDir, "kanban");

      const columnNames = snapshot.data.columns.map(c => c.name);
      const expectedOrder = ["backlog", "ready", "in-progress", "blocked", "review", "done"];
      
      // Filter to only columns with tasks
      const actualOrder = columnNames.filter(name => 
        snapshot.data.columns.find(c => c.name === name && c.count > 0)
      );

      for (let i = 0; i < actualOrder.length - 1; i++) {
        const currentIdx = expectedOrder.indexOf(actualOrder[i]);
        const nextIdx = expectedOrder.indexOf(actualOrder[i + 1]);
        expect(currentIdx).toBeLessThan(nextIdx);
      }
    });
  });

  describe("mailbox parsing", () => {
    beforeEach(async () => {
      // Create mailbox structure for an agent
      await mkdir(join(testDir, "inbox"), { recursive: true });
      await mkdir(join(testDir, "processing"), { recursive: true });
      await mkdir(join(testDir, "outbox"), { recursive: true });
    });

    it("parses empty mailbox view", async () => {
      const snapshot = await parseViewSnapshot(testDir, "mailbox");

      expect(snapshot.viewType).toBe("mailbox");
      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.data.inbox).toEqual([]);
      expect(snapshot.data.processing).toEqual([]);
      expect(snapshot.data.outbox).toEqual([]);
    });

    it("parses mailbox with tasks in all folders", async () => {
      await writeFile(
        join(testDir, "inbox", "MSG-001.md"),
        `---
id: MSG-001
title: Incoming task
from: pm
---

# Incoming task`
      );

      await writeFile(
        join(testDir, "processing", "MSG-002.md"),
        `---
id: MSG-002
title: In progress task
---

# In progress`
      );

      await writeFile(
        join(testDir, "outbox", "MSG-003.md"),
        `---
id: MSG-003
title: Completed task
to: qa
---

# Completed`
      );

      const snapshot = await parseViewSnapshot(testDir, "mailbox");

      expect(snapshot.viewType).toBe("mailbox");
      
      expect(snapshot.data.inbox).toHaveLength(1);
      expect(snapshot.data.inbox[0].id).toBe("MSG-001");
      expect(snapshot.data.inbox[0].title).toBe("Incoming task");
      expect(snapshot.data.inbox[0].from).toBe("pm");

      expect(snapshot.data.processing).toHaveLength(1);
      expect(snapshot.data.processing[0].id).toBe("MSG-002");

      expect(snapshot.data.outbox).toHaveLength(1);
      expect(snapshot.data.outbox[0].id).toBe("MSG-003");
      expect(snapshot.data.outbox[0].to).toBe("qa");
    });

    it("extracts agentId from directory path", async () => {
      const agentDir = join(testDir, "agents", "swe-backend");
      await mkdir(join(agentDir, "inbox"), { recursive: true });
      await mkdir(join(agentDir, "processing"), { recursive: true });
      await mkdir(join(agentDir, "outbox"), { recursive: true });

      await writeFile(
        join(agentDir, "inbox", "TSK-001.md"),
        `---
id: TSK-001
title: Task
---

# Task`
      );

      const snapshot = await parseViewSnapshot(agentDir, "mailbox");

      expect(snapshot.data.agentId).toBe("swe-backend");
      expect(snapshot.data.inbox).toHaveLength(1);
    });

    it("handles missing optional fields", async () => {
      await writeFile(
        join(testDir, "inbox", "MIN.md"),
        `---
id: MIN
title: Minimal
---

# Minimal`
      );

      const snapshot = await parseViewSnapshot(testDir, "mailbox");

      expect(snapshot.data.inbox[0].from).toBeUndefined();
      expect(snapshot.data.inbox[0].to).toBeUndefined();
    });

    it("ignores non-markdown files", async () => {
      await writeFile(join(testDir, "inbox", "TASK.md"), `---\nid: TASK\ntitle: Task\n---\n# Task`);
      await writeFile(join(testDir, "inbox", "notes.txt"), "Notes");

      const snapshot = await parseViewSnapshot(testDir, "mailbox");

      expect(snapshot.data.inbox).toHaveLength(1);
    });
  });

  describe("error handling", () => {
    it("throws error for non-existent directory", async () => {
      const nonExistent = join(tmpdir(), "does-not-exist-" + Date.now());

      await expect(parseViewSnapshot(nonExistent, "kanban")).rejects.toThrow();
    });

    it("throws error for invalid view type", async () => {
      await expect(
        parseViewSnapshot(testDir, "invalid" as any)
      ).rejects.toThrow();
    });
  });

  describe("timestamp", () => {
    it("includes ISO 8601 timestamp", async () => {
      await mkdir(join(testDir, "backlog"), { recursive: true });
      
      const snapshot = await parseViewSnapshot(testDir, "kanban");

      expect(snapshot.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      
      // Should be recent
      const timestamp = new Date(snapshot.timestamp);
      const now = new Date();
      expect(now.getTime() - timestamp.getTime()).toBeLessThan(5000); // Within 5 seconds
    });
  });
});
