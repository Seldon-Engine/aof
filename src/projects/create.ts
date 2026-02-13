/**
 * Project creation - validate, scaffold, and initialize new projects.
 */

import { join } from "node:path";
import { mkdir, access } from "node:fs/promises";
import { bootstrapProject } from "./bootstrap.js";
import { buildProjectManifest, writeProjectManifest } from "./manifest.js";
import type { ProjectManifest } from "../schemas/project.js";

/** Reserved project IDs that cannot be used */
const RESERVED_IDS = ["_inbox", ".", "..", "_config", "_system"];

/** Valid project ID pattern: alphanumeric, hyphens, underscores */
const VALID_ID_PATTERN = /^[a-z0-9_-]+$/;

export interface CreateProjectOptions {
  vaultRoot: string;
  title?: string;
  type?: "swe" | "ops" | "research" | "admin" | "personal" | "other";
  owner?: {
    team: string;
    lead: string;
  };
  parentId?: string;
}

export interface CreateProjectResult {
  projectId: string;
  projectRoot: string;
  manifest: ProjectManifest;
  directoriesCreated: string[];
}

/**
 * Validate a project ID.
 *
 * Rules:
 * - Alphanumeric + hyphens + underscores only
 * - Not reserved (_inbox, _system, etc.)
 * - No spaces or special characters
 *
 * @throws Error if invalid
 */
export function validateProjectId(id: string): void {
  if (!id || id.trim() !== id || id.length === 0) {
    throw new Error("Project ID cannot be empty or contain leading/trailing spaces");
  }

  if (RESERVED_IDS.includes(id)) {
    throw new Error(`Project ID "${id}" is reserved`);
  }

  if (!VALID_ID_PATTERN.test(id)) {
    throw new Error(
      `Project ID "${id}" is invalid. Use only lowercase letters, numbers, hyphens, and underscores.`
    );
  }
}

/**
 * Create a new project with standard directory structure and manifest.
 *
 * Steps:
 * 1. Validate project ID
 * 2. Check if project already exists
 * 3. Create project directory
 * 4. Bootstrap directory structure
 * 5. Generate and write project manifest
 *
 * @throws Error if validation fails or project exists
 */
export async function createProject(
  id: string,
  opts: CreateProjectOptions
): Promise<CreateProjectResult> {
  // Step 1: Validate ID
  validateProjectId(id);

  // Step 2: Resolve paths
  const projectRoot = join(opts.vaultRoot, "Projects", id);

  // Step 3: Check if exists
  try {
    await access(projectRoot);
    throw new Error(`Project "${id}" already exists at ${projectRoot}`);
  } catch (error) {
    // ENOENT is expected - project doesn't exist yet
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  // Step 4: Create project directory
  await mkdir(projectRoot, { recursive: true });

  // Step 5: Bootstrap structure
  await bootstrapProject(projectRoot);

  // Step 6: Build and write manifest
  const manifest = buildProjectManifest(id, {
    title: opts.title ?? id,
    type: opts.type ?? "other",
    owner: opts.owner ?? { team: "system", lead: "system" },
    parentId: opts.parentId,
  });

  await writeProjectManifest(projectRoot, manifest);

  // Step 7: Return result
  const directoriesCreated = ["tasks", "artifacts", "state", "views", "cold"];

  return {
    projectId: id,
    projectRoot,
    manifest,
    directoriesCreated,
  };
}
