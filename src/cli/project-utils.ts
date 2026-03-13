/**
 * CLI project utilities.
 *
 * Helpers for resolving projects and creating TaskStore instances.
 * createProjectStore is re-exported from projects/store-factory.ts
 * for backward compatibility.
 */

import { join } from "node:path";

export { createProjectStore } from "../projects/store-factory.js";
export type { CreateStoreOptions } from "../projects/store-factory.js";

/**
 * Resolve views directory for a project.
 *
 * @param projectRoot - Project root directory
 * @returns Absolute path to views directory
 */
export function getViewsDir(projectRoot: string): string {
  return join(projectRoot, "views");
}

/**
 * Resolve mailbox views directory for a project.
 *
 * @param projectRoot - Project root directory
 * @returns Absolute path to mailbox views directory
 */
export function getMailboxViewsDir(projectRoot: string): string {
  return join(projectRoot, "views", "mailbox");
}

/**
 * Resolve kanban views directory for a project.
 *
 * @param projectRoot - Project root directory
 * @returns Absolute path to kanban views directory
 */
export function getKanbanViewsDir(projectRoot: string): string {
  return join(projectRoot, "views", "kanban");
}
