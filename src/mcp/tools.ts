/**
 * MCP tool registration — thin adapter that consumes the shared tool registry
 * and registers MCP-specific tools (dispatch, board, subscribe, projects).
 *
 * Shared tools are registered via a loop over toolRegistry.
 * MCP-specific tools with extra behavior (dispatch w/ workflow resolution,
 * task_update w/ workLog, task_complete w/ outputs) are registered directly.
 */

import { z } from "zod";
import { aofDispatch } from "../dispatch/aof-dispatch.js";
import { aofTaskUpdate, aofTaskComplete } from "../tools/aof-tools.js";
import type { TaskStatus } from "../schemas/task.js";
import type { DispatchResult } from "../dispatch/aof-dispatch.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadOrgChart } from "../org/loader.js";
import { appendSection, formatTimestamp, normalizePriority, resolveTask, type AofMcpContext } from "./shared.js";
import { WorkflowDefinition, validateDAG, type WorkflowDefinition as WorkflowDefinitionType } from "../schemas/workflow-dag.js";
import { toolRegistry } from "../tools/tool-registry.js";

// --- MCP-specific schemas (not in shared registry) ---

const mcpDispatchInputSchema = z.object({
  title: z.string().min(1),
  brief: z.string().min(1),
  type: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "critical", "normal"]).optional(),
  assignedAgent: z.string().optional(),
  ownerTeam: z.string().optional(),
  inputs: z.array(z.string()).optional(),
  checklist: z.array(z.string()).optional(),
  actor: z.string().optional(),
  workflow: z.union([z.string(), WorkflowDefinition, z.literal(false)]).optional(),
  contextTier: z.enum(["seed", "full"]).optional(),
  subscribe: z.enum(["completion", "all"]).optional(),
});

const mcpTaskUpdateInputSchema = z.object({
  taskId: z.string(),
  status: z.enum(["backlog", "ready", "in-progress", "blocked", "review", "done"]).optional(),
  workLog: z.string().optional(),
  outputs: z.array(z.string()).optional(),
  blockedReason: z.string().optional(),
  body: z.string().optional(),
  actor: z.string().optional(),
});

const mcpTaskCompleteInputSchema = z.object({
  taskId: z.string(),
  summary: z.string(),
  outputs: z.array(z.string()).optional(),
  skipReview: z.boolean().optional(),
  actor: z.string().optional(),
});

const boardInputSchema = z.object({
  team: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
});

const taskSubscribeInputSchema = z.object({
  taskId: z.string(),
  subscriberId: z.string().min(1),
  granularity: z.enum(["completion", "all"]),
});

const taskUnsubscribeInputSchema = z.object({
  taskId: z.string(),
  subscriptionId: z.string(),
});

const projectCreateInputSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  type: z.enum(["swe", "ops", "research", "admin", "personal", "other"]).optional(),
  participants: z.array(z.string()).optional(),
});

const projectListInputSchema = z.object({});

// --- MCP-specific helpers ---

async function resolveOwnerTeam(ctx: AofMcpContext, input: z.infer<typeof mcpDispatchInputSchema>) {
  if (input.ownerTeam) return input.ownerTeam;
  if (!input.assignedAgent) return undefined;

  const chart = await loadOrgChart(ctx.orgChartPath).catch(() => null);
  if (!chart?.success || !chart.chart) return undefined;
  return chart.chart.agents.find(agent => agent.id === input.assignedAgent)?.team;
}

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

// --- MCP-specific handlers (complex behavior beyond base tools) ---

export async function handleAofDispatch(ctx: AofMcpContext, input: z.infer<typeof mcpDispatchInputSchema>) {
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
    const templates = ctx.projectConfig?.workflowTemplates;
    const definition = templates?.[input.workflow];
    if (!definition) {
      const available = templates ? Object.keys(templates).join(", ") : "(none)";
      throw new McpError(ErrorCode.InvalidParams, `Unknown workflow template: "${input.workflow}". Available: ${available}`);
    }
    const dagErrors = validateDAG(definition);
    if (dagErrors.length > 0) {
      throw new McpError(ErrorCode.InvalidParams, `Workflow template "${input.workflow}" has invalid DAG: ${dagErrors.join(", ")}`);
    }
    workflow = { definition, templateName: input.workflow };
  } else if (typeof input.workflow === "object" && input.workflow !== null) {
    const dagErrors = validateDAG(input.workflow);
    if (dagErrors.length > 0) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid workflow DAG: ${dagErrors.join(", ")}`);
    }
    workflow = { definition: input.workflow };
  }

  const task = await ctx.store.create({
    title: input.title,
    body,
    priority,
    routing: { agent: input.assignedAgent, team: ownerTeam },
    metadata,
    createdBy: input.actor ?? "mcp",
    workflow,
    contextTier: input.contextTier ?? "seed",
    ...(ctx.callbackDepth > 0 ? { callbackDepth: ctx.callbackDepth } : {}),
  });

  let currentTask = await ctx.store.transition(task.frontmatter.id, "ready");
  let status: TaskStatus = "ready";
  let sessionId: string | undefined;

  // Subscribe at dispatch time
  let subscriptionId: string | undefined;
  if (input.subscribe) {
    const subscriberId = input.actor ?? "mcp";
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

export async function handleAofTaskUpdate(ctx: AofMcpContext, input: z.infer<typeof mcpTaskUpdateInputSchema>) {
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

  return { success: true, taskId: result.taskId, newStatus: result.status, updatedAt: result.updatedAt };
}

export async function handleAofTaskComplete(ctx: AofMcpContext, input: z.infer<typeof mcpTaskCompleteInputSchema>) {
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
    { taskId: task.frontmatter.id, actor: input.actor ?? "mcp", summary: input.summary },
  );
  const updated = await ctx.store.get(result.taskId);

  return { success: true, taskId: result.taskId, finalStatus: result.status, completedAt: updated?.frontmatter.updatedAt };
}

export async function handleAofStatusReport(ctx: AofMcpContext, input: { agentId?: string; status?: string; compact?: boolean; limit?: number; actor?: string }) {
  const { aofStatusReport } = await import("../tools/aof-tools.js");
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
  return { total: result.total, byStatus: result.byStatus, tasks: result.tasks, summary: result.summary, details: result.details };
}

export async function handleAofTaskEdit(ctx: AofMcpContext, input: Record<string, unknown>) {
  const { aofTaskEdit } = await import("../tools/aof-tools.js");
  const result = await aofTaskEdit(
    { store: ctx.store, logger: ctx.logger },
    { taskId: input.taskId as string, title: input.title as string | undefined, description: input.description as string | undefined, priority: input.priority as any, routing: input.routing as any, actor: (input.actor as string) ?? "mcp" },
  );
  return { success: true, taskId: result.taskId, updatedFields: result.updatedFields };
}

export async function handleAofTaskCancel(ctx: AofMcpContext, input: Record<string, unknown>) {
  const { aofTaskCancel } = await import("../tools/aof-tools.js");
  const result = await aofTaskCancel(
    { store: ctx.store, logger: ctx.logger },
    { taskId: input.taskId as string, reason: input.reason as string | undefined, actor: (input.actor as string) ?? "mcp" },
  );
  return { success: true, taskId: result.taskId, status: result.status, reason: result.reason };
}

export async function handleAofTaskBlock(ctx: AofMcpContext, input: Record<string, unknown>) {
  const { aofTaskBlock } = await import("../tools/aof-tools.js");
  const result = await aofTaskBlock(
    { store: ctx.store, logger: ctx.logger },
    { taskId: input.taskId as string, reason: input.reason as string, actor: (input.actor as string) ?? "mcp" },
  );
  return { success: true, taskId: result.taskId, status: result.status, reason: result.reason };
}

export async function handleAofTaskUnblock(ctx: AofMcpContext, input: Record<string, unknown>) {
  const { aofTaskUnblock } = await import("../tools/aof-tools.js");
  const result = await aofTaskUnblock(
    { store: ctx.store, logger: ctx.logger },
    { taskId: input.taskId as string, actor: (input.actor as string) ?? "mcp" },
  );
  return { success: true, taskId: result.taskId, status: result.status };
}

export async function handleAofTaskDepAdd(ctx: AofMcpContext, input: Record<string, unknown>) {
  const { aofTaskDepAdd } = await import("../tools/aof-tools.js");
  const result = await aofTaskDepAdd(
    { store: ctx.store, logger: ctx.logger },
    { taskId: input.taskId as string, blockerId: input.blockerId as string, actor: (input.actor as string) ?? "mcp" },
  );
  return { success: true, taskId: result.taskId, blockerId: result.blockerId, dependsOn: result.dependsOn };
}

export async function handleAofTaskDepRemove(ctx: AofMcpContext, input: Record<string, unknown>) {
  const { aofTaskDepRemove } = await import("../tools/aof-tools.js");
  const result = await aofTaskDepRemove(
    { store: ctx.store, logger: ctx.logger },
    { taskId: input.taskId as string, blockerId: input.blockerId as string, actor: (input.actor as string) ?? "mcp" },
  );
  return { success: true, taskId: result.taskId, blockerId: result.blockerId, dependsOn: result.dependsOn };
}

export async function handleAofTaskSubscribe(ctx: AofMcpContext, input: z.infer<typeof taskSubscribeInputSchema>) {
  const task = await resolveTask(ctx.store, input.taskId);
  await validateSubscriberId(ctx.orgChartPath, input.subscriberId);
  const existing = await ctx.subscriptionStore.list(task.frontmatter.id, { status: "active" });
  const duplicate = existing.find(s => s.subscriberId === input.subscriberId && s.granularity === input.granularity);
  if (duplicate) {
    return { subscriptionId: duplicate.id, taskId: task.frontmatter.id, granularity: duplicate.granularity, status: duplicate.status, taskStatus: task.frontmatter.status, createdAt: duplicate.createdAt };
  }
  const sub = await ctx.subscriptionStore.create(task.frontmatter.id, input.subscriberId, input.granularity);
  return { subscriptionId: sub.id, taskId: task.frontmatter.id, granularity: sub.granularity, status: sub.status, taskStatus: task.frontmatter.status, createdAt: sub.createdAt };
}

export async function handleAofTaskUnsubscribe(ctx: AofMcpContext, input: z.infer<typeof taskUnsubscribeInputSchema>) {
  const task = await resolveTask(ctx.store, input.taskId);
  try {
    const cancelled = await ctx.subscriptionStore.cancel(task.frontmatter.id, input.subscriptionId);
    return { subscriptionId: cancelled.id, status: "cancelled" as const };
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `Subscription not found: ${input.subscriptionId}`);
  }
}

export async function handleAofProjectCreate(ctx: AofMcpContext, input: z.infer<typeof projectCreateInputSchema>) {
  const { createProject } = await import("../projects/create.js");
  const result = await createProject(input.id, { vaultRoot: ctx.vaultRoot, title: input.title, type: input.type, participants: input.participants, template: true });
  return { projectId: result.projectId, projectRoot: result.projectRoot, directoriesCreated: result.directoriesCreated };
}

export async function handleAofProjectList(ctx: AofMcpContext) {
  const { discoverProjects } = await import("../projects/index.js");
  const projects = await discoverProjects(ctx.vaultRoot);
  return { projects: projects.map(p => ({ id: p.id, path: p.path, error: p.error })) };
}

// --- Registration ---

const mcpContent = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

export function registerAofTools(server: McpServer, ctx: AofMcpContext, buildBoard: (team: string, status?: string, priority?: string) => Promise<unknown>) {
  // --- Shared tools from registry (loop registration) ---
  const toolCtx = () => ({ store: ctx.store, logger: ctx.logger });

  for (const [name, def] of Object.entries(toolRegistry)) {
    // Skip tools that have MCP-specific handlers below
    if (["aof_dispatch", "aof_task_update", "aof_task_complete", "aof_status_report", "aof_context_load"].includes(name)) continue;

    server.registerTool(name, {
      description: def.description,
      inputSchema: def.schema,
    }, async (input) => mcpContent(await def.handler(toolCtx(), input)));
  }

  // --- MCP-specific tools (extra behavior beyond base tools) ---

  server.registerTool("aof_dispatch", {
    description: "Create a new AOF task and assign to an agent or team",
    inputSchema: mcpDispatchInputSchema,
  }, async (input) => mcpContent(await handleAofDispatch(ctx, input)));

  server.registerTool("aof_task_update", {
    description: "Update task metadata, status, or work log",
    inputSchema: mcpTaskUpdateInputSchema,
  }, async (input) => mcpContent(await handleAofTaskUpdate(ctx, input)));

  server.registerTool("aof_task_complete", {
    description: "Mark task as complete",
    inputSchema: mcpTaskCompleteInputSchema,
  }, async (input) => mcpContent(await handleAofTaskComplete(ctx, input)));

  server.registerTool("aof_status_report", {
    description: "Report task status counts",
    inputSchema: z.object({
      agentId: z.string().optional(),
      status: z.enum(["backlog", "ready", "in-progress", "blocked", "review", "done"]).optional(),
      compact: z.boolean().optional(),
      limit: z.number().int().positive().optional(),
      actor: z.string().optional(),
    }),
  }, async (input) => mcpContent(await handleAofStatusReport(ctx, input)));

  server.registerTool("aof_board", {
    description: "Get kanban board view for a team",
    inputSchema: boardInputSchema,
  }, async (input) => mcpContent(await buildBoard(input.team ?? "swe", input.status, input.priority)));

  // --- Subscription tools (MCP-specific, need subscriptionStore) ---

  server.registerTool("aof_task_subscribe", {
    description: "Subscribe to task outcome notifications",
    inputSchema: taskSubscribeInputSchema,
  }, async (input) => mcpContent(await handleAofTaskSubscribe(ctx, input)));

  server.registerTool("aof_task_unsubscribe", {
    description: "Cancel a task outcome subscription",
    inputSchema: taskUnsubscribeInputSchema,
  }, async (input) => mcpContent(await handleAofTaskUnsubscribe(ctx, input)));

  // --- Project tools (MCP-specific, need vaultRoot) ---

  server.registerTool("aof_project_create", {
    description: "Create a new project with standard directory structure and manifest",
    inputSchema: projectCreateInputSchema,
  }, async (input) => mcpContent(await handleAofProjectCreate(ctx, input)));

  server.registerTool("aof_project_list", {
    description: "List all projects on this AOF instance",
    inputSchema: projectListInputSchema,
  }, async () => mcpContent(await handleAofProjectList(ctx)));
}
