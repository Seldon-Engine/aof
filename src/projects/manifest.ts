/**
 * Project manifest helpers — build and write project.yaml files.
 *
 * Provides defaults for standard project types (especially _inbox)
 * and reusable manifest creation for migration and project creation.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ProjectManifest } from "../schemas/project.js";
import type { ITaskStore } from "../store/interfaces.js";
import { createLogger } from "../logging/index.js";

const log = createLogger("projects:manifest");

export interface BuildProjectManifestOptions {
  title?: string;
  status?: "active" | "paused" | "archived";
  type?: "swe" | "ops" | "research" | "admin" | "personal" | "other";
  owner?: {
    team: string;
    lead: string;
  };
  participants?: string[];
  parentId?: string;
  routing?: ProjectManifest["routing"];
  memory?: ProjectManifest["memory"];
  links?: ProjectManifest["links"];
}

/**
 * Build a project manifest with sensible defaults.
 *
 * For "_inbox", provides system defaults:
 * - title: "_Inbox"
 * - status: "active"
 * - type: "admin"
 * - owner: { team: "system", lead: "system" }
 *
 * For other projects, requires explicit options.
 */
export function buildProjectManifest(
  id: string,
  opts: BuildProjectManifestOptions = {}
): ProjectManifest {
  // Special defaults for _inbox
  if (id === "_inbox") {
    return {
      id,
      title: opts.title ?? "_Inbox",
      status: opts.status ?? "active",
      type: opts.type ?? "admin",
      owner: opts.owner ?? { team: "system", lead: "system" },
      participants: opts.participants ?? [],
      ...(opts.parentId && { parentId: opts.parentId }),
      routing: opts.routing ?? {
        intake: { default: "Tasks/Backlog" },
        mailboxes: { enabled: true },
      },
      memory: opts.memory ?? {
        tiers: { bronze: "cold", silver: "warm", gold: "warm" },
        allowIndex: { warmPaths: ["Artifacts/Silver", "Artifacts/Gold"] },
        denyIndex: ["Cold", "Artifacts/Bronze", "State", "Tasks"],
      },
      links: opts.links ?? { dashboards: [], docs: [] },
    };
  }

  // For non-inbox projects, require explicit values
  if (!opts.title || !opts.type || !opts.owner) {
    throw new Error(
      `buildProjectManifest requires title, type, and owner for project "${id}"`
    );
  }

  return {
    id,
    title: opts.title,
    status: opts.status ?? "active",
    type: opts.type,
    owner: opts.owner,
    participants: opts.participants ?? [],
    ...(opts.parentId && { parentId: opts.parentId }),
    routing: opts.routing ?? {
      intake: { default: "Tasks/Backlog" },
      mailboxes: { enabled: true },
    },
    memory: opts.memory ?? {
      tiers: { bronze: "cold", silver: "warm", gold: "warm" },
      allowIndex: { warmPaths: ["Artifacts/Silver", "Artifacts/Gold"] },
      denyIndex: ["Cold", "Artifacts/Bronze", "State", "Tasks"],
    },
    links: opts.links ?? { dashboards: [], docs: [] },
  };
}

/**
 * Load project manifest from disk.
 *
 * When projectId matches store.projectId, reads from store.projectRoot/project.yaml.
 * Otherwise falls back to store.projectRoot/projects/<projectId>/project.yaml.
 *
 * Early-returns `null` (no filesystem probe, no warn log) when the
 * requested projectId is falsy. This is BUG-044: legacy tasks from an
 * unscoped base store have `frontmatter.project === undefined`, and
 * task-dispatcher previously hit this function with `projectId = "data"`
 * (the spurious basename) on every poll, producing ENOENT spam in the
 * daemon logs.
 *
 * @param store - Task store with projectRoot and (possibly null) projectId
 * @param projectId - Project to load manifest for
 * @returns Parsed manifest or null if not found / unreadable / unscoped
 */
export async function loadProjectManifest(
  store: ITaskStore,
  projectId: string | null | undefined
): Promise<ProjectManifest | null> {
  // BUG-044: no project requested, or the store itself is unscoped →
  // there can't be a manifest to load. Skip the readFile+warn path.
  if (!projectId) return null;

  try {
    const projectPath = (store.projectId && store.projectId === projectId)
      ? join(store.projectRoot, "project.yaml")
      : join(store.projectRoot, "projects", projectId, "project.yaml");
    const content = await readFile(projectPath, "utf-8");
    const manifest = parseYaml(content) as ProjectManifest;
    return manifest;
  } catch (err) {
    log.warn({ err, op: "loadProjectManifest", projectId }, "failed to load project manifest");
    return null;
  }
}

/**
 * Write project manifest to project.yaml at the given project root.
 *
 * Creates a clean YAML file with line width 120.
 */
export async function writeProjectManifest(
  projectRoot: string,
  manifest: ProjectManifest
): Promise<void> {
  const yaml = stringifyYaml(manifest, { lineWidth: 120 });
  const manifestPath = join(projectRoot, "project.yaml");
  await writeFile(manifestPath, yaml, "utf-8");
}
