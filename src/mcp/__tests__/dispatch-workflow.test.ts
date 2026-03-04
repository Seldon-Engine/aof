/**
 * Tests for the workflow parameter on aof_dispatch.
 *
 * Covers: template name resolution, inline DAG validation,
 * error handling for invalid templates/DAGs, backward compatibility,
 * and explicit workflow skip via `false`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as yamlStringify } from "yaml";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import type { AofMcpContext } from "../shared.js";
import { handleAofDispatch } from "../tools.js";
import type { WorkflowDefinition } from "../../schemas/workflow-dag.js";
import type { ProjectManifest } from "../../schemas/project.js";

const ORG_CHART = `schemaVersion: 1
teams:
  - id: "swe"
    name: "Software"
agents:
  - id: "swe-backend"
    name: "Backend"
    team: "swe"
routing: []
metadata: {}
`;

/** A valid two-hop linear workflow definition for test fixtures. */
const STANDARD_REVIEW: WorkflowDefinition = {
  name: "standard-review",
  hops: [
    { id: "implement", role: "swe-backend", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "review", role: "swe-qa", dependsOn: ["implement"], joinType: "all", autoAdvance: true, canReject: false },
  ],
};

/** A valid parallel fan-out workflow. */
const PARALLEL_WORKFLOW: WorkflowDefinition = {
  name: "parallel-build",
  hops: [
    { id: "plan", role: "swe-backend", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "frontend", role: "swe-frontend", dependsOn: ["plan"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "backend", role: "swe-backend", dependsOn: ["plan"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "integrate", role: "swe-qa", dependsOn: ["frontend", "backend"], joinType: "all", autoAdvance: true, canReject: false },
  ],
};

describe("aof_dispatch workflow parameter", () => {
  let dataDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "aof-mcp-wf-"));
    store = new FilesystemTaskStore(dataDir);
    await store.init();
    await mkdir(join(dataDir, "org"), { recursive: true });
    await writeFile(join(dataDir, "org", "org-chart.yaml"), ORG_CHART);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Helper to build an AofMcpContext with projectConfig. */
  function makeCtx(projectConfig?: ProjectManifest): AofMcpContext {
    return {
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
      orgChartPath: join(dataDir, "org", "org-chart.yaml"),
      projectConfig,
    };
  }

  /** Minimal valid project manifest with workflow templates. */
  const PROJECT_CONFIG: ProjectManifest = {
    id: "test-proj",
    title: "Test Project",
    status: "active",
    type: "swe",
    owner: { team: "swe", lead: "swe-backend" },
    participants: [],
    routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: true } },
    memory: {
      tiers: { bronze: "cold", silver: "warm", gold: "warm" },
      allowIndex: { warmPaths: [] },
      denyIndex: [],
    },
    links: { dashboards: [], docs: [] },
    workflowTemplates: {
      "standard-review": STANDARD_REVIEW,
      "parallel-build": PARALLEL_WORKFLOW,
    },
  };

  it("Test 1: resolves template name from project config and creates task with workflow", async () => {
    const ctx = makeCtx(PROJECT_CONFIG);

    const result = await handleAofDispatch(ctx, {
      title: "Task with template workflow",
      brief: "Test template resolution",
      workflow: "standard-review",
    });

    expect(result.taskId).toBeDefined();

    const task = await store.get(result.taskId);
    expect(task).toBeDefined();
    expect(task!.frontmatter.workflow).toBeDefined();
    expect(task!.frontmatter.workflow!.templateName).toBe("standard-review");
    expect(task!.frontmatter.workflow!.definition.name).toBe("standard-review");
    expect(task!.frontmatter.workflow!.definition.hops).toHaveLength(2);
    // State should be initialized
    expect(task!.frontmatter.workflow!.state.status).toBe("pending");
    expect(task!.frontmatter.workflow!.state.hops["implement"]?.status).toBe("ready");
    expect(task!.frontmatter.workflow!.state.hops["review"]?.status).toBe("pending");
  });

  it("Test 2: passes inline DAG directly after validation", async () => {
    const ctx = makeCtx(PROJECT_CONFIG);
    const inlineDAG: WorkflowDefinition = {
      name: "custom-inline",
      hops: [
        { id: "build", role: "swe-backend", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
        { id: "test", role: "swe-qa", dependsOn: ["build"], joinType: "all", autoAdvance: true, canReject: false },
      ],
    };

    const result = await handleAofDispatch(ctx, {
      title: "Task with inline workflow",
      brief: "Test inline DAG",
      workflow: inlineDAG,
    });

    const task = await store.get(result.taskId);
    expect(task).toBeDefined();
    expect(task!.frontmatter.workflow).toBeDefined();
    expect(task!.frontmatter.workflow!.templateName).toBeUndefined();
    expect(task!.frontmatter.workflow!.definition.name).toBe("custom-inline");
    expect(task!.frontmatter.workflow!.definition.hops).toHaveLength(2);
    expect(task!.frontmatter.workflow!.state.hops["build"]?.status).toBe("ready");
  });

  it("Test 3: returns MCP error for nonexistent template name", async () => {
    const ctx = makeCtx(PROJECT_CONFIG);

    await expect(
      handleAofDispatch(ctx, {
        title: "Bad template",
        brief: "Should fail",
        workflow: "nonexistent-template",
      }),
    ).rejects.toThrow(/Unknown workflow template.*nonexistent-template/);
  });

  it("Test 4: returns MCP error for invalid inline DAG with cycle", async () => {
    const ctx = makeCtx(PROJECT_CONFIG);
    const cyclicDAG: WorkflowDefinition = {
      name: "cyclic",
      hops: [
        { id: "a", role: "swe", dependsOn: ["b"], joinType: "all", autoAdvance: true, canReject: false },
        { id: "b", role: "swe", dependsOn: ["a"], joinType: "all", autoAdvance: true, canReject: false },
      ],
    };

    await expect(
      handleAofDispatch(ctx, {
        title: "Cyclic DAG",
        brief: "Should fail",
        workflow: cyclicDAG,
      }),
    ).rejects.toThrow(/Invalid workflow DAG/);
  });

  it("Test 5: creates task without workflow when workflow param omitted (backward compatible)", async () => {
    const ctx = makeCtx(PROJECT_CONFIG);

    const result = await handleAofDispatch(ctx, {
      title: "No workflow task",
      brief: "Should create normally",
    });

    const task = await store.get(result.taskId);
    expect(task).toBeDefined();
    expect(task!.frontmatter.workflow).toBeUndefined();
  });

  it("Test 6: workflow: false explicitly skips any default workflow", async () => {
    const configWithDefault: ProjectManifest = {
      ...PROJECT_CONFIG,
      defaultWorkflow: "standard-review",
    };
    const ctx = makeCtx(configWithDefault);

    const result = await handleAofDispatch(ctx, {
      title: "Skip workflow task",
      brief: "Explicit skip",
      workflow: false,
    });

    const task = await store.get(result.taskId);
    expect(task).toBeDefined();
    expect(task!.frontmatter.workflow).toBeUndefined();
  });

  it("returns MCP error for template name when no project config available", async () => {
    const ctx = makeCtx(undefined); // No project config

    await expect(
      handleAofDispatch(ctx, {
        title: "No config",
        brief: "Should fail",
        workflow: "standard-review",
      }),
    ).rejects.toThrow(/Unknown workflow template|No project config/);
  });
});
