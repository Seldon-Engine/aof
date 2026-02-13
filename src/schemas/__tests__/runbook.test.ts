import { describe, it, expect } from "vitest";
import { RunbookFrontmatter, parseRunbookFile, serializeRunbook } from "../runbook.js";

describe("RunbookFrontmatter schema", () => {
  it("validates minimal runbook frontmatter", () => {
    const data = {
      id: "deploy-backend",
      title: "Deploy Backend Service",
      team: "swe",
      taskType: "deploy",
      version: "1.0.0",
      createdAt: "2026-02-07T12:00:00Z",
      updatedAt: "2026-02-07T12:00:00Z",
    };

    const result = RunbookFrontmatter.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("deploy-backend");
      expect(result.data.team).toBe("swe");
      expect(result.data.taskType).toBe("deploy");
    }
  });

  it("validates runbook with optional fields", () => {
    const data = {
      id: "incident-response",
      title: "Incident Response Runbook",
      team: "ops",
      taskType: "incident",
      version: "2.1.0",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-07T12:00:00Z",
      owner: "sre-lead",
      tags: ["critical", "oncall"],
      estimatedDurationMinutes: 30,
    };

    const result = RunbookFrontmatter.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.owner).toBe("sre-lead");
      expect(result.data.tags).toEqual(["critical", "oncall"]);
      expect(result.data.estimatedDurationMinutes).toBe(30);
    }
  });

  it("rejects invalid runbook frontmatter", () => {
    const data = {
      id: "bad-runbook",
      // missing required fields
    };

    const result = RunbookFrontmatter.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("validates version as semver-like string", () => {
    const valid = RunbookFrontmatter.safeParse({
      id: "test",
      title: "Test",
      team: "swe",
      taskType: "test",
      version: "1.2.3",
      createdAt: "2026-02-07T12:00:00Z",
      updatedAt: "2026-02-07T12:00:00Z",
    });
    expect(valid.success).toBe(true);
  });
});

describe("parseRunbookFile", () => {
  it("parses valid runbook markdown", () => {
    const content = `---
id: deploy-backend
title: Deploy Backend Service
team: swe
taskType: deploy
version: 1.0.0
createdAt: 2026-02-07T12:00:00Z
updatedAt: 2026-02-07T12:00:00Z
---

## Purpose
Deploy the backend service to production.

## Prerequisites
- AWS credentials configured
- Database migrations tested

## Steps
1. Run tests
2. Build Docker image
3. Push to ECR
4. Deploy via ECS

## Verification
- Health check passes
- Smoke tests pass

## Rollback
- Revert ECS task definition
`;

    const runbook = parseRunbookFile(content);
    expect(runbook.frontmatter.id).toBe("deploy-backend");
    expect(runbook.frontmatter.title).toBe("Deploy Backend Service");
    expect(runbook.body).toContain("## Purpose");
    expect(runbook.body).toContain("## Steps");
  });

  it("throws on missing frontmatter", () => {
    const content = `# Not a valid runbook
This has no frontmatter.`;

    expect(() => parseRunbookFile(content)).toThrow("must start with YAML frontmatter");
  });

  it("throws on invalid frontmatter schema", () => {
    const content = `---
id: incomplete
---

Body here.`;

    expect(() => parseRunbookFile(content)).toThrow();
  });
});

describe("serializeRunbook", () => {
  it("serializes runbook back to markdown", () => {
    const runbook = {
      frontmatter: {
        id: "test-runbook",
        title: "Test Runbook",
        team: "swe",
        taskType: "test",
        version: "1.0.0",
        createdAt: "2026-02-07T12:00:00Z",
        updatedAt: "2026-02-07T12:00:00Z",
      },
      body: "## Purpose\nTest purpose.",
    };

    const serialized = serializeRunbook(runbook);
    expect(serialized).toContain("---");
    expect(serialized).toContain("id: test-runbook");
    expect(serialized).toContain("## Purpose");
    expect(serialized).toContain("Test purpose.");
  });

  it("round-trips parse and serialize", () => {
    const original = `---
id: roundtrip-test
title: Round Trip Test
team: swe
taskType: test
version: 1.0.0
createdAt: 2026-02-07T12:00:00Z
updatedAt: 2026-02-07T12:00:00Z
---

## Purpose
Test round-trip serialization.
`;

    const runbook = parseRunbookFile(original);
    const serialized = serializeRunbook(runbook);
    const reparsed = parseRunbookFile(serialized);

    expect(reparsed.frontmatter).toEqual(runbook.frontmatter);
    expect(reparsed.body.trim()).toBe(runbook.body.trim());
  });
});
