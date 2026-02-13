import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverProjects } from "../registry.js";
import { stringify as stringifyYaml } from "yaml";

describe("discoverProjects", () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = join(tmpdir(), `aof-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("discovers valid projects with manifests", async () => {
    await createProject(testRoot, "project-a", {
      id: "project-a",
      title: "Project A",
      type: "swe",
      owner: { team: "swe", lead: "lead" },
    });

    await createProject(testRoot, "project-b", {
      id: "project-b",
      title: "Project B",
      type: "ops",
      owner: { team: "ops", lead: "lead" },
    });

    const records = await discoverProjects(testRoot);

    expect(records.length).toBeGreaterThanOrEqual(2);
    const projectA = records.find((r) => r.id === "project-a");
    const projectB = records.find((r) => r.id === "project-b");

    expect(projectA).toBeDefined();
    expect(projectA?.manifest?.title).toBe("Project A");
    expect(projectA?.error).toBeUndefined();

    expect(projectB).toBeDefined();
    expect(projectB?.manifest?.title).toBe("Project B");
  });

  it("always includes _inbox even if missing", async () => {
    await createProject(testRoot, "project-a", {
      id: "project-a",
      title: "Project A",
      type: "swe",
      owner: { team: "swe", lead: "lead" },
    });

    const records = await discoverProjects(testRoot);

    const inbox = records.find((r) => r.id === "_inbox");
    expect(inbox).toBeDefined();
    expect(inbox?.manifest?.title).toBe("Inbox");
    expect(inbox?.manifest?.status).toBe("active");
    expect(inbox?.error).toBeUndefined();
  });

  it("includes _inbox when it exists on disk", async () => {
    await createProject(testRoot, "_inbox", {
      id: "_inbox",
      title: "Custom Inbox",
      type: "admin",
      owner: { team: "ops", lead: "system" },
    });

    const records = await discoverProjects(testRoot);

    const inboxRecords = records.filter((r) => r.id === "_inbox");
    expect(inboxRecords.length).toBe(1);
    expect(inboxRecords[0].manifest?.title).toBe("Custom Inbox");
  });

  it("skips archived projects by default", async () => {
    await createProject(testRoot, "active-project", {
      id: "active-project",
      title: "Active",
      type: "swe",
      status: "active",
      owner: { team: "swe", lead: "lead" },
    });

    await createProject(testRoot, "archived-project", {
      id: "archived-project",
      title: "Archived",
      type: "swe",
      status: "archived",
      owner: { team: "swe", lead: "lead" },
    });

    const records = await discoverProjects(testRoot);

    expect(records.some((r) => r.id === "active-project")).toBe(true);
    expect(records.some((r) => r.id === "archived-project")).toBe(false);
  });

  it("includes archived projects when requested", async () => {
    await createProject(testRoot, "archived-project", {
      id: "archived-project",
      title: "Archived",
      type: "swe",
      status: "archived",
      owner: { team: "swe", lead: "lead" },
    });

    const records = await discoverProjects(testRoot, { includeArchived: true });

    expect(records.some((r) => r.id === "archived-project")).toBe(true);
  });

  it("returns error entry for missing project.yaml", async () => {
    const projectsDir = join(testRoot, "Projects");
    await mkdir(join(projectsDir, "no-manifest"), { recursive: true });

    const records = await discoverProjects(testRoot);

    const noManifest = records.find((r) => r.id === "no-manifest");
    expect(noManifest).toBeDefined();
    expect(noManifest?.error).toContain("Missing project.yaml");
    expect(noManifest?.manifest).toBeUndefined();
  });

  it("returns error entry for invalid YAML", async () => {
    const projectsDir = join(testRoot, "Projects");
    const projectDir = join(projectsDir, "bad-yaml");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "project.yaml"), "{ bad: yaml: syntax");

    const records = await discoverProjects(testRoot);

    const badYaml = records.find((r) => r.id === "bad-yaml");
    expect(badYaml).toBeDefined();
    expect(badYaml?.error).toBeDefined();
    expect(badYaml?.manifest).toBeUndefined();
  });

  it("returns error entry when ID does not match directory name", async () => {
    await createProject(testRoot, "wrong-dir-name", {
      id: "correct-id",
      title: "Mismatched",
      type: "swe",
      owner: { team: "swe", lead: "lead" },
    });

    const records = await discoverProjects(testRoot);

    const mismatched = records.find((r) => r.id === "wrong-dir-name");
    expect(mismatched).toBeDefined();
    expect(mismatched?.error).toContain("does not match directory name");
    expect(mismatched?.manifest).toBeUndefined();
  });

  it("returns error entry for invalid manifest schema", async () => {
    await createProject(testRoot, "invalid-schema", {
      id: "invalid-schema",
      title: "Invalid",
      type: "swe",
      // missing required owner field
    });

    const records = await discoverProjects(testRoot);

    const invalid = records.find((r) => r.id === "invalid-schema");
    expect(invalid).toBeDefined();
    expect(invalid?.error).toContain("Validation failed");
    expect(invalid?.manifest).toBeUndefined();
  });

  it("returns empty array when Projects directory does not exist", async () => {
    const emptyRoot = join(tmpdir(), `aof-empty-${Date.now()}`);
    await mkdir(emptyRoot, { recursive: true });

    const records = await discoverProjects(emptyRoot);

    // Should still include _inbox placeholder
    expect(records.length).toBe(1);
    expect(records[0].id).toBe("_inbox");

    await rm(emptyRoot, { recursive: true, force: true });
  });
});

/** Helper: create a project directory with manifest. */
async function createProject(
  testRoot: string,
  projectId: string,
  manifest: Record<string, unknown>
): Promise<void> {
  const projectsDir = join(testRoot, "Projects");
  const projectDir = join(projectsDir, projectId);
  await mkdir(projectDir, { recursive: true });
  const yaml = stringifyYaml(manifest);
  await writeFile(join(projectDir, "project.yaml"), yaml, "utf-8");
}
