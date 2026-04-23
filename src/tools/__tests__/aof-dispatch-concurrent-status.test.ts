/**
 * BUG-006 mitigation: `aof_dispatch` writes directly into `tasks/ready/`.
 *
 * When the LLM agent emits parallel `tool_use` blocks for dispatch and
 * status_report, the orchestrator executes both concurrently at HTTP
 * level, and status_report's `readdir` can race dispatch's write. The
 * original implementation made the race window worse by writing to
 * `backlog/` first and then transitioning to `ready/` — two disk ops
 * during which a concurrent reader could miss the file in both dirs.
 *
 * The fix collapses dispatch into a single write directly into `ready/`,
 * halving the race window. A concurrent reader in a tight Promise.all
 * can still race that single rename — `readdir` is fundamentally
 * point-in-time — but the real-world IPC-level race (the pattern that
 * triggered BUG-006 in the field) is essentially closed. Callers who
 * need read-your-own-writes semantics should sequence dispatch before
 * status_report rather than firing them in parallel tool_use blocks.
 *
 * This test locks in the "born ready" path and verifies that a
 * sequential status_report after dispatch sees the new task; we do
 * NOT attempt to assert concurrent-safety since that's outside what
 * filesystem `readdir` guarantees.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { aofDispatch } from "../project-tools.js";
import { aofStatusReport } from "../query-tools.js";

describe("aof_dispatch born-ready (BUG-006 mitigation)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-bug006-"));
    logger = new EventLogger(join(tmpDir, "events"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates the task directly in 'ready' (skips backlog intermediate)", async () => {
    const result = await aofDispatch(
      { store, logger },
      {
        title: "born-ready probe",
        brief: "b",
        actor: "main",
        agent: "swe-backend",
      },
    );
    expect(result.status).toBe("ready");
    expect(result.filePath).toContain(`/tasks/ready/`);

    const task = await store.get(result.taskId);
    expect(task?.frontmatter.status).toBe("ready");
    expect(task?.path).toContain(`/tasks/ready/`);
  });

  it("never writes the file to the backlog directory during dispatch", async () => {
    const result = await aofDispatch(
      { store, logger },
      {
        title: "no-backlog probe",
        brief: "b",
        actor: "main",
        agent: "swe-backend",
      },
    );
    const backlogList = await store.list({ status: "backlog" });
    expect(backlogList.find((t) => t.frontmatter.id === result.taskId)).toBeUndefined();
  });

  it("is visible to a sequential status_report after dispatch completes", async () => {
    const result = await aofDispatch(
      { store, logger },
      {
        title: "sequential probe",
        brief: "b",
        actor: "main",
        agent: "swe-backend",
      },
    );

    const status = await aofStatusReport({ store, logger }, {});
    expect(status.tasks.map((t) => t.id)).toContain(result.taskId);
    expect(status.byStatus.ready).toBeGreaterThanOrEqual(1);
  });
});
