import { describe, it, expect } from "vitest";
import { ProjectManifest, PROJECT_ID_REGEX } from "../project.js";

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
