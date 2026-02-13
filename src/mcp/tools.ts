import { z } from "zod";
import { aofDispatch } from "../dispatch/aof-dispatch.js";
import { aofStatusReport } from "../tools/aof-tools.js";
import { aofTaskComplete, aofTaskUpdate } from "../tools/aof-tools.js";
import type { TaskStatus } from "../schemas/task.js";
import type { DispatchResult } from "../dispatch/aof-dispatch.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadOrgChart } from "../org/loader.js";
import { appendSection, formatTimestamp, normalizePriority, resolveTask, type AofMcpContext } from "./shared.js";

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
});

const dispatchOutputSchema = z.object({
  taskId: z.string(),
  status: z.string(),
  assignedAgent: z.string().optional(),
  filePath: z.string().optional(),
  sessionId: z.string().optional(),
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
  });

  let currentTask = await ctx.store.transition(task.frontmatter.id, "ready");
  let status: TaskStatus = "ready";
  let sessionId: string | undefined;

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
}
