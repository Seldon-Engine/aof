import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { loadOrgChart } from "../org/loader.js";
import type { Task, TaskStatus } from "../schemas/task.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { normalizePriority, resolveAssignedAgent, resolveTask, type AofMcpContext } from "./shared.js";

export interface TaskSummary {
  id: string;
  title: string;
  priority: string;
  assignedAgent?: string;
  createdAt: string;
  updatedAt: string;
}

const STATUS_COLUMNS: TaskStatus[] = [
  "backlog",
  "ready",
  "in-progress",
  "blocked",
  "review",
  "done",
];

export async function buildBoard(ctx: AofMcpContext, team: string, status?: string, priority?: string) {
  const tasks = await ctx.store.list();
  const normalizedPriority = priority ? normalizePriority(priority) : undefined;
  const filtered = tasks.filter((task) => {
    if (team && task.frontmatter.routing.team !== team) return false;
    if (status && task.frontmatter.status !== status) return false;
    if (normalizedPriority && task.frontmatter.priority !== normalizedPriority) return false;
    return true;
  });

  const columns: Record<string, TaskSummary[]> = {};
  const statsByStatus: Record<string, number> = {};
  const statsByPriority: Record<string, number> = {};

  for (const column of STATUS_COLUMNS) {
    columns[column] = [];
    statsByStatus[column] = 0;
  }

  for (const task of filtered) {
    const summary = toTaskSummary(task);
    const col = columns[task.frontmatter.status];
    if (col) col.push(summary);
    statsByStatus[task.frontmatter.status] = (statsByStatus[task.frontmatter.status] ?? 0) + 1;
    statsByPriority[task.frontmatter.priority] = (statsByPriority[task.frontmatter.priority] ?? 0) + 1;
  }

  return {
    team,
    timestamp: new Date().toISOString(),
    columns,
    stats: {
      totalTasks: filtered.length,
      byStatus: statsByStatus,
      byPriority: statsByPriority,
    },
  };
}

export async function readTaskResource(ctx: AofMcpContext, taskId: string) {
  const task = await resolveTask(ctx.store, taskId);
  const inputs = await ctx.store.getTaskInputs(task.frontmatter.id).catch(() => []);
  const outputs = await ctx.store.getTaskOutputs(task.frontmatter.id).catch(() => []);

  const content = {
    id: task.frontmatter.id,
    title: task.frontmatter.title,
    status: task.frontmatter.status,
    priority: task.frontmatter.priority,
    assignedAgent: resolveAssignedAgent(task),
    ownerTeam: task.frontmatter.routing.team,
    createdAt: task.frontmatter.createdAt,
    updatedAt: task.frontmatter.updatedAt,
    lastTransitionAt: task.frontmatter.lastTransitionAt,
    routing: task.frontmatter.routing,
    lease: task.frontmatter.lease,
    metadata: task.frontmatter.metadata,
    body: task.body,
    inputs,
    outputs,
  };

  return {
    contents: [
      {
        uri: `aof://tasks/${task.frontmatter.id}`,
        mimeType: "application/json",
        text: JSON.stringify(content, null, 2),
      },
    ],
  };
}

export async function readTasksByStatusResource(ctx: AofMcpContext, uri: URL) {
  const status = uri.searchParams.get("status");
  if (status && !STATUS_COLUMNS.includes(status as TaskStatus)) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid status: ${status}`);
  }

  const tasks = await ctx.store.list({ status: status as TaskStatus | undefined });
  const summaries = tasks.map(task => ({
    id: task.frontmatter.id,
    title: task.frontmatter.title,
    assignedAgent: resolveAssignedAgent(task),
    priority: task.frontmatter.priority,
    updatedAt: task.frontmatter.updatedAt,
  }));

  const content = {
    status: status ?? "all",
    tasks: summaries,
  };

  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify(content, null, 2),
      },
    ],
  };
}

export async function readKanbanResource(ctx: AofMcpContext, team: string, uri: URL) {
  const board = await buildBoard(ctx, team, uri.searchParams.get("status") ?? undefined, uri.searchParams.get("priority") ?? undefined);
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify(board, null, 2),
      },
    ],
  };
}

export async function readMailboxResource(ctx: AofMcpContext, agentId: string, uri: URL) {
  const tasks = await ctx.store.list();
  const inbox: TaskSummary[] = [];
  const processing: TaskSummary[] = [];
  const outbox: TaskSummary[] = [];

  for (const task of tasks) {
    const assigned = resolveAssignedAgent(task);
    if (assigned !== agentId) continue;

    if (task.frontmatter.status === "ready") {
      inbox.push(toTaskSummary(task));
    } else if (task.frontmatter.status === "in-progress" || task.frontmatter.status === "blocked") {
      processing.push(toTaskSummary(task));
    } else if (task.frontmatter.status === "review") {
      outbox.push(toTaskSummary(task));
    }
  }

  const content = {
    agentId,
    timestamp: new Date().toISOString(),
    inbox,
    processing,
    outbox,
  };

  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify(content, null, 2),
      },
    ],
  };
}

export async function readOrgChartResource(ctx: AofMcpContext, uri: URL) {
  let result;
  try {
    result = await loadOrgChart(ctx.orgChartPath);
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, "Org chart not available", {
      path: ctx.orgChartPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (!result.success || !result.chart) {
    throw new McpError(ErrorCode.InternalError, "Org chart not available", {
      path: ctx.orgChartPath,
      errors: result.errors,
    });
  }

  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify(result.chart, null, 2),
      },
    ],
  };
}

function toTaskSummary(task: Task): TaskSummary {
  return {
    id: task.frontmatter.id,
    title: task.frontmatter.title,
    priority: task.frontmatter.priority,
    assignedAgent: resolveAssignedAgent(task),
    createdAt: task.frontmatter.createdAt,
    updatedAt: task.frontmatter.updatedAt,
  };
}

export function registerAofResources(server: McpServer, ctx: AofMcpContext) {
  const taskTemplate = new ResourceTemplate("aof://tasks/{taskId}", {
    list: async () => {
      const tasks = await ctx.store.list();
      return {
        resources: tasks.map(task => ({
          uri: `aof://tasks/${task.frontmatter.id}`,
          name: task.frontmatter.id,
          description: task.frontmatter.title,
          mimeType: "application/json",
        })),
      };
    },
  });

  server.registerResource("aof-task", taskTemplate, {
    description: "AOF task card",
    mimeType: "application/json",
  }, async (uri, variables) => readTaskResource(ctx, variables.taskId as string));

  const statusTemplate = new ResourceTemplate("aof://tasks{?status}", {
    list: async () => ({ resources: [] }),
  });

  server.registerResource("aof-tasks-status", statusTemplate, {
    description: "AOF tasks by status",
    mimeType: "application/json",
  }, async (uri) => readTasksByStatusResource(ctx, uri));

  const kanbanTemplate = new ResourceTemplate("aof://views/kanban/{team}", {
    list: async () => {
      const result = await loadOrgChart(ctx.orgChartPath).catch(() => null);
      if (!result || !result.success || !result.chart) return { resources: [] };
      return {
        resources: result.chart.teams.map(team => ({
          uri: `aof://views/kanban/${team.id}`,
          name: team.id,
          description: team.name,
          mimeType: "application/json",
        })),
      };
    },
  });

  server.registerResource("aof-kanban", kanbanTemplate, {
    description: "AOF kanban board view",
    mimeType: "application/json",
  }, async (uri, variables) => readKanbanResource(ctx, variables.team as string, uri));

  const mailboxTemplate = new ResourceTemplate("aof://views/mailbox/{agentId}", {
    list: async () => {
      const result = await loadOrgChart(ctx.orgChartPath).catch(() => null);
      if (!result || !result.success || !result.chart) return { resources: [] };
      return {
        resources: result.chart.agents.map(agent => ({
          uri: `aof://views/mailbox/${agent.id}`,
          name: agent.id,
          description: agent.name,
          mimeType: "application/json",
        })),
      };
    },
  });

  server.registerResource("aof-mailbox", mailboxTemplate, {
    description: "AOF mailbox view for an agent",
    mimeType: "application/json",
  }, async (uri, variables) => readMailboxResource(ctx, variables.agentId as string, uri));

  server.registerResource("aof-org-chart", "aof://org/chart", {
    description: "AOF organization chart",
    mimeType: "application/json",
  }, async (uri) => readOrgChartResource(ctx, uri));
}
