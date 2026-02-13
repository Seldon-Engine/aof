/**
 * Skills Module Tests
 * 
 * Tests skill manifest loading and directory listing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkillManifest, listSkills } from "../skills.js";

describe("Skills Module", () => {
  let tmpDir: string;
  let skillsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-skills-test-"));
    skillsDir = join(tmpDir, "skills");
    await mkdir(skillsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("loadSkillManifest", () => {
    it("loads a valid skill manifest", async () => {
      const skillDir = join(skillsDir, "test-skill");
      await mkdir(skillDir, { recursive: true });
      
      const manifest = {
        version: "v1",
        name: "test-skill",
        description: "A test skill",
        tags: ["test", "example"],
        entrypoint: "SKILL.md",
      };
      
      await writeFile(join(skillDir, "skill.json"), JSON.stringify(manifest, null, 2), "utf-8");
      
      const loaded = await loadSkillManifest(skillDir);
      
      expect(loaded).toEqual(manifest);
    });

    it("loads manifest with references and estimatedTokens", async () => {
      const skillDir = join(skillsDir, "full-skill");
      await mkdir(skillDir, { recursive: true });
      
      const manifest = {
        version: "v1",
        name: "full-skill",
        description: "A skill with all fields",
        tags: ["complete"],
        entrypoint: "SKILL.md",
        references: ["references/doc1.md", "references/doc2.md"],
        estimatedTokens: 1500,
      };
      
      await writeFile(join(skillDir, "skill.json"), JSON.stringify(manifest), "utf-8");
      
      const loaded = await loadSkillManifest(skillDir);
      
      expect(loaded.references).toEqual(["references/doc1.md", "references/doc2.md"]);
      expect(loaded.estimatedTokens).toBe(1500);
    });

    it("throws error when skill.json does not exist", async () => {
      const skillDir = join(skillsDir, "missing-skill");
      await mkdir(skillDir, { recursive: true });
      
      await expect(loadSkillManifest(skillDir)).rejects.toThrow();
    });

    it("throws error when skill.json is invalid JSON", async () => {
      const skillDir = join(skillsDir, "invalid-skill");
      await mkdir(skillDir, { recursive: true });
      
      await writeFile(join(skillDir, "skill.json"), "{ invalid json", "utf-8");
      
      await expect(loadSkillManifest(skillDir)).rejects.toThrow();
    });

    it("validates version is 'v1'", async () => {
      const skillDir = join(skillsDir, "wrong-version");
      await mkdir(skillDir, { recursive: true });
      
      const manifest = {
        version: "v2",
        name: "wrong-version",
        description: "Wrong version",
        tags: [],
        entrypoint: "SKILL.md",
      };
      
      await writeFile(join(skillDir, "skill.json"), JSON.stringify(manifest), "utf-8");
      
      await expect(loadSkillManifest(skillDir)).rejects.toThrow("version");
    });

    it("validates required fields are present", async () => {
      const skillDir = join(skillsDir, "incomplete");
      await mkdir(skillDir, { recursive: true });
      
      const manifest = {
        version: "v1",
        name: "incomplete",
        // missing description, tags, entrypoint
      };
      
      await writeFile(join(skillDir, "skill.json"), JSON.stringify(manifest), "utf-8");
      
      await expect(loadSkillManifest(skillDir)).rejects.toThrow();
    });
  });

  describe("listSkills", () => {
    it("returns empty array when skills directory is empty", async () => {
      const skills = await listSkills(skillsDir);
      expect(skills).toEqual([]);
    });

    it("lists all skills in directory", async () => {
      // Create skill 1
      const skill1Dir = join(skillsDir, "skill-one");
      await mkdir(skill1Dir, { recursive: true });
      await writeFile(join(skill1Dir, "skill.json"), JSON.stringify({
        version: "v1",
        name: "skill-one",
        description: "First skill",
        tags: ["test"],
        entrypoint: "SKILL.md",
      }), "utf-8");
      
      // Create skill 2
      const skill2Dir = join(skillsDir, "skill-two");
      await mkdir(skill2Dir, { recursive: true });
      await writeFile(join(skill2Dir, "skill.json"), JSON.stringify({
        version: "v1",
        name: "skill-two",
        description: "Second skill",
        tags: ["example"],
        entrypoint: "SKILL.md",
      }), "utf-8");
      
      const skills = await listSkills(skillsDir);
      
      expect(skills).toHaveLength(2);
      expect(skills.map(s => s.name).sort()).toEqual(["skill-one", "skill-two"]);
    });

    it("skips directories without skill.json", async () => {
      const skill1Dir = join(skillsDir, "valid-skill");
      await mkdir(skill1Dir, { recursive: true });
      await writeFile(join(skill1Dir, "skill.json"), JSON.stringify({
        version: "v1",
        name: "valid-skill",
        description: "Valid skill",
        tags: [],
        entrypoint: "SKILL.md",
      }), "utf-8");
      
      // Create directory without skill.json
      const invalidDir = join(skillsDir, "not-a-skill");
      await mkdir(invalidDir, { recursive: true });
      await writeFile(join(invalidDir, "README.md"), "Not a skill", "utf-8");
      
      const skills = await listSkills(skillsDir);
      
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe("valid-skill");
    });

    it("skips files in skills directory", async () => {
      const skillDir = join(skillsDir, "valid-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "skill.json"), JSON.stringify({
        version: "v1",
        name: "valid-skill",
        description: "Valid skill",
        tags: [],
        entrypoint: "SKILL.md",
      }), "utf-8");
      
      // Create a file (not directory) in skills dir
      await writeFile(join(skillsDir, "README.md"), "Documentation", "utf-8");
      
      const skills = await listSkills(skillsDir);
      
      expect(skills).toHaveLength(1);
    });

    it("throws error when skills directory does not exist", async () => {
      await expect(listSkills(join(tmpDir, "nonexistent"))).rejects.toThrow();
    });

    it("handles skills with all optional fields", async () => {
      const skillDir = join(skillsDir, "complete-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "skill.json"), JSON.stringify({
        version: "v1",
        name: "complete-skill",
        description: "Complete skill",
        tags: ["full", "complete"],
        entrypoint: "SKILL.md",
        references: ["ref1.md", "ref2.md"],
        estimatedTokens: 2000,
      }), "utf-8");
      
      const skills = await listSkills(skillsDir);
      
      expect(skills).toHaveLength(1);
      expect(skills[0].estimatedTokens).toBe(2000);
      expect(skills[0].references).toEqual(["ref1.md", "ref2.md"]);
    });
  });
});
