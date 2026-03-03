/**
 * TaskStore Workflow Support Tests
 *
 * Tests workflow DAG auto-validation and auto-initialization in store.create().
 * Both ad-hoc (agent-authored) and template-resolved (CLI-resolved) paths
 * produce identical TaskWorkflow runtime objects.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../task-store.js";
import type { WorkflowDefinition } from "../../schemas/workflow-dag.js";

/** Minimal valid 2-hop DAG for testing. */
const VALID_DEFINITION: WorkflowDefinition = {
  name: "test-workflow",
  hops: [
    { id: "implement", role: "swe-backend", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "review", role: "swe-qa", dependsOn: ["implement"], joinType: "all", autoAdvance: true, canReject: false },
  ],
};

/** 3-hop DAG with fork-join pattern. */
const FORK_JOIN_DEFINITION: WorkflowDefinition = {
  name: "fork-join",
  hops: [
    { id: "start", role: "swe-backend", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
    { id: "test", role: "swe-qa", dependsOn: ["start"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "deploy", role: "swe-ops", dependsOn: ["start", "test"], joinType: "all", autoAdvance: true, canReject: false },
  ],
};

/** Invalid DAG: cycle between hops. */
const CYCLIC_DEFINITION: WorkflowDefinition = {
  name: "cyclic",
  hops: [
    { id: "a", role: "swe", dependsOn: ["b"], joinType: "all", autoAdvance: true, canReject: false },
    { id: "b", role: "swe", dependsOn: ["a"], joinType: "all", autoAdvance: true, canReject: false },
  ],
};

/** Invalid DAG: dangling dependency reference. */
const DANGLING_DEP_DEFINITION: WorkflowDefinition = {
  name: "dangling",
  hops: [
    { id: "a", role: "swe", dependsOn: ["nonexistent"], joinType: "all", autoAdvance: true, canReject: false },
  ],
};

describe("TaskStore Workflow Support", () => {
  let tmpDir: string;
  let store: FilesystemTaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-workflow-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("store.create() with ad-hoc workflow definition", () => {
    it("auto-validates and auto-initializes a valid workflow definition", async () => {
      const task = await store.create({
        title: "Task with workflow",
        createdBy: "test-agent",
        workflow: { definition: VALID_DEFINITION },
      });

      expect(task.frontmatter.workflow).toBeDefined();
      const wf = task.frontmatter.workflow!;

      // Definition preserved
      expect(wf.definition.name).toBe("test-workflow");
      expect(wf.definition.hops).toHaveLength(2);

      // State auto-initialized
      expect(wf.state).toBeDefined();
      expect(wf.state.status).toBe("pending");
      expect(wf.state.hops["implement"]?.status).toBe("ready"); // root hop
      expect(wf.state.hops["review"]?.status).toBe("pending"); // depends on implement
    });

    it("throws on invalid workflow definition (cycle)", async () => {
      await expect(
        store.create({
          title: "Cyclic DAG",
          createdBy: "test-agent",
          workflow: { definition: CYCLIC_DEFINITION },
        }),
      ).rejects.toThrow("Workflow DAG invalid");
    });

    it("throws on invalid workflow definition (dangling dep)", async () => {
      await expect(
        store.create({
          title: "Dangling dep",
          createdBy: "test-agent",
          workflow: { definition: DANGLING_DEP_DEFINITION },
        }),
      ).rejects.toThrow("Workflow DAG invalid");
    });

    it("works without workflow field (backward compat)", async () => {
      const task = await store.create({
        title: "No workflow",
        createdBy: "test-agent",
      });

      expect(task.frontmatter.workflow).toBeUndefined();
    });

    it("preserves templateName on resulting TaskWorkflow", async () => {
      const task = await store.create({
        title: "Template-resolved task",
        createdBy: "cli",
        workflow: {
          definition: VALID_DEFINITION,
          templateName: "code-review",
        },
      });

      expect(task.frontmatter.workflow).toBeDefined();
      expect(task.frontmatter.workflow!.templateName).toBe("code-review");
    });

    it("persists complete TaskWorkflow that survives round-trip", async () => {
      const task = await store.create({
        title: "Persist workflow",
        createdBy: "test-agent",
        workflow: { definition: FORK_JOIN_DEFINITION },
      });

      // Re-read from disk
      const loaded = await store.get(task.frontmatter.id);
      expect(loaded).toBeDefined();
      expect(loaded!.frontmatter.workflow).toBeDefined();

      const wf = loaded!.frontmatter.workflow!;
      expect(wf.definition.name).toBe("fork-join");
      expect(wf.definition.hops).toHaveLength(3);
      expect(wf.state.status).toBe("pending");
      expect(wf.state.hops["start"]?.status).toBe("ready");
      expect(wf.state.hops["test"]?.status).toBe("pending");
      expect(wf.state.hops["deploy"]?.status).toBe("pending");
    });
  });
});
