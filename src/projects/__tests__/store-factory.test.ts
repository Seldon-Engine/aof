/**
 * Tests for createProjectStore auto-bootstrap behavior.
 *
 * Regression guard for the bug where `aof_dispatch`-style first-use
 * of a project ID left the project half-initialized (only the
 * `tasks/<status>/` subdirs existed; no `artifacts/`, no `views/`,
 * no `project.yaml`). `project-list` then reported those projects
 * as broken ("Missing project.yaml").
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { createProjectStore } from "../store-factory.js";

describe("createProjectStore — auto-bootstrap", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-store-factory-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("bootstraps a never-seen project with full scaffold + manifest", async () => {
    const { projectRoot } = await createProjectStore({
      projectId: "first-use-project",
      vaultRoot: tmpDir,
    });

    // Full scaffold (not just tasks/)
    for (const dir of ["tasks", "artifacts", "state", "views", "cold"]) {
      await expect(access(join(projectRoot, dir))).resolves.toBeUndefined();
    }
    for (const tier of ["bronze", "silver", "gold"]) {
      await expect(access(join(projectRoot, "artifacts", tier))).resolves.toBeUndefined();
    }

    // Manifest exists and is parseable
    const manifestYaml = await readFile(join(projectRoot, "project.yaml"), "utf-8");
    const manifest = parseYaml(manifestYaml) as { id: string; type: string; owner: { team: string; lead: string } };
    expect(manifest.id).toBe("first-use-project");
    expect(manifest.type).toBe("other");
    expect(manifest.owner).toEqual({ team: "system", lead: "system" });
  });

  it("bootstraps `_inbox` with admin defaults (not `other`)", async () => {
    const { projectRoot } = await createProjectStore({ vaultRoot: tmpDir });

    const manifestYaml = await readFile(join(projectRoot, "project.yaml"), "utf-8");
    const manifest = parseYaml(manifestYaml) as { id: string; type: string; title: string };
    expect(manifest.id).toBe("_inbox");
    expect(manifest.type).toBe("admin");
    // Uses the `_inbox` special-case title from buildProjectManifest
    expect(manifest.title).toBe("_Inbox");
  });

  it("is idempotent: calling twice does not clobber the manifest", async () => {
    const first = await createProjectStore({
      projectId: "stable-project",
      vaultRoot: tmpDir,
    });
    const manifestPath = join(first.projectRoot, "project.yaml");
    const before = await readFile(manifestPath, "utf-8");

    // Touch-and-reread cadence: a second factory call must not overwrite.
    await createProjectStore({
      projectId: "stable-project",
      vaultRoot: tmpDir,
    });
    const after = await readFile(manifestPath, "utf-8");

    expect(after).toBe(before);
  });

  it("leaves an existing properly-bootstrapped project untouched", async () => {
    // Pre-create the project the "right" way via createProject
    const { createProject } = await import("../create.js");
    await createProject("preexisting", {
      vaultRoot: tmpDir,
      title: "Hand-crafted title",
      type: "research",
      owner: { team: "platform", lead: "alice" },
    });

    const manifestPath = join(tmpDir, "Projects", "preexisting", "project.yaml");
    const before = await readFile(manifestPath, "utf-8");

    await createProjectStore({
      projectId: "preexisting",
      vaultRoot: tmpDir,
    });

    const after = await readFile(manifestPath, "utf-8");
    expect(after).toBe(before);

    const manifest = parseYaml(after) as { title: string; type: string; owner: { team: string; lead: string } };
    expect(manifest.title).toBe("Hand-crafted title");
    expect(manifest.type).toBe("research");
    expect(manifest.owner).toEqual({ team: "platform", lead: "alice" });
  });
});
