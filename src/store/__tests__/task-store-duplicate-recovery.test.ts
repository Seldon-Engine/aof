/**
 * Regression tests for store.get() duplicate-task-file recovery.
 *
 * Once the same task id ends up on disk under two status directories,
 * the previous behavior was to throw "Duplicate task ID detected" on
 * every subsequent get(), which jammed the whole dispatch chain
 * (lifecycle-handlers → assign-executor → task-lock) in an infinite
 * retry loop. Prevention (v1.14.8 per-task mutex) closes the intra-process
 * race, but duplicates from older installs, external sync, or multi-
 * process access still bricked the scheduler.
 *
 * This suite pins recovery semantics: get() detects the duplicate,
 * keeps the most-recently-written copy as canonical, removes the stale
 * copies, and returns the canonical task without throwing. A second
 * get() reads cleanly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, stat, utimes, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../task-store.js";
import { serializeTask } from "../task-parser.js";
import type { Task, TaskStatus } from "../../schemas/task.js";

vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
    warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(),
  }),
}));

describe("FilesystemTaskStore.get — duplicate file recovery", () => {
  let tmpDir: string;
  let store: FilesystemTaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-duplicate-recovery-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Create a real task via the store (lands in `ready/`), then manually
   * plant an additional copy under a different status directory to
   * simulate a duplicate that survived whatever produced it (pre-v1.14.8
   * race, external sync, manual file op, etc).
   */
  async function createAndPlantDuplicate(
    plants: Array<{ status: TaskStatus; mtimeSec: number; bodySuffix?: string }>,
  ): Promise<{ id: string }> {
    const task = await store.create({
      title: "Duplicate recovery fixture",
      body: "original",
      priority: "normal",
      routing: { agent: "researcher" },
      metadata: {},
      createdBy: "test",
    });
    const id = task.frontmatter.id;
    // store.create() lands in backlog/ — remove it; we fully control placement below.
    const backlogPath = join(tmpDir, "tasks", "backlog", `${id}.md`);
    await rm(backlogPath, { force: true });

    for (const plant of plants) {
      const dir = join(tmpDir, "tasks", plant.status);
      await mkdir(dir, { recursive: true });
      const filePath = join(dir, `${id}.md`);
      const copy: Task = {
        frontmatter: { ...task.frontmatter, status: plant.status },
        body: `${task.body}${plant.bodySuffix ?? ""}`,
      };
      await writeFile(filePath, serializeTask(copy), "utf-8");
      await utimes(filePath, plant.mtimeSec, plant.mtimeSec);
    }
    return { id };
  }

  async function statusDirsContaining(id: string): Promise<string[]> {
    const tasksDir = join(tmpDir, "tasks");
    const hits: string[] = [];
    const statusDirs = await readdir(tasksDir);
    for (const status of statusDirs) {
      try {
        const entries = await readdir(join(tasksDir, status));
        if (entries.some((e) => e === `${id}.md`)) hits.push(status);
      } catch {
        // not a directory
      }
    }
    return hits.sort();
  }

  it("keeps the most-recent copy and removes stale duplicates without throwing", async () => {
    const { id } = await createAndPlantDuplicate([
      { status: "ready", mtimeSec: 1_000_000, bodySuffix: "-older" },
      { status: "blocked", mtimeSec: 2_000_000, bodySuffix: "-newer" },
    ]);

    expect(await statusDirsContaining(id)).toEqual(["blocked", "ready"]);

    const task = await store.get(id);

    expect(task).toBeDefined();
    expect(task!.frontmatter.id).toBe(id);
    // Most-recent copy wins; the blocked/ file survives
    expect(task!.frontmatter.status).toBe("blocked");
    expect(task!.body).toContain("-newer");

    // Stale copy removed
    expect(await statusDirsContaining(id)).toEqual(["blocked"]);
    const staleExists = await stat(join(tmpDir, "tasks", "ready", `${id}.md`))
      .then(() => true)
      .catch(() => false);
    expect(staleExists).toBe(false);

    // Subsequent get() reads cleanly — no throw, same canonical answer
    const again = await store.get(id);
    expect(again).toBeDefined();
    expect(again!.frontmatter.status).toBe("blocked");
  });

  it("heals three-way duplicates by keeping only the newest", async () => {
    const { id } = await createAndPlantDuplicate([
      { status: "backlog", mtimeSec: 1_000_000 },
      { status: "ready", mtimeSec: 1_500_000 },
      { status: "in-progress", mtimeSec: 2_000_000 },
    ]);

    expect(await statusDirsContaining(id)).toEqual(["backlog", "in-progress", "ready"]);

    const task = await store.get(id);
    expect(task).toBeDefined();
    expect(task!.frontmatter.status).toBe("in-progress");

    expect(await statusDirsContaining(id)).toEqual(["in-progress"]);
  });

  it("returns the single matching task unchanged when no duplicates exist", async () => {
    const { id } = await createAndPlantDuplicate([
      { status: "ready", mtimeSec: 1_000_000 },
    ]);

    const task = await store.get(id);

    expect(task).toBeDefined();
    expect(task!.frontmatter.status).toBe("ready");
    expect(await statusDirsContaining(id)).toEqual(["ready"]);
  });

  it("returns undefined when no copies exist", async () => {
    const task = await store.get("TASK-2026-04-15-996");
    expect(task).toBeUndefined();
  });

  it("is deterministic when mtimes are equal — picks a single canonical copy and removes the rest", async () => {
    // Identical mtime: the invariant that matters for dispatch recovery
    // is that exactly one copy survives and get() does not throw. Tie
    // breaks follow STATUS_DIRS iteration order; we assert the survival
    // invariant, not the specific winner.
    const { id } = await createAndPlantDuplicate([
      { status: "ready", mtimeSec: 1_500_000 },
      { status: "blocked", mtimeSec: 1_500_000 },
    ]);

    const task = await store.get(id);

    expect(task).toBeDefined();
    const surviving = await statusDirsContaining(id);
    expect(surviving).toHaveLength(1);
    // The survivor's on-disk directory matches the task we returned.
    expect(surviving[0]).toBe(task!.frontmatter.status);
  });
});
