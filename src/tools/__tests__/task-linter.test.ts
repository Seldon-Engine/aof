import { describe, it, expect } from "vitest";
import { lintTaskCard } from "../task-linter.js";
import type { Task } from "../../schemas/task.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    frontmatter: {
      schemaVersion: 1,
      id: "TASK-2026-02-07-001",
      project: "AOF",
      title: "Test Task",
      status: "backlog",
      priority: "normal",
      routing: { tags: [] },
      createdAt: "2026-02-07T19:00:00Z",
      updatedAt: "2026-02-07T19:00:00Z",
      lastTransitionAt: "2026-02-07T19:00:00Z",
      createdBy: "main",
      dependsOn: [],
      metadata: {},
      ...overrides.frontmatter,
    },
    body: overrides.body ?? "## Instructions\n\nDo something.",
    path: overrides.path,
  };
}

describe("lintTaskCard", () => {
  describe("instructions section validation", () => {
    it("passes when Instructions section is present", () => {
      const task = makeTask({
        body: `## Instructions

Do the thing.

## Other Section

More content.`,
      });

      const issues = lintTaskCard(task);
      const instructionIssues = issues.filter(i => i.rule === "instructions-section-present");
      expect(instructionIssues).toHaveLength(0);
    });

    it("warns when Instructions section is missing", () => {
      const task = makeTask({
        body: `## Some Section

No instructions here.`,
      });

      const issues = lintTaskCard(task);
      const instructionIssues = issues.filter(i => i.rule === "instructions-section-present");
      expect(instructionIssues).toHaveLength(1);
      expect(instructionIssues[0]?.severity).toBe("warning");
    });

    it("warns when Instructions section is empty", () => {
      const task = makeTask({
        body: `## Instructions

## Other Section

Content`,
      });

      const issues = lintTaskCard(task);
      const emptyIssues = issues.filter(i => i.rule === "instructions-section-not-empty");
      expect(emptyIssues).toHaveLength(1);
      expect(emptyIssues[0]?.severity).toBe("warning");
    });
  });

  describe("guidance section validation", () => {
    it("passes when Guidance section is present and guidanceRef is set", () => {
      const task = makeTask({
        frontmatter: {
          guidanceRef: "inputs/guidance.md",
        },
        body: `## Instructions

Do the thing.

## Guidance

Follow the rules.`,
      });

      const issues = lintTaskCard(task);
      const guidanceIssues = issues.filter(i => i.rule === "guidance-section-present");
      expect(guidanceIssues).toHaveLength(0);
    });

    it("warns when guidanceRef is set but Guidance section is missing", () => {
      const task = makeTask({
        frontmatter: {
          guidanceRef: "inputs/guidance.md",
        },
        body: `## Instructions

Do the thing.`,
      });

      const issues = lintTaskCard(task);
      const guidanceIssues = issues.filter(i => i.rule === "guidance-section-present");
      expect(guidanceIssues).toHaveLength(1);
      expect(guidanceIssues[0]?.severity).toBe("warning");
    });

    it("warns when Guidance section is empty and guidanceRef is set", () => {
      const task = makeTask({
        frontmatter: {
          guidanceRef: "inputs/guidance.md",
        },
        body: `## Instructions

Do the thing.

## Guidance

## Other Section

Content`,
      });

      const issues = lintTaskCard(task);
      const emptyIssues = issues.filter(i => i.rule === "guidance-section-not-empty");
      expect(emptyIssues).toHaveLength(1);
      expect(emptyIssues[0]?.severity).toBe("warning");
    });

    it("passes when neither guidanceRef nor Guidance section present (optional)", () => {
      const task = makeTask({
        body: `## Instructions

Do the thing.`,
      });

      const issues = lintTaskCard(task);
      const guidanceIssues = issues.filter(i => i.rule === "guidance-section-present");
      expect(guidanceIssues).toHaveLength(0);
    });
  });

  describe("strict mode for runbook-tagged tasks", () => {
    it("errors when runbook task missing Guidance section", () => {
      const task = makeTask({
        frontmatter: {
          routing: { tags: ["runbook"] },
        },
        body: `## Instructions

Do the thing.`,
      });

      const issues = lintTaskCard(task, { strict: true });
      const guidanceIssues = issues.filter(i => i.rule === "guidance-section-required");
      expect(guidanceIssues).toHaveLength(1);
      expect(guidanceIssues[0]?.severity).toBe("error");
    });

    it("errors when task has requiredRunbook but missing Guidance section", () => {
      const task = makeTask({
        frontmatter: {
          requiredRunbook: "runbooks/deploy.md",
        },
        body: `## Instructions

Do the thing.`,
      });

      const issues = lintTaskCard(task, { strict: true });
      const guidanceIssues = issues.filter(i => i.rule === "guidance-section-required");
      expect(guidanceIssues).toHaveLength(1);
      expect(guidanceIssues[0]?.severity).toBe("error");
    });

    it("passes when runbook task has Guidance section", () => {
      const task = makeTask({
        frontmatter: {
          routing: { tags: ["runbook"] },
        },
        body: `## Instructions

Do the thing.

## Guidance

Follow runbook conventions.`,
      });

      const issues = lintTaskCard(task, { strict: true });
      const errors = issues.filter(i => i.severity === "error");
      expect(errors).toHaveLength(0);
    });

    it("does not error in non-strict mode for runbook tasks", () => {
      const task = makeTask({
        frontmatter: {
          routing: { tags: ["runbook"] },
        },
        body: `## Instructions

Do the thing.`,
      });

      const issues = lintTaskCard(task, { strict: false });
      const errors = issues.filter(i => i.severity === "error");
      expect(errors).toHaveLength(0);
    });
  });

  describe("instructionsRef validation", () => {
    it("warns when instructionsRef is set but Instructions section is missing", () => {
      const task = makeTask({
        frontmatter: {
          instructionsRef: "inputs/instructions.md",
        },
        body: `## Other Section

Some content.`,
      });

      const issues = lintTaskCard(task);
      const refIssues = issues.filter(i => i.rule === "instructions-ref-has-section");
      expect(refIssues).toHaveLength(1);
      expect(refIssues[0]?.severity).toBe("warning");
    });

    it("passes when instructionsRef is set and Instructions section exists", () => {
      const task = makeTask({
        frontmatter: {
          instructionsRef: "inputs/instructions.md",
        },
        body: `## Instructions

Do the thing.`,
      });

      const issues = lintTaskCard(task);
      const refIssues = issues.filter(i => i.rule === "instructions-ref-has-section");
      expect(refIssues).toHaveLength(0);
    });
  });

  describe("guidanceRef validation", () => {
    it("warns when guidanceRef is set but Guidance section is missing", () => {
      const task = makeTask({
        frontmatter: {
          guidanceRef: "inputs/guidance.md",
        },
        body: `## Instructions

Do the thing.`,
      });

      const issues = lintTaskCard(task);
      const refIssues = issues.filter(i => i.rule === "guidance-ref-has-section");
      expect(refIssues).toHaveLength(1);
      expect(refIssues[0]?.severity).toBe("warning");
    });

    it("passes when guidanceRef is set and Guidance section exists", () => {
      const task = makeTask({
        frontmatter: {
          guidanceRef: "inputs/guidance.md",
        },
        body: `## Guidance

Follow the rules.`,
      });

      const issues = lintTaskCard(task);
      const refIssues = issues.filter(i => i.rule === "guidance-ref-has-section");
      expect(refIssues).toHaveLength(0);
    });
  });

  describe("backward compatibility", () => {
    it("allows tasks without any Instructions or Guidance sections (warnings only)", () => {
      const task = makeTask({
        body: `Some old task format

With no sections.`,
      });

      const issues = lintTaskCard(task);
      const errors = issues.filter(i => i.severity === "error");
      expect(errors).toHaveLength(0);
    });

    it("allows tasks with legacy format (warnings only)", () => {
      const task = makeTask({
        body: `## Context

Some context.

## Deliverables

- Item 1
- Item 2`,
      });

      const issues = lintTaskCard(task);
      const errors = issues.filter(i => i.severity === "error");
      expect(errors).toHaveLength(0);
    });
  });
});
