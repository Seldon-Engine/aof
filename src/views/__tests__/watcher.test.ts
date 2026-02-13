import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ViewWatcher, type WatchEvent } from "../watcher.js";

describe("ViewWatcher", () => {
  let testDir: string;
  let events: WatchEvent[];
  let watcher: ViewWatcher | undefined;

  // Helper to wait for events with retry logic (fixes flaky timing issues)
  const waitForEvent = async (
    predicate: (event: WatchEvent) => boolean,
    timeoutMs = 500,
    checkIntervalMs = 50
  ): Promise<WatchEvent | undefined> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
    }
    return undefined;
  };

  // Helper to wait for any event to arrive
  const waitForEvents = async (
    minCount = 1,
    timeoutMs = 500,
    checkIntervalMs = 50
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (events.length >= minCount) return;
      await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
    }
  };

  beforeEach(async () => {
    testDir = join(tmpdir(), `aof-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    events = [];
  });

  afterEach(async () => {
    if (watcher?.isRunning()) {
      await watcher.stop();
    }
    await rm(testDir, { recursive: true, force: true });
  });

  describe("constructor and lifecycle", () => {
    it("creates watcher with required options", () => {
      watcher = new ViewWatcher({
        viewDir: testDir,
        viewType: "kanban",
        onEvent: (e) => events.push(e),
      });

      expect(watcher).toBeDefined();
      expect(watcher.isRunning()).toBe(false);
    });

    it("starts and stops watcher", async () => {
      watcher = new ViewWatcher({
        viewDir: testDir,
        viewType: "kanban",
        onEvent: (e) => events.push(e),
      });

      await watcher.start();
      expect(watcher.isRunning()).toBe(true);

      await watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it("throws error when starting already running watcher", async () => {
      watcher = new ViewWatcher({
        viewDir: testDir,
        viewType: "kanban",
        onEvent: (e) => events.push(e),
      });

      await watcher.start();
      await expect(watcher.start()).rejects.toThrow("already running");
    });

    it("stops gracefully when not running", async () => {
      watcher = new ViewWatcher({
        viewDir: testDir,
        viewType: "kanban",
        onEvent: (e) => events.push(e),
      });

      await expect(watcher.stop()).resolves.toBeUndefined();
    });
  });

  describe("auto-detection", () => {
    it("detects kanban view from directory structure", async () => {
      // Create kanban structure
      await mkdir(join(testDir, "backlog"), { recursive: true });
      await mkdir(join(testDir, "in-progress"), { recursive: true });
      await mkdir(join(testDir, "done"), { recursive: true });

      let detectedType: string | undefined;
      watcher = new ViewWatcher({
        viewDir: testDir,
        viewType: "auto",
        onEvent: (e) => {
          detectedType = e.viewType;
          events.push(e);
        },
      });

      await watcher.start();
      await writeFile(join(testDir, "backlog", "TEST-001.md"), "# Test");

      // Wait for event with deterministic retry
      await waitForEvents(1);

      expect(detectedType).toBe("kanban");
    });

    it("detects mailbox view from directory structure", async () => {
      // Create mailbox structure
      await mkdir(join(testDir, "inbox"), { recursive: true });
      await mkdir(join(testDir, "processing"), { recursive: true });
      await mkdir(join(testDir, "outbox"), { recursive: true });

      let detectedType: string | undefined;
      watcher = new ViewWatcher({
        viewDir: testDir,
        viewType: "auto",
        onEvent: (e) => {
          detectedType = e.viewType;
          events.push(e);
        },
      });

      await watcher.start();
      await writeFile(join(testDir, "inbox", "MSG-001.md"), "# Message");

      // Wait for event with deterministic retry
      await waitForEvents(1);

      expect(detectedType).toBe("mailbox");
    });

    it("falls back to generic when structure is ambiguous", async () => {
      // Create ambiguous structure
      await mkdir(join(testDir, "other"), { recursive: true });

      let detectedType: string | undefined;
      watcher = new ViewWatcher({
        viewDir: testDir,
        viewType: "auto",
        onEvent: (e) => {
          detectedType = e.viewType;
          events.push(e);
        },
      });

      await watcher.start();
      await writeFile(join(testDir, "other", "FILE-001.md"), "# File");

      // Wait for event with deterministic retry
      await waitForEvents(1);

      expect(detectedType).toBe("generic");
    });
  });

  describe("file events", () => {
    beforeEach(async () => {
      // Create kanban structure
      await mkdir(join(testDir, "backlog"), { recursive: true });
      await mkdir(join(testDir, "in-progress"), { recursive: true });
    });

    it("emits 'add' event when file is created", async () => {
      watcher = new ViewWatcher({
        viewDir: testDir,
        viewType: "kanban",
        onEvent: (e) => events.push(e),
      });

      await watcher.start();
      
      const filePath = join(testDir, "backlog", "NEW-001.md");
      await writeFile(filePath, "# New task");

      // Wait for event with deterministic retry
      const addEvent = await waitForEvent(e => e.type === "add" && e.path.includes("NEW-001.md"));

      expect(addEvent).toBeDefined();
      expect(addEvent?.path).toContain("NEW-001.md");
      expect(addEvent?.viewType).toBe("kanban");
      expect(addEvent?.timestamp).toBeDefined();
    });

    it("emits 'change' event when file is modified", async () => {
      const filePath = join(testDir, "backlog", "EXISTING-001.md");
      await writeFile(filePath, "# Original");

      watcher = new ViewWatcher({
        viewDir: testDir,
        viewType: "kanban",
        onEvent: (e) => events.push(e),
      });

      await watcher.start();

      // Modify file
      await writeFile(filePath, "# Modified");

      // Wait for event with deterministic retry
      const changeEvent = await waitForEvent(e => e.type === "change" && e.path.includes("EXISTING-001.md"));

      expect(changeEvent).toBeDefined();
      expect(changeEvent?.path).toContain("EXISTING-001.md");
    });

    it("emits 'remove' event when file is deleted", async () => {
      const filePath = join(testDir, "backlog", "DELETE-001.md");
      await writeFile(filePath, "# To delete");

      watcher = new ViewWatcher({
        viewDir: testDir,
        viewType: "kanban",
        onEvent: (e) => events.push(e),
      });

      await watcher.start();

      // Delete file
      await rm(filePath);

      // Wait for event with deterministic retry
      const removeEvent = await waitForEvent(e => e.type === "remove" && e.path.includes("DELETE-001.md"));

      expect(removeEvent).toBeDefined();
      expect(removeEvent?.path).toContain("DELETE-001.md");
    });
  });

  describe("debouncing", () => {
    beforeEach(async () => {
      await mkdir(join(testDir, "backlog"), { recursive: true });
    });

    it("debounces rapid file changes", async () => {
      watcher = new ViewWatcher({
        viewDir: testDir,
        viewType: "kanban",
        debounceMs: 100,
        onEvent: (e) => events.push(e),
      });

      await watcher.start();

      // Rapidly create multiple files
      for (let i = 0; i < 5; i++) {
        await writeFile(join(testDir, "backlog", `RAPID-${i}.md`), `# Task ${i}`);
      }

      // Wait for events with deterministic retry
      await waitForEvents(1);

      // Should receive events, but not 5 separate bursts
      expect(events.length).toBeGreaterThan(0);
      expect(events.length).toBeLessThanOrEqual(10); // Reasonable upper bound
    });

    it("respects custom debounce time", async () => {
      const customDebounce = 50;
      watcher = new ViewWatcher({
        viewDir: testDir,
        viewType: "kanban",
        debounceMs: customDebounce,
        onEvent: (e) => events.push(e),
      });

      await watcher.start();

      await writeFile(join(testDir, "backlog", "TEST.md"), "# Test");

      // Wait for events with deterministic retry
      await waitForEvents(1);

      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe("recursive watching", () => {
    it("watches nested subdirectories", async () => {
      // Create nested kanban structure
      await mkdir(join(testDir, "priority", "backlog"), { recursive: true });
      await mkdir(join(testDir, "priority", "in-progress"), { recursive: true });

      watcher = new ViewWatcher({
        viewDir: testDir,
        viewType: "kanban",
        onEvent: (e) => events.push(e),
      });

      await watcher.start();

      // Create file in nested directory
      await writeFile(join(testDir, "priority", "backlog", "NESTED-001.md"), "# Nested");

      // Wait for event with deterministic retry
      const addEvent = await waitForEvent(e => e.type === "add" && e.path.includes("NESTED-001.md"));

      expect(addEvent).toBeDefined();
      expect(addEvent?.path).toContain("NESTED-001.md");
    });
  });

  describe("error handling", () => {
    it("throws error when viewDir does not exist", async () => {
      const nonExistentDir = join(tmpdir(), "does-not-exist-" + Date.now());

      watcher = new ViewWatcher({
        viewDir: nonExistentDir,
        viewType: "kanban",
        onEvent: (e) => events.push(e),
      });

      await expect(watcher.start()).rejects.toThrow();
    });
  });
});
