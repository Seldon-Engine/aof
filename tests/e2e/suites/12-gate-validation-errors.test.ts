/**
 * E2E Test Suite 12: DAG Validation & Completion Behavior
 *
 * Tests that the DAG workflow engine handles edge cases and invalid states
 * correctly, and that non-workflow tasks still complete normally via
 * aofTaskComplete.
 *
 * Scenarios tested:
 * 1. Rejection at non-rejectable hop — treated as completion, not rejection
 * 2. needs_review at rejectable hop — triggers origin rejection cascade
 * 3. Blocked outcome — maps to hop failure with downstream cascade
 * 4. No dispatched hop — graceful no-op
 * 5. Graceful fallback for non-workflow tasks (aofTaskComplete)
 * 6. Non-workflow task with outcome params — graceful ignore
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FilesystemTaskStore, serializeTask } from "../../../src/store/task-store.js";
import type { ITaskStore } from "../../../src/store/interfaces.js";
import { EventLogger } from "../../../src/events/logger.js";
import { aofTaskComplete, type ToolContext } from "../../../src/tools/aof-tools.js";
import { handleDAGHopCompletion } from "../../../src/dispatch/dag-transition-handler.js";
import { initializeWorkflowState } from "../../../src/schemas/workflow-dag.js";
import type { WorkflowDefinition, Hop } from "../../../src/schemas/workflow-dag.js";
import type { RunResult } from "../../../src/schemas/run-result.js";
import type { Task } from "../../../src/schemas/task.js";
import { seedTestData, cleanupTestData } from "../utils/test-data.js";
import { join } from "node:path";
import { homedir } from "node:os";
import writeFileAtomic from "write-file-atomic";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "dag-validation-errors");

/**
 * Helper: Create a task with DAG workflow, first hop dispatched.
 */
async function createDAGTask(
  store: ITaskStore,
  definition: WorkflowDefinition,
  opts: { initialHop?: string; tags?: string[] } = {},
): Promise<Task> {
  const task = await store.create({
    title: "Test task",
    body: "# Work",
    createdBy: "system",
  });
  await store.transition(task.frontmatter.id, "ready");
  await store.transition(task.frontmatter.id, "in-progress");

  const reloaded = await store.get(task.frontmatter.id);
  if (!reloaded) throw new Error(`Task not found after transition`);

  const state = initializeWorkflowState(definition);
  const hopId = opts.initialHop ?? definition.hops[0]!.id;
  state.hops[hopId] = {
    ...state.hops[hopId]!,
    status: "dispatched",
    startedAt: new Date().toISOString(),
    agent: "test-agent",
  };
  state.status = "running";

  reloaded.frontmatter.workflow = { definition, state };
  reloaded.frontmatter.routing = {
    role: "test-role",
    tags: opts.tags ?? [],
  };

  const taskPath = join(
    TEST_DATA_DIR, "tasks", reloaded.frontmatter.status, `${reloaded.frontmatter.id}.md`,
  );
  await writeFileAtomic(taskPath, serializeTask(reloaded));
  return reloaded;
}

function makeRunResult(taskId: string, outcome: string, notes: string = ""): RunResult {
  return {
    taskId,
    agentId: "test-agent",
    completedAt: new Date().toISOString(),
    outcome: outcome as any,
    summaryRef: "summary.md",
    handoffRef: "handoff.md",
    deliverables: [],
    tests: { passed: 1, failed: 0, total: 1 },
    blockers: [],
    notes,
  };
}

describe("E2E: DAG Validation & Completion Behavior", () => {
  let store: ITaskStore;
  let logger: EventLogger;
  let ctx: ToolContext;

  beforeEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
    await seedTestData(TEST_DATA_DIR);
    store = new FilesystemTaskStore(TEST_DATA_DIR);
    logger = new EventLogger(join(TEST_DATA_DIR, "events"));
    ctx = { store, logger };
  });

  afterEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
  });

  describe("Scenario 1: Rejection at non-rejectable hop", () => {
    it("should treat needs_review as completion when canReject is false", async () => {
      const definition: WorkflowDefinition = {
        name: "simple-workflow",
        hops: [
          { id: "ready-check", role: "swe-backend", dependsOn: [], autoAdvance: true },
          { id: "qa", role: "swe-qa", dependsOn: ["ready-check"], canReject: true, autoAdvance: true },
        ] as Hop[],
      };

      const task = await createDAGTask(store, definition);
      const runResult = makeRunResult(task.frontmatter.id, "needs_review", "Some feedback");

      // On a non-rejectable hop, needs_review maps to "complete" (not "rejected")
      const result = await handleDAGHopCompletion(store, logger, task, runResult);

      const updated = await store.get(task.frontmatter.id);
      // ready-check completes (needs_review treated as complete since canReject=false)
      expect(updated?.frontmatter.workflow?.state.hops["ready-check"]?.status).toBe("complete");
      // qa should be the next hop
      expect(result.readyHops).toContain("qa");
    });
  });

  describe("Scenario 2: Rejection at rejectable hop triggers origin cascade", () => {
    it("should reset all hops when needs_review on canReject=true hop", async () => {
      const definition: WorkflowDefinition = {
        name: "simple-workflow",
        hops: [
          { id: "dev", role: "swe-backend", dependsOn: [], autoAdvance: true },
          { id: "qa", role: "swe-qa", dependsOn: ["dev"], canReject: true, rejectionStrategy: "origin", autoAdvance: true },
        ] as Hop[],
      };

      // Start at qa hop (dev already completed)
      const task = await createDAGTask(store, definition, { initialHop: "qa" });
      // Set dev to complete
      task.frontmatter.workflow!.state.hops["dev"] = {
        ...task.frontmatter.workflow!.state.hops["dev"]!,
        status: "complete",
        completedAt: new Date().toISOString(),
      };
      await writeFileAtomic(task.path!, serializeTask(task));

      const runResult = makeRunResult(task.frontmatter.id, "needs_review", "Issues found");

      const result = await handleDAGHopCompletion(store, logger, task, runResult);

      const updated = await store.get(task.frontmatter.id);
      // Origin rejection: dev reset to ready, qa reset to pending
      expect(updated?.frontmatter.workflow?.state.hops["dev"]?.status).toBe("ready");
      expect(updated?.frontmatter.workflow?.state.hops["qa"]?.status).toBe("pending");
      expect(updated?.frontmatter.workflow?.state.hops["qa"]?.rejectionCount).toBe(1);
      expect(result.readyHops).toContain("dev");
    });
  });

  describe("Scenario 3: Blocked outcome maps to hop failure", () => {
    it("should mark hop as failed and cascade skips downstream", async () => {
      const definition: WorkflowDefinition = {
        name: "simple-workflow",
        hops: [
          { id: "dev", role: "swe-backend", dependsOn: [], autoAdvance: true },
          { id: "deploy", role: "swe-devops", dependsOn: ["dev"], autoAdvance: true },
        ] as Hop[],
      };

      const task = await createDAGTask(store, definition);
      const runResult = makeRunResult(task.frontmatter.id, "blocked", "Waiting on infra");

      const result = await handleDAGHopCompletion(store, logger, task, runResult);

      const updated = await store.get(task.frontmatter.id);
      // Blocked maps to "failed"
      expect(updated?.frontmatter.workflow?.state.hops["dev"]?.status).toBe("failed");
      // deploy cascaded to skipped
      expect(updated?.frontmatter.workflow?.state.hops["deploy"]?.status).toBe("skipped");
    });
  });

  describe("Scenario 4: No dispatched hop — graceful no-op", () => {
    it("should return empty result when no hop is dispatched", async () => {
      const definition: WorkflowDefinition = {
        name: "simple-workflow",
        hops: [
          { id: "dev", role: "swe-backend", dependsOn: [], autoAdvance: true },
        ] as Hop[],
      };

      const task = await store.create({
        title: "Test task",
        body: "# Work",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      const reloaded = await store.get(task.frontmatter.id);
      if (!reloaded) throw new Error("Task not found");

      // Set workflow with dev=ready (NOT dispatched)
      const state = initializeWorkflowState(definition);
      reloaded.frontmatter.workflow = { definition, state };
      const taskPath = join(
        TEST_DATA_DIR, "tasks", reloaded.frontmatter.status, `${reloaded.frontmatter.id}.md`,
      );
      await writeFileAtomic(taskPath, serializeTask(reloaded));

      const runResult = makeRunResult(reloaded.frontmatter.id, "done");

      const result = await handleDAGHopCompletion(store, logger, reloaded, runResult);

      // No dispatched hop → graceful no-op
      expect(result.readyHops).toHaveLength(0);
      expect(result.dagComplete).toBe(false);
    });
  });

  describe("Scenario 5: Graceful fallback for non-workflow tasks", () => {
    it("should complete task normally when no workflow but outcome provided", async () => {
      const task = await store.create({
        title: "Legacy task",
        body: "# Work",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      await store.transition(task.frontmatter.id, "review");

      // No DAG workflow, but agent sends outcome
      // Should gracefully ignore outcome and complete normally
      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "test-agent",
        summary: "Completed",
        outcome: "complete", // Ignored for non-workflow tasks
      });

      expect(result.status).toBe("done");
      expect(result.taskId).toBe(task.frontmatter.id);
    });

    it("should handle non-workflow task with outcome and blockers gracefully", async () => {
      const task = await store.create({
        title: "Legacy task with params",
        body: "# Work",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      await store.transition(task.frontmatter.id, "review");

      // No workflow, but agent sends outcome and blockers
      // Should complete normally and ignore workflow parameters
      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "test-agent",
        summary: "Completed",
        outcome: "complete",
        blockers: ["Some blocker"], // Should be ignored
      });

      expect(result.status).toBe("done");
    });
  });
});
