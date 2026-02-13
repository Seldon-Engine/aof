import { describe, it, expect } from "vitest";
import { TaskFrontmatter } from "../task.js";

describe("TaskFrontmatter - instructions/guidance extensions", () => {
  const baseTaskFrontmatter = {
    schemaVersion: 1,
    id: "TASK-2026-02-07-001",
    project: "AOF",
    title: "Test Task",
    status: "backlog",
    priority: "normal",
    routing: {},
    createdAt: "2026-02-07T19:00:00Z",
    updatedAt: "2026-02-07T19:00:00Z",
    lastTransitionAt: "2026-02-07T19:00:00Z",
    createdBy: "main",
    dependsOn: [],
    metadata: {},
  } as const;

  it("accepts task without instructionsRef or guidanceRef (backward compat)", () => {
    const result = TaskFrontmatter.safeParse(baseTaskFrontmatter);
    expect(result.success).toBe(true);
  });

  it("accepts task with instructionsRef", () => {
    const withInstructions = {
      ...baseTaskFrontmatter,
      instructionsRef: "inputs/instructions.md",
    };
    const result = TaskFrontmatter.safeParse(withInstructions);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.instructionsRef).toBe("inputs/instructions.md");
    }
  });

  it("accepts task with guidanceRef", () => {
    const withGuidance = {
      ...baseTaskFrontmatter,
      guidanceRef: "inputs/guidance.md",
    };
    const result = TaskFrontmatter.safeParse(withGuidance);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.guidanceRef).toBe("inputs/guidance.md");
    }
  });

  it("accepts task with both instructionsRef and guidanceRef", () => {
    const withBoth = {
      ...baseTaskFrontmatter,
      instructionsRef: "inputs/instructions.md",
      guidanceRef: "inputs/guidance.md",
    };
    const result = TaskFrontmatter.safeParse(withBoth);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.instructionsRef).toBe("inputs/instructions.md");
      expect(result.data.guidanceRef).toBe("inputs/guidance.md");
    }
  });

  it("rejects empty string for instructionsRef", () => {
    const withEmpty = {
      ...baseTaskFrontmatter,
      instructionsRef: "",
    };
    const result = TaskFrontmatter.safeParse(withEmpty);
    expect(result.success).toBe(false);
  });

  it("rejects empty string for guidanceRef", () => {
    const withEmpty = {
      ...baseTaskFrontmatter,
      guidanceRef: "",
    };
    const result = TaskFrontmatter.safeParse(withEmpty);
    expect(result.success).toBe(false);
  });
});
