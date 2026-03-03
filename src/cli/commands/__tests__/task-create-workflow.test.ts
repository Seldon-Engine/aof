/**
 * Tests for --workflow CLI flag template resolution in task create.
 *
 * Tests template name resolution from project manifest workflowTemplates,
 * error handling for unknown templates and missing project context.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { FilesystemTaskStore } from "../../../store/task-store.js";
import type { ProjectManifest } from "../../../schemas/project.js";
import type { WorkflowDefinition } from "../../../schemas/workflow-dag.js";
import { resolveWorkflowTemplate } from "../task-create-workflow.js";

/** Minimal valid workflow definition for testing. */
const CODE_REVIEW_WORKFLOW: WorkflowDefinition = {
  name: "code-review",
  hops: [
    { id: "implement", role: "swe-backend", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "review", role: "swe-qa", dependsOn: ["implement"], joinType: "all", autoAdvance: true, canReject: false },
  ],
};

const DEPLOY_WORKFLOW: WorkflowDefinition = {
  name: "deploy-pipeline",
  hops: [
    { id: "build", role: "swe-backend", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "test", role: "swe-qa", dependsOn: ["build"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "deploy", role: "swe-ops", dependsOn: ["test"], joinType: "all", autoAdvance: true, canReject: false },
  ],
};

/** Helper: build a valid project manifest with workflow templates. */
function buildManifestWithTemplates(
  templates: Record<string, WorkflowDefinition>,
): ProjectManifest {
  return {
    id: "test-project",
    title: "Test Project",
    status: "active",
    type: "swe",
    owner: { team: "test-team", lead: "test-lead" },
    participants: [],
    routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: true } },
    memory: {
      tiers: { bronze: "cold", silver: "warm", gold: "warm" },
      allowIndex: { warmPaths: ["Artifacts/Silver", "Artifacts/Gold"] },
      denyIndex: ["Cold", "Artifacts/Bronze", "State", "Tasks"],
    },
    links: { dashboards: [], docs: [] },
    workflowTemplates: templates,
  };
}

describe("resolveWorkflowTemplate", () => {
  let testDir: string;
  let store: FilesystemTaskStore;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "aof-workflow-cli-test-"));
    const projectDir = join(testDir, "Projects", "test-project");
    await mkdir(join(projectDir, "tasks", "backlog"), { recursive: true });

    // Write project manifest with workflow templates
    const manifest = buildManifestWithTemplates({
      "code-review": CODE_REVIEW_WORKFLOW,
      "deploy-pipeline": DEPLOY_WORKFLOW,
    });
    await writeFile(
      join(projectDir, "project.yaml"),
      stringifyYaml(manifest, { lineWidth: 120 }),
      "utf-8",
    );

    store = new FilesystemTaskStore(projectDir, { projectId: "test-project" });
    await store.init();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("resolves template from project manifest and passes to store.create", async () => {
    const projectRoot = join(testDir, "Projects", "test-project");
    const result = await resolveWorkflowTemplate("code-review", projectRoot);

    expect(result.definition).toBeDefined();
    expect(result.definition.name).toBe("code-review");
    expect(result.definition.hops).toHaveLength(2);
    expect(result.templateName).toBe("code-review");
  });

  it("throws actionable error for unknown template name", async () => {
    const projectRoot = join(testDir, "Projects", "test-project");

    await expect(
      resolveWorkflowTemplate("nonexistent", projectRoot),
    ).rejects.toThrow(/not found in project manifest/);
    await expect(
      resolveWorkflowTemplate("nonexistent", projectRoot),
    ).rejects.toThrow(/Available: code-review, deploy-pipeline/);
  });

  it("throws error when project has no workflowTemplates", async () => {
    // Write a manifest without templates
    const noTemplateProjDir = join(testDir, "Projects", "no-templates");
    await mkdir(join(noTemplateProjDir, "tasks", "backlog"), { recursive: true });

    const manifest = {
      id: "no-templates",
      title: "No Templates Project",
      status: "active" as const,
      type: "swe" as const,
      owner: { team: "test-team", lead: "test-lead" },
      participants: [],
      routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: true } },
      memory: {
        tiers: { bronze: "cold" as const, silver: "warm" as const, gold: "warm" as const },
        allowIndex: { warmPaths: ["Artifacts/Silver", "Artifacts/Gold"] },
        denyIndex: ["Cold", "Artifacts/Bronze", "State", "Tasks"],
      },
      links: { dashboards: [], docs: [] },
    };
    await writeFile(
      join(noTemplateProjDir, "project.yaml"),
      stringifyYaml(manifest, { lineWidth: 120 }),
      "utf-8",
    );

    await expect(
      resolveWorkflowTemplate("code-review", noTemplateProjDir),
    ).rejects.toThrow(/not found in project manifest/);
  });

  it("resolved workflow includes templateName for traceability", async () => {
    const projectRoot = join(testDir, "Projects", "test-project");
    const result = await resolveWorkflowTemplate("deploy-pipeline", projectRoot);

    expect(result.templateName).toBe("deploy-pipeline");
    expect(result.definition.name).toBe("deploy-pipeline");
  });

  it("integrates end-to-end: resolved template creates task with workflow", async () => {
    const projectRoot = join(testDir, "Projects", "test-project");
    const resolved = await resolveWorkflowTemplate("code-review", projectRoot);

    const task = await store.create({
      title: "Test with workflow template",
      createdBy: "cli",
      workflow: resolved,
    });

    expect(task.frontmatter.workflow).toBeDefined();
    expect(task.frontmatter.workflow!.definition.name).toBe("code-review");
    expect(task.frontmatter.workflow!.templateName).toBe("code-review");
    expect(task.frontmatter.workflow!.state.status).toBe("pending");
    expect(task.frontmatter.workflow!.state.hops["implement"]?.status).toBe("ready");
  });
});
