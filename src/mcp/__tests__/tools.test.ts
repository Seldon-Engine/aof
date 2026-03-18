import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { createAofMcpContext } from "../shared.js";
import {
  handleAofDispatch,
  handleAofStatusReport,
  handleAofTaskComplete,
  handleAofTaskUpdate,
  handleAofTaskEdit,
  handleAofTaskCancel,
  handleAofTaskBlock,
  handleAofTaskUnblock,
  handleAofTaskDepAdd,
  handleAofTaskDepRemove,
  handleAofProjectCreate,
  handleAofProjectList,
} from "../tools.js";
import { aofTaskSubscribe, aofTaskUnsubscribe } from "../../tools/subscription-tools.js";
import { buildBoard } from "../resources.js";

const ORG_CHART = `schemaVersion: 1
teams:
  - id: "swe"
    name: "Software"
agents:
  - id: "swe-backend"
    name: "Backend"
    team: "swe"
  - id: "swe-qa"
    name: "QA"
    team: "swe"
routing: []
metadata: {}
`;

describe("mcp tools", () => {
  let dataDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "aof-mcp-tools-"));
    store = new FilesystemTaskStore(dataDir);
    await store.init();
    await mkdir(join(dataDir, "org"), { recursive: true });
    await writeFile(join(dataDir, "org", "org-chart.yaml"), ORG_CHART);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("creates a task via aof_dispatch", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const result = await handleAofDispatch(ctx, {
      title: "Test dispatch",
      brief: "Dispatch a task",
      assignedAgent: "swe-backend",
      priority: "medium",
    });

    const created = await store.get(result.taskId);
    expect(created).toBeDefined();
    expect(created?.frontmatter.status).toBe("ready");
    expect(created?.frontmatter.routing.agent).toBe("swe-backend");
    expect(result.status).toBe("ready");
  });

  it("updates a task via aof_task_update", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const task = await store.create({
      title: "Update me",
      body: "Initial body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    const result = await handleAofTaskUpdate(ctx, {
      taskId: task.frontmatter.id,
      status: "in-progress",
      workLog: "Started work",
      outputs: ["dist/output.txt"],
    });

    const updated = await store.get(task.frontmatter.id);
    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("in-progress");
    expect(updated?.body).toContain("Work Log");
    expect(updated?.body).toContain("Started work");
    expect(updated?.body).toContain("Outputs");
  });

  it("completes a task via aof_task_complete", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const task = await store.create({
      title: "Complete me",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    await store.transition(task.frontmatter.id, "review");

    const result = await handleAofTaskComplete(ctx, {
      taskId: task.frontmatter.id,
      summary: "Done",
      outputs: ["dist/report.md"],
    });

    const updated = await store.get(task.frontmatter.id);
    expect(result.success).toBe(true);
    expect(result.finalStatus).toBe("done");
    expect(updated?.frontmatter.status).toBe("done");
    expect(updated?.body).toContain("Completion Summary");
  });

  it("returns status report via aof_status_report", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    await store.create({
      title: "Task A",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    const task = await store.create({
      title: "Task B",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    const report = await handleAofStatusReport(ctx, {});
    expect(report.total).toBe(2);
    expect(report.byStatus.backlog).toBe(1);
    expect(report.byStatus.ready).toBe(1);
  });

  it("dispatch stores contextTier on task frontmatter", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const result = await handleAofDispatch(ctx, {
      title: "Full context task",
      brief: "Needs full skill context",
      contextTier: "full",
    });

    const created = await store.get(result.taskId);
    expect(created).toBeDefined();
    expect(created?.frontmatter.contextTier).toBe("full");
  });

  it("dispatch defaults contextTier to seed", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const result = await handleAofDispatch(ctx, {
      title: "Default context task",
      brief: "No explicit contextTier",
    });

    const created = await store.get(result.taskId);
    expect(created).toBeDefined();
    expect(created?.frontmatter.contextTier).toBe("seed");
  });

  it("builds a kanban board via aof_board", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    await store.create({
      title: "Team task",
      body: "Body",
      routing: { team: "swe" },
      createdBy: "test",
    });
    await store.create({
      title: "Other task",
      body: "Body",
      routing: { team: "ops" },
      createdBy: "test",
    });

    const board = await buildBoard(ctx, "swe");
    expect(board.team).toBe("swe");
    expect(board.columns.backlog).toHaveLength(1);
  });

  // --- New tool tests ---

  it("edits task fields via aof_task_edit", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const task = await store.create({
      title: "Edit me",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });

    const result = await handleAofTaskEdit(ctx, {
      taskId: task.frontmatter.id,
      title: "Edited title",
      priority: "high",
    });

    expect(result.success).toBe(true);
    expect(result.updatedFields).toContain("title");
    expect(result.updatedFields).toContain("priority");

    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.title).toBe("Edited title");
    expect(updated?.frontmatter.priority).toBe("high");
  });

  it("cancels a task via aof_task_cancel", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const task = await store.create({
      title: "Cancel me",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });

    const result = await handleAofTaskCancel(ctx, {
      taskId: task.frontmatter.id,
      reason: "No longer needed",
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe("cancelled");
    expect(result.reason).toBe("No longer needed");
  });

  it("blocks and unblocks a task", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const task = await store.create({
      title: "Block me",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    const blockResult = await handleAofTaskBlock(ctx, {
      taskId: task.frontmatter.id,
      reason: "Waiting for API key",
    });

    expect(blockResult.success).toBe(true);
    expect(blockResult.status).toBe("blocked");
    expect(blockResult.reason).toBe("Waiting for API key");

    const unblockResult = await handleAofTaskUnblock(ctx, {
      taskId: task.frontmatter.id,
    });

    expect(unblockResult.success).toBe(true);
    expect(unblockResult.status).toBe("ready");
  });

  it("adds and removes dependencies", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const taskA = await store.create({
      title: "Task A",
      body: "Body",
      routing: {},
      createdBy: "test",
    });
    const taskB = await store.create({
      title: "Task B (depends on A)",
      body: "Body",
      routing: {},
      createdBy: "test",
    });

    const addResult = await handleAofTaskDepAdd(ctx, {
      taskId: taskB.frontmatter.id,
      blockerId: taskA.frontmatter.id,
    });

    expect(addResult.success).toBe(true);
    expect(addResult.dependsOn).toContain(taskA.frontmatter.id);

    const removeResult = await handleAofTaskDepRemove(ctx, {
      taskId: taskB.frontmatter.id,
      blockerId: taskA.frontmatter.id,
    });

    expect(removeResult.success).toBe(true);
    expect(removeResult.dependsOn).not.toContain(taskA.frontmatter.id);
  });

  it("creates a project via aof_project_create", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const result = await handleAofProjectCreate(ctx, {
      id: "test-project",
      title: "Test Project",
      type: "swe",
    });

    expect(result.projectId).toBe("test-project");
    expect(result.projectRoot).toContain("test-project");
    expect(result.directoriesCreated).toContain("tasks");
  });

  it("lists projects via aof_project_list", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    // Create a project first
    await handleAofProjectCreate(ctx, { id: "list-test" });

    const result = await handleAofProjectList(ctx);

    expect(result.projects).toBeDefined();
    expect(result.projects.length).toBeGreaterThanOrEqual(1);
    const found = result.projects.find(p => p.id === "list-test");
    expect(found).toBeDefined();
  });

  // --- Subscription tool tests ---

  it("subscribes to a task via aof_task_subscribe", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const task = await store.create({
      title: "Subscribe target",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    const result = await aofTaskSubscribe({ store: ctx.store, logger: ctx.logger, orgChartPath: ctx.orgChartPath }, {
      taskId: task.frontmatter.id,
      subscriberId: "swe-qa",
      granularity: "completion",
    });

    expect(result.subscriptionId).toBeDefined();
    expect(result.taskId).toBe(task.frontmatter.id);
    expect(result.granularity).toBe("completion");
    expect(result.status).toBe("active");
    expect(result.taskStatus).toBe("ready");
    expect(result.createdAt).toBeDefined();
  });

  it("subscribe throws McpError for non-existent task", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    await expect(
      aofTaskSubscribe({ store: ctx.store, logger: ctx.logger, orgChartPath: ctx.orgChartPath }, {
        taskId: "non-existent-task-id",
        subscriberId: "swe-backend",
        granularity: "completion",
      }),
    ).rejects.toThrow(/Task not found/);
  });

  it("subscribe returns existing subscription for duplicate", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const task = await store.create({
      title: "Duplicate sub target",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    const first = await aofTaskSubscribe({ store: ctx.store, logger: ctx.logger, orgChartPath: ctx.orgChartPath }, {
      taskId: task.frontmatter.id,
      subscriberId: "swe-qa",
      granularity: "completion",
    });

    const second = await aofTaskSubscribe({ store: ctx.store, logger: ctx.logger, orgChartPath: ctx.orgChartPath }, {
      taskId: task.frontmatter.id,
      subscriberId: "swe-qa",
      granularity: "completion",
    });

    expect(second.subscriptionId).toBe(first.subscriptionId);
  });

  it("unsubscribes from a task via aof_task_unsubscribe", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const task = await store.create({
      title: "Unsubscribe target",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    const sub = await aofTaskSubscribe({ store: ctx.store, logger: ctx.logger, orgChartPath: ctx.orgChartPath }, {
      taskId: task.frontmatter.id,
      subscriberId: "swe-qa",
      granularity: "all",
    });

    const result = await aofTaskUnsubscribe({ store: ctx.store, logger: ctx.logger, orgChartPath: ctx.orgChartPath }, {
      taskId: task.frontmatter.id,
      subscriptionId: sub.subscriptionId,
    });

    expect(result.subscriptionId).toBe(sub.subscriptionId);
    expect(result.status).toBe("cancelled");
  });

  it("unsubscribe throws McpError for non-existent subscription", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const task = await store.create({
      title: "Unsub error target",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await expect(
      aofTaskUnsubscribe({ store: ctx.store, logger: ctx.logger, orgChartPath: ctx.orgChartPath }, {
        taskId: task.frontmatter.id,
        subscriptionId: "non-existent-sub-id",
      }),
    ).rejects.toThrow(/Subscription not found/);
  });

  it("unsubscribe throws McpError for non-existent task", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    await expect(
      aofTaskUnsubscribe({ store: ctx.store, logger: ctx.logger, orgChartPath: ctx.orgChartPath }, {
        taskId: "non-existent-task-id",
        subscriptionId: "some-sub-id",
      }),
    ).rejects.toThrow(/Task not found/);
  });

  // --- Dispatch + subscribe tests ---

  it("dispatch with subscribe: completion returns subscriptionId", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const result = await handleAofDispatch(ctx, {
      title: "Dispatch with sub",
      brief: "Subscribe at dispatch",
      subscribe: "completion",
      actor: "swe-backend",
    });

    expect(result.taskId).toBeDefined();
    expect(result.subscriptionId).toBeDefined();
    expect(typeof result.subscriptionId).toBe("string");
    expect(result.subscriptionId!.length).toBeGreaterThan(0);
  });

  it("dispatch with subscribe: all returns subscriptionId", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const result = await handleAofDispatch(ctx, {
      title: "Dispatch with all sub",
      brief: "Subscribe all at dispatch",
      subscribe: "all",
      actor: "swe-qa",
    });

    expect(result.subscriptionId).toBeDefined();
  });

  it("dispatch without subscribe does not include subscriptionId", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const result = await handleAofDispatch(ctx, {
      title: "Dispatch no sub",
      brief: "No subscribe param",
    });

    expect(result.subscriptionId).toBeUndefined();
  });

  it("dispatch with subscribe uses actor as subscriberId", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const result = await handleAofDispatch(ctx, {
      title: "Dispatch actor sub",
      brief: "Subscribe with actor",
      subscribe: "completion",
      actor: "swe-qa",
    });

    expect(result.subscriptionId).toBeDefined();

    // Verify subscriberId matches actor
    const subs = await ctx.subscriptionStore.list(result.taskId, { status: "active" });
    const match = subs.find(s => s.id === result.subscriptionId);
    expect(match).toBeDefined();
    expect(match!.subscriberId).toBe("swe-qa");
  });

  it("dispatch with subscribe but no actor defaults to mcp (rejected if not in org chart)", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    // "mcp" is not in the org chart, so this should fail with validation error
    await expect(
      handleAofDispatch(ctx, {
        title: "Dispatch default sub",
        brief: "Subscribe with default actor",
        subscribe: "completion",
      }),
    ).rejects.toThrow(/not found in org chart/);
  });

  // --- Org chart validation tests (Phase 30-02) ---

  it("subscribe with valid subscriberId (in org chart) succeeds", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const task = await store.create({
      title: "Valid sub target",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    const result = await aofTaskSubscribe({ store: ctx.store, logger: ctx.logger, orgChartPath: ctx.orgChartPath }, {
      taskId: task.frontmatter.id,
      subscriberId: "swe-backend",
      granularity: "completion",
    });

    expect(result.subscriptionId).toBeDefined();
    expect(result.status).toBe("active");
  });

  it("subscribe with invalid subscriberId (not in org chart) throws McpError", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const task = await store.create({
      title: "Invalid sub target",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await expect(
      aofTaskSubscribe({ store: ctx.store, logger: ctx.logger, orgChartPath: ctx.orgChartPath }, {
        taskId: task.frontmatter.id,
        subscriberId: "nonexistent-agent",
        granularity: "completion",
      }),
    ).rejects.toThrow(/not found in org chart/);
  });

  it("dispatch with subscribe and valid actor succeeds with subscription", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const result = await handleAofDispatch(ctx, {
      title: "Dispatch valid actor sub",
      brief: "Subscribe with valid actor",
      subscribe: "completion",
      actor: "swe-backend",
    });

    expect(result.subscriptionId).toBeDefined();
  });

  it("dispatch with subscribe and invalid actor throws McpError", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    await expect(
      handleAofDispatch(ctx, {
        title: "Dispatch invalid actor sub",
        brief: "Subscribe with invalid actor",
        subscribe: "completion",
        actor: "nonexistent",
      }),
    ).rejects.toThrow(/not found in org chart/);
  });

  // --- callbackDepth propagation tests (SAFE-01) ---

  it("handleAofDispatch passes callbackDepth to store.create when ctx.callbackDepth > 0", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
      callbackDepth: 2,
    });

    const result = await handleAofDispatch(ctx, {
      title: "Depth propagation test",
      brief: "Should have callbackDepth",
    });

    const created = await store.get(result.taskId);
    expect(created).toBeDefined();
    expect(created?.frontmatter.callbackDepth).toBe(2);
  });

  it("handleAofDispatch does NOT set callbackDepth when ctx.callbackDepth is 0", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const result = await handleAofDispatch(ctx, {
      title: "No depth task",
      brief: "Should not have callbackDepth",
    });

    const created = await store.get(result.taskId);
    expect(created).toBeDefined();
    expect(created?.frontmatter.callbackDepth).toBeUndefined();
  });

  it("subscribe with mcp as subscriberId validates against org chart", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const task = await store.create({
      title: "Mcp sub target",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    // "mcp" is NOT in the org chart fixture, so this should fail
    await expect(
      aofTaskSubscribe({ store: ctx.store, logger: ctx.logger, orgChartPath: ctx.orgChartPath }, {
        taskId: task.frontmatter.id,
        subscriberId: "mcp",
        granularity: "completion",
      }),
    ).rejects.toThrow(/not found in org chart/);
  });
});
