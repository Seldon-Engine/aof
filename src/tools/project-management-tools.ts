/**
 * AOF project management tools — create/list/add-participant operations.
 *
 * Handlers are framework-agnostic and consumed by both the MCP and OpenClaw
 * adapters via the shared `toolRegistry`. Per Phase 43 Open Q2 resolution, these
 * tools move out of `src/openclaw/adapter.ts` (where they were registered
 * inline) into the shared registry so they dispatch through the single
 * `/v1/tool/invoke` IPC envelope like every other tool.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { createLogger } from "../logging/index.js";
import type { ToolContext } from "./types.js";
import { createProject } from "../projects/create.js";
import { discoverProjects } from "../projects/registry.js";
import { resolveProject } from "../projects/resolver.js";
import { writeProjectManifest } from "../projects/manifest.js";
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
  participants: z.array(z.string()).optional(),
});

export const projectListSchema = z.object({}).strict();

export const projectAddParticipantSchema = z.object({
  project: z.string().min(1),
  agent: z.string().min(1),
});

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
    participants: input.participants,
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

/**
 * aof_project_add_participant — load manifest, append to participants list,
 * atomic-write.
 *
 * Idempotent: adding a participant that is already present is a no-op (returns
 * `success: true` with a message indicating the existing state).
 */
export async function aofProjectAddParticipant(
  ctx: ToolContext,
  input: z.infer<typeof projectAddParticipantSchema>,
): Promise<unknown> {
  const vaultRoot = resolveVaultRoot(ctx);
  const resolution = await resolveProject(input.project, vaultRoot);
  const manifestPath = join(resolution.projectRoot, "project.yaml");
  const content = await readFile(manifestPath, "utf-8");
  const manifest = parseYaml(content);

  if (!manifest.participants) manifest.participants = [];

  if (manifest.participants.includes(input.agent)) {
    return {
      success: true,
      message: "Agent already a participant",
      participants: manifest.participants,
    };
  }

  manifest.participants.push(input.agent);
  await writeProjectManifest(resolution.projectRoot, manifest);

  return {
    success: true,
    participants: manifest.participants,
  };
}
