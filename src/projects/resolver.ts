/**
 * Project resolution utility for CLI and tools.
 *
 * Resolves project IDs to project roots, handles _inbox default.
 */

import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { access } from "node:fs/promises";

export interface ProjectResolution {
  projectId: string;
  projectRoot: string;
  vaultRoot: string;
}

/**
 * Resolve a project ID to its root directory.
 *
 * @param projectId - Project ID (e.g., "_inbox", "aof-core")
 * @param vaultRoot - Optional vault root (defaults to AOF_ROOT env or ~/Projects/AOF)
 * @returns Project resolution with projectId, projectRoot, and vaultRoot
 */
export async function resolveProject(
  projectId: string = "_inbox",
  vaultRoot?: string
): Promise<ProjectResolution> {
  // Resolve vault root
  const resolvedVaultRoot =
    vaultRoot ??
    process.env["AOF_ROOT"] ??
    resolve(homedir(), "Projects", "AOF");

  // For _inbox or other projects, resolve under Projects/
  const projectRoot = join(resolvedVaultRoot, "Projects", projectId);

  return {
    projectId,
    projectRoot,
    vaultRoot: resolvedVaultRoot,
  };
}

/**
 * Check if a project directory exists.
 *
 * @param projectRoot - Absolute path to project directory
 * @returns true if the directory exists and is accessible
 */
export async function projectExists(projectRoot: string): Promise<boolean> {
  try {
    await access(projectRoot);
    return true;
  } catch {
    return false;
  }
}
