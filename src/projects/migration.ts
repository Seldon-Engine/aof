/**
 * Migration tooling — safely migrate legacy single-project vaults to Projects v0.
 *
 * Implements:
 * - Legacy → Projects/_inbox/ migration with backup
 * - Rollback from backup
 * - Dry-run support
 * - Idempotent operation
 */

import {
  readdir,
  mkdir,
  rename,
  copyFile,
  readFile,
  writeFile,
  stat,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { bootstrapProject } from "./bootstrap.js";
import { buildProjectManifest, writeProjectManifest } from "./manifest.js";

/** Legacy directories that may exist in vault root. */
const LEGACY_DIRS = ["tasks", "events", "views", "state"] as const;

/** Directories that should be present in Projects/_inbox/ after migration. */
const REQUIRED_INBOX_DIRS = ["tasks", "artifacts", "state", "views", "cold"] as const;

export interface MigrationOptions {
  /** If true, report planned actions without making changes. */
  dryRun?: boolean;
  /** Custom backup directory name (for testing). */
  backupDir?: string;
  /** Custom timestamp for deterministic testing. */
  timestamp?: string;
}

export interface RollbackOptions {
  /** If true, report planned actions without making changes. */
  dryRun?: boolean;
  /** Explicit backup directory to restore from (defaults to latest tasks.backup-*). */
  backupDir?: string;
}

export interface MigrationResult {
  success: boolean;
  backupPath?: string;
  migratedDirs: string[];
  updatedTaskCount: number;
  skippedTaskCount: number;
  warnings: string[];
}

export interface RollbackResult {
  success: boolean;
  restoredDirs: string[];
  warnings: string[];
}

/**
 * Migrate legacy vault layout to Projects/_inbox/.
 *
 * Steps:
 * 1. Check if migration is needed (legacy dirs exist, _inbox doesn't).
 * 2. Create backup directory (tasks.backup-<timestamp>).
 * 3. Move legacy dirs into backup.
 * 4. Create Projects/_inbox/ with required structure.
 * 5. Copy files from backup into _inbox scope.
 * 6. Update task frontmatter to include `project: "_inbox"`.
 *
 * Idempotent: if legacy dirs missing and _inbox exists, treats as already migrated.
 */
export async function migrateToProjects(
  vaultRoot: string,
  opts: MigrationOptions = {}
): Promise<MigrationResult> {
  const result: MigrationResult = {
    success: false,
    migratedDirs: [],
    updatedTaskCount: 0,
    skippedTaskCount: 0,
    warnings: [],
  };

  // Step 1: Check if migration is needed
  const legacyDirsPresent = await checkLegacyDirsExist(vaultRoot);
  const inboxExists = await directoryExists(join(vaultRoot, "Projects", "_inbox"));

  if (legacyDirsPresent.length === 0 && inboxExists) {
    result.warnings.push("Already migrated: no legacy dirs and _inbox exists");
    result.success = true;
    return result;
  }

  if (legacyDirsPresent.length === 0 && !inboxExists) {
    // Fresh install: create _inbox and return
    result.warnings.push("Fresh install: creating _inbox project");
    if (!opts.dryRun) {
      const inboxRoot = join(vaultRoot, "Projects", "_inbox");
      await mkdir(join(vaultRoot, "Projects"), { recursive: true });
      await bootstrapProject(inboxRoot);
      
      // Write project.yaml
      const manifest = buildProjectManifest("_inbox");
      await writeProjectManifest(inboxRoot, manifest);
    }
    result.success = true;
    return result;
  }

  if (inboxExists) {
    result.warnings.push(
      "Projects/_inbox already exists; migration may have been partially completed"
    );
  }

  // Step 2: Create backup directory
  const timestamp = opts.timestamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const backupDirName = opts.backupDir ?? `tasks.backup-${timestamp}`;
  const backupPath = join(vaultRoot, backupDirName);
  result.backupPath = backupPath;

  if (!opts.dryRun) {
    await mkdir(backupPath, { recursive: true });
  }

  // Step 3: Move legacy dirs into backup
  for (const dir of legacyDirsPresent) {
    const sourcePath = join(vaultRoot, dir);
    const destPath = join(backupPath, dir);

    if (!opts.dryRun) {
      await rename(sourcePath, destPath);
    }
    result.migratedDirs.push(dir);
  }

  // Step 4: Create Projects/_inbox/ with required structure
  const inboxRoot = join(vaultRoot, "Projects", "_inbox");
  if (!opts.dryRun) {
    await mkdir(join(vaultRoot, "Projects"), { recursive: true });
    await bootstrapProject(inboxRoot);

    // Create events/ if it was present in legacy
    if (legacyDirsPresent.includes("events")) {
      await mkdir(join(inboxRoot, "events"), { recursive: true });
    }

    // Write project.yaml
    const manifest = buildProjectManifest("_inbox");
    await writeProjectManifest(inboxRoot, manifest);

  }

  // Step 5: Copy files from backup into _inbox scope
  for (const dir of legacyDirsPresent) {
    const sourceDir = join(backupPath, dir);
    const destDir = join(inboxRoot, dir);

    if (dir === "tasks") {
      // Copy entire tasks directory first (preserves all artifacts, companion dirs, non-md files)
      if (!opts.dryRun) {
        await copyDirectory(sourceDir, destDir);
      }
      
      // Then update frontmatter on task card files only (top-level .md files under status dirs)
      const stats = await updateTaskCardFrontmatter(
        destDir,
        "_inbox",
        opts.dryRun ?? false
      );
      result.updatedTaskCount += stats.updated;
      result.skippedTaskCount += stats.skipped;
    } else if (!opts.dryRun) {
      // Copy other dirs recursively (events, views, state)
      await copyDirectory(sourceDir, destDir);
    }
  }

  result.success = true;
  return result;
}

/**
 * Rollback migration — restore legacy layout from backup.
 *
 * Steps:
 * 1. Find backup directory (explicit or latest tasks.backup-*).
 * 2. Remove/rename Projects/_inbox to avoid duplicates.
 * 3. Move backup dirs back to vault root.
 */
export async function rollbackMigration(
  vaultRoot: string,
  opts: RollbackOptions = {}
): Promise<RollbackResult> {
  const result: RollbackResult = {
    success: false,
    restoredDirs: [],
    warnings: [],
  };

  // Step 1: Find backup directory
  let backupPath: string;
  if (opts.backupDir) {
    backupPath = join(vaultRoot, opts.backupDir);
  } else {
    const latestBackup = await findLatestBackup(vaultRoot);
    if (!latestBackup) {
      throw new Error("No backup directory found (tasks.backup-*)");
    }
    backupPath = latestBackup;
  }

  const backupExists = await directoryExists(backupPath);
  if (!backupExists) {
    throw new Error(`Backup directory not found: ${backupPath}`);
  }

  // Step 2: Remove/rename Projects/_inbox
  const inboxPath = join(vaultRoot, "Projects", "_inbox");
  const inboxExists = await directoryExists(inboxPath);

  if (inboxExists && !opts.dryRun) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const renamedInbox = join(vaultRoot, `_inbox.rollback-${timestamp}`);
    await rename(inboxPath, renamedInbox);
    result.warnings.push(`Renamed _inbox to ${renamedInbox}`);
  }

  // Step 3: Move backup dirs back to vault root
  const backupContents = await readdir(backupPath);
  for (const item of backupContents) {
    const sourcePath = join(backupPath, item);
    const destPath = join(vaultRoot, item);

    // Check if it's a directory
    const itemStat = await stat(sourcePath);
    if (itemStat.isDirectory()) {
      if (!opts.dryRun) {
        await rename(sourcePath, destPath);
      }
      result.restoredDirs.push(item);
    }
  }

  result.success = true;
  return result;
}

// --- Helper Functions ---

/**
 * Check which legacy directories exist in vault root.
 */
async function checkLegacyDirsExist(vaultRoot: string): Promise<string[]> {
  const present: string[] = [];
  for (const dir of LEGACY_DIRS) {
    const exists = await directoryExists(join(vaultRoot, dir));
    if (exists) {
      present.push(dir);
    }
  }
  return present;
}

/**
 * Check if a directory exists.
 */
async function directoryExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find the latest backup directory (tasks.backup-*) in vault root.
 */
async function findLatestBackup(vaultRoot: string): Promise<string | null> {
  try {
    const entries = await readdir(vaultRoot);
    const backups = entries
      .filter((name) => name.startsWith("tasks.backup-"))
      .sort()
      .reverse();

    return backups.length > 0 ? join(vaultRoot, backups[0]!) : null;
  } catch {
    return null;
  }
}

/**
 * Copy and update task files recursively.
 *
 * For each .md file:
 * - Parse YAML frontmatter
 * - Add/overwrite `project: "_inbox"`
 * - Write to destination
 *
 * Preserves body content. Does NOT validate schema (legacy tasks may be incomplete).
 */
/**
 * Update task card frontmatter in-place (after full copy).
 * 
 * Only processes top-level .md files in status directories (e.g., tasks/backlog/*.md).
 * Does NOT recurse into task companion subdirectories (e.g., tasks/ready/TASK-123/outputs/).
 * Skips files that already have the project field set (idempotent).
 */
async function updateTaskCardFrontmatter(
  tasksDir: string,
  projectId: string,
  dryRun: boolean
): Promise<{ updated: number; skipped: number }> {
  let updated = 0;
  let skipped = 0;

  try {
    const statusDirs = await readdir(tasksDir, { withFileTypes: true });

    for (const statusEntry of statusDirs) {
      if (!statusEntry.isDirectory()) {
        continue;
      }

      const statusPath = join(tasksDir, statusEntry.name);
      const taskFiles = await readdir(statusPath, { withFileTypes: true });

      for (const taskEntry of taskFiles) {
        // Only process top-level .md files (task cards)
        if (!taskEntry.isFile() || !taskEntry.name.endsWith(".md")) {
          continue;
        }

        const taskPath = join(statusPath, taskEntry.name);

        // Always read to check if already migrated (even in dry-run)
        const content = await readFile(taskPath, "utf-8");
        
        // Check if already migrated (has project field)
        if (hasProjectField(content, projectId)) {
          skipped++;
          continue;
        }

        // Update file (unless dry-run)
        if (!dryRun) {
          const updatedContent = updateTaskFrontmatter(content, projectId);
          await writeFile(taskPath, updatedContent, "utf-8");
        }
        
        updated++;
      }
    }
  } catch (error) {
    // If tasks directory doesn't exist, that's OK (fresh install)
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return { updated, skipped };
}

/**
 * Update task frontmatter to include `project: "<projectId>"`.
 *
 * Does NOT validate schema — legacy tasks may be missing required fields.
 * Uses YAML parse/stringify to preserve structure.
 */
function updateTaskFrontmatter(content: string, projectId: string): string {
  const FENCE = "---";
  const lines = content.split("\n");

  if (lines[0]?.trim() !== FENCE) {
    throw new Error("Task file must start with YAML frontmatter (---)");
  }

  const endIdx = lines.indexOf(FENCE, 1);
  if (endIdx === -1) {
    throw new Error("Unterminated YAML frontmatter (missing closing ---)");
  }

  const yamlBlock = lines.slice(1, endIdx).join("\n");
  const body = lines.slice(endIdx + 1).join("\n");

  // Parse frontmatter and add/overwrite project field
  const frontmatter = parseYaml(yamlBlock) as Record<string, unknown>;
  frontmatter.project = projectId;

  // Serialize back
  const updatedYaml = stringifyYaml(frontmatter, { lineWidth: 120 });
  return `${FENCE}\n${updatedYaml}${FENCE}${body}`;
}

/**
 * Check if a task file already has the project field set (for idempotency).
 */
function hasProjectField(content: string, expectedProjectId: string): boolean {
  const FENCE = "---";
  const lines = content.split("\n");

  if (lines[0]?.trim() !== FENCE) {
    return false;
  }

  const endIdx = lines.indexOf(FENCE, 1);
  if (endIdx === -1) {
    return false;
  }

  try {
    const yamlBlock = lines.slice(1, endIdx).join("\n");
    const frontmatter = parseYaml(yamlBlock) as Record<string, unknown>;
    return frontmatter.project === expectedProjectId;
  } catch {
    return false;
  }
}

/**
 * Check if a file exists.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Recursively copy directory contents.
 */
async function copyDirectory(source: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });

  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destPath);
    } else {
      await copyFile(sourcePath, destPath);
    }
  }
}
