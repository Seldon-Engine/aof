import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ViewWatcher } from "../watcher.js";
import { parseViewSnapshot } from "../parser.js";
import { renderCLI, renderJSON, renderJSONL } from "../renderers.js";

describe("Integration: Watch + Parse + Render", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `aof-integration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });

    // Create kanban structure
    await mkdir(join(testDir, "backlog"), { recursive: true });
    await mkdir(join(testDir, "in-progress"), { recursive: true });
    await mkdir(join(testDir, "done"), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("watches, parses, and renders kanban view end-to-end", async () => {
    // Initial snapshot
    const snapshot1 = await parseViewSnapshot(testDir, "kanban");
    expect(snapshot1.data.totalTasks).toBe(0);

    const render1 = renderCLI(snapshot1);
    expect(render1).toContain("AOF Kanban");
    expect(render1).toContain("Total: 0 tasks");

    // Add a task
    await writeFile(
      join(testDir, "backlog", "TSK-001.md"),
      `---
id: TSK-001
title: New task
priority: high
agent: swe-backend
---

# New task
Content`
    );

    const snapshot2 = await parseViewSnapshot(testDir, "kanban");
    expect(snapshot2.data.totalTasks).toBe(1);

    const render2 = renderCLI(snapshot2);
    expect(render2).toContain("TSK-001");
    expect(render2).toContain("New task");
    expect(render2).toContain("@swe-backend");
    expect(render2).toContain("HIGH");

    // Test JSON rendering
    const jsonOutput = renderJSON(snapshot2);
    const parsed = JSON.parse(jsonOutput);
    expect(parsed.viewType).toBe("kanban");
    expect(parsed.data.totalTasks).toBe(1);

    // Test JSONL rendering
    const jsonlOutput = renderJSONL({
      type: "add",
      path: join(testDir, "backlog", "TSK-001.md"),
      viewType: "kanban",
      timestamp: new Date().toISOString(),
    }, snapshot2);

    expect(jsonlOutput).toContain("\"type\":\"add\"");
    expect(jsonlOutput.trim().split("\n")).toHaveLength(1);
  });

  it("watches and detects file changes", async () => {
    const events: any[] = [];

    const watcher = new ViewWatcher({
      viewDir: testDir,
      viewType: "kanban",
      onEvent: async (event) => {
        events.push(event);
        
        // Parse and render on each event
        const snapshot = await parseViewSnapshot(testDir, "kanban");
        const rendered = renderCLI(snapshot);
        
        expect(rendered).toBeDefined();
        expect(snapshot.viewType).toBe("kanban");
      },
    });

    await watcher.start();

    // Add a file
    await writeFile(
      join(testDir, "backlog", "WATCH-001.md"),
      `---
id: WATCH-001
title: Watched task
---

# Watched task`
    );

    // Wait for event processing
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.type === "add")).toBe(true);

    await watcher.stop();
  });

  it("handles rapid changes with debouncing", async () => {
    const events: any[] = [];

    const watcher = new ViewWatcher({
      viewDir: testDir,
      viewType: "kanban",
      debounceMs: 100,
      onEvent: (event) => {
        events.push(event);
      },
    });

    await watcher.start();

    // Rapidly create multiple files
    for (let i = 0; i < 5; i++) {
      await writeFile(
        join(testDir, "backlog", `RAPID-${i}.md`),
        `---
id: RAPID-${i}
title: Rapid task ${i}
---

# Task ${i}`
      );
    }

    // Wait for debounce and processing
    await new Promise(resolve => setTimeout(resolve, 300));

    // Parse final state
    const finalSnapshot = await parseViewSnapshot(testDir, "kanban");
    expect(finalSnapshot.data.totalTasks).toBe(5);

    // Render should work with all tasks
    const rendered = renderCLI(finalSnapshot);
    expect(rendered).toContain("Total: 5 tasks");

    await watcher.stop();
  });

  it("renders mailbox view", async () => {
    const mailboxDir = join(testDir, "mailbox-test", "swe-backend");
    await mkdir(join(mailboxDir, "inbox"), { recursive: true });
    await mkdir(join(mailboxDir, "processing"), { recursive: true });
    await mkdir(join(mailboxDir, "outbox"), { recursive: true });

    await writeFile(
      join(mailboxDir, "inbox", "MSG-001.md"),
      `---
id: MSG-001
title: Inbox message
from: pm
---

# Message`
    );

    const snapshot = await parseViewSnapshot(mailboxDir, "mailbox");
    expect(snapshot.viewType).toBe("mailbox");
    expect(snapshot.data.agentId).toBe("swe-backend");
    expect(snapshot.data.inbox).toHaveLength(1);

    const rendered = renderCLI(snapshot);
    expect(rendered).toContain("Mailbox: swe-backend");
    expect(rendered).toContain("MSG-001");
    expect(rendered).toContain("Inbox message");
    expect(rendered).toContain("from: pm");
  });

  it("handles view switching from kanban to mailbox format", async () => {
    // Start with kanban
    await writeFile(
      join(testDir, "backlog", "K-001.md"),
      `---
id: K-001
title: Kanban task
priority: high
---

# Kanban`
    );

    const kanbanSnapshot = await parseViewSnapshot(testDir, "kanban");
    const kanbanRender = renderCLI(kanbanSnapshot);
    expect(kanbanRender).toContain("AOF Kanban");

    // Create mailbox structure
    const mailboxDir = join(testDir, "mailbox", "agent");
    await mkdir(join(mailboxDir, "inbox"), { recursive: true });
    await mkdir(join(mailboxDir, "processing"), { recursive: true });
    await mkdir(join(mailboxDir, "outbox"), { recursive: true });

    await writeFile(
      join(mailboxDir, "inbox", "M-001.md"),
      `---
id: M-001
title: Mailbox task
---

# Mailbox`
    );

    const mailboxSnapshot = await parseViewSnapshot(mailboxDir, "mailbox");
    const mailboxRender = renderCLI(mailboxSnapshot);
    expect(mailboxRender).toContain("Mailbox:");

    // Both renderings should be valid
    expect(kanbanRender).not.toEqual(mailboxRender);
    expect(kanbanRender).toContain("BACKLOG");
    expect(mailboxRender).toContain("INBOX");
  });
});
