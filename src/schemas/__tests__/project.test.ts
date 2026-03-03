import { describe, it, expect } from "vitest";
import { ProjectManifest, PROJECT_ID_REGEX, TemplateNameKey } from "../project.js";

describe("ProjectManifest", () => {
  it("validates a valid manifest with all required fields", () => {
    const raw = {
      id: "email-autopilot",
      title: "Email Autopilot",
      status: "active",
      type: "swe",
      owner: {
        team: "swe",
        lead: "swe-pm",
      },
      participants: ["swe-backend", "swe-qa"],
    };

    const result = ProjectManifest.parse(raw);
    expect(result.id).toBe("email-autopilot");
    expect(result.title).toBe("Email Autopilot");
    expect(result.status).toBe("active");
    expect(result.type).toBe("swe");
    expect(result.participants).toEqual(["swe-backend", "swe-qa"]);
  });

  it("applies default values for optional fields", () => {
    const raw = {
      id: "minimal-project",
      title: "Minimal Project",
      type: "ops",
      owner: {
        team: "ops",
        lead: "ops-lead",
      },
    };

    const result = ProjectManifest.parse(raw);
    expect(result.status).toBe("active");
    expect(result.participants).toEqual([]);
    expect(result.routing.intake.default).toBe("Tasks/Backlog");
    expect(result.memory.tiers.bronze).toBe("cold");
    expect(result.memory.tiers.silver).toBe("warm");
  });

  it("rejects invalid project ID (uppercase)", () => {
    const raw = {
      id: "Invalid-ID",
      title: "Bad ID",
      type: "swe",
      owner: { team: "swe", lead: "lead" },
    };

    expect(() => ProjectManifest.parse(raw)).toThrow(/must match/);
  });

  it("accepts _inbox as special case", () => {
    const raw = {
      id: "_inbox",
      title: "Inbox",
      type: "admin",
      owner: { team: "ops", lead: "system" },
    };

    const result = ProjectManifest.parse(raw);
    expect(result.id).toBe("_inbox");
  });

  it("rejects invalid project ID (underscore prefix except _inbox)", () => {
    const raw = {
      id: "_private",
      title: "Private Project",
      type: "swe",
      owner: { team: "swe", lead: "lead" },
    };

    expect(() => ProjectManifest.parse(raw)).toThrow(/must match/);
  });

  it("rejects project ID longer than 64 characters", () => {
    const raw = {
      id: "a".repeat(65),
      title: "Too Long",
      type: "swe",
      owner: { team: "swe", lead: "lead" },
    };

    expect(() => ProjectManifest.parse(raw)).toThrow(/must match/);
  });

  it("accepts valid hyphenated project ID", () => {
    const raw = {
      id: "my-cool-project-123",
      title: "Hyphenated",
      type: "research",
      owner: { team: "research", lead: "lead" },
    };

    const result = ProjectManifest.parse(raw);
    expect(result.id).toBe("my-cool-project-123");
  });

  it("rejects missing required field (title)", () => {
    const raw = {
      id: "missing-title",
      type: "swe",
      owner: { team: "swe", lead: "lead" },
    };

    expect(() => ProjectManifest.parse(raw)).toThrow();
  });

  it("rejects missing required field (owner)", () => {
    const raw = {
      id: "missing-owner",
      title: "No Owner",
      type: "swe",
    };

    expect(() => ProjectManifest.parse(raw)).toThrow();
  });

  it("accepts optional parentId", () => {
    const raw = {
      id: "child-project",
      title: "Child Project",
      type: "swe",
      owner: { team: "swe", lead: "lead" },
      parentId: "parent-project",
    };

    const result = ProjectManifest.parse(raw);
    expect(result.parentId).toBe("parent-project");
  });

  it("accepts manifest without parentId", () => {
    const raw = {
      id: "standalone-project",
      title: "Standalone Project",
      type: "swe",
      owner: { team: "swe", lead: "lead" },
    };

    const result = ProjectManifest.parse(raw);
    expect(result.parentId).toBeUndefined();
  });
});

describe("ProjectManifest — workflowTemplates", () => {
  const baseManifest = {
    id: "test-project",
    title: "Test Project",
    type: "swe" as const,
    owner: { team: "swe", lead: "lead" },
  };

  it("parses successfully without workflowTemplates (backward compat)", () => {
    const result = ProjectManifest.parse(baseManifest);
    expect(result.workflowTemplates).toBeUndefined();
  });

  it("parses with a valid workflowTemplates map containing named WorkflowDefinition objects", () => {
    const raw = {
      ...baseManifest,
      workflowTemplates: {
        "standard-sdlc": {
          name: "standard-sdlc",
          hops: [
            { id: "implement", role: "swe-backend" },
            { id: "review", role: "swe-architect", dependsOn: ["implement"] },
          ],
        },
        "simple-review": {
          name: "simple-review",
          hops: [{ id: "review", role: "swe-architect" }],
        },
      },
    };

    const result = ProjectManifest.parse(raw);
    expect(result.workflowTemplates).toBeDefined();
    expect(Object.keys(result.workflowTemplates!)).toEqual([
      "standard-sdlc",
      "simple-review",
    ]);
    expect(result.workflowTemplates!["standard-sdlc"].name).toBe("standard-sdlc");
    expect(result.workflowTemplates!["standard-sdlc"].hops).toHaveLength(2);
  });

  it("rejects workflowTemplates with invalid WorkflowDefinition shapes", () => {
    const raw = {
      ...baseManifest,
      workflowTemplates: {
        "bad-template": {
          name: "bad-template",
          hops: [], // WorkflowDefinition requires at least 1 hop
        },
      },
    };

    expect(() => ProjectManifest.parse(raw)).toThrow();
  });

  it("rejects workflowTemplates key with uppercase letters", () => {
    const raw = {
      ...baseManifest,
      workflowTemplates: {
        "BadName": {
          name: "BadName",
          hops: [{ id: "a", role: "r" }],
        },
      },
    };

    expect(() => ProjectManifest.parse(raw)).toThrow();
  });

  it("rejects workflowTemplates key starting with hyphen", () => {
    const raw = {
      ...baseManifest,
      workflowTemplates: {
        "-bad-start": {
          name: "bad-start",
          hops: [{ id: "a", role: "r" }],
        },
      },
    };

    expect(() => ProjectManifest.parse(raw)).toThrow();
  });

  it("accepts workflowTemplates key with lowercase alphanumeric and hyphens", () => {
    const raw = {
      ...baseManifest,
      workflowTemplates: {
        "my-template-123": {
          name: "my-template-123",
          hops: [{ id: "a", role: "r" }],
        },
      },
    };

    const result = ProjectManifest.parse(raw);
    expect(result.workflowTemplates!["my-template-123"]).toBeDefined();
  });
});

describe("TemplateNameKey", () => {
  it("accepts lowercase alphanumeric with hyphens", () => {
    expect(TemplateNameKey.parse("standard-sdlc")).toBe("standard-sdlc");
    expect(TemplateNameKey.parse("review123")).toBe("review123");
    expect(TemplateNameKey.parse("a")).toBe("a");
    expect(TemplateNameKey.parse("0simple")).toBe("0simple");
  });

  it("rejects uppercase letters", () => {
    expect(() => TemplateNameKey.parse("BadName")).toThrow(/lowercase/i);
  });

  it("rejects keys starting with hyphen", () => {
    expect(() => TemplateNameKey.parse("-bad")).toThrow(/lowercase/i);
  });

  it("rejects empty string", () => {
    expect(() => TemplateNameKey.parse("")).toThrow();
  });
});

describe("PROJECT_ID_REGEX", () => {
  it("accepts valid lowercase alphanumeric with hyphens", () => {
    expect(PROJECT_ID_REGEX.test("project-123")).toBe(true);
    expect(PROJECT_ID_REGEX.test("abc")).toBe(true);
    expect(PROJECT_ID_REGEX.test("a1")).toBe(true);
  });

  it("rejects IDs starting with hyphen", () => {
    expect(PROJECT_ID_REGEX.test("-project")).toBe(false);
  });

  it("rejects uppercase letters", () => {
    expect(PROJECT_ID_REGEX.test("Project")).toBe(false);
  });

  it("accepts _inbox as special case", () => {
    expect(PROJECT_ID_REGEX.test("_inbox")).toBe(true);
  });

  it("rejects other underscores", () => {
    expect(PROJECT_ID_REGEX.test("_private")).toBe(false);
    expect(PROJECT_ID_REGEX.test("project_name")).toBe(false);
  });

  it("rejects single character IDs", () => {
    expect(PROJECT_ID_REGEX.test("a")).toBe(false);
  });

  it("accepts exactly 64 characters", () => {
    const id = "a" + "b".repeat(63);
    expect(id.length).toBe(64);
    expect(PROJECT_ID_REGEX.test(id)).toBe(true);
  });

  it("rejects 65 characters", () => {
    const id = "a" + "b".repeat(64);
    expect(id.length).toBe(65);
    expect(PROJECT_ID_REGEX.test(id)).toBe(false);
  });
});
