/**
 * Project store factory — create TaskStore instances for project scopes.
 *
 * Moved from cli/project-utils.ts so that MCP and other non-CLI consumers
 * can create project-scoped stores without depending on the CLI layer.
 */

import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FilesystemTaskStore } from "../store/task-store.js";
import type { ITaskStore } from "../store/interfaces.js";
import { EventLogger } from "../events/logger.js";
import { resolveProject } from "./resolver.js";
import { bootstrapProject } from "./bootstrap.js";
import { buildProjectManifest, writeProjectManifest } from "./manifest.js";
import { createLogger } from "../logging/index.js";

const log = createLogger("projects:store-factory");

export interface CreateStoreOptions {
  /** Project ID (defaults to _inbox). */
  projectId?: string;
  /** Vault root (optional, uses AOF_ROOT env or default). */
  vaultRoot?: string;
  /** Event logger (optional). */
  logger?: EventLogger;
}

/**
 * Ensure a project directory has the standard scaffold + a manifest.
 *
 * Idempotent: if `project.yaml` already exists, returns immediately.
 * If it's missing, creates the required directory layout (tasks/,
 * artifacts/{bronze,silver,gold}/, state/, views/, cold/) and writes
 * a minimal manifest with system defaults.
 *
 * This prevents "lazy partial" projects where `aof_dispatch` would
 * land tasks into a previously-unknown project ID and create only the
 * `tasks/<status>/` subdirs on demand — skipping the full scaffold
 * and never writing a manifest. Downstream tooling (`aof project-list`,
 * `aof org drift`, migration helpers) treats such projects as broken.
 *
 * For non-`_inbox` IDs this is a "trust the caller" auto-bootstrap —
 * typo prevention lives one layer up at the org-chart / fleet layer,
 * not here.
 */
async function ensureProjectBootstrapped(
  projectId: string,
  projectRoot: string,
): Promise<void> {
  const manifestPath = join(projectRoot, "project.yaml");
  try {
    await access(manifestPath);
    return; // already bootstrapped — manifest exists
  } catch {
    // no manifest — fall through to create scaffold + manifest
  }

  await mkdir(projectRoot, { recursive: true });
  await bootstrapProject(projectRoot);

  const manifest = buildProjectManifest(projectId, {
    title: projectId === "_inbox" ? undefined : projectId,
    // `buildProjectManifest` handles `_inbox` specially (admin defaults);
    // for other IDs we pass minimal values so the project is at least
    // complete enough for tooling to parse.
    type: projectId === "_inbox" ? undefined : "other",
    owner: { team: "system", lead: "system" },
  });
  await writeProjectManifest(projectRoot, manifest);

  log.info({ projectId, projectRoot }, "auto-bootstrapped project on first store access");
}

/**
 * Create a TaskStore for a project scope.
 *
 * If the project has not yet been bootstrapped (no `project.yaml` on
 * disk), the scaffold and a minimal manifest are created before the
 * store is instantiated. This keeps `aof_dispatch`-style first-use
 * flows from leaving projects in a half-initialized state.
 *
 * @param opts - Store creation options
 * @returns TaskStore instance and project resolution
 */
export async function createProjectStore(
  opts: CreateStoreOptions = {}
): Promise<{ store: ITaskStore; projectRoot: string; vaultRoot: string }> {
  const projectId = opts.projectId ?? "_inbox";
  const resolution = await resolveProject(projectId, opts.vaultRoot);

  await ensureProjectBootstrapped(resolution.projectId, resolution.projectRoot);

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
