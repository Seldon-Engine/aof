/**
 * Tests for task block/unblock commands.
 * 
 * Requirements:
 * - Block command with --reason flag
 * - Unblock command
 * - Wired to store.block() and store.unblock() methods
 * - Error handling for not found / invalid state transitions
 * - Confirmation printed
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../../store/task-store.js";
import type { ITaskStore } from "../../../store/interfaces.js";
import { EventLogger } from "../../../events/logger.js";
import { taskBlock } from "../task-block.js";
import { taskUnblock } from "../task-unblock.js";

describe("Task Block/Unblock Commands", () => {
  let testDir: string;
  let store: ITaskStore;
  let eventLogger: EventLogger;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Create temporary directory for test
    testDir = await mkdtemp(join(tmpdir(), "aof-block-test-"));
    
    // Create required directories
    await mkdir(join(testDir, "tasks", "ready"), { recursive: true });
    await mkdir(join(testDir, "tasks", "in-progress"), { recursive: true });
    await mkdir(join(testDir, "tasks", "blocked"), { recursive: true });
    await mkdir(join(testDir, "tasks", "done"), { recursive: true });
    await mkdir(join(testDir, "events"), { recursive: true });
    
    // Initialize event logger first
    eventLogger = new EventLogger(join(testDir, "events"));
    
    // Initialize store with event logger
    store = new FilesystemTaskStore(testDir, { projectId: "test", logger: eventLogger });

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
    
    // Restore spies
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe("block command", () => {
    it("blocks a ready task with reason", async () => {
      const taskId = "TASK-2026-02-17-001";
      const reason = "Waiting for upstream dependency";
      const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: ready
priority: normal
createdAt: 2026-02-17T00:00:00Z
updatedAt: 2026-02-17T00:00:00Z
lastTransitionAt: 2026-02-17T00:00:00Z
createdBy: system
routing:
  agent: swe-backend
---

Test task body`;

      await writeFile(join(testDir, "tasks", "ready", `${taskId}.md`), taskContent);

      // Block the task
      await taskBlock(store, taskId, { reason });

      // Verify task status changed to blocked
      const task = await store.get(taskId);
      expect(task?.frontmatter.status).toBe("blocked");
      expect(task?.frontmatter.metadata.blockReason).toBe(reason);
      
      // Verify confirmation printed
      expect(consoleLogSpy).toHaveBeenCalledWith(`✅ Task blocked: ${taskId}`);
      expect(consoleLogSpy).toHaveBeenCalledWith(`   Previous status: ready`);
      expect(consoleLogSpy).toHaveBeenCalledWith(`   Reason: ${reason}`);
    });

    it("handles task not found error", async () => {
      const taskId = "TASK-9999-99-99-999";

      // Try to block non-existent task
      await taskBlock(store, taskId, { reason: "Test reason" });

      // Verify error printed
      expect(consoleErrorSpy).toHaveBeenCalledWith(`❌ Task not found: ${taskId}`);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0; // Reset for next test
    });

    it("rejects blocking a terminal task (done)", async () => {
      const taskId = "TASK-2026-02-17-002";
      const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: done
priority: normal
createdAt: 2026-02-17T00:00:00Z
updatedAt: 2026-02-17T00:00:00Z
lastTransitionAt: 2026-02-17T00:00:00Z
createdBy: system
routing:
  agent: swe-backend
---

Test task body`;

      await writeFile(join(testDir, "tasks", "done", `${taskId}.md`), taskContent);

      // Try to block done task
      await taskBlock(store, taskId, { reason: "Test reason" });

      // Verify error printed and process exited
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Cannot block task ${taskId}`)
      );
      expect(process.exitCode).toBe(1);
      process.exitCode = 0; // Reset for next test
    });

    it("resolves task by prefix", async () => {
      const taskId = "TASK-2026-02-17-003";
      const reason = "Test block";
      const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: ready
priority: normal
createdAt: 2026-02-17T00:00:00Z
updatedAt: 2026-02-17T00:00:00Z
lastTransitionAt: 2026-02-17T00:00:00Z
createdBy: system
routing:
  agent: swe-backend
---

Test task body`;

      await writeFile(join(testDir, "tasks", "ready", `${taskId}.md`), taskContent);

      // Block using prefix instead of full ID
      await taskBlock(store, "TASK-2026-02", { reason });

      // Verify task was blocked
      const task = await store.get(taskId);
      expect(task?.frontmatter.status).toBe("blocked");
      expect(task?.frontmatter.metadata.blockReason).toBe(reason);
    });
  });

  describe("unblock command", () => {
    it("unblocks a blocked task", async () => {
      const taskId = "TASK-2026-02-17-004";
      const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: blocked
priority: normal
createdAt: 2026-02-17T00:00:00Z
updatedAt: 2026-02-17T00:00:00Z
lastTransitionAt: 2026-02-17T00:00:00Z
createdBy: system
routing:
  agent: swe-backend
metadata:
  blockReason: "Previously blocked"
---

Test task body`;

      await writeFile(join(testDir, "tasks", "blocked", `${taskId}.md`), taskContent);

      // Unblock the task
      await taskUnblock(store, taskId);

      // Verify task status changed to ready
      const task = await store.get(taskId);
      expect(task?.frontmatter.status).toBe("ready");
      expect(task?.frontmatter.metadata.blockReason).toBeUndefined();
      
      // Verify confirmation printed
      expect(consoleLogSpy).toHaveBeenCalledWith(`✅ Task unblocked: ${taskId}`);
      expect(consoleLogSpy).toHaveBeenCalledWith(`   Previous status: blocked`);
      expect(consoleLogSpy).toHaveBeenCalledWith(`   Now ready for dispatch`);
    });

    it("handles task not found error", async () => {
      const taskId = "TASK-9999-99-99-999";

      // Try to unblock non-existent task
      await taskUnblock(store, taskId);

      // Verify error printed
      expect(consoleErrorSpy).toHaveBeenCalledWith(`❌ Task not found: ${taskId}`);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0; // Reset for next test
    });

    it("rejects unblocking a non-blocked task", async () => {
      const taskId = "TASK-2026-02-17-005";
      const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: ready
priority: normal
createdAt: 2026-02-17T00:00:00Z
updatedAt: 2026-02-17T00:00:00Z
lastTransitionAt: 2026-02-17T00:00:00Z
createdBy: system
routing:
  agent: swe-backend
---

Test task body`;

      await writeFile(join(testDir, "tasks", "ready", `${taskId}.md`), taskContent);

      // Try to unblock a ready task
      await taskUnblock(store, taskId);

      // Verify error printed
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Cannot unblock task ${taskId}`)
      );
      expect(process.exitCode).toBe(1);
      process.exitCode = 0; // Reset for next test
    });

    it("resolves task by prefix", async () => {
      const taskId = "TASK-2026-02-17-006";
      const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: blocked
priority: normal
createdAt: 2026-02-17T00:00:00Z
updatedAt: 2026-02-17T00:00:00Z
lastTransitionAt: 2026-02-17T00:00:00Z
createdBy: system
routing:
  agent: swe-backend
metadata:
  blockReason: "Test"
---

Test task body`;

      await writeFile(join(testDir, "tasks", "blocked", `${taskId}.md`), taskContent);

      // Unblock using prefix instead of full ID
      await taskUnblock(store, "TASK-2026-02-17-006");

      // Verify task was unblocked
      const task = await store.get(taskId);
      expect(task?.frontmatter.status).toBe("ready");
    });
  });
});
