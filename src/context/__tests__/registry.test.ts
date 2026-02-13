/**
 * Context Interface Registry Tests
 * 
 * Tests registry for cataloging available context interfaces (tools, MCP servers, skills).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ContextInterfaceRegistry, type ContextInterface } from "../registry.js";

describe("ContextInterfaceRegistry", () => {
  let registry: ContextInterfaceRegistry;

  beforeEach(() => {
    registry = new ContextInterfaceRegistry();
  });

  describe("register", () => {
    it("registers a new context interface", () => {
      const iface: ContextInterface = {
        kind: "tool",
        name: "test-tool",
        description: "A test tool",
      };
      
      registry.register(iface);
      
      const retrieved = registry.get("test-tool");
      expect(retrieved).toEqual(iface);
    });

    it("registers interfaces of different kinds", () => {
      const tool: ContextInterface = {
        kind: "tool",
        name: "my-tool",
        description: "A tool",
      };
      
      const mcp: ContextInterface = {
        kind: "mcp",
        name: "my-server",
        description: "An MCP server",
      };
      
      const skill: ContextInterface = {
        kind: "skill",
        name: "my-skill",
        description: "A skill",
      };
      
      registry.register(tool);
      registry.register(mcp);
      registry.register(skill);
      
      expect(registry.get("my-tool")?.kind).toBe("tool");
      expect(registry.get("my-server")?.kind).toBe("mcp");
      expect(registry.get("my-skill")?.kind).toBe("skill");
    });

    it("registers interface with optional fields", () => {
      const iface: ContextInterface = {
        kind: "skill",
        name: "complete-skill",
        description: "A complete skill",
        estimatedTokens: 1500,
        resolver: "skill:complete-skill",
      };
      
      registry.register(iface);
      
      const retrieved = registry.get("complete-skill");
      expect(retrieved?.estimatedTokens).toBe(1500);
      expect(retrieved?.resolver).toBe("skill:complete-skill");
    });

    it("overwrites existing interface with same name", () => {
      const original: ContextInterface = {
        kind: "tool",
        name: "my-tool",
        description: "Original description",
      };
      
      const updated: ContextInterface = {
        kind: "tool",
        name: "my-tool",
        description: "Updated description",
      };
      
      registry.register(original);
      registry.register(updated);
      
      const retrieved = registry.get("my-tool");
      expect(retrieved?.description).toBe("Updated description");
    });
  });

  describe("unregister", () => {
    it("removes a registered interface", () => {
      const iface: ContextInterface = {
        kind: "tool",
        name: "temp-tool",
        description: "Temporary tool",
      };
      
      registry.register(iface);
      expect(registry.get("temp-tool")).toBeDefined();
      
      registry.unregister("temp-tool");
      expect(registry.get("temp-tool")).toBeUndefined();
    });

    it("does not throw when unregistering non-existent interface", () => {
      expect(() => registry.unregister("nonexistent")).not.toThrow();
    });
  });

  describe("get", () => {
    it("returns undefined for non-existent interface", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    it("retrieves registered interface by name", () => {
      const iface: ContextInterface = {
        kind: "mcp",
        name: "test-server",
        description: "Test MCP server",
      };
      
      registry.register(iface);
      
      const retrieved = registry.get("test-server");
      expect(retrieved).toEqual(iface);
    });
  });

  describe("list", () => {
    it("returns empty array when no interfaces registered", () => {
      expect(registry.list()).toEqual([]);
    });

    it("lists all registered interfaces", () => {
      const tool: ContextInterface = {
        kind: "tool",
        name: "tool1",
        description: "Tool 1",
      };
      
      const mcp: ContextInterface = {
        kind: "mcp",
        name: "server1",
        description: "Server 1",
      };
      
      const skill: ContextInterface = {
        kind: "skill",
        name: "skill1",
        description: "Skill 1",
      };
      
      registry.register(tool);
      registry.register(mcp);
      registry.register(skill);
      
      const all = registry.list();
      expect(all).toHaveLength(3);
      expect(all.map(i => i.name).sort()).toEqual(["server1", "skill1", "tool1"]);
    });

    it("filters by kind when specified", () => {
      const tool1: ContextInterface = {
        kind: "tool",
        name: "tool1",
        description: "Tool 1",
      };
      
      const tool2: ContextInterface = {
        kind: "tool",
        name: "tool2",
        description: "Tool 2",
      };
      
      const mcp: ContextInterface = {
        kind: "mcp",
        name: "server1",
        description: "Server 1",
      };
      
      const skill: ContextInterface = {
        kind: "skill",
        name: "skill1",
        description: "Skill 1",
      };
      
      registry.register(tool1);
      registry.register(tool2);
      registry.register(mcp);
      registry.register(skill);
      
      const tools = registry.list("tool");
      expect(tools).toHaveLength(2);
      expect(tools.every(i => i.kind === "tool")).toBe(true);
      
      const mcps = registry.list("mcp");
      expect(mcps).toHaveLength(1);
      expect(mcps[0].name).toBe("server1");
      
      const skills = registry.list("skill");
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe("skill1");
    });

    it("returns empty array when filtering by kind with no matches", () => {
      const tool: ContextInterface = {
        kind: "tool",
        name: "tool1",
        description: "Tool 1",
      };
      
      registry.register(tool);
      
      expect(registry.list("mcp")).toEqual([]);
      expect(registry.list("skill")).toEqual([]);
    });
  });

  describe("findByTag", () => {
    it("returns empty array when no interfaces match tag", () => {
      const iface: ContextInterface = {
        kind: "tool",
        name: "tool1",
        description: "A tool with tags",
      };
      
      registry.register(iface);
      
      expect(registry.findByTag("security")).toEqual([]);
    });

    it("finds interfaces by tag in name", () => {
      const iface: ContextInterface = {
        kind: "skill",
        name: "security-auditor",
        description: "Security audit skill",
      };
      
      registry.register(iface);
      
      const results = registry.findByTag("security");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("security-auditor");
    });

    it("finds interfaces by tag in description", () => {
      const iface: ContextInterface = {
        kind: "tool",
        name: "audit-tool",
        description: "Performs security audits on code",
      };
      
      registry.register(iface);
      
      const results = registry.findByTag("security");
      expect(results).toHaveLength(1);
    });

    it("performs case-insensitive search", () => {
      const iface: ContextInterface = {
        kind: "skill",
        name: "Security-Tool",
        description: "SECURITY checking",
      };
      
      registry.register(iface);
      
      expect(registry.findByTag("security")).toHaveLength(1);
      expect(registry.findByTag("SECURITY")).toHaveLength(1);
      expect(registry.findByTag("SeCuRiTy")).toHaveLength(1);
    });

    it("finds multiple matching interfaces", () => {
      const skill1: ContextInterface = {
        kind: "skill",
        name: "test-writer",
        description: "Writes test cases",
      };
      
      const skill2: ContextInterface = {
        kind: "skill",
        name: "test-runner",
        description: "Runs test suites",
      };
      
      const tool: ContextInterface = {
        kind: "tool",
        name: "other-tool",
        description: "Does other things",
      };
      
      registry.register(skill1);
      registry.register(skill2);
      registry.register(tool);
      
      const results = registry.findByTag("test");
      expect(results).toHaveLength(2);
      expect(results.map(r => r.name).sort()).toEqual(["test-runner", "test-writer"]);
    });

    it("handles special regex characters in search", () => {
      const iface: ContextInterface = {
        kind: "tool",
        name: "regex-tool",
        description: "Uses (.*) regex patterns",
      };
      
      registry.register(iface);
      
      expect(() => registry.findByTag("(.*)")).not.toThrow();
    });
  });
});
