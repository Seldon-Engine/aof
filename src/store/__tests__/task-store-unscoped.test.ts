/**
 * BUG-044 regression: unscoped FilesystemTaskStore must not stamp a
 * bogus `project:` field into task frontmatter.
 *
 * Before the fix, `new FilesystemTaskStore("/tmp/whatever")` defaulted
 * `this.projectId = basename(projectRoot)` ("whatever"), then stamped
 * that as `project: whatever` into every task it created. The daemon's
 * base store constructed at `~/.aof/data/` therefore turned every
 * scheduled task into `project: "data"`, triggering ENOENT manifest
 * loads downstream (see bug-044-projectId-leak regression test).
 *
 * Invariants asserted here:
 *   1. An unscoped store reports `projectId === null`.
 *   2. A task created by an unscoped store has NO `project` field
 *      in its frontmatter (Zod `optional()` means "key absent").
 *   3. A scoped store (explicit projectId) continues to stamp as before.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../task-store.js";

describe("BUG-044: FilesystemTaskStore unscoped construction (no basename fallback)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug044-store-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reports projectId=null when no projectId is passed", () => {
    const store = new FilesystemTaskStore(tmpDir);
    expect(store.projectId).toBeNull();
  });

  it("does NOT stamp basename(projectRoot) as projectId", async () => {
    // Old behavior: basename("/tmp/.../data") === "data" would leak.
    const store = new FilesystemTaskStore(tmpDir);
    // basename of the tmp dir is some `bug044-store-XXXXX` string;
    // a correct unscoped store must NOT use that.
    expect(store.projectId).not.toBe(tmpDir.split("/").pop());
  });

  it("creates tasks WITHOUT a `project` frontmatter field when unscoped", async () => {
    const store = new FilesystemTaskStore(tmpDir);
    await store.init();

    const task = await store.create({
      title: "Unscoped task",
      body: "Body",
      createdBy: "test",
    });

    // In-memory: the frontmatter must either lack the key or have it
    // as undefined. A value of "data", the tmpdir basename, or anything
    // else stamped by the store is a bug.
    expect(task.frontmatter.project).toBeUndefined();

    // On disk: the serialized YAML frontmatter must not contain a
    // `project:` line. We read the file raw to catch any sneaky
    // `project: ""` or `project: null` serialization.
    const raw = await readFile(task.path!, "utf-8");
    const frontmatterEnd = raw.indexOf("\n---", 3);
    const frontmatterBlock = raw.slice(4, frontmatterEnd);
    expect(frontmatterBlock).not.toMatch(/^project:/m);
  });

  it("STILL stamps the explicit projectId when constructed scoped", async () => {
    const store = new FilesystemTaskStore(tmpDir, { projectId: "my-project" });
    await store.init();

    expect(store.projectId).toBe("my-project");

    const task = await store.create({
      title: "Scoped task",
      body: "Body",
      createdBy: "test",
    });

    expect(task.frontmatter.project).toBe("my-project");
  });
});
