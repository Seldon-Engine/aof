/**
 * Context Tools Tests
 * 
 * Tests for context-related tool handlers (skill loading, etc.).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextInterfaceRegistry } from "../../context/registry.js";
import { aofContextLoad } from "../context-tools.js";

describe("aofContextLoad", () => {
  let tmpDir: string;
  let skillsDir: string;
  let registry: ContextInterfaceRegistry;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-context-tools-test-"));
    skillsDir = join(tmpDir, "skills");
    await mkdir(skillsDir, { recursive: true });
    registry = new ContextInterfaceRegistry();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createSkill(
    name: string,
    description: string,
    content: string,
    tags: string[] = [],
    estimatedTokens?: number,
  ) {
    const skillDir = join(skillsDir, name);
    await mkdir(skillDir, { recursive: true });

    const manifest = {
      version: "v1",
      name,
      description,
      tags,
      entrypoint: "SKILL.md",
      ...(estimatedTokens !== undefined && { estimatedTokens }),
    };

    await writeFile(join(skillDir, "skill.json"), JSON.stringify(manifest, null, 2), "utf-8");
    await writeFile(join(skillDir, "SKILL.md"), content, "utf-8");

    // Register in registry
    registry.register({
      kind: "skill",
      name,
      description,
      estimatedTokens,
      resolver: `skill:${name}`,
    });
  }

  it("loads a skill and returns envelope with summary", async () => {
    await createSkill(
      "test-skill",
      "A test skill",
      "# Test Skill\n\nThis is the content of the test skill.",
      ["test"],
      500,
    );

    const result = await aofContextLoad({
      skillName: "test-skill",
      registry,
      skillsDir,
    });

    expect(result.summary).toContain("test-skill");
    expect(result.summary).toContain("loaded");
  });

  it("includes skill content in details", async () => {
    const content = "# Security Audit\n\nPerform comprehensive security audits.";
    await createSkill("security-audit", "Security auditing skill", content, ["security"], 1200);

    const result = await aofContextLoad({
      skillName: "security-audit",
      registry,
      skillsDir,
    });

    expect(result.details).toContain("Security Audit");
    expect(result.details).toContain("comprehensive security audits");
  });

  it("includes metadata with token estimate", async () => {
    await createSkill("meta-skill", "Skill with metadata", "Content", [], 750);

    const result = await aofContextLoad({
      skillName: "meta-skill",
      registry,
      skillsDir,
    });

    expect(result.meta?.charCount).toBeGreaterThan(0);
    expect(result.summary).toContain("meta-skill");
  });

  it("throws error when skill does not exist", async () => {
    await expect(
      aofContextLoad({
        skillName: "nonexistent",
        registry,
        skillsDir,
      }),
    ).rejects.toThrow();
  });

  it("throws error when skill not in registry", async () => {
    // Create skill file but don't register
    const skillDir = join(skillsDir, "unregistered");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "skill.json"), JSON.stringify({
      version: "v1",
      name: "unregistered",
      description: "Not in registry",
      tags: [],
      entrypoint: "SKILL.md",
    }), "utf-8");
    await writeFile(join(skillDir, "SKILL.md"), "Content", "utf-8");

    await expect(
      aofContextLoad({
        skillName: "unregistered",
        registry,
        skillsDir,
      }),
    ).rejects.toThrow("not found in registry");
  });

  it("handles skill with no token estimate", async () => {
    await createSkill("no-estimate", "Skill without token estimate", "# Content\n\nSome text.");

    const result = await aofContextLoad({
      skillName: "no-estimate",
      registry,
      skillsDir,
    });

    expect(result.summary).toContain("no-estimate");
    expect(result.details).toContain("Content");
  });

  it("returns ToolResponseEnvelope format", async () => {
    await createSkill("envelope-test", "Testing envelope format", "# Envelope Test");

    const result = await aofContextLoad({
      skillName: "envelope-test",
      registry,
      skillsDir,
    });

    // Verify envelope structure
    expect(result).toHaveProperty("summary");
    expect(typeof result.summary).toBe("string");
    expect(result).toHaveProperty("details");
    expect(result).toHaveProperty("meta");
  });

  it("includes skill description in summary when available", async () => {
    await createSkill("described-skill", "This is a well-described skill", "# Content");

    const result = await aofContextLoad({
      skillName: "described-skill",
      registry,
      skillsDir,
    });

    expect(result.summary).toContain("described-skill");
  });

  it("handles skills with special characters in name", async () => {
    await createSkill("skill-with-dashes", "Dashed skill", "# Dashed Content");

    const result = await aofContextLoad({
      skillName: "skill-with-dashes",
      registry,
      skillsDir,
    });

    expect(result.summary).toContain("skill-with-dashes");
  });

  it("handles large skill content", async () => {
    const largeContent = "# Large Skill\n\n" + "Lorem ipsum ".repeat(1000);
    await createSkill("large-skill", "A large skill", largeContent, [], 5000);

    const result = await aofContextLoad({
      skillName: "large-skill",
      registry,
      skillsDir,
    });

    expect(result.details?.length).toBeGreaterThan(1000);
    expect(result.meta?.charCount).toBeGreaterThan(1000);
  });
});
