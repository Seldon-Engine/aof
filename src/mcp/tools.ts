import { z } from "zod";
import { aofDispatch } from "../dispatch/aof-dispatch.js";
import { aofStatusReport } from "../tools/aof-tools.js";
import { aofTaskComplete, aofTaskUpdate, aofTaskEdit, aofTaskCancel, aofTaskDepAdd, aofTaskDepRemove, aofTaskBlock, aofTaskUnblock } from "../tools/aof-tools.js";
import type { TaskStatus, TaskPriority } from "../schemas/task.js";
import type { DispatchResult } from "../dispatch/aof-dispatch.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadOrgChart } from "../org/loader.js";
import { appendSection, formatTimestamp, normalizePriority, resolveTask, type AofMcpContext } from "./shared.js";
import { WorkflowDefinition, validateDAG, type WorkflowDefinition as WorkflowDefinitionType } from "../schemas/workflow-dag.js";

const dispatchInputSchema = z.object({
  title: z.string().min(1),
  brief: z.string().min(1),
  type: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "critical", "normal"]).optional(),
  assignedAgent: z.string().optional(),
  ownerTeam: z.string().optional(),
  inputs: z.array(z.string()).optional(),
  checklist: z.array(z.string()).optional(),
  actor: z.string().optional(),
  /** Workflow: template name (string), inline WorkflowDefinition (object), or false (skip). */
  workflow: z.union([z.string(), WorkflowDefinition, z.literal(false)]).optional(),
  /** Context tier for skill injection: 'seed' (minimal) or 'full' (complete). Defaults to 'seed'. */
  contextTier: z.enum(["seed", "full"]).optional(),
  /** Subscribe to task outcome notifications at dispatch time. */
  subscribe: z.enum(["completion", "all"]).optional(),
});

const dispatchOutputSchema = z.object({
  taskId: z.string(),
  status: z.string(),
  assignedAgent: z.string().optional(),
  filePath: z.string().optional(),
  sessionId: z.string().optional(),
  subscriptionId: z.string().optional(),
});

const taskUpdateInputSchema = z.object({
  taskId: z.string(),
  status: z.enum(["backlog", "ready", "in-progress", "blocked", "review", "done"]).optional(),
  workLog: z.string().optional(),
  outputs: z.array(z.string()).optional(),
  blockedReason: z.string().optional(),
  body: z.string().optional(),
  actor: z.string().optional(),
});

const taskUpdateOutputSchema = z.object({
  success: z.boolean(),
  taskId: z.string(),
  newStatus: z.string(),
  updatedAt: z.string(),
});

const taskCompleteInputSchema = z.object({
  taskId: z.string(),
  summary: z.string(),
  outputs: z.array(z.string()).optional(),
  skipReview: z.boolean().optional(),
  actor: z.string().optional(),
});

const taskCompleteOutputSchema = z.object({
  success: z.boolean(),
  taskId: z.string(),
  finalStatus: z.string(),
  completedAt: z.string().optional(),
});

const statusReportInputSchema = z.object({
  agentId: z.string().optional(),
  status: z.enum(["backlog", "ready", "in-progress", "blocked", "review", "done"]).optional(),
  compact: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
  actor: z.string().optional(),
});

const statusReportOutputSchema = z.object({
  total: z.number(),
  byStatus: z.record(z.string(), z.number()),
  tasks: z.array(z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    agent: z.string().optional(),
  })),
  summary: z.string().optional(),
  details: z.string().optional(),
});

const boardInputSchema = z.object({
  team: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
});

const boardOutputSchema = z.object({
  team: z.string(),
  timestamp: z.string(),
  columns: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  stats: z.record(z.string(), z.unknown()),
});

async function resolveOwnerTeam(ctx: AofMcpContext, input: z.infer<typeof dispatchInputSchema>) {
  if (input.ownerTeam) return input.ownerTeam;
  if (!input.assignedAgent) return undefined;

  const chart = await loadOrgChart(ctx.orgChartPath).catch(() => null);
  if (!chart?.success || !chart.chart) return undefined;
  return chart.chart.agents.find(agent => agent.id === input.assignedAgent)?.team;
}

export async function handleAofDispatch(ctx: AofMcpContext, input: z.infer<typeof dispatchInputSchema>) {
  const priority = normalizePriority(input.priority);
  const metadata: Record<string, unknown> = {};

  if (input.type) metadata.type = input.type;
  if (input.inputs) metadata.inputs = input.inputs;
  if (input.checklist) metadata.checklist = input.checklist;

  let body = input.brief.trim();
  if (input.checklist?.length) {
    const items = input.checklist.map(item => `- [ ] ${item}`);
    body = appendSection(body, "Checklist", items);
  }
  if (input.inputs?.length) {
    const items = input.inputs.map(item => `- ${item}`);
    body = appendSection(body, "Inputs", items);
  }

  const ownerTeam = await resolveOwnerTeam(ctx, input);

  // --- Workflow resolution ---
  let workflow: { definition: WorkflowDefinitionType; templateName?: string } | undefined;

  if (typeof input.workflow === "string") {
    // Template name: resolve from project config
    const templates = ctx.projectConfig?.workflowTemplates;
    const definition = templates?.[input.workflow];
    if (!definition) {
      const available = templates ? Object.keys(templates).join(", ") : "(none)";
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown workflow template: "${input.workflow}". Available: ${available}`,
      );
    }
    // Belt-and-suspenders validation (templates should already be valid)
    const dagErrors = validateDAG(definition);
    if (dagErrors.length > 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Workflow template "${input.workflow}" has invalid DAG: ${dagErrors.join(", ")}`,
      );
    }
    workflow = { definition, templateName: input.workflow };
  } else if (typeof input.workflow === "object" && input.workflow !== null) {
    // Inline DAG definition: validate and pass through
    const dagErrors = validateDAG(input.workflow);
    if (dagErrors.length > 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid workflow DAG: ${dagErrors.join(", ")}`,
      );
    }
    workflow = { definition: input.workflow };
  }
  // input.workflow === false or undefined: no workflow (explicit skip or backward compatible)

  const task = await ctx.store.create({
    title: input.title,
    body,
    priority,
    routing: {
      agent: input.assignedAgent,
      team: ownerTeam,
    },
    metadata,
    createdBy: input.actor ?? "mcp",
    workflow,
    contextTier: input.contextTier ?? "seed",
  });

  let currentTask = await ctx.store.transition(task.frontmatter.id, "ready");
  let status: TaskStatus = "ready";
  let sessionId: string | undefined;

  // Subscribe at dispatch time (before executor dispatch for atomicity)
  let subscriptionId: string | undefined;
  if (input.subscribe) {
    const subscriberId = input.actor ?? "mcp";
    // Validate subscriberId against org chart (Phase 30-02)
    await validateSubscriberId(ctx.orgChartPath, subscriberId);
    const existing = await ctx.subscriptionStore.list(task.frontmatter.id, { status: "active" });
    const duplicate = existing.find(s => s.subscriberId === subscriberId && s.granularity === input.subscribe);
    if (duplicate) {
      subscriptionId = duplicate.id;
    } else {
      const sub = await ctx.subscriptionStore.create(task.frontmatter.id, subscriberId, input.subscribe);
      subscriptionId = sub.id;
    }
  }

  if (ctx.executor) {
    const result: DispatchResult = await aofDispatch({
      taskId: task.frontmatter.id,
      store: ctx.store,
      executor: ctx.executor,
    });

    if (!result.success) {
      throw new McpError(ErrorCode.InternalError, result.error ?? "Dispatch failed");
    }

    currentTask = await resolveTask(ctx.store, task.frontmatter.id);
    status = "in-progress";
    sessionId = result.sessionId;
  }

  return {
    taskId: task.frontmatter.id,
    status,
    assignedAgent: input.assignedAgent,
    filePath: currentTask.path,
    sessionId,
    ...(subscriptionId && { subscriptionId }),
  };
}

export async function handleAofTaskUpdate(ctx: AofMcpContext, input: z.infer<typeof taskUpdateInputSchema>) {
  const task = await resolveTask(ctx.store, input.taskId);
  let body = input.body ?? task.body;

  if (input.workLog) {
    const entry = `- ${formatTimestamp()} ${input.workLog}`;
    body = appendSection(body, "Work Log", [entry]);
  }

  if (input.outputs?.length) {
    const items = input.outputs.map(output => `- ${output}`);
    body = appendSection(body, "Outputs", items);
  }

  const result = await aofTaskUpdate(
    { store: ctx.store, logger: ctx.logger },
    {
      taskId: task.frontmatter.id,
      status: input.status as TaskStatus | undefined,
      body: body !== task.body ? body : undefined,
      actor: input.actor ?? "mcp",
      reason: input.blockedReason,
    },
  );

  return {
    success: true,
    taskId: result.taskId,
    newStatus: result.status,
    updatedAt: result.updatedAt,
  };
}

export async function handleAofTaskComplete(ctx: AofMcpContext, input: z.infer<typeof taskCompleteInputSchema>) {
  const task = await resolveTask(ctx.store, input.taskId);
  let body = task.body;

  if (input.outputs?.length) {
    const items = input.outputs.map(output => `- ${output}`);
    body = appendSection(body, "Outputs", items);
  }

  if (body !== task.body) {
    await ctx.store.updateBody(task.frontmatter.id, body);
  }

  const result = await aofTaskComplete(
    { store: ctx.store, logger: ctx.logger },
    {
      taskId: task.frontmatter.id,
      actor: input.actor ?? "mcp",
      summary: input.summary,
    },
  );

  const updated = await ctx.store.get(result.taskId);

  return {
    success: true,
    taskId: result.taskId,
    finalStatus: result.status,
    completedAt: updated?.frontmatter.updatedAt,
  };
}

export async function handleAofStatusReport(ctx: AofMcpContext, input: z.infer<typeof statusReportInputSchema>) {
  const result = await aofStatusReport(
    { store: ctx.store, logger: ctx.logger },
    {
      actor: input.actor ?? "mcp",
      agent: input.agentId,
      status: input.status as TaskStatus | undefined,
      compact: input.compact,
      limit: input.limit,
    },
  );

  return {
    total: result.total,
    byStatus: result.byStatus,
    tasks: result.tasks,
    summary: result.summary,
    details: result.details,
  };
}

// --- Task Edit ---

const taskEditInputSchema = z.object({
  taskId: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  priority: z.enum(["low", "normal", "high", "critical"]).optional(),
  routing: z.object({
    role: z.string().optional(),
    team: z.string().optional(),
    agent: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }).optional(),
  actor: z.string().optional(),
});

const taskEditOutputSchema = z.object({
  success: z.boolean(),
  taskId: z.string(),
  updatedFields: z.array(z.string()),
});

export async function handleAofTaskEdit(ctx: AofMcpContext, input: z.infer<typeof taskEditInputSchema>) {
  const result = await aofTaskEdit(
    { store: ctx.store, logger: ctx.logger },
    {
      taskId: input.taskId,
      title: input.title,
      description: input.description,
      priority: input.priority as TaskPriority | undefined,
      routing: input.routing,
      actor: input.actor ?? "mcp",
    },
  );

  return {
    success: true,
    taskId: result.taskId,
    updatedFields: result.updatedFields,
  };
}

// --- Task Cancel ---

const taskCancelInputSchema = z.object({
  taskId: z.string(),
  reason: z.string().optional(),
  actor: z.string().optional(),
});

const taskCancelOutputSchema = z.object({
  success: z.boolean(),
  taskId: z.string(),
  status: z.string(),
  reason: z.string().optional(),
});

export async function handleAofTaskCancel(ctx: AofMcpContext, input: z.infer<typeof taskCancelInputSchema>) {
  const result = await aofTaskCancel(
    { store: ctx.store, logger: ctx.logger },
    {
      taskId: input.taskId,
      reason: input.reason,
      actor: input.actor ?? "mcp",
    },
  );

  return {
    success: true,
    taskId: result.taskId,
    status: result.status,
    reason: result.reason,
  };
}

// --- Task Block ---

const taskBlockInputSchema = z.object({
  taskId: z.string(),
  reason: z.string(),
  actor: z.string().optional(),
});

const taskBlockOutputSchema = z.object({
  success: z.boolean(),
  taskId: z.string(),
  status: z.string(),
  reason: z.string(),
});

export async function handleAofTaskBlock(ctx: AofMcpContext, input: z.infer<typeof taskBlockInputSchema>) {
  const result = await aofTaskBlock(
    { store: ctx.store, logger: ctx.logger },
    {
      taskId: input.taskId,
      reason: input.reason,
      actor: input.actor ?? "mcp",
    },
  );

  return {
    success: true,
    taskId: result.taskId,
    status: result.status,
    reason: result.reason,
  };
}

// --- Task Unblock ---

const taskUnblockInputSchema = z.object({
  taskId: z.string(),
  actor: z.string().optional(),
});

const taskUnblockOutputSchema = z.object({
  success: z.boolean(),
  taskId: z.string(),
  status: z.string(),
});

export async function handleAofTaskUnblock(ctx: AofMcpContext, input: z.infer<typeof taskUnblockInputSchema>) {
  const result = await aofTaskUnblock(
    { store: ctx.store, logger: ctx.logger },
    {
      taskId: input.taskId,
      actor: input.actor ?? "mcp",
    },
  );

  return {
    success: true,
    taskId: result.taskId,
    status: result.status,
  };
}

// --- Task Dep Add ---

const taskDepAddInputSchema = z.object({
  taskId: z.string(),
  blockerId: z.string(),
  actor: z.string().optional(),
});

const taskDepAddOutputSchema = z.object({
  success: z.boolean(),
  taskId: z.string(),
  blockerId: z.string(),
  dependsOn: z.array(z.string()),
});

export async function handleAofTaskDepAdd(ctx: AofMcpContext, input: z.infer<typeof taskDepAddInputSchema>) {
  const result = await aofTaskDepAdd(
    { store: ctx.store, logger: ctx.logger },
    {
      taskId: input.taskId,
      blockerId: input.blockerId,
      actor: input.actor ?? "mcp",
    },
  );

  return {
    success: true,
    taskId: result.taskId,
    blockerId: result.blockerId,
    dependsOn: result.dependsOn,
  };
}

// --- Task Dep Remove ---

const taskDepRemoveInputSchema = z.object({
  taskId: z.string(),
  blockerId: z.string(),
  actor: z.string().optional(),
});

const taskDepRemoveOutputSchema = z.object({
  success: z.boolean(),
  taskId: z.string(),
  blockerId: z.string(),
  dependsOn: z.array(z.string()),
});

export async function handleAofTaskDepRemove(ctx: AofMcpContext, input: z.infer<typeof taskDepRemoveInputSchema>) {
  const result = await aofTaskDepRemove(
    { store: ctx.store, logger: ctx.logger },
    {
      taskId: input.taskId,
      blockerId: input.blockerId,
      actor: input.actor ?? "mcp",
    },
  );

  return {
    success: true,
    taskId: result.taskId,
    blockerId: result.blockerId,
    dependsOn: result.dependsOn,
  };
}

// --- Task Subscribe ---

const taskSubscribeInputSchema = z.object({
  taskId: z.string(),
  subscriberId: z.string().min(1),
  granularity: z.enum(["completion", "all"]),
});

const taskSubscribeOutputSchema = z.object({
  subscriptionId: z.string(),
  taskId: z.string(),
  granularity: z.string(),
  status: z.string(),
  taskStatus: z.string(),
  createdAt: z.string(),
});

async function validateSubscriberId(orgChartPath: string, subscriberId: string): Promise<void> {
  const result = await loadOrgChart(orgChartPath);
  if (!result.success || !result.chart) {
    throw new McpError(ErrorCode.InternalError, "Failed to load org chart for subscriber validation");
  }
  const agentExists = result.chart.agents.some(a => a.id === subscriberId);
  if (!agentExists) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `subscriberId "${subscriberId}" not found in org chart. Available agents: ${result.chart.agents.map(a => a.id).join(", ")}`,
    );
  }
}

export async function handleAofTaskSubscribe(ctx: AofMcpContext, input: z.infer<typeof taskSubscribeInputSchema>) {
  const task = await resolveTask(ctx.store, input.taskId);

  // Validate subscriberId against org chart (Phase 30-02)
  await validateSubscriberId(ctx.orgChartPath, input.subscriberId);

  // Duplicate detection: find existing active subscription with same subscriberId + granularity
  const existing = await ctx.subscriptionStore.list(task.frontmatter.id, { status: "active" });
  const duplicate = existing.find(s => s.subscriberId === input.subscriberId && s.granularity === input.granularity);

  if (duplicate) {
    return {
      subscriptionId: duplicate.id,
      taskId: task.frontmatter.id,
      granularity: duplicate.granularity,
      status: duplicate.status,
      taskStatus: task.frontmatter.status,
      createdAt: duplicate.createdAt,
    };
  }

  const sub = await ctx.subscriptionStore.create(task.frontmatter.id, input.subscriberId, input.granularity);

  return {
    subscriptionId: sub.id,
    taskId: task.frontmatter.id,
    granularity: sub.granularity,
    status: sub.status,
    taskStatus: task.frontmatter.status,
    createdAt: sub.createdAt,
  };
}

// --- Task Unsubscribe ---

const taskUnsubscribeInputSchema = z.object({
  taskId: z.string(),
  subscriptionId: z.string(),
});

const taskUnsubscribeOutputSchema = z.object({
  subscriptionId: z.string(),
  status: z.literal("cancelled"),
});

export async function handleAofTaskUnsubscribe(ctx: AofMcpContext, input: z.infer<typeof taskUnsubscribeInputSchema>) {
  const task = await resolveTask(ctx.store, input.taskId);

  try {
    const cancelled = await ctx.subscriptionStore.cancel(task.frontmatter.id, input.subscriptionId);
    return {
      subscriptionId: cancelled.id,
      status: "cancelled" as const,
    };
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `Subscription not found: ${input.subscriptionId}`);
  }
}

// --- Project Create ---

const projectCreateInputSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  type: z.enum(["swe", "ops", "research", "admin", "personal", "other"]).optional(),
  participants: z.array(z.string()).optional(),
});

const projectCreateOutputSchema = z.object({
  projectId: z.string(),
  projectRoot: z.string(),
  directoriesCreated: z.array(z.string()),
});

export async function handleAofProjectCreate(ctx: AofMcpContext, input: z.infer<typeof projectCreateInputSchema>) {
  const { createProject } = await import("../projects/create.js");
  const result = await createProject(input.id, {
    vaultRoot: ctx.vaultRoot,
    title: input.title,
    type: input.type,
    participants: input.participants,
    template: true,
  });

  return {
    projectId: result.projectId,
    projectRoot: result.projectRoot,
    directoriesCreated: result.directoriesCreated,
  };
}

// --- Project List ---

const projectListInputSchema = z.object({});

const projectListOutputSchema = z.object({
  projects: z.array(z.object({
    id: z.string(),
    path: z.string(),
    error: z.string().optional(),
  })),
});

export async function handleAofProjectList(ctx: AofMcpContext) {
  const { discoverProjects } = await import("../projects/index.js");
  const projects = await discoverProjects(ctx.vaultRoot);

  return {
    projects: projects.map(p => ({
      id: p.id,
      path: p.path,
      error: p.error,
    })),
  };
}

export function registerAofTools(server: McpServer, ctx: AofMcpContext, buildBoard: (team: string, status?: string, priority?: string) => Promise<unknown>) {
  server.registerTool("aof_dispatch", {
    description: "Create a new AOF task and assign to an agent or team",
    inputSchema: dispatchInputSchema,
  }, async (input) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await handleAofDispatch(ctx, input), null, 2) }],
  }));

  server.registerTool("aof_task_update", {
    description: "Update task metadata, status, or work log",
    inputSchema: taskUpdateInputSchema,
  }, async (input) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await handleAofTaskUpdate(ctx, input), null, 2) }],
  }));

  server.registerTool("aof_task_complete", {
    description: "Mark task as complete",
    inputSchema: taskCompleteInputSchema,
  }, async (input) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await handleAofTaskComplete(ctx, input), null, 2) }],
  }));

  server.registerTool("aof_status_report", {
    description: "Report task status counts",
    inputSchema: statusReportInputSchema,
  }, async (input) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await handleAofStatusReport(ctx, input), null, 2) }],
  }));

  server.registerTool("aof_board", {
    description: "Get kanban board view for a team",
    inputSchema: boardInputSchema,
  }, async (input) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await buildBoard(input.team ?? "swe", input.status, input.priority), null, 2) }],
  }));

  // --- Task mutation tools ---

  server.registerTool("aof_task_edit", {
    description: "Edit task frontmatter (title, priority, routing) without changing status",
    inputSchema: taskEditInputSchema,
  }, async (input) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await handleAofTaskEdit(ctx, input), null, 2) }],
  }));

  server.registerTool("aof_task_cancel", {
    description: "Cancel a task with optional reason",
    inputSchema: taskCancelInputSchema,
  }, async (input) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await handleAofTaskCancel(ctx, input), null, 2) }],
  }));

  server.registerTool("aof_task_block", {
    description: "Block a task with a reason, preventing dispatch until unblocked",
    inputSchema: taskBlockInputSchema,
  }, async (input) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await handleAofTaskBlock(ctx, input), null, 2) }],
  }));

  server.registerTool("aof_task_unblock", {
    description: "Unblock a previously blocked task, moving it back to ready",
    inputSchema: taskUnblockInputSchema,
  }, async (input) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await handleAofTaskUnblock(ctx, input), null, 2) }],
  }));

  // --- Dependency tools ---

  server.registerTool("aof_task_dep_add", {
    description: "Add a dependency — task will be blocked until blocker completes",
    inputSchema: taskDepAddInputSchema,
  }, async (input) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await handleAofTaskDepAdd(ctx, input), null, 2) }],
  }));

  server.registerTool("aof_task_dep_remove", {
    description: "Remove a dependency from a task",
    inputSchema: taskDepRemoveInputSchema,
  }, async (input) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await handleAofTaskDepRemove(ctx, input), null, 2) }],
  }));

  // --- Subscription tools ---

  server.registerTool("aof_task_subscribe", {
    description: "Subscribe to task outcome notifications",
    inputSchema: taskSubscribeInputSchema,
  }, async (input) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await handleAofTaskSubscribe(ctx, input), null, 2) }],
  }));

  server.registerTool("aof_task_unsubscribe", {
    description: "Cancel a task outcome subscription",
    inputSchema: taskUnsubscribeInputSchema,
  }, async (input) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await handleAofTaskUnsubscribe(ctx, input), null, 2) }],
  }));

  // --- Project tools ---

  server.registerTool("aof_project_create", {
    description: "Create a new project with standard directory structure and manifest",
    inputSchema: projectCreateInputSchema,
  }, async (input) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await handleAofProjectCreate(ctx, input), null, 2) }],
  }));

  server.registerTool("aof_project_list", {
    description: "List all projects on this AOF instance",
    inputSchema: projectListInputSchema,
  }, async () => ({
    content: [{ type: "text" as const, text: JSON.stringify(await handleAofProjectList(ctx), null, 2) }],
  }));
}
