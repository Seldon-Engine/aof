import { describe, it, expect } from "vitest";
import { parseTaskFile, extractTaskSections } from "../task-store.js";

describe("extractTaskSections", () => {
  it("extracts instructions section from task body", () => {
    const body = `## Instructions

Step 1: Do this
Step 2: Do that

## Other Section

Some content`;

    const sections = extractTaskSections(body);
    expect(sections.instructions).toBe("Step 1: Do this\nStep 2: Do that");
  });

  it("extracts guidance section from task body", () => {
    const body = `## Guidance

Follow convention X
Use pattern Y

## Other Section

Some content`;

    const sections = extractTaskSections(body);
    expect(sections.guidance).toBe("Follow convention X\nUse pattern Y");
  });

  it("extracts both instructions and guidance", () => {
    const body = `## Instructions

Do the thing.

## Guidance

Follow the rules.

## Acceptance Criteria

- [ ] Done`;

    const sections = extractTaskSections(body);
    expect(sections.instructions).toBe("Do the thing.");
    expect(sections.guidance).toBe("Follow the rules.");
  });

  it("returns undefined for missing instructions section", () => {
    const body = `## Guidance

Some guidance.`;

    const sections = extractTaskSections(body);
    expect(sections.instructions).toBeUndefined();
    expect(sections.guidance).toBe("Some guidance.");
  });

  it("returns undefined for missing guidance section", () => {
    const body = `## Instructions

Do the thing.`;

    const sections = extractTaskSections(body);
    expect(sections.instructions).toBe("Do the thing.");
    expect(sections.guidance).toBeUndefined();
  });

  it("handles case-insensitive section headers", () => {
    const body = `## instructions

Do the thing.

## GUIDANCE

Follow rules.`;

    const sections = extractTaskSections(body);
    expect(sections.instructions).toBe("Do the thing.");
    expect(sections.guidance).toBe("Follow rules.");
  });

  it("extracts content until next section", () => {
    const body = `## Instructions

Line 1
Line 2
Line 3

## Guidance

Guidance content

## Acceptance Criteria

Criteria content`;

    const sections = extractTaskSections(body);
    expect(sections.instructions).toBe("Line 1\nLine 2\nLine 3");
    expect(sections.guidance).toBe("Guidance content");
  });

  it("handles sections with extra whitespace", () => {
    const body = `##    Instructions   

Content here

##  Guidance  

More content`;

    const sections = extractTaskSections(body);
    expect(sections.instructions).toBe("Content here");
    expect(sections.guidance).toBe("More content");
  });

  it("returns empty object when no relevant sections exist", () => {
    const body = `## Some Section

Content

## Another Section

More content`;

    const sections = extractTaskSections(body);
    expect(sections.instructions).toBeUndefined();
    expect(sections.guidance).toBeUndefined();
  });

  it("handles sections at end of document", () => {
    const body = `## Other

Content

## Instructions

Final instructions`;

    const sections = extractTaskSections(body);
    expect(sections.instructions).toBe("Final instructions");
  });

  it("trims whitespace from extracted content", () => {
    const body = `## Instructions


   Indented content   


## Guidance


   More indented   

`;

    const sections = extractTaskSections(body);
    expect(sections.instructions).toBe("Indented content");
    expect(sections.guidance).toBe("More indented");
  });
});

describe("parseTaskFile - integration with section extraction", () => {
  it("parses task with instructions and guidance sections", () => {
    const raw = `---
schemaVersion: 1
id: "TASK-2026-02-07-001"
project: "AOF"
title: Test Task
status: backlog
priority: normal
routing:
  tags: []
createdAt: "2026-02-07T19:00:00Z"
updatedAt: "2026-02-07T19:00:00Z"
lastTransitionAt: "2026-02-07T19:00:00Z"
createdBy: main
dependsOn: []
metadata: {}
instructionsRef: "inputs/instructions.md"
guidanceRef: "inputs/guidance.md"
---

## Instructions

Do the thing.

## Guidance

Follow the rules.
`;

    const task = parseTaskFile(raw);
    expect(task.frontmatter.instructionsRef).toBe("inputs/instructions.md");
    expect(task.frontmatter.guidanceRef).toBe("inputs/guidance.md");
    expect(task.body).toContain("## Instructions");
    expect(task.body).toContain("## Guidance");
  });
});
