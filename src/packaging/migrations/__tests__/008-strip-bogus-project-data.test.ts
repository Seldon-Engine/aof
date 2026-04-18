/**
 * Migration 008 tests — BUG-044
 *
 * Invariants:
 *   1. Identity: id/version/description match the expected shape.
 *   2. Strip: tasks with `project: data` (the pre-v1.15.1 bogus value)
 *      have the key removed; other frontmatter survives byte-for-byte
 *      where possible.
 *   3. Preserve: tasks with legitimate project IDs are UNTOUCHED.
 *   4. Preserve: tasks with no `project:` field at all are UNTOUCHED.
 *   5. Idempotent: re-running on already-clean data is a no-op (no
 *      disk writes, no errors).
 *   6. Robust: malformed files and non-.md files are skipped silently.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migration008 } from "../008-strip-bogus-project-data.js";
import type { MigrationContext } from "../../migrations.js";

/** Minimal valid-ish task frontmatter. Values are shaped to survive YAML roundtrip; schema parse is NOT exercised here — the migration only rewrites files whose frontmatter matches `project: data` exactly. */
function taskWithProject(id: string, project: string | null): string {
  const projectLine = project === null ? "" : `project: ${project}\n`;
  return `---
schemaVersion: 1
id: ${id}
${projectLine}title: Dummy task
status: done
priority: normal
createdAt: "2026-04-18T00:00:00.000Z"
updatedAt: "2026-04-18T00:00:00.000Z"
lastTransitionAt: "2026-04-18T00:00:00.000Z"
createdBy: test
---

Body content
`;
}

async function readFrontmatter(path: string): Promise<string> {
  const raw = await readFile(path, "utf-8");
  const end = raw.indexOf("\n---", 3);
  return raw.slice(4, end);
}

describe("Migration 008: strip-bogus-project-data (BUG-044)", () => {
  let tmpDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-mig008-"));
    tasksDir = join(tmpDir, "tasks");
    for (const status of ["backlog", "ready", "in-progress", "blocked", "review", "done", "cancelled", "deadletter"]) {
      await mkdir(join(tasksDir, status), { recursive: true });
    }
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("identity: has id '008-strip-bogus-project-data' and version 1.15.1", () => {
    expect(migration008.id).toBe("008-strip-bogus-project-data");
    expect(migration008.version).toBe("1.15.1");
    expect(typeof migration008.description).toBe("string");
    expect(migration008.description.length).toBeGreaterThan(0);
  });

  it("strips `project: data` from a tainted task in done/", async () => {
    const taskPath = join(tasksDir, "done", "TASK-2026-04-18-001.md");
    await writeFile(taskPath, taskWithProject("TASK-2026-04-18-001", "data"));

    const ctx: MigrationContext = { aofRoot: tmpDir, version: "1.15.1" };
    await migration008.up(ctx);

    const fm = await readFrontmatter(taskPath);
    expect(fm).not.toMatch(/^project:/m);
    // The rest of the frontmatter should survive.
    expect(fm).toMatch(/id: TASK-2026-04-18-001/);
    expect(fm).toMatch(/status: done/);
  });

  it("scans ALL 8 status directories", async () => {
    const taintedStatuses = ["backlog", "ready", "in-progress", "blocked", "review", "done", "cancelled", "deadletter"];
    for (const status of taintedStatuses) {
      const taskPath = join(tasksDir, status, `TASK-2026-04-18-${status}.md`);
      await writeFile(taskPath, taskWithProject(`TASK-2026-04-18-001`, "data"));
    }

    const ctx: MigrationContext = { aofRoot: tmpDir, version: "1.15.1" };
    await migration008.up(ctx);

    for (const status of taintedStatuses) {
      const taskPath = join(tasksDir, status, `TASK-2026-04-18-${status}.md`);
      const fm = await readFrontmatter(taskPath);
      expect(fm, `status ${status} should have project: stripped`).not.toMatch(/^project:/m);
    }
  });

  it("does NOT touch tasks with legitimate project IDs", async () => {
    const taskPath = join(tasksDir, "ready", "TASK-2026-04-18-003.md");
    const original = taskWithProject("TASK-2026-04-18-003", "my-real-project");
    await writeFile(taskPath, original);
    const originalMtime = (await stat(taskPath)).mtimeMs;

    const ctx: MigrationContext = { aofRoot: tmpDir, version: "1.15.1" };
    // Brief sleep to ensure mtime would change if a write happened.
    await new Promise(r => setTimeout(r, 5));
    await migration008.up(ctx);

    const after = await readFile(taskPath, "utf-8");
    expect(after).toBe(original);
    // mtime must not have changed — confirms no write happened.
    expect((await stat(taskPath)).mtimeMs).toBe(originalMtime);
  });

  it("does NOT touch tasks that already have no `project:` field", async () => {
    const taskPath = join(tasksDir, "backlog", "TASK-2026-04-18-004.md");
    const original = taskWithProject("TASK-2026-04-18-004", null);
    await writeFile(taskPath, original);
    const originalMtime = (await stat(taskPath)).mtimeMs;

    const ctx: MigrationContext = { aofRoot: tmpDir, version: "1.15.1" };
    await new Promise(r => setTimeout(r, 5));
    await migration008.up(ctx);

    const after = await readFile(taskPath, "utf-8");
    expect(after).toBe(original);
    expect((await stat(taskPath)).mtimeMs).toBe(originalMtime);
  });

  it("is idempotent: second run on already-clean data is a no-op", async () => {
    const taskPath = join(tasksDir, "done", "TASK-2026-04-18-005.md");
    await writeFile(taskPath, taskWithProject("TASK-2026-04-18-005", "data"));

    const ctx: MigrationContext = { aofRoot: tmpDir, version: "1.15.1" };
    await migration008.up(ctx);
    const firstRunMtime = (await stat(taskPath)).mtimeMs;

    await new Promise(r => setTimeout(r, 5));
    await migration008.up(ctx);

    const secondRunMtime = (await stat(taskPath)).mtimeMs;
    expect(secondRunMtime).toBe(firstRunMtime);

    const fm = await readFrontmatter(taskPath);
    expect(fm).not.toMatch(/^project:/m);
  });

  it("skips non-.md entries silently", async () => {
    await writeFile(join(tasksDir, "done", "not-a-task.txt"), "garbage");
    await writeFile(join(tasksDir, "done", "README"), "readme");
    const ctx: MigrationContext = { aofRoot: tmpDir, version: "1.15.1" };

    // Should not throw.
    await expect(migration008.up(ctx)).resolves.toBeUndefined();
  });

  it("tolerates missing status directories (fresh install)", async () => {
    // Remove some status dirs — migration must still succeed.
    await rm(join(tasksDir, "deadletter"), { recursive: true });
    await rm(join(tasksDir, "cancelled"), { recursive: true });

    const ctx: MigrationContext = { aofRoot: tmpDir, version: "1.15.1" };
    await expect(migration008.up(ctx)).resolves.toBeUndefined();
  });

  it("tolerates a completely missing tasks/ tree", async () => {
    await rm(tasksDir, { recursive: true });

    const ctx: MigrationContext = { aofRoot: tmpDir, version: "1.15.1" };
    await expect(migration008.up(ctx)).resolves.toBeUndefined();
  });

  it("skips malformed frontmatter without erroring", async () => {
    const taskPath = join(tasksDir, "done", "TASK-2026-04-18-666.md");
    await writeFile(taskPath, "no frontmatter here, just garbage\n");

    const ctx: MigrationContext = { aofRoot: tmpDir, version: "1.15.1" };
    await expect(migration008.up(ctx)).resolves.toBeUndefined();

    // File left untouched.
    expect(await readFile(taskPath, "utf-8")).toBe("no frontmatter here, just garbage\n");
  });
});
