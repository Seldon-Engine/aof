/**
 * AOF Migration Framework
 * Manages schema migrations across version updates.
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";

export interface Migration {
  id: string;
  version: string;
  description: string;
  up: (ctx: MigrationContext) => Promise<void>;
  down?: (ctx: MigrationContext) => Promise<void>;
}

export interface MigrationContext {
  aofRoot: string;
  version: string;
}

export interface MigrationHistoryEntry {
  id: string;
  version: string;
  description: string;
  appliedAt?: string;
}

export interface MigrationHistory {
  migrations: MigrationHistoryEntry[];
}

export interface RunMigrationsOptions {
  aofRoot: string;
  migrations: Migration[];
  targetVersion: string;
  direction?: "up" | "down";
}

export interface RunMigrationsResult {
  success: boolean;
  applied: string[];
}

const MIGRATION_HISTORY_FILE = ".aof/migrations.json";

// Global migration registry
const migrationRegistry: Map<string, Migration> = new Map();

/**
 * Register a migration in the global registry.
 */
export function registerMigration(migration: Migration): void {
  migrationRegistry.set(migration.id, migration);
}

/**
 * Run migrations up to target version.
 */
export async function runMigrations(opts: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const { aofRoot, migrations, targetVersion, direction = "up" } = opts;

  // Get migration history
  const history = await getMigrationHistory(aofRoot);
  const appliedIds = new Set(history.migrations.map(m => m.id));

  // Filter migrations based on direction and version
  let pendingMigrations: Migration[];

  if (direction === "up") {
    // Run migrations not yet applied, up to target version
    pendingMigrations = migrations.filter(m => {
      if (appliedIds.has(m.id)) return false;
      return compareVersions(m.version, targetVersion) <= 0;
    });
  } else {
    // Reverse migrations applied after target version
    pendingMigrations = migrations
      .filter(m => {
        if (!appliedIds.has(m.id)) return false;
        return compareVersions(m.version, targetVersion) > 0;
      })
      .reverse();
  }

  // Sort by version (ascending for up, already reversed for down)
  if (direction === "up") {
    pendingMigrations.sort((a, b) => compareVersions(a.version, b.version));
  }

  const applied: string[] = [];
  const ctx: MigrationContext = { aofRoot, version: targetVersion };

  try {
    for (const migration of pendingMigrations) {
      if (direction === "up") {
        await migration.up(ctx);
        await recordMigration(aofRoot, migration);
      } else {
        if (!migration.down) {
          throw new Error(`Migration ${migration.id} is not reversible`);
        }
        await migration.down(ctx);
        await removeMigration(aofRoot, migration.id);
      }

      applied.push(migration.id);
    }

    return {
      success: true,
      applied,
    };
  } catch (error) {
    throw new Error(
      `Migration failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Get migration history.
 */
export async function getMigrationHistory(aofRoot: string): Promise<MigrationHistory> {
  const historyPath = join(aofRoot, MIGRATION_HISTORY_FILE);

  try {
    await access(historyPath);
    const content = await readFile(historyPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return { migrations: [] };
  }
}

// --- Helper functions ---

async function recordMigration(aofRoot: string, migration: Migration): Promise<void> {
  const history = await getMigrationHistory(aofRoot);

  const entry: MigrationHistoryEntry = {
    id: migration.id,
    version: migration.version,
    description: migration.description,
    appliedAt: new Date().toISOString(),
  };

  history.migrations.push(entry);

  const historyPath = join(aofRoot, MIGRATION_HISTORY_FILE);
  await mkdir(join(aofRoot, ".aof"), { recursive: true });
  await writeFile(historyPath, JSON.stringify(history, null, 2));
}

async function removeMigration(aofRoot: string, migrationId: string): Promise<void> {
  const history = await getMigrationHistory(aofRoot);

  history.migrations = history.migrations.filter(m => m.id !== migrationId);

  const historyPath = join(aofRoot, MIGRATION_HISTORY_FILE);
  await mkdir(join(aofRoot, ".aof"), { recursive: true });
  await writeFile(historyPath, JSON.stringify(history, null, 2));
}

/**
 * Compare semantic versions.
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
function compareVersions(a: string, b: string): number {
  const aParts = a.split(".").map(Number);
  const bParts = b.split(".").map(Number);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i] ?? 0;
    const bPart = bParts[i] ?? 0;

    if (aPart < bPart) return -1;
    if (aPart > bPart) return 1;
  }

  return 0;
}
