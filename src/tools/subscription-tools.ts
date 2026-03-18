/**
 * Shared subscription tool handlers — extracted from MCP-specific code
 * so both MCP and OpenClaw adapters can create/cancel task subscriptions.
 */

import { z } from "zod";
import { join } from "node:path";
import type { ITaskStore } from "../store/interfaces.js";
import { SubscriptionStore } from "../store/subscription-store.js";
import { loadOrgChart } from "../org/loader.js";
import type { ToolContext } from "./types.js";
import type { Task } from "../schemas/task.js";

// --- Local helpers ---

async function resolveTask(store: ITaskStore, taskId: string): Promise<Task> {
  const task = await store.get(taskId);
  if (task) return task;
  const byPrefix = await store.getByPrefix(taskId);
  if (byPrefix) return byPrefix;
  throw new Error(`Task not found: ${taskId}`);
}

// --- Schemas ---

export const taskSubscribeInputSchema = z.object({
  taskId: z.string(),
  subscriberId: z.string().min(1),
  granularity: z.enum(["completion", "all"]),
});

export const taskUnsubscribeInputSchema = z.object({
  taskId: z.string(),
  subscriptionId: z.string(),
});

// --- Factory ---

/**
 * Create a SubscriptionStore from a task store, using the same pattern
 * as callback-helpers.ts and mcp/shared.ts.
 */
export function createSubscriptionStore(store: ITaskStore): SubscriptionStore {
  const tasksDir = store.tasksDir;
  const taskDirResolver = async (tid: string): Promise<string> => {
    const t = await store.get(tid);
    if (!t) throw new Error(`Task not found: ${tid}`);
    return join(tasksDir, t.frontmatter.status, tid);
  };
  return new SubscriptionStore(taskDirResolver);
}

// --- Validation ---

/**
 * Validate that a subscriber agent exists in the org chart.
 * If orgChartPath is undefined, validation is skipped (graceful degradation).
 * Throws a plain Error (not McpError) for adapter-neutral usage.
 */
export async function validateSubscriberAgent(
  orgChartPath: string | undefined,
  subscriberId: string,
): Promise<void> {
  if (!orgChartPath) return; // graceful: skip validation when no org chart
  const result = await loadOrgChart(orgChartPath);
  if (!result.success || !result.chart) {
    throw new Error("Failed to load org chart for subscriber validation");
  }
  const agentExists = result.chart.agents.some(a => a.id === subscriberId);
  if (!agentExists) {
    throw new Error(
      `subscriberId "${subscriberId}" not found in org chart. Available agents: ${result.chart.agents.map(a => a.id).join(", ")}`,
    );
  }
}

// --- Handlers ---

export async function aofTaskSubscribe(
  ctx: ToolContext,
  input: z.infer<typeof taskSubscribeInputSchema>,
) {
  const task = await resolveTask(ctx.store, input.taskId);
  await validateSubscriberAgent(ctx.orgChartPath, input.subscriberId);
  const subscriptionStore = createSubscriptionStore(ctx.store);
  const existing = await subscriptionStore.list(task.frontmatter.id, { status: "active" });
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
  const sub = await subscriptionStore.create(task.frontmatter.id, input.subscriberId, input.granularity);
  return {
    subscriptionId: sub.id,
    taskId: task.frontmatter.id,
    granularity: sub.granularity,
    status: sub.status,
    taskStatus: task.frontmatter.status,
    createdAt: sub.createdAt,
  };
}

export async function aofTaskUnsubscribe(
  ctx: ToolContext,
  input: z.infer<typeof taskUnsubscribeInputSchema>,
) {
  const task = await resolveTask(ctx.store, input.taskId);
  const subscriptionStore = createSubscriptionStore(ctx.store);
  try {
    const cancelled = await subscriptionStore.cancel(task.frontmatter.id, input.subscriptionId);
    return { subscriptionId: cancelled.id, status: "cancelled" as const };
  } catch {
    throw new Error(`Subscription not found: ${input.subscriptionId}`);
  }
}
