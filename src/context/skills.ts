/**
 * Skills Module — lazy-loadable context bundles.
 * 
 * Skills are structured context packages with metadata manifests.
 * Each skill lives in a directory with skill.json manifest and SKILL.md entrypoint.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Skill manifest metadata.
 * 
 * Describes a skill's structure, content, and dependencies.
 */
export interface SkillManifest {
  /** Manifest schema version */
  version: 'v1';
  /** Skill identifier (should match directory name) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Tags for categorization and search */
  tags: string[];
  /** Relative path to main skill content file */
  entrypoint: string;
  /** Optional supporting file paths (relative to skill directory) */
  references?: string[];
  /** Pre-computed token count estimate for cost planning */
  estimatedTokens?: number;
}

/**
 * Load a skill manifest from a skill directory.
 * 
 * @param skillPath - Path to skill directory containing skill.json
 * @returns Promise resolving to validated skill manifest
 * @throws Error if manifest is missing, invalid, or fails validation
 */
export async function loadSkillManifest(skillPath: string): Promise<SkillManifest> {
  const manifestPath = join(skillPath, "skill.json");
  
  let content: string;
  try {
    content = await readFile(manifestPath, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read skill manifest: ${manifestPath}`, { cause: err });
  }
  
  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON in skill manifest: ${manifestPath}`, { cause: err });
  }
  
  // Validate manifest structure
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error(`Skill manifest must be an object: ${manifestPath}`);
  }
  
  const m = manifest as Record<string, unknown>;
  
  // Validate version
  if (m.version !== "v1") {
    throw new Error(`Unsupported skill manifest version: ${m.version} (expected 'v1')`);
  }
  
  // Validate required fields
  if (typeof m.name !== "string") {
    throw new Error(`Skill manifest missing or invalid 'name' field: ${manifestPath}`);
  }
  if (typeof m.description !== "string") {
    throw new Error(`Skill manifest missing or invalid 'description' field: ${manifestPath}`);
  }
  if (!Array.isArray(m.tags)) {
    throw new Error(`Skill manifest missing or invalid 'tags' field: ${manifestPath}`);
  }
  if (typeof m.entrypoint !== "string") {
    throw new Error(`Skill manifest missing or invalid 'entrypoint' field: ${manifestPath}`);
  }
  
  // Validate optional fields if present
  if (m.references !== undefined && !Array.isArray(m.references)) {
    throw new Error(`Skill manifest 'references' must be an array: ${manifestPath}`);
  }
  if (m.estimatedTokens !== undefined && typeof m.estimatedTokens !== "number") {
    throw new Error(`Skill manifest 'estimatedTokens' must be a number: ${manifestPath}`);
  }
  
  return manifest as SkillManifest;
}

/**
 * List all available skills in a skills directory.
 * 
 * Scans the directory for subdirectories containing skill.json manifests.
 * Skips directories without valid manifests (no error thrown).
 * 
 * @param skillsDir - Path to directory containing skill subdirectories
 * @returns Promise resolving to array of skill manifests
 * @throws Error if skills directory does not exist or is not readable
 */
export async function listSkills(skillsDir: string): Promise<SkillManifest[]> {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Failed to read skills directory: ${skillsDir}`, { cause: err });
  }
  
  const skills: SkillManifest[] = [];
  
  for (const entry of entries) {
    // Only process directories
    if (!entry.isDirectory()) {
      continue;
    }
    
    const skillPath = join(skillsDir, entry.name);
    
    try {
      const manifest = await loadSkillManifest(skillPath);
      skills.push(manifest);
    } catch {
      // Skip directories without valid skill.json
      continue;
    }
  }
  
  return skills;
}
