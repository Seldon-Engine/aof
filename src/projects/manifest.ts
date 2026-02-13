/**
 * Project manifest helpers — build and write project.yaml files.
 *
 * Provides defaults for standard project types (especially _inbox)
 * and reusable manifest creation for migration and project creation.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { ProjectManifest } from "../schemas/project.js";

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
