/**
 * Task dependency graph operations.
 * 
 * Pure functions for DAG validation and dependency management.
 * Extracted from FilesystemTaskStore to keep it under size limits.
 */

import writeFileAtomic from "write-file-atomic";
import type { Task, TaskStatus } from "../schemas/task.js";
import type { EventLogger } from "../events/logger.js";
import { serializeTask } from "./task-parser.js";

/**
 * Task getter function type - abstracts store's get() method.
 */
export type TaskGetter = (id: string) => Promise<Task | undefined>;

/**
 * Check if adding a dependency would create a cycle.
 * 
 * @param taskId - The task that will depend on blockerId
 * @param blockerId - The task that taskId will depend on
 * @param getTask - Function to fetch tasks by ID
 * @returns true if adding the dependency would create a cycle
 */
export async function hasCycle(
  taskId: string,
  blockerId: string,
  getTask: TaskGetter,
): Promise<boolean> {
  const visited = new Set<string>();

  const dfs = async (currentId: string): Promise<boolean> => {
    // If we've reached taskId, there's a cycle
    if (currentId === taskId) {
      return true;
    }

    // Already visited this node in this search path
    if (visited.has(currentId)) {
      return false;
    }

    visited.add(currentId);

    const task = await getTask(currentId);
    if (!task) {
      return false; // Task doesn't exist
    }

    // Check all dependencies recursively
    for (const depId of task.frontmatter.dependsOn) {
      if (await dfs(depId)) {
        return true;
      }
    }

    return false;
  };

  // Check if blockerId (or any of its dependencies) depends on taskId
  // Start DFS from blockerId
  return await dfs(blockerId);
}

/**
 * Add a dependency to a task.
 * Makes taskId depend on blockerId (taskId cannot start until blockerId is done).
 * 
 * @param taskId - Task that will depend on blockerId
 * @param blockerId - Task that taskId will wait for
 * @param getTask - Function to fetch tasks by ID
 * @param taskPath - Function to compute file path for a task
 * @param logger - Optional event logger
 * @returns Updated task with new dependency
 */
export async function addDependency(
  taskId: string,
  blockerId: string,
  getTask: TaskGetter,
  taskPath: (id: string, status: TaskStatus) => string,
  logger?: EventLogger,
): Promise<Task> {
  // Validate both tasks exist
  const task = await getTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const blocker = await getTask(blockerId);
  if (!blocker) {
    throw new Error(`Blocker task not found: ${blockerId}`);
  }

  // Reject modifications to tasks in terminal states
  const terminalStates: TaskStatus[] = ["done", "cancelled"];
  if (terminalStates.includes(task.frontmatter.status)) {
    throw new Error(
      `Cannot modify dependencies for task ${taskId}: task is in terminal state '${task.frontmatter.status}'`,
    );
  }

  // Reject self-dependency
  if (taskId === blockerId) {
    throw new Error(`Task cannot depend on itself: ${taskId}`);
  }

  // Check if already depends
  if (task.frontmatter.dependsOn.includes(blockerId)) {
    return task; // Idempotent: already has this dependency
  }

  // Check for circular dependencies
  if (await hasCycle(taskId, blockerId, getTask)) {
    throw new Error(`Adding dependency would create a circular dependency: ${taskId} -> ${blockerId}`);
  }

  // Update task
  task.frontmatter.dependsOn.push(blockerId);
  task.frontmatter.updatedAt = new Date().toISOString();

  // Write atomically
  const filePath = task.path ?? taskPath(taskId, task.frontmatter.status);
  await writeFileAtomic(filePath, serializeTask(task));

  // Emit event
  if (logger) {
    await logger.log("task.dep.added", "system", {
      taskId,
      payload: { taskId, blockerId },
    });
  }

  return task;
}

/**
 * Remove a dependency from a task.
 * 
 * @param taskId - Task to remove dependency from
 * @param blockerId - Dependency to remove
 * @param getTask - Function to fetch tasks by ID
 * @param taskPath - Function to compute file path for a task
 * @param logger - Optional event logger
 * @returns Updated task with dependency removed
 */
export async function removeDependency(
  taskId: string,
  blockerId: string,
  getTask: TaskGetter,
  taskPath: (id: string, status: TaskStatus) => string,
  logger?: EventLogger,
): Promise<Task> {
  const task = await getTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  // Reject modifications to tasks in terminal states
  const terminalStates: TaskStatus[] = ["done", "cancelled"];
  if (terminalStates.includes(task.frontmatter.status)) {
    throw new Error(
      `Cannot modify dependencies for task ${taskId}: task is in terminal state '${task.frontmatter.status}'`,
    );
  }

  // Check if dependency exists
  const index = task.frontmatter.dependsOn.indexOf(blockerId);
  if (index === -1) {
    return task; // Idempotent: dependency doesn't exist
  }

  // Remove dependency
  task.frontmatter.dependsOn.splice(index, 1);
  task.frontmatter.updatedAt = new Date().toISOString();

  // Write atomically
  const filePath = task.path ?? taskPath(taskId, task.frontmatter.status);
  await writeFileAtomic(filePath, serializeTask(task));

  // Emit event
  if (logger) {
    await logger.log("task.dep.removed", "system", {
      taskId,
      payload: { taskId, blockerId },
    });
  }

  return task;
}
