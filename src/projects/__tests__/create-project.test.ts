/**
 * Tests for create-project functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { createProject, validateProjectId } from "../create.js";
import { discoverProjects } from "../registry.js";

describe("create-project", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-create-project-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("validateProjectId", () => {
    it("accepts valid alphanumeric IDs", () => {
      expect(() => validateProjectId("alpha")).not.toThrow();
      expect(() => validateProjectId("project123")).not.toThrow();
      expect(() => validateProjectId("my-project")).not.toThrow();
      expect(() => validateProjectId("my_project")).not.toThrow();
      expect(() => validateProjectId("test-project-123")).not.toThrow();
    });

    it("rejects IDs with spaces", () => {
      expect(() => validateProjectId("my project")).toThrow("invalid");
      expect(() => validateProjectId(" alpha")).toThrow("empty");
      expect(() => validateProjectId("alpha ")).toThrow("empty");
    });

    it("rejects IDs with special characters", () => {
      expect(() => validateProjectId("my@project")).toThrow("invalid");
      expect(() => validateProjectId("project!")).toThrow("invalid");
      expect(() => validateProjectId("test.project")).toThrow("invalid");
      expect(() => validateProjectId("foo/bar")).toThrow("invalid");
    });

    it("rejects reserved IDs", () => {
      expect(() => validateProjectId("_inbox")).toThrow("reserved");
      expect(() => validateProjectId("_system")).toThrow("reserved");
      expect(() => validateProjectId(".")).toThrow("reserved");
      expect(() => validateProjectId("..")).toThrow("reserved");
    });

    it("rejects empty or whitespace IDs", () => {
      expect(() => validateProjectId("")).toThrow("empty");
      expect(() => validateProjectId("   ")).toThrow("empty");
    });
  });

  describe("createProject", () => {
    it("creates project with valid ID", async () => {
      const result = await createProject("alpha", {
        vaultRoot: tmpDir,
        title: "Alpha Project",
        type: "swe",
        owner: { team: "engineering", lead: "alice" },
      });

      expect(result.projectId).toBe("alpha");
      expect(result.projectRoot).toBe(join(tmpDir, "Projects", "alpha"));
      expect(result.manifest.title).toBe("Alpha Project");
      expect(result.manifest.type).toBe("swe");
      expect(result.manifest.owner).toEqual({ team: "engineering", lead: "alice" });

      // Verify directories exist
      const projectRoot = result.projectRoot;
      await expect(access(join(projectRoot, "tasks"))).resolves.toBeUndefined();
      await expect(access(join(projectRoot, "artifacts"))).resolves.toBeUndefined();
      await expect(access(join(projectRoot, "state"))).resolves.toBeUndefined();
      await expect(access(join(projectRoot, "views"))).resolves.toBeUndefined();
      await expect(access(join(projectRoot, "cold"))).resolves.toBeUndefined();

      // Verify artifact tiers
      await expect(access(join(projectRoot, "artifacts", "bronze"))).resolves.toBeUndefined();
      await expect(access(join(projectRoot, "artifacts", "silver"))).resolves.toBeUndefined();
      await expect(access(join(projectRoot, "artifacts", "gold"))).resolves.toBeUndefined();

      // Verify manifest file
      const manifestPath = join(projectRoot, "project.yaml");
      await expect(access(manifestPath)).resolves.toBeUndefined();

      // Parse and validate manifest
      const manifestYaml = await readFile(manifestPath, "utf-8");
      const manifest = parseYaml(manifestYaml);
      expect(manifest.id).toBe("alpha");
      expect(manifest.title).toBe("Alpha Project");
      expect(manifest.type).toBe("swe");
    });

    it("uses ID as title when title not provided", async () => {
      const result = await createProject("beta", {
        vaultRoot: tmpDir,
        type: "ops",
        owner: { team: "ops", lead: "bob" },
      });

      expect(result.manifest.title).toBe("beta");
    });

    it("uses default type and owner when not provided", async () => {
      const result = await createProject("gamma", {
        vaultRoot: tmpDir,
      });

      expect(result.manifest.type).toBe("other");
      expect(result.manifest.owner).toEqual({ team: "system", lead: "system" });
    });

    it("fails when project already exists", async () => {
      // Create first time
      await createProject("delta", { vaultRoot: tmpDir });

      // Try to create again
      await expect(
        createProject("delta", { vaultRoot: tmpDir })
      ).rejects.toThrow("already exists");
    });

    it("fails with invalid project ID", async () => {
      await expect(
        createProject("invalid project", { vaultRoot: tmpDir })
      ).rejects.toThrow("invalid");

      await expect(
        createProject("project@123", { vaultRoot: tmpDir })
      ).rejects.toThrow("invalid");

      await expect(
        createProject("_inbox", { vaultRoot: tmpDir })
      ).rejects.toThrow("reserved");
    });

    it("creates project discoverable by discoverProjects", async () => {
      // Create _inbox first (required by discovery)
      await mkdir(join(tmpDir, "Projects", "_inbox"), { recursive: true });

      // Create test project
      await createProject("epsilon", {
        vaultRoot: tmpDir,
        title: "Epsilon Project",
        type: "research",
        owner: { team: "research", lead: "eve" },
      });

      // Discover projects
      const projects = await discoverProjects(tmpDir);
      
      const epsilon = projects.find(p => p.id === "epsilon");
      expect(epsilon).toBeDefined();
      expect(epsilon?.manifest).toBeDefined();
      expect(epsilon?.manifest?.title).toBe("Epsilon Project");
      expect(epsilon?.manifest?.type).toBe("research");
      expect(epsilon?.manifest?.owner).toEqual({ team: "research", lead: "eve" });
    });

    it("accepts --title flag", async () => {
      const result = await createProject("zeta", {
        vaultRoot: tmpDir,
        title: "Custom Title",
        type: "admin",
        owner: { team: "admin", lead: "zack" },
      });

      expect(result.manifest.title).toBe("Custom Title");
      expect(result.manifest.id).toBe("zeta");
    });

    it("creates project with parentId", async () => {
      const result = await createProject("child-project", {
        vaultRoot: tmpDir,
        title: "Child Project",
        type: "swe",
        owner: { team: "swe", lead: "alice" },
        parentId: "parent-project",
      });

      expect(result.manifest.parentId).toBe("parent-project");

      // Verify manifest file contains parentId
      const manifestPath = join(result.projectRoot, "project.yaml");
      const manifestYaml = await readFile(manifestPath, "utf-8");
      const manifest = parseYaml(manifestYaml);
      expect(manifest.parentId).toBe("parent-project");
    });

    it("creates project without parentId when not provided", async () => {
      const result = await createProject("standalone", {
        vaultRoot: tmpDir,
        title: "Standalone Project",
        type: "swe",
        owner: { team: "swe", lead: "bob" },
      });

      expect(result.manifest.parentId).toBeUndefined();

      // Verify manifest file does not contain parentId
      const manifestPath = join(result.projectRoot, "project.yaml");
      const manifestYaml = await readFile(manifestPath, "utf-8");
      const manifest = parseYaml(manifestYaml);
      expect(manifest.parentId).toBeUndefined();
    });

    it("exposes parent/child relationships in discoverProjects", async () => {
      // Create _inbox first
      await mkdir(join(tmpDir, "Projects", "_inbox"), { recursive: true });

      // Create parent project
      await createProject("parent-proj", {
        vaultRoot: tmpDir,
        title: "Parent Project",
        type: "swe",
        owner: { team: "swe", lead: "alice" },
      });

      // Create child projects
      await createProject("child-1", {
        vaultRoot: tmpDir,
        title: "Child 1",
        type: "swe",
        owner: { team: "swe", lead: "bob" },
        parentId: "parent-proj",
      });

      await createProject("child-2", {
        vaultRoot: tmpDir,
        title: "Child 2",
        type: "swe",
        owner: { team: "swe", lead: "charlie" },
        parentId: "parent-proj",
      });

      // Discover projects
      const projects = await discoverProjects(tmpDir);

      const parent = projects.find((p) => p.id === "parent-proj");
      const child1 = projects.find((p) => p.id === "child-1");
      const child2 = projects.find((p) => p.id === "child-2");

      // Check parent has children
      expect(parent?.children).toBeDefined();
      expect(parent?.children).toContain("child-1");
      expect(parent?.children).toContain("child-2");
      expect(parent?.children?.length).toBe(2);

      // Check children have parentId
      expect(child1?.parentId).toBe("parent-proj");
      expect(child2?.parentId).toBe("parent-proj");
    });
  });
});
