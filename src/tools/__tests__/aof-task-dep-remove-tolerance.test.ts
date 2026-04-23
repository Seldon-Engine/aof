/**
 * `aof_task_dep_remove` must be able to drop a blocker entry from a
 * task's dependsOn list even when the blocker ID doesn't resolve to an
 * existing task — otherwise corrupt tasks (those created before the
 * dispatch-time dependsOn validator landed, or seeded by external
 * tooling) cannot be cleaned up through the MCP surface at all.
 *
 * The CLI path in `src/cli/commands/task-dep.ts` has always handled
 * this correctly by falling through with the literal blockerId when
 * store.getByPrefix returns undefined. The MCP handler was stricter
 * and threw "Task not found" before ever reaching the store — the
 * exact error reported as BUG-004 sub-issue B.
 *
 * We deliberately leave `aof_task_dep_add` strict: adding a brand-new
 * dependency on a nonexistent task is always a caller mistake, and
 * sub-issue A already blocks that at dispatch time. Only removal
 * needs a cleanup-friendly path.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { aofTaskDepRemove, aofTaskDepAdd } from "../task-workflow-tools.js";
import { serializeTask } from "../../store/task-store.js";

async function seedCorruptTask(
  tasksDir: string,
  id: string,
  status: string,
  dependsOn: string[],
): Promise<void> {
  const now = new Date().toISOString();
  const task = {
    frontmatter: {
      schemaVersion: 1 as const,
      id,
      title: "corrupt legacy task",
      status: status as never,
      priority: "normal" as const,
      routing: { tags: [] },
      createdAt: now,
      updatedAt: now,
      lastTransitionAt: now,
      createdBy: "test",
      dependsOn,
      metadata: {},
      gateHistory: [],
      tests: [],
    },
    body: "",
  } as Parameters<typeof serializeTask>[0];

  const dir = join(tasksDir, status);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.md`), serializeTask(task), "utf-8");
}

describe("aof_task_dep_remove tolerance for nonexistent blockers", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-dep-remove-tolerance-"));
    logger = new EventLogger(join(tmpDir, "events"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("removes a bogus blocker entry from a legacy-corrupt task", async () => {
    await seedCorruptTask(join(tmpDir, "tasks"), "TASK-2026-04-23-001", "ready", [
      "TASK-2099-99-99-997",
      "TASK-2099-99-99-998",
    ]);

    const result = await aofTaskDepRemove(
      { store, logger },
      {
        taskId: "TASK-2026-04-23-001",
        blockerId: "TASK-2099-99-99-997",
      },
    );

    expect(result.dependsOn).toEqual(["TASK-2099-99-99-998"]);

    const reloaded = await store.get("TASK-2026-04-23-001");
    expect(reloaded?.frontmatter.dependsOn).toEqual(["TASK-2099-99-99-998"]);
  });

  it("is idempotent when the bogus blocker was never in dependsOn", async () => {
    await seedCorruptTask(join(tmpDir, "tasks"), "TASK-2026-04-23-001", "ready", [
      "TASK-2099-99-99-997",
    ]);

    const result = await aofTaskDepRemove(
      { store, logger },
      {
        taskId: "TASK-2026-04-23-001",
        blockerId: "TASK-2099-99-99-000", // not in list, also nonexistent
      },
    );

    expect(result.dependsOn).toEqual(["TASK-2099-99-99-997"]);
  });

  it("still rejects when the dependent task itself doesn't exist", async () => {
    // The tolerant path only loosens *blocker* resolution. The dependent
    // task must still exist — there's no legitimate use case for removing
    // a dep from a task that was never there.
    await expect(
      aofTaskDepRemove(
        { store, logger },
        {
          taskId: "TASK-2099-99-99-001",
          blockerId: "TASK-2026-04-23-001",
        },
      ),
    ).rejects.toThrow(/TASK-2099-99-99-001/);
  });

  it("still removes a real blocker that exists (baseline unchanged)", async () => {
    const blocker = await store.create({ title: "real", body: "r", createdBy: "t" });
    const target = await store.create({ title: "target", body: "t", createdBy: "t" });
    await store.addDep(target.frontmatter.id, blocker.frontmatter.id);

    const result = await aofTaskDepRemove(
      { store, logger },
      { taskId: target.frontmatter.id, blockerId: blocker.frontmatter.id },
    );

    expect(result.dependsOn).toEqual([]);
  });

  it("aof_task_dep_add stays strict — rejects nonexistent blocker", async () => {
    const target = await store.create({ title: "target", body: "t", createdBy: "t" });

    await expect(
      aofTaskDepAdd(
        { store, logger },
        {
          taskId: target.frontmatter.id,
          blockerId: "TASK-2099-99-99-997",
        },
      ),
    ).rejects.toThrow(/TASK-2099-99-99-997/);
  });
});
