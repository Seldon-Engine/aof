/**
 * `aof_dispatch` must reject `dependsOn` entries that don't resolve to
 * existing tasks in the target store, rather than silently persisting
 * unresolvable blockers.
 *
 * Reported as BUG-004 sub-issue A in bug-reports.md: a coordinator can
 * dispatch a task with bogus dependsOn IDs, get a `ready` task back, and
 * then be stuck — the nonexistent blockers can't be satisfied, the
 * dependency list can't be cleaned up via dep_remove, and readiness
 * semantics are meaningless.
 *
 * Fix: validate each `dependsOn` entry against the store before creating
 * the task. Surface the offending ID(s) in the error message.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { aofDispatch } from "../project-tools.js";

describe("aof_dispatch dependsOn validation", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-dispatch-deps-"));
    logger = new EventLogger(join(tmpDir, "events"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // NOTE: each call below passes `agent: "main"` so it bypasses the
  // Phase 46 / Bug 2B routing-required rejection (added in
  // src/tools/project-tools.ts) and exercises ONLY the dependsOn
  // validation path under test here.

  it("rejects dispatch when dependsOn references nonexistent tasks", async () => {
    await expect(
      aofDispatch(
        { store, logger },
        {
          title: "orphan-blocker task",
          brief: "depends on tasks that don't exist",
          actor: "main",
          agent: "main",
          dependsOn: ["TASK-2099-99-99-997", "TASK-2099-99-99-998"],
        },
      ),
    ).rejects.toThrow(/TASK-2099-99-99-997/);
  });

  it("surfaces every missing blocker id in the error message", async () => {
    await expect(
      aofDispatch(
        { store, logger },
        {
          title: "multi-bogus",
          brief: "several missing blockers",
          actor: "main",
          agent: "main",
          dependsOn: ["TASK-2099-99-99-001", "TASK-2099-99-99-002"],
        },
      ),
    ).rejects.toThrow(/TASK-2099-99-99-001.*TASK-2099-99-99-002|TASK-2099-99-99-002.*TASK-2099-99-99-001/s);
  });

  it("accepts dispatch when dependsOn references existing tasks", async () => {
    const blocker = await store.create({
      title: "real blocker",
      body: "b",
      createdBy: "test",
    });
    await store.transition(blocker.frontmatter.id, "ready");

    const result = await aofDispatch(
      { store, logger },
      {
        title: "well-formed task",
        brief: "depends on a real task",
        actor: "main",
        agent: "main",
        dependsOn: [blocker.frontmatter.id],
      },
    );

    expect(result.taskId).toMatch(/^TASK-/);
    const created = await store.get(result.taskId);
    expect(created?.frontmatter.dependsOn).toEqual([blocker.frontmatter.id]);
  });

  it("does not create the task file when dependsOn validation fails", async () => {
    const beforeCount = (await store.list()).length;

    await expect(
      aofDispatch(
        { store, logger },
        {
          title: "should-not-persist",
          brief: "rejected",
          actor: "main",
          agent: "main",
          dependsOn: ["TASK-2099-99-99-997"],
        },
      ),
    ).rejects.toThrow();

    const afterCount = (await store.list()).length;
    expect(afterCount).toBe(beforeCount);
  });

  it("accepts dispatch with no dependsOn (unchanged baseline)", async () => {
    const result = await aofDispatch(
      { store, logger },
      {
        title: "no-deps",
        brief: "no blockers",
        actor: "main",
        agent: "main",
      },
    );

    expect(result.status).toBe("ready");
    const created = await store.get(result.taskId);
    expect(created?.frontmatter.dependsOn).toEqual([]);
  });
});
