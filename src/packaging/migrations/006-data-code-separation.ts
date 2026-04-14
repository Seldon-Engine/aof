/**
 * Migration 006: Separate user data from install directory.
 *
 * Historically AOF installed code AND stored user data under ~/.aof. That made
 * upgrades risky: layout changes between versions left orphan files on disk
 * because `tar -xzf` is additive (files absent from the new tarball survive).
 *
 * From v1.13 onward, user data is segregated into a dedicated subdirectory:
 *   ~/.aof/         install root — code, package.json, node_modules, data/
 *   ~/.aof/data/    user data — tasks, org, memory, events, state, Projects, logs
 *
 * The installer preserves ~/.aof/data/ across upgrades and --clean runs; the
 * rest of ~/.aof/ is installer-owned and freely wiped.
 *
 * This migration moves user data out of the install directory. It also
 * updates the OpenClaw plugin config if it points `dataDir` at the legacy
 * location, so the plugin keeps reading its own data after restart.
 *
 * Safety:
 *   - Uses rename() for atomic per-item moves; both dirs are under $HOME so
 *     this stays on a single filesystem in practice.
 *   - If a directory already exists at the destination, the legacy copy is
 *     renamed to <dir>.migrated-<timestamp> inside the legacy root — never
 *     deleted — so manual reconciliation remains possible.
 *   - Writes a breadcrumb in the legacy dir so the migration is idempotent.
 *   - No-op if legacy location does not exist, equals the new location, or
 *     contains no data items.
 */

import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { access, rename, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";
import type { Migration, MigrationContext } from "../migrations.js";

const BREADCRUMB = ".migrated-to-data-subdir";

// Resolve paths lazily so tests can override HOME between runs. Production
// behavior is unchanged: both resolve from the current environment.
function legacyInstallDir(): string {
  return resolve(homedir(), ".aof");
}

function openclawConfigPath(): string {
  return resolve(homedir(), ".openclaw", "openclaw.json");
}

// Note: we intentionally don't include a top-level "data" entry here. Under
// the new layout the user data root IS ~/.aof/data, so any existing ~/.aof/data
// must be treated as already-migrated (or the target of an in-progress move),
// never as legacy data to be relocated into itself.
const DATA_DIRS = [
  "tasks",
  "events",
  "memory",
  "state",
  "Projects",
  "logs",
  "org",
  "config",
];
const DATA_FILES = ["memory.db", "memory-hnsw.dat"];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * True if the directory contains no regular files at any depth — only empty
 * (possibly nested) subdirectories. Lets us distinguish "fresh scaffold"
 * (e.g. tasks/{ready,in-progress,...} with no task files) from real user data.
 * Safe to replace a scaffold-only directory with the legacy data being moved.
 */
async function hasOnlyScaffold(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isFile() || e.isSymbolicLink()) return false;
      if (e.isDirectory()) {
        if (!(await hasOnlyScaffold(full))) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function say(msg: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function warn(msg: string): void {
  console.log(`  \x1b[33m!\x1b[0m ${msg}`);
}

/**
 * Update OpenClaw plugin config so `plugins.entries.aof.config.dataDir` points
 * at the new data location. No-op if config missing or dataDir already correct.
 * The atomic-write + .pre-migration backup pattern mirrors what setup.ts does
 * when it wires the plugin, so rollback means restoring from the backup.
 */
async function updateOpenclawConfig(newDataDir: string): Promise<void> {
  const configPath = openclawConfigPath();
  const legacyInstall = legacyInstallDir();

  if (!(await exists(configPath))) return;

  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    warn(`Could not read ${configPath}`);
    return;
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    warn(`Could not parse ${configPath}; skipping plugin config update`);
    return;
  }

  const entries = (config.plugins as Record<string, unknown> | undefined)?.entries as
    | Record<string, unknown>
    | undefined;
  const aofEntry = entries?.aof as Record<string, unknown> | undefined;
  const aofConfig = aofEntry?.config as Record<string, unknown> | undefined;

  if (!aofConfig) return; // plugin not registered with a config block — nothing to do

  const currentDataDir = aofConfig.dataDir;
  const isLegacyPointer =
    currentDataDir === "~/.aof" ||
    currentDataDir === legacyInstall ||
    currentDataDir === undefined; // unset → plugin uses its own default which was ~/.aof

  if (!isLegacyPointer) return;

  const backupPath = `${configPath}.${Date.now()}.pre-migration006.backup.json`;
  await writeFile(backupPath, raw, "utf-8");
  aofConfig.dataDir = newDataDir;

  await writeFileAtomic(configPath, JSON.stringify(config, null, 2) + "\n");
  say(`OpenClaw plugin dataDir → ${newDataDir} (backup: ${backupPath})`);
}

export const migration006: Migration = {
  id: "006-data-code-separation",
  version: "1.13.0",
  description: "Move user data into dedicated subdirectory (~/.aof/{tasks,org,...} → ~/.aof/data/)",

  up: async (ctx: MigrationContext): Promise<void> => {
    const newDataDir = ctx.aofRoot;
    const legacyInstall = legacyInstallDir();

    // No-op: user explicitly set data dir back to the legacy install path
    if (resolve(newDataDir) === legacyInstall) {
      say("006 skipped (data dir equals install dir — user override)");
      return;
    }

    // No-op: legacy install dir doesn't exist (fresh install)
    if (!(await exists(legacyInstall))) {
      say("006 skipped (no legacy install directory)");
      return;
    }

    // Idempotence: already migrated
    if (await exists(join(legacyInstall, BREADCRUMB))) {
      say("006 skipped (already migrated)");
      return;
    }

    // Check if there's anything to migrate
    const present: string[] = [];
    for (const dir of DATA_DIRS) {
      if (await exists(join(legacyInstall, dir))) present.push(dir);
    }
    const filesPresent: string[] = [];
    for (const f of DATA_FILES) {
      if (await exists(join(legacyInstall, f))) filesPresent.push(f);
    }

    if (present.length === 0 && filesPresent.length === 0) {
      say("006 skipped (no user data in install dir)");
      return;
    }

    say(`006 moving user data: ${legacyInstall} → ${newDataDir}`);
    await mkdir(newDataDir, { recursive: true });

    let moved = 0;
    let conflicted = 0;
    const ts = Date.now();

    // Move directories
    for (const dir of present) {
      const src = join(legacyInstall, dir);
      const dest = join(newDataDir, dir);

      if (await exists(dest)) {
        // An earlier migration (004-scaffold-repair) may have created empty
        // scaffold at the destination before we got here. That's not a real
        // conflict — replace the scaffold with the legacy data being moved.
        if (await hasOnlyScaffold(dest)) {
          try {
            await rm(dest, { recursive: true, force: true });
          } catch (e) {
            warn(`${dir}/: could not remove empty scaffold at ${dest} (${String(e)}); treating as conflict`);
          }
        }
      }

      if (await exists(dest)) {
        // Destination has real content — don't merge blindly. Stash legacy.
        const stash = `${src}.migrated-${ts}`;
        try {
          await rename(src, stash);
          warn(`${dir}/: destination has real content at ${dest}; legacy renamed to ${stash}`);
          conflicted++;
        } catch (e) {
          warn(`${dir}/: could not stash legacy (${String(e)}); left in place`);
        }
        continue;
      }

      if (!(await isDir(src))) continue;

      try {
        await rename(src, dest);
        moved++;
      } catch (e) {
        warn(`${dir}/: rename failed (${String(e)}); left in place — manual move required`);
      }
    }

    // Move files
    for (const file of filesPresent) {
      const src = join(legacyInstall, file);
      const dest = join(newDataDir, file);

      if (await exists(dest)) {
        const stash = `${src}.migrated-${ts}`;
        try {
          await rename(src, stash);
          warn(`${file}: destination exists; legacy renamed to ${stash}`);
          conflicted++;
        } catch (e) {
          warn(`${file}: could not stash legacy (${String(e)}); left in place`);
        }
        continue;
      }

      try {
        await rename(src, dest);
        moved++;
      } catch (e) {
        warn(`${file}: rename failed (${String(e)}); left in place`);
      }
    }

    // Update OpenClaw plugin config so the plugin reads from the new location
    await updateOpenclawConfig(newDataDir);

    // Breadcrumb
    const report = [
      `Migrated from ${legacyInstall} to ${newDataDir}`,
      `Timestamp: ${new Date(ts).toISOString()}`,
      `Items moved: ${moved}`,
      `Conflicts stashed: ${conflicted}`,
      "",
    ].join("\n");
    await writeFile(join(legacyInstall, BREADCRUMB), report, "utf-8");

    if (moved > 0) say(`006 moved ${moved} item(s)`);
    if (conflicted > 0) {
      warn(`006 ${conflicted} conflict(s) stashed in ${legacyInstall} as .migrated-${ts}`);
    }
  },
};
