/**
 * Helper functions for scheduler poll cycle.
 * 
 * Extracted to keep scheduler.ts focused on orchestration.
 */

import type { Task } from "../types.js";
import type { SchedulerAction } from "./scheduler.js";

/**
 * Build task statistics by status.
 */
export function buildTaskStats(allTasks: Task[]) {
  const stats = {
    total: allTasks.length,
    backlog: 0,
    ready: 0,
    inProgress: 0,
    blocked: 0,
    review: 0,
    done: 0,
  };

  for (const task of allTasks) {
    const s = task.frontmatter.status;
    if (s === "backlog") stats.backlog++;
    else if (s === "ready") stats.ready++;
    else if (s === "in-progress") stats.inProgress++;
    else if (s === "blocked") stats.blocked++;
    else if (s === "review") stats.review++;
    else if (s === "done") stats.done++;
  }

  return stats;
}

/**
 * Build parent→children task map.
 */
export function buildChildrenMap(allTasks: Task[]): Map<string, Task[]> {
  const childrenByParent = new Map<string, Task[]>();
  for (const task of allTasks) {
    const parentId = task.frontmatter.parentId;
    if (!parentId) continue;
    const list = childrenByParent.get(parentId) ?? [];
    list.push(task);
    childrenByParent.set(parentId, list);
  }
  return childrenByParent;
}

/**
 * Check for expired leases and return expiry actions.
 * BUG-AUDIT-001: checks both in-progress AND blocked tasks.
 */
export function checkExpiredLeases(allTasks: Task[]): SchedulerAction[] {
  const actions: SchedulerAction[] = [];
  const inProgressTasks = allTasks.filter(t => t.frontmatter.status === "in-progress");
  const blockedTasks = allTasks.filter(t => t.frontmatter.status === "blocked");
  const tasksWithPotentialLeases = [...inProgressTasks, ...blockedTasks];

  for (const task of tasksWithPotentialLeases) {
    const lease = task.frontmatter.lease;
    if (!lease) continue;

    const expiresAt = new Date(lease.expiresAt).getTime();
    if (expiresAt <= Date.now()) {
      const expiredDuration = Date.now() - expiresAt;
      actions.push({
        type: "expire_lease",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        agent: lease.agent,
        reason: `Lease expired at ${lease.expiresAt} (held by ${lease.agent}, expired ${Math.round(expiredDuration / 1000)}s ago)`,
        fromStatus: task.frontmatter.status,
      });
    }
  }

  return actions;
}

/**
 * Build resource occupancy map.
 * TASK-054: Track which resources are currently occupied by in-progress tasks.
 */
export function buildResourceOccupancyMap(allTasks: Task[]): Map<string, string> {
  const occupiedResources = new Map<string, string>(); // resource -> taskId
  const inProgressTasks = allTasks.filter(t => t.frontmatter.status === "in-progress");
  
  for (const task of inProgressTasks) {
    const resource = task.frontmatter.resource;
    if (resource) {
      occupiedResources.set(resource, task.frontmatter.id);
    }
  }
  
  return occupiedResources;
}
