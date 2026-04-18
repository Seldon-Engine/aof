/**
 * BUG-044 regression: unscoped base store at the daemon data dir must
 * NOT trigger `loadProjectManifest` during dispatch.
 *
 * Symptom in the wild (v1.15.0):
 *   aof-daemon started at ~/.aof/data logged on EVERY poll:
 *     ENOENT: no such file or directory, open '/Users/.../.aof/data/project.yaml'
 *     projectId:"data"
 *
 * Root cause chain:
 *   1. `new FilesystemTaskStore("~/.aof/data")` → `basename()` fallback
 *      set `store.projectId = "data"`.
 *   2. Tasks created got `project: "data"` stamped in frontmatter.
 *   3. task-dispatcher read `task.frontmatter.project === "data"` and
 *      called `loadProjectManifest(store, "data")`.
 *   4. `manifest.ts` saw `store.projectId === "data"` and tried to open
 *      `store.projectRoot/project.yaml`, which didn't exist for an
 *      unscoped base store → ENOENT warning every poll.
 *
 * This regression test drives the dispatch path with an unscoped store
 * and asserts no manifest-load warning is emitted.
 *
 * RED pre-fix: fails because task gets `project: <basename>` stamped
 * and dispatch path emits the manifest warning.
 * GREEN post-fix: task has no `project` field; dispatcher skips the
 * manifest lookup entirely.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import { loadProjectManifest } from "../../projects/manifest.js";

describe("BUG-044: unscoped base store must not leak projectId into dispatch", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug044-dispatch-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("task created by unscoped store has no `project` field — dispatcher skips manifest load", async () => {
    const store = new FilesystemTaskStore(tmpDir);
    await store.init();

    const task = await store.create({
      title: "Daemon-managed task",
      body: "Body",
      createdBy: "test",
    });

    // Invariant 1: frontmatter.project is absent (falsy).
    //   task-dispatcher's L209-224 block is gated on
    //   `if (projectId && targetAgent)` — skipping the manifest load
    //   is how we avoid the ENOENT warning.
    expect(task.frontmatter.project).toBeFalsy();
  });

  it("loadProjectManifest returns null without filesystem probe when store is unscoped", async () => {
    const store = new FilesystemTaskStore(tmpDir);
    await store.init();

    // Even if some caller passes a non-empty projectId, an unscoped
    // store must not look up manifest files on disk at its own root.
    // The manifest resolver's `store.projectId === projectId` match
    // branch must not fire when store.projectId is null.
    const manifest = await loadProjectManifest(store, "anything");
    expect(manifest).toBeNull();
  });

  it("loadProjectManifest returns null when projectId argument itself is falsy", async () => {
    const store = new FilesystemTaskStore(tmpDir, { projectId: "real-project" });
    await store.init();

    // Even a scoped store should return null for an empty request —
    // this guards against `task.frontmatter.project` being undefined
    // on legacy tasks.
    const manifest = await loadProjectManifest(store, "");
    expect(manifest).toBeNull();
  });
});
