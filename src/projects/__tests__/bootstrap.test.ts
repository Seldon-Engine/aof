import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrapProject } from "../bootstrap.js";

describe("bootstrapProject", () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = join(
      tmpdir(),
      `aof-bootstrap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("creates all required top-level directories", async () => {
    const projectRoot = join(testRoot, "test-project");

    await bootstrapProject(projectRoot);

    const expectedDirs = ["tasks", "artifacts", "state", "views", "cold"];
    for (const dir of expectedDirs) {
      const dirPath = join(projectRoot, dir);
      const dirStat = await stat(dirPath);
      expect(dirStat.isDirectory()).toBe(true);
    }
  });

  it("creates artifact medallion tier subdirectories", async () => {
    const projectRoot = join(testRoot, "test-project");

    await bootstrapProject(projectRoot);

    const tiers = ["bronze", "silver", "gold"];
    for (const tier of tiers) {
      const tierPath = join(projectRoot, "artifacts", tier);
      const tierStat = await stat(tierPath);
      expect(tierStat.isDirectory()).toBe(true);
    }
  });

  it("is idempotent - does not fail if directories already exist", async () => {
    const projectRoot = join(testRoot, "test-project");

    // Create once
    await bootstrapProject(projectRoot);

    // Create again - should not throw
    await expect(bootstrapProject(projectRoot)).resolves.toBeUndefined();

    // Verify structure still exists
    const tasksStat = await stat(join(projectRoot, "tasks"));
    expect(tasksStat.isDirectory()).toBe(true);
  });

  it("creates nested structure in one call", async () => {
    const projectRoot = join(testRoot, "deeply", "nested", "project");

    await bootstrapProject(projectRoot);

    const stateStat = await stat(join(projectRoot, "state"));
    expect(stateStat.isDirectory()).toBe(true);
  });

  it("creates complete structure from scratch", async () => {
    const projectRoot = join(testRoot, "new-project");

    await bootstrapProject(projectRoot);

    // Verify complete tree
    const allDirs = await readdir(projectRoot);
    expect(allDirs).toContain("tasks");
    expect(allDirs).toContain("artifacts");
    expect(allDirs).toContain("state");
    expect(allDirs).toContain("views");
    expect(allDirs).toContain("cold");

    const artifactDirs = await readdir(join(projectRoot, "artifacts"));
    expect(artifactDirs).toContain("bronze");
    expect(artifactDirs).toContain("silver");
    expect(artifactDirs).toContain("gold");
  });
});
