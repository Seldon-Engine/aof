import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lintProject } from "../lint.js";
import { bootstrapProject } from "../bootstrap.js";
import type { ProjectRecord } from "../registry.js";
import { EventLogger } from "../../events/logger.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("lintProject", () => {
  let testRoot: string;
  let eventsDir: string;
  let capturedEvents: BaseEvent[];

  beforeEach(async () => {
    testRoot = join(
      tmpdir(),
      `aof-lint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    eventsDir = join(testRoot, "events");
    await mkdir(testRoot, { recursive: true });
    await mkdir(eventsDir, { recursive: true });
    capturedEvents = [];
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  function createEventLogger(): EventLogger {
    return new EventLogger(eventsDir, {
      onEvent: (event) => {
        capturedEvents.push(event);
      },
    });
  }

  it("passes for valid project with complete structure", async () => {
    const projectRoot = join(testRoot, "valid-project");
    await bootstrapProject(projectRoot);

    const record: ProjectRecord = {
      id: "valid-project",
      path: projectRoot,
      manifest: {
        id: "valid-project",
        title: "Valid Project",
        status: "active",
        type: "swe",
        owner: { team: "swe", lead: "lead" },
        participants: [],
        routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: true } },
        memory: {
          tiers: { bronze: "cold", silver: "warm", gold: "warm" },
          allowIndex: { warmPaths: [] },
          denyIndex: [],
        },
        links: { dashboards: [], docs: [] },
      },
    };

    const result = await lintProject(record);

    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);

    // Verify lint report was written
    const reportPath = join(projectRoot, "state", "lint-report.md");
    const reportContent = await readFile(reportPath, "utf-8");
    expect(reportContent).toContain("✓ PASSED");
    expect(reportContent).toContain("No issues found");
  });

  it("reports missing required directories", async () => {
    const projectRoot = join(testRoot, "incomplete-project");
    await mkdir(projectRoot, { recursive: true });
    // Only create some directories
    await mkdir(join(projectRoot, "tasks"), { recursive: true });
    await mkdir(join(projectRoot, "state"), { recursive: true });

    const record: ProjectRecord = {
      id: "incomplete-project",
      path: projectRoot,
    };

    const result = await lintProject(record);

    expect(result.passed).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);

    const missingDirs = result.issues.filter(
      (i) => i.category === "structure" && i.message.includes("Missing required directory")
    );
    expect(missingDirs.length).toBeGreaterThan(0);

    // Should report missing: artifacts, views, cold
    const messages = missingDirs.map((i) => i.message).join(" ");
    expect(messages).toContain("artifacts");
    expect(messages).toContain("views");
    expect(messages).toContain("cold");
  });

  it("reports missing artifact medallion tiers", async () => {
    const projectRoot = join(testRoot, "missing-tiers");
    await mkdir(join(projectRoot, "artifacts"), { recursive: true });
    await mkdir(join(projectRoot, "artifacts", "bronze"), { recursive: true });
    // Missing silver and gold
    await mkdir(join(projectRoot, "tasks"), { recursive: true });
    await mkdir(join(projectRoot, "state"), { recursive: true });
    await mkdir(join(projectRoot, "views"), { recursive: true });
    await mkdir(join(projectRoot, "cold"), { recursive: true });

    const record: ProjectRecord = {
      id: "missing-tiers",
      path: projectRoot,
    };

    const result = await lintProject(record);

    expect(result.passed).toBe(false);

    const tierIssues = result.issues.filter(
      (i) => i.category === "artifacts" && i.message.includes("Missing artifact tier")
    );
    expect(tierIssues.length).toBe(2);

    const messages = tierIssues.map((i) => i.message).join(" ");
    expect(messages).toContain("silver");
    expect(messages).toContain("gold");
  });

  it("reports task status mismatch with directory", async () => {
    const projectRoot = join(testRoot, "status-mismatch");
    await bootstrapProject(projectRoot);

    // Create a task in backlog directory but with status "ready"
    const backlogDir = join(projectRoot, "tasks", "backlog");
    await mkdir(backlogDir, { recursive: true });

    const taskContent = `---
schemaVersion: 1
id: TASK-2026-02-11-001
title: Mismatched Task
status: ready
priority: normal
createdAt: "2026-02-11T10:00:00Z"
updatedAt: "2026-02-11T10:00:00Z"
lastTransitionAt: "2026-02-11T10:00:00Z"
createdBy: test
---

Task body.
`;

    await writeFile(join(backlogDir, "TASK-2026-02-11-001.md"), taskContent, "utf-8");

    const record: ProjectRecord = {
      id: "status-mismatch",
      path: projectRoot,
    };

    const result = await lintProject(record);

    expect(result.passed).toBe(false);

    const statusIssues = result.issues.filter(
      (i) => i.message.includes("does not match directory")
    );
    expect(statusIssues.length).toBe(1);
    expect(statusIssues[0].message).toContain("status 'ready' does not match directory 'backlog'");
    expect(statusIssues[0].severity).toBe("error");
  });

  it("reports task project field mismatch", async () => {
    const projectRoot = join(testRoot, "project-mismatch");
    await bootstrapProject(projectRoot);

    const readyDir = join(projectRoot, "tasks", "ready");
    await mkdir(readyDir, { recursive: true });

    const taskContent = `---
schemaVersion: 1
id: TASK-2026-02-11-002
title: Wrong Project Task
status: ready
priority: normal
project: other-project
createdAt: "2026-02-11T10:00:00Z"
updatedAt: "2026-02-11T10:00:00Z"
lastTransitionAt: "2026-02-11T10:00:00Z"
createdBy: test
---

Task body.
`;

    await writeFile(join(readyDir, "TASK-2026-02-11-002.md"), taskContent, "utf-8");

    const record: ProjectRecord = {
      id: "project-mismatch",
      path: projectRoot,
    };

    const result = await lintProject(record);

    expect(result.passed).toBe(false);

    const projectIssues = result.issues.filter(
      (i) => i.message.includes("Task project") && i.message.includes("does not match project id")
    );
    expect(projectIssues.length).toBe(1);
    expect(projectIssues[0].message).toContain("'other-project'");
    expect(projectIssues[0].message).toContain("'project-mismatch'");
    expect(projectIssues[0].severity).toBe("error");
  });

  it("reports invalid project manifest and emits event", async () => {
    const projectRoot = join(testRoot, "invalid-manifest");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(projectRoot, "state"), { recursive: true });

    const eventLogger = createEventLogger();

    const record: ProjectRecord = {
      id: "invalid-manifest",
      path: projectRoot,
      error: "Validation failed: owner: Required",
    };

    const result = await lintProject(record, eventLogger);

    expect(result.passed).toBe(false);

    const manifestIssues = result.issues.filter((i) => i.category === "manifest");
    expect(manifestIssues.length).toBe(1);
    expect(manifestIssues[0].message).toContain("Invalid project.yaml");
    expect(manifestIssues[0].severity).toBe("error");

    // Verify event was emitted
    expect(capturedEvents.length).toBe(1);
    expect(capturedEvents[0].type).toBe("project.validation.failed");
    expect(capturedEvents[0].payload.projectId).toBe("invalid-manifest");
  });

  it("writes lint report even when project fails validation", async () => {
    const projectRoot = join(testRoot, "fail-project");
    await mkdir(join(projectRoot, "state"), { recursive: true });

    const record: ProjectRecord = {
      id: "fail-project",
      path: projectRoot,
    };

    const result = await lintProject(record);

    expect(result.passed).toBe(false);

    // Verify lint report exists
    const reportPath = join(projectRoot, "state", "lint-report.md");
    const reportContent = await readFile(reportPath, "utf-8");
    expect(reportContent).toContain("✗ FAILED");
    expect(reportContent).toContain("error(s)");
  });

  it("includes issue paths in lint report", async () => {
    const projectRoot = join(testRoot, "path-test");
    await bootstrapProject(projectRoot);

    const readyDir = join(projectRoot, "tasks", "ready");
    await mkdir(readyDir, { recursive: true });

    const taskContent = `---
schemaVersion: 1
id: TASK-2026-02-11-003
title: Test Task
status: backlog
priority: normal
createdAt: "2026-02-11T10:00:00Z"
updatedAt: "2026-02-11T10:00:00Z"
lastTransitionAt: "2026-02-11T10:00:00Z"
createdBy: test
---

Task body.
`;

    await writeFile(join(readyDir, "TASK-2026-02-11-003.md"), taskContent, "utf-8");

    const record: ProjectRecord = {
      id: "path-test",
      path: projectRoot,
    };

    const result = await lintProject(record);

    const reportPath = join(projectRoot, "state", "lint-report.md");
    const reportContent = await readFile(reportPath, "utf-8");

    // Report should include relative paths
    expect(reportContent).toContain("Path:");
    expect(reportContent).toContain("ready/TASK-2026-02-11-003.md");
  });

  it("warns about unknown task status directories", async () => {
    const projectRoot = join(testRoot, "unknown-status");
    await bootstrapProject(projectRoot);

    const unknownDir = join(projectRoot, "tasks", "unknown-status");
    await mkdir(unknownDir, { recursive: true });

    const record: ProjectRecord = {
      id: "unknown-status",
      path: projectRoot,
    };

    const result = await lintProject(record);

    const unknownIssues = result.issues.filter(
      (i) => i.message.includes("Unknown task status directory")
    );
    expect(unknownIssues.length).toBe(1);
    expect(unknownIssues[0].severity).toBe("warning");
    expect(unknownIssues[0].message).toContain("unknown-status");
  });

  it("passes for task without project field (optional field)", async () => {
    const projectRoot = join(testRoot, "no-project-field");
    await bootstrapProject(projectRoot);

    const backlogDir = join(projectRoot, "tasks", "backlog");
    await mkdir(backlogDir, { recursive: true });

    const taskContent = `---
schemaVersion: 1
id: TASK-2026-02-11-004
title: Task Without Project Field
status: backlog
priority: normal
createdAt: "2026-02-11T10:00:00Z"
updatedAt: "2026-02-11T10:00:00Z"
lastTransitionAt: "2026-02-11T10:00:00Z"
createdBy: test
---

Task body.
`;

    await writeFile(join(backlogDir, "TASK-2026-02-11-004.md"), taskContent, "utf-8");

    const record: ProjectRecord = {
      id: "no-project-field",
      path: projectRoot,
    };

    const result = await lintProject(record);

    // Should not flag missing project field as error
    const projectIssues = result.issues.filter((i) => i.message.includes("project"));
    expect(projectIssues.length).toBe(0);
  });

  it("groups issues by category in report", async () => {
    const projectRoot = join(testRoot, "multi-issue");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(projectRoot, "state"), { recursive: true });
    // Missing most directories

    const record: ProjectRecord = {
      id: "multi-issue",
      path: projectRoot,
      error: "Invalid manifest",
    };

    const result = await lintProject(record);

    const reportPath = join(projectRoot, "state", "lint-report.md");
    const reportContent = await readFile(reportPath, "utf-8");

    // Report should have category headings
    expect(reportContent).toContain("## Manifest");
    expect(reportContent).toContain("## Structure");
  });

  describe("hierarchy validation", () => {
    it("warns when parentId references non-existent project", async () => {
      const projectRoot = join(testRoot, "child-missing-parent");
      await bootstrapProject(projectRoot);

      const record: ProjectRecord = {
        id: "child-missing-parent",
        path: projectRoot,
        manifest: {
          id: "child-missing-parent",
          title: "Child Project",
          status: "active",
          type: "swe",
          owner: { team: "swe", lead: "lead" },
          participants: [],
          parentId: "non-existent-parent",
          routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: true } },
          memory: {
            tiers: { bronze: "cold", silver: "warm", gold: "warm" },
            allowIndex: { warmPaths: [] },
            denyIndex: [],
          },
          links: { dashboards: [], docs: [] },
        },
      };

      // Create a mock project list without the parent
      const allProjects: ProjectRecord[] = [record];

      const result = await lintProject(record, undefined, allProjects);

      const hierarchyIssues = result.issues.filter(
        (i) => i.category === "hierarchy"
      );
      expect(hierarchyIssues.length).toBe(1);
      expect(hierarchyIssues[0].severity).toBe("warning");
      expect(hierarchyIssues[0].message).toContain("non-existent-parent");
      expect(hierarchyIssues[0].message).toContain("does not exist");
    });

    it("errors on circular parent reference (self-reference)", async () => {
      const projectRoot = join(testRoot, "circular-self");
      await bootstrapProject(projectRoot);

      const record: ProjectRecord = {
        id: "circular-self",
        path: projectRoot,
        manifest: {
          id: "circular-self",
          title: "Circular Self",
          status: "active",
          type: "swe",
          owner: { team: "swe", lead: "lead" },
          participants: [],
          parentId: "circular-self", // Self-reference
          routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: true } },
          memory: {
            tiers: { bronze: "cold", silver: "warm", gold: "warm" },
            allowIndex: { warmPaths: [] },
            denyIndex: [],
          },
          links: { dashboards: [], docs: [] },
        },
      };

      const allProjects: ProjectRecord[] = [record];

      const result = await lintProject(record, undefined, allProjects);

      const hierarchyIssues = result.issues.filter(
        (i) => i.category === "hierarchy"
      );
      expect(hierarchyIssues.length).toBe(1);
      expect(hierarchyIssues[0].severity).toBe("error");
      expect(hierarchyIssues[0].message).toContain("Circular parent reference");
      expect(hierarchyIssues[0].message).toContain("circular-self");
    });

    it("errors on circular parent reference (multi-level cycle)", async () => {
      const projectARoot = join(testRoot, "project-a");
      const projectBRoot = join(testRoot, "project-b");
      const projectCRoot = join(testRoot, "project-c");
      
      await bootstrapProject(projectARoot);
      await bootstrapProject(projectBRoot);
      await bootstrapProject(projectCRoot);

      const recordA: ProjectRecord = {
        id: "project-a",
        path: projectARoot,
        manifest: {
          id: "project-a",
          title: "Project A",
          status: "active",
          type: "swe",
          owner: { team: "swe", lead: "lead" },
          participants: [],
          parentId: "project-c", // A -> C
          routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: true } },
          memory: {
            tiers: { bronze: "cold", silver: "warm", gold: "warm" },
            allowIndex: { warmPaths: [] },
            denyIndex: [],
          },
          links: { dashboards: [], docs: [] },
        },
      };

      const recordB: ProjectRecord = {
        id: "project-b",
        path: projectBRoot,
        manifest: {
          id: "project-b",
          title: "Project B",
          status: "active",
          type: "swe",
          owner: { team: "swe", lead: "lead" },
          participants: [],
          parentId: "project-a", // B -> A
          routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: true } },
          memory: {
            tiers: { bronze: "cold", silver: "warm", gold: "warm" },
            allowIndex: { warmPaths: [] },
            denyIndex: [],
          },
          links: { dashboards: [], docs: [] },
        },
      };

      const recordC: ProjectRecord = {
        id: "project-c",
        path: projectCRoot,
        manifest: {
          id: "project-c",
          title: "Project C",
          status: "active",
          type: "swe",
          owner: { team: "swe", lead: "lead" },
          participants: [],
          parentId: "project-b", // C -> B (completes cycle: A -> C -> B -> A)
          routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: true } },
          memory: {
            tiers: { bronze: "cold", silver: "warm", gold: "warm" },
            allowIndex: { warmPaths: [] },
            denyIndex: [],
          },
          links: { dashboards: [], docs: [] },
        },
      };

      const allProjects: ProjectRecord[] = [recordA, recordB, recordC];

      const result = await lintProject(recordA, undefined, allProjects);

      const hierarchyIssues = result.issues.filter(
        (i) => i.category === "hierarchy"
      );
      expect(hierarchyIssues.length).toBe(1);
      expect(hierarchyIssues[0].severity).toBe("error");
      expect(hierarchyIssues[0].message).toContain("Circular parent reference");
      // Cycle should be detected
      expect(result.passed).toBe(false);
    });

    it("passes when parentId references valid project", async () => {
      const parentRoot = join(testRoot, "parent-proj");
      const childRoot = join(testRoot, "child-proj");
      
      await bootstrapProject(parentRoot);
      await bootstrapProject(childRoot);

      const parentRecord: ProjectRecord = {
        id: "parent-proj",
        path: parentRoot,
        manifest: {
          id: "parent-proj",
          title: "Parent Project",
          status: "active",
          type: "swe",
          owner: { team: "swe", lead: "lead" },
          participants: [],
          routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: true } },
          memory: {
            tiers: { bronze: "cold", silver: "warm", gold: "warm" },
            allowIndex: { warmPaths: [] },
            denyIndex: [],
          },
          links: { dashboards: [], docs: [] },
        },
      };

      const childRecord: ProjectRecord = {
        id: "child-proj",
        path: childRoot,
        manifest: {
          id: "child-proj",
          title: "Child Project",
          status: "active",
          type: "swe",
          owner: { team: "swe", lead: "lead" },
          participants: [],
          parentId: "parent-proj",
          routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: true } },
          memory: {
            tiers: { bronze: "cold", silver: "warm", gold: "warm" },
            allowIndex: { warmPaths: [] },
            denyIndex: [],
          },
          links: { dashboards: [], docs: [] },
        },
      };

      const allProjects: ProjectRecord[] = [parentRecord, childRecord];

      const result = await lintProject(childRecord, undefined, allProjects);

      const hierarchyIssues = result.issues.filter(
        (i) => i.category === "hierarchy"
      );
      expect(hierarchyIssues.length).toBe(0);
      expect(result.passed).toBe(true);
    });

    it("passes when project has no parentId", async () => {
      const projectRoot = join(testRoot, "standalone-proj");
      await bootstrapProject(projectRoot);

      const record: ProjectRecord = {
        id: "standalone-proj",
        path: projectRoot,
        manifest: {
          id: "standalone-proj",
          title: "Standalone Project",
          status: "active",
          type: "swe",
          owner: { team: "swe", lead: "lead" },
          participants: [],
          routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: true } },
          memory: {
            tiers: { bronze: "cold", silver: "warm", gold: "warm" },
            allowIndex: { warmPaths: [] },
            denyIndex: [],
          },
          links: { dashboards: [], docs: [] },
        },
      };

      const allProjects: ProjectRecord[] = [record];

      const result = await lintProject(record, undefined, allProjects);

      const hierarchyIssues = result.issues.filter(
        (i) => i.category === "hierarchy"
      );
      expect(hierarchyIssues.length).toBe(0);
      expect(result.passed).toBe(true);
    });
  });
});
