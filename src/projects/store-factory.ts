/**
 * Project store factory — create TaskStore instances for project scopes.
 *
 * Moved from cli/project-utils.ts so that MCP and other non-CLI consumers
 * can create project-scoped stores without depending on the CLI layer.
 */

import { join } from "node:path";
import { FilesystemTaskStore } from "../store/task-store.js";
import type { ITaskStore } from "../store/interfaces.js";
import { EventLogger } from "../events/logger.js";
import { resolveProject } from "./resolver.js";

export interface CreateStoreOptions {
  /** Project ID (defaults to _inbox). */
  projectId?: string;
  /** Vault root (optional, uses AOF_ROOT env or default). */
  vaultRoot?: string;
  /** Event logger (optional). */
  logger?: EventLogger;
}

/**
 * Create a TaskStore for a project scope.
 *
 * @param opts - Store creation options
 * @returns TaskStore instance and project resolution
 */
export async function createProjectStore(
  opts: CreateStoreOptions = {}
): Promise<{ store: ITaskStore; projectRoot: string; vaultRoot: string }> {
  const projectId = opts.projectId ?? "_inbox";
  const resolution = await resolveProject(projectId, opts.vaultRoot);

  const store = new FilesystemTaskStore(resolution.projectRoot, {
    projectId: resolution.projectId,
    logger: opts.logger,
  });

  return {
    store,
    projectRoot: resolution.projectRoot,
    vaultRoot: resolution.vaultRoot,
  };
}
