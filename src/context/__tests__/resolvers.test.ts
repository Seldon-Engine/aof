/**
 * Context Resolver Tests
 * 
 * Tests pluggable resolver interface for context resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { 
  FilesystemResolver, 
  InlineResolver, 
  ResolverChain,
  type ContextResolver 
} from "../resolvers.js";

describe("Context Resolvers", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-resolvers-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("FilesystemResolver", () => {
    it("has correct type identifier", () => {
      const resolver = new FilesystemResolver(tmpDir);
      expect(resolver.type).toBe("filesystem");
    });

    it("can resolve file paths within base directory", () => {
      const resolver = new FilesystemResolver(tmpDir);
      expect(resolver.canResolve("test.md")).toBe(true);
      expect(resolver.canResolve("dir/file.txt")).toBe(true);
    });

    it("resolves file content from filesystem", async () => {
      const testFile = join(tmpDir, "test.md");
      await writeFile(testFile, "# Test Content\n\nHello world.", "utf-8");

      const resolver = new FilesystemResolver(tmpDir);
      const content = await resolver.resolve("test.md");

      expect(content).toBe("# Test Content\n\nHello world.");
    });

    it("resolves nested file paths", async () => {
      const subDir = join(tmpDir, "nested", "deep");
      await mkdir(subDir, { recursive: true });
      const testFile = join(subDir, "file.txt");
      await writeFile(testFile, "Nested content", "utf-8");

      const resolver = new FilesystemResolver(tmpDir);
      const content = await resolver.resolve("nested/deep/file.txt");

      expect(content).toBe("Nested content");
    });

    it("throws error when file does not exist", async () => {
      const resolver = new FilesystemResolver(tmpDir);
      await expect(resolver.resolve("nonexistent.md")).rejects.toThrow();
    });

    it("throws error when trying to access outside base directory", async () => {
      const resolver = new FilesystemResolver(tmpDir);
      await expect(resolver.resolve("../outside.txt")).rejects.toThrow();
    });
  });

  describe("InlineResolver", () => {
    it("has correct type identifier", () => {
      const resolver = new InlineResolver({});
      expect(resolver.type).toBe("inline");
    });

    it("can resolve refs that exist in content map", () => {
      const contentMap = {
        "doc1": "Document 1 content",
        "doc2": "Document 2 content",
      };
      const resolver = new InlineResolver(contentMap);

      expect(resolver.canResolve("doc1")).toBe(true);
      expect(resolver.canResolve("doc2")).toBe(true);
      expect(resolver.canResolve("doc3")).toBe(false);
    });

    it("resolves content from inline map", async () => {
      const contentMap = {
        "intro": "# Introduction\n\nWelcome to the guide.",
        "outro": "# Conclusion\n\nThank you!",
      };
      const resolver = new InlineResolver(contentMap);

      const intro = await resolver.resolve("intro");
      const outro = await resolver.resolve("outro");

      expect(intro).toBe("# Introduction\n\nWelcome to the guide.");
      expect(outro).toBe("# Conclusion\n\nThank you!");
    });

    it("throws error when ref does not exist", async () => {
      const resolver = new InlineResolver({ "doc1": "content" });
      await expect(resolver.resolve("missing")).rejects.toThrow();
    });

    it("handles empty content map", () => {
      const resolver = new InlineResolver({});
      expect(resolver.canResolve("anything")).toBe(false);
    });
  });

  describe("ResolverChain", () => {
    it("resolves using first matching resolver", async () => {
      const inline = new InlineResolver({ "doc": "Inline content" });
      const fs = new FilesystemResolver(tmpDir);
      
      await writeFile(join(tmpDir, "doc"), "Filesystem content", "utf-8");

      const chain = new ResolverChain([inline, fs]);
      const content = await chain.resolve("doc");

      // Should use inline resolver first
      expect(content).toBe("Inline content");
    });

    it("falls through to next resolver when first cannot resolve", async () => {
      const inline = new InlineResolver({ "inline-only": "Inline content" });
      const testFile = join(tmpDir, "fs-only.md");
      await writeFile(testFile, "Filesystem content", "utf-8");

      const fs = new FilesystemResolver(tmpDir);
      const chain = new ResolverChain([inline, fs]);

      const fsContent = await chain.resolve("fs-only.md");
      expect(fsContent).toBe("Filesystem content");
    });

    it("throws error when no resolver can handle ref", async () => {
      const inline = new InlineResolver({ "doc1": "content" });
      const fs = new FilesystemResolver(tmpDir);
      const chain = new ResolverChain([inline, fs]);

      // Use absolute path - FilesystemResolver won't accept it
      await expect(chain.resolve("/absolute/path")).rejects.toThrow("No resolver could handle");
    });

    it("tries resolvers in order", async () => {
      const resolver1 = new InlineResolver({ "doc": "Resolver 1" });
      const resolver2 = new InlineResolver({ "doc": "Resolver 2" });
      const resolver3 = new InlineResolver({ "doc": "Resolver 3" });

      const chain = new ResolverChain([resolver1, resolver2, resolver3]);
      const content = await chain.resolve("doc");

      expect(content).toBe("Resolver 1");
    });

    it("handles empty resolver list", async () => {
      const chain = new ResolverChain([]);
      await expect(chain.resolve("anything")).rejects.toThrow();
    });

    it("handles single resolver", async () => {
      const inline = new InlineResolver({ "test": "Test content" });
      const chain = new ResolverChain([inline]);

      const content = await chain.resolve("test");
      expect(content).toBe("Test content");
    });
  });

  describe("Custom Resolver", () => {
    it("supports custom resolver implementations", async () => {
      class UpperCaseResolver implements ContextResolver {
        readonly type = "uppercase";
        
        canResolve(ref: string): boolean {
          return ref.startsWith("upper:");
        }
        
        async resolve(ref: string): Promise<string> {
          if (!this.canResolve(ref)) {
            throw new Error(`Cannot resolve: ${ref}`);
          }
          return ref.substring(6).toUpperCase();
        }
      }

      const custom = new UpperCaseResolver();
      const chain = new ResolverChain([custom]);

      const content = await chain.resolve("upper:hello");
      expect(content).toBe("HELLO");
    });
  });

  describe("SkillResolver", () => {
    let skillsDir: string;

    beforeEach(async () => {
      skillsDir = join(tmpDir, "skills");
      await mkdir(skillsDir, { recursive: true });
    });

    async function createSkill(name: string, entryContent: string, entrypoint = "SKILL.md") {
      const skillDir = join(skillsDir, name);
      await mkdir(skillDir, { recursive: true });
      
      const manifest = {
        version: "v1",
        name,
        description: `${name} skill`,
        tags: ["test"],
        entrypoint,
      };
      
      await writeFile(join(skillDir, "skill.json"), JSON.stringify(manifest), "utf-8");
      await writeFile(join(skillDir, entrypoint), entryContent, "utf-8");
    }

    it("has correct type identifier", async () => {
      const { SkillResolver } = await import("../resolvers.js");
      const resolver = new SkillResolver(skillsDir);
      expect(resolver.type).toBe("skill");
    });

    it("can resolve skill: references", async () => {
      const { SkillResolver } = await import("../resolvers.js");
      const resolver = new SkillResolver(skillsDir);
      
      expect(resolver.canResolve("skill:test-skill")).toBe(true);
      expect(resolver.canResolve("skill:another-skill")).toBe(true);
    });

    it("cannot resolve non-skill references", async () => {
      const { SkillResolver } = await import("../resolvers.js");
      const resolver = new SkillResolver(skillsDir);
      
      expect(resolver.canResolve("file.md")).toBe(false);
      expect(resolver.canResolve("inline:content")).toBe(false);
      expect(resolver.canResolve("other:ref")).toBe(false);
    });

    it("resolves skill entrypoint content", async () => {
      await createSkill("security-audit", "# Security Audit Skill\n\nPerform security audits.");
      
      const { SkillResolver } = await import("../resolvers.js");
      const resolver = new SkillResolver(skillsDir);
      
      const content = await resolver.resolve("skill:security-audit");
      expect(content).toContain("Security Audit Skill");
    });

    it("resolves skill with custom entrypoint", async () => {
      await createSkill("custom-entry", "# Custom Entry\n\nCustom content.", "custom.md");
      
      const { SkillResolver } = await import("../resolvers.js");
      const resolver = new SkillResolver(skillsDir);
      
      const content = await resolver.resolve("skill:custom-entry");
      expect(content).toContain("Custom Entry");
    });

    it("throws error when skill does not exist", async () => {
      const { SkillResolver } = await import("../resolvers.js");
      const resolver = new SkillResolver(skillsDir);
      
      await expect(resolver.resolve("skill:nonexistent")).rejects.toThrow();
    });

    it("throws error when skill has no manifest", async () => {
      const skillDir = join(skillsDir, "no-manifest");
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), "Content", "utf-8");
      
      const { SkillResolver } = await import("../resolvers.js");
      const resolver = new SkillResolver(skillsDir);
      
      await expect(resolver.resolve("skill:no-manifest")).rejects.toThrow();
    });

    it("throws error when entrypoint file does not exist", async () => {
      const skillDir = join(skillsDir, "missing-entry");
      await mkdir(skillDir, { recursive: true });
      
      const manifest = {
        version: "v1",
        name: "missing-entry",
        description: "Missing entrypoint",
        tags: [],
        entrypoint: "SKILL.md",
      };
      
      await writeFile(join(skillDir, "skill.json"), JSON.stringify(manifest), "utf-8");
      
      const { SkillResolver } = await import("../resolvers.js");
      const resolver = new SkillResolver(skillsDir);
      
      await expect(resolver.resolve("skill:missing-entry")).rejects.toThrow();
    });

    it("works with ResolverChain", async () => {
      await createSkill("chain-test", "# Chain Test\n\nResolved via chain.");
      
      const { SkillResolver } = await import("../resolvers.js");
      const inline = new InlineResolver({ "inline:doc": "Inline content" });
      const skill = new SkillResolver(skillsDir);
      const chain = new ResolverChain([inline, skill]);
      
      const inlineContent = await chain.resolve("inline:doc");
      expect(inlineContent).toBe("Inline content");
      
      const skillContent = await chain.resolve("skill:chain-test");
      expect(skillContent).toContain("Chain Test");
    });

    it("throws error for malformed skill reference", async () => {
      const { SkillResolver } = await import("../resolvers.js");
      const resolver = new SkillResolver(skillsDir);
      
      await expect(resolver.resolve("skill:")).rejects.toThrow();
    });
  });
});
