/**
 * Project bootstrap - ensures required project directory structure.
 *
 * Creates:
 * - tasks/, artifacts/, state/, views/, cold/
 * - artifacts/{bronze,silver,gold}/
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Required top-level directories for a project. */
const REQUIRED_DIRS = ["tasks", "artifacts", "state", "views", "cold"] as const;

/** Required artifact tier subdirectories. */
const ARTIFACT_TIERS = ["bronze", "silver", "gold"] as const;

/**
 * Bootstrap project structure at the given root path.
 *
 * Creates all required directories if missing.
 * Safe to call on existing projects (idempotent).
 */
export async function bootstrapProject(projectRoot: string): Promise<void> {
  // Create top-level directories
  for (const dir of REQUIRED_DIRS) {
    await mkdir(join(projectRoot, dir), { recursive: true });
  }

  // Create artifact tier subdirectories
  const artifactsRoot = join(projectRoot, "artifacts");
  for (const tier of ARTIFACT_TIERS) {
    await mkdir(join(artifactsRoot, tier), { recursive: true });
  }
}
