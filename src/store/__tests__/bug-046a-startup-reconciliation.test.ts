/**
 * Phase 46 / Bug 1A — startup reconciliation regression suite.
 *
 * The 2026-04-24 production incident left 5 task files on disk with
 * `frontmatter.status: deadletter` while physically located in
 * `tasks/ready/`. The user hand-moved them as mitigation; this suite
 * pins the self-heal so a future repeat is invisible to operators.
 *
 * Plan 01 (atomic transition) closes the FUTURE-drift window by making
 * `transitionToDeadletter` a single store call. Plan 02 (this file)
 * heals drift that ALREADY exists on disk — for any file whose
 * `frontmatter.status` disagrees with the directory it sits in,
 * `FilesystemTaskStore.init()` renames it to the matching directory.
 *
 * Per CONTEXT.md: "Filesystem is the source of truth for location;
 * frontmatter is the source of truth for which status the task should
 * have. The reconciliation resolves disagreement in favor of the
 * frontmatter status."
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  readFile,
  stat,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../task-store.js";
import { serializeTask, parseTaskFile } from "../task-parser.js";
import type { Task } from "../../schemas/task.js";

// Suppress structured logger output (matches the analog in
// task-store-concurrent-transition.test.ts and
// task-store-duplicate-recovery.test.ts).
vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }),
}));

describe("Phase 46 / Bug 1A — startup reconciliation", () => {
  let tmpDir: string;
  let store: FilesystemTaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-bug046a-reconcile-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Plant a misfiled task: create via the store (lands in `backlog/`),
   * remove the real file, then writeFile a copy with a different
   * `frontmatter.status` into a different status directory. Mirrors
   * `task-store-duplicate-recovery.test.ts:50-80` plant pattern.
   *
   * Returns the canonical task id and the original task so the caller
   * can reuse the body / metadata for assertions.
   */
  async function plantMisfiledTask(opts: {
    plantedDir: string;     // physical location on disk (e.g. "ready")
    frontmatterStatus: string; // value of frontmatter.status (e.g. "deadletter")
  }): Promise<{ id: string; task: Task }> {
    const task = await store.create({
      title: "Reconciliation fixture",
      body: "fixture body",
      priority: "normal",
      routing: { agent: "researcher" },
      metadata: {},
      createdBy: "test",
    });
    const id = task.frontmatter.id;
    // store.create() lands in backlog/ — remove it; the planted copy
    // is the only on-disk file for this task id.
    const backlogPath = join(tmpDir, "tasks", "backlog", `${id}.md`);
    await rm(backlogPath, { force: true });

    const plantDir = join(tmpDir, "tasks", opts.plantedDir);
    await mkdir(plantDir, { recursive: true });
    const filePath = join(plantDir, `${id}.md`);
    const copy: Task = {
      // Cast through unknown→Task so we can plant a status string that
      // doesn't satisfy the TaskStatus union — needed for the
      // bogus-status case. The serializer doesn't re-validate, just
      // stringifies the YAML.
      frontmatter: {
        ...task.frontmatter,
        status: opts.frontmatterStatus as Task["frontmatter"]["status"],
      },
      body: task.body,
    };
    await writeFile(filePath, serializeTask(copy), "utf-8");
    return { id, task };
  }

  it("moves a file with frontmatter.status=deadletter but in tasks/ready/ to tasks/deadletter/", async () => {
    const { id } = await plantMisfiledTask({
      plantedDir: "ready",
      frontmatterStatus: "deadletter",
    });

    // Sanity: the planted file is at tasks/ready/<id>.md, not at deadletter/.
    const plantedPath = join(tmpDir, "tasks", "ready", `${id}.md`);
    const targetPath = join(tmpDir, "tasks", "deadletter", `${id}.md`);
    expect(await pathExists(plantedPath)).toBe(true);
    expect(await pathExists(targetPath)).toBe(false);

    // Re-init the store. Phase 46 reconcileDrift() must move the file
    // to the directory matching its frontmatter status.
    const store2 = new FilesystemTaskStore(tmpDir);
    await store2.init();

    expect(await pathExists(targetPath)).toBe(true);
    expect(await pathExists(plantedPath)).toBe(false);

    // Re-parse the post-move file directly — do NOT call store.get(id),
    // which has its own duplicate-recovery self-heal that would
    // interfere (PATTERNS.md Pitfall 4).
    const raw = await readFile(targetPath, "utf-8");
    const reparsed = parseTaskFile(raw, targetPath);
    expect(reparsed.frontmatter.status).toBe("deadletter");
    expect(reparsed.frontmatter.id).toBe(id);
  });

  it("leaves a well-placed file alone (no unnecessary I/O)", async () => {
    // Create a task and transition it to ready/ via the normal API —
    // this leaves frontmatter.status === "ready" matching the
    // directory. Reconciliation should find no drift and not touch
    // the file.
    const created = await store.create({
      title: "Well-placed task",
      body: "x",
      priority: "normal",
      routing: { agent: "researcher" },
      metadata: {},
      createdBy: "test",
    });
    await store.transition(created.frontmatter.id, "ready");
    const id = created.frontmatter.id;
    const filePath = join(tmpDir, "tasks", "ready", `${id}.md`);
    expect(await pathExists(filePath)).toBe(true);

    const beforeMtime = (await stat(filePath)).mtimeMs;

    // Two re-inits in quick succession — the second must be a no-op
    // on a drift-free store.
    const s1 = new FilesystemTaskStore(tmpDir);
    await s1.init();
    const s2 = new FilesystemTaskStore(tmpDir);
    await s2.init();

    expect(await pathExists(filePath)).toBe(true);
    const afterMtime = (await stat(filePath)).mtimeMs;
    // mtime must be unchanged — a no-op walk, no rewrite.
    expect(afterMtime).toBe(beforeMtime);

    // And the file is still where it should be: nothing planted in
    // any other status dir for this id.
    for (const status of [
      "backlog",
      "in-progress",
      "blocked",
      "review",
      "done",
      "cancelled",
      "deadletter",
    ]) {
      const otherPath = join(tmpDir, "tasks", status, `${id}.md`);
      expect(await pathExists(otherPath)).toBe(false);
    }
  });

  it("moves the companion directory alongside the .md file", async () => {
    const { id } = await plantMisfiledTask({
      plantedDir: "ready",
      frontmatterStatus: "done",
    });
    // Plant a companion outputs directory at the OLD location.
    const oldOutputs = join(tmpDir, "tasks", "ready", id, "outputs");
    await mkdir(oldOutputs, { recursive: true });
    const dummyPath = join(oldOutputs, "result.txt");
    await writeFile(dummyPath, "hello world", "utf-8");

    // Sanity: companion exists at old location, not yet at new.
    expect(await pathExists(oldOutputs)).toBe(true);
    expect(
      await pathExists(join(tmpDir, "tasks", "done", id, "outputs")),
    ).toBe(false);

    const store2 = new FilesystemTaskStore(tmpDir);
    await store2.init();

    // .md must have moved.
    expect(
      await pathExists(join(tmpDir, "tasks", "done", `${id}.md`)),
    ).toBe(true);
    expect(
      await pathExists(join(tmpDir, "tasks", "ready", `${id}.md`)),
    ).toBe(false);

    // Companion dir + file must have moved alongside (best-effort).
    const newOutputs = join(tmpDir, "tasks", "done", id, "outputs");
    expect(await pathExists(newOutputs)).toBe(true);
    const movedDummy = join(newOutputs, "result.txt");
    const dummyContent = await readFile(movedDummy, "utf-8");
    expect(dummyContent).toBe("hello world");

    // Old companion path must be gone (or at minimum empty).
    const oldDirGone = !(await pathExists(
      join(tmpDir, "tasks", "ready", id),
    ));
    if (!oldDirGone) {
      // Tolerate empty leftover dir on platforms where rename is
      // partial — the contract is "best-effort"; enforce only that
      // it's empty.
      const remaining = await readdir(join(tmpDir, "tasks", "ready", id));
      expect(remaining).toEqual([]);
    }
  });
});

/** Helper: returns true iff the path exists (file or directory). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
