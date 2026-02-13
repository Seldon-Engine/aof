/**
 * Project registry - discovers and validates projects from vault.
 *
 * Scans vaultRoot/Projects directories for project.yaml manifests.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ProjectManifest } from "../schemas/project.js";
import type { ZodError } from "zod";

/** Project record returned by registry. */
export interface ProjectRecord {
  /** Project ID (matches directory name). */
  id: string;
  /** Absolute path to project directory. */
  path: string;
  /** Parsed manifest (undefined if invalid). */
  manifest?: ProjectManifest;
  /** Validation or parse error (if any). */
  error?: string;
  /** Parent project ID (from manifest.parentId). */
  parentId?: string;
  /** Child project IDs (computed from other projects' parentId). */
  children?: string[];
}

/** Options for project discovery. */
export interface DiscoverOptions {
  /** Include archived projects (default: false). */
  includeArchived?: boolean;
}

/**
 * Discover projects from vaultRoot.
 *
 * - Scans vaultRoot/Projects directories
 * - Always includes _inbox (creates placeholder if missing)
 * - Validates manifests and returns errors for invalid projects
 * - Skips archived projects by default
 * - Populates parent/child relationships
 */
export async function discoverProjects(
  vaultRoot: string,
  options: DiscoverOptions = {}
): Promise<ProjectRecord[]> {
  const projectsRoot = resolve(vaultRoot, "Projects");
  const records: ProjectRecord[] = [];

  const dirs = await scanProjectDirs(projectsRoot);
  const foundInbox = dirs.some((d) => d === "_inbox");

  for (const dirName of dirs) {
    const record = await loadProject(projectsRoot, dirName);
    records.push(record);
  }

  // Always include _inbox even if missing
  if (!foundInbox) {
    records.unshift(createInboxPlaceholder(projectsRoot));
  }

  // Populate parent/child relationships
  populateHierarchy(records);

  // Filter archived unless requested
  if (!options.includeArchived) {
    return records.filter(
      (r) => !r.manifest || r.manifest.status !== "archived"
    );
  }

  return records;
}

/**
 * Populate parentId and children arrays for all project records.
 */
function populateHierarchy(records: ProjectRecord[]): void {
  // First pass: copy parentId from manifest to record
  for (const record of records) {
    if (record.manifest?.parentId) {
      record.parentId = record.manifest.parentId;
    }
  }

  // Second pass: build children arrays
  const childrenMap = new Map<string, string[]>();
  
  for (const record of records) {
    if (record.parentId) {
      const siblings = childrenMap.get(record.parentId) ?? [];
      siblings.push(record.id);
      childrenMap.set(record.parentId, siblings);
    }
  }

  // Third pass: assign children arrays to parent records
  for (const record of records) {
    const children = childrenMap.get(record.id);
    if (children && children.length > 0) {
      record.children = children;
    }
  }
}

/** Scan project directories under Projects/. */
async function scanProjectDirs(projectsRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(projectsRoot, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/** Load and validate a single project. */
async function loadProject(
  projectsRoot: string,
  dirName: string
): Promise<ProjectRecord> {
  const projectPath = join(projectsRoot, dirName);
  const manifestPath = join(projectPath, "project.yaml");

  try {
    const content = await readFile(manifestPath, "utf-8");
    const raw = parseYaml(content);
    const manifest = ProjectManifest.parse(raw);

    // Validate ID matches directory name
    if (manifest.id !== dirName) {
      return {
        id: dirName,
        path: projectPath,
        error: `Manifest ID '${manifest.id}' does not match directory name '${dirName}'`,
      };
    }

    return {
      id: manifest.id,
      path: projectPath,
      manifest,
    };
  } catch (err) {
    return {
      id: dirName,
      path: projectPath,
      error: formatError(err),
    };
  }
}

/** Create placeholder record for missing _inbox. */
function createInboxPlaceholder(projectsRoot: string): ProjectRecord {
  return {
    id: "_inbox",
    path: join(projectsRoot, "_inbox"),
    manifest: {
      id: "_inbox",
      title: "Inbox",
      status: "active",
      type: "admin",
      owner: { team: "ops", lead: "system" },
      participants: [],
      routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: true } },
      memory: {
        tiers: { bronze: "cold", silver: "warm", gold: "warm" },
        allowIndex: { warmPaths: ["Artifacts/Silver", "Artifacts/Gold"] },
        denyIndex: ["Cold", "Artifacts/Bronze", "State", "Tasks"],
      },
      links: { dashboards: [], docs: [] },
    },
  };
}

/** Format error for registry entry. */
function formatError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "ZodError") {
      const zodErr = err as ZodError;
      return `Validation failed: ${zodErr.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")}`;
    }
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "Missing project.yaml";
    }
    return err.message;
  }
  return String(err);
}
