/**
 * AOF project management tools — create/list operations.
 *
 * Handlers are framework-agnostic and consumed by both the MCP and OpenClaw
 * adapters via the shared `toolRegistry`. Per Phase 43 Open Q2 resolution, these
 * tools move out of `src/openclaw/adapter.ts` (where they were registered
 * inline) into the shared registry so they dispatch through the single
 * `/v1/tool/invoke` IPC envelope like every other tool.
 *
 * `aof_project_add_participant` was removed 2026-04-26 along with the
 * project.participants field — it managed an authorization list nobody read.
 */

import { z } from "zod";
import { createLogger } from "../logging/index.js";
import type { ToolContext } from "./types.js";
import { createProject } from "../projects/create.js";
import { discoverProjects } from "../projects/registry.js";
import { getConfig } from "../config/registry.js";

const log = createLogger("tools:project-management");

/**
 * Resolve the vaultRoot for project operations.
 *
 * Priority:
 *  1. `ctx.vaultRoot` (adapter-provided extra — takes precedence so callers
 *     running a multi-vault setup or pointing at a scratch dir in tests can
 *     inject without mutating global config).
 *  2. Configured `core.vaultRoot`.
 *  3. `core.dataDir` (default location).
 */
function resolveVaultRoot(ctx: ToolContext): string {
  const extra = (ctx as unknown as { vaultRoot?: string }).vaultRoot;
  if (typeof extra === "string" && extra.trim().length > 0) {
    return extra;
  }
  const cfg = getConfig();
  return cfg.core.vaultRoot ?? cfg.core.dataDir;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const projectCreateSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  type: z
    .enum(["swe", "ops", "research", "admin", "personal", "other"])
    .optional(),
});

export const projectListSchema = z.object({}).strict();

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * aof_project_create — scaffold a new project directory + manifest.
 */
export async function aofProjectCreate(
  ctx: ToolContext,
  input: z.infer<typeof projectCreateSchema>,
): Promise<unknown> {
  const vaultRoot = resolveVaultRoot(ctx);
  log.info({ op: "project_create", id: input.id, vaultRoot }, "creating project");
  const result = await createProject(input.id, {
    vaultRoot,
    title: input.title,
    type: input.type,
    template: true,
  });
  return result;
}

/**
 * aof_project_list — discover all projects under the active vault root.
 */
export async function aofProjectList(
  ctx: ToolContext,
  _input: z.infer<typeof projectListSchema>,
): Promise<unknown> {
  const vaultRoot = resolveVaultRoot(ctx);
  const projects = await discoverProjects(vaultRoot);
  return {
    projects: projects.map((p) => ({
      id: p.id,
      path: p.path,
      error: p.error,
    })),
  };
}

