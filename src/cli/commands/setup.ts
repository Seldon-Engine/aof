/**
 * `aof setup` command — post-extraction setup orchestrator.
 *
 * Called by install.sh after tarball extraction and npm ci.
 * Handles: fresh install (wizard), upgrade (migrations), legacy (data migration),
 * and OpenClaw plugin wiring.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { readFile, access, mkdir, cp, writeFile, unlink, rm } from "node:fs/promises";
import type { Command } from "commander";
import writeFileAtomic from "write-file-atomic";
import { runWizard, ensureScaffold } from "../../packaging/wizard.js";
import { normalizePath } from "../../config/paths.js";
import { runMigrations } from "../../packaging/migrations.js";
import type { Migration } from "../../packaging/migrations.js";
import { createSnapshot, restoreSnapshot, pruneSnapshots } from "../../packaging/snapshot.js";
import { migration001 } from "../../packaging/migrations/001-default-workflow-template.js";
import { migration003 } from "../../packaging/migrations/003-version-metadata.js";
import { migration004 } from "../../packaging/migrations/004-scaffold-repair.js";
import { migration005 } from "../../packaging/migrations/005-path-reconciliation.js";
import {
  detectOpenClaw,
  isAofPluginRegistered,
  registerAofPlugin,
  detectMemoryPlugin,
  configureAofAsMemoryPlugin,
  openclawConfigGet,
  openclawConfigSet,
  openclawConfigUnset,
} from "../../packaging/openclaw-cli.js";

// --- Output helpers ---

function say(msg: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function warn(msg: string): void {
  console.log(`  \x1b[33m!\x1b[0m ${msg}`);
}

function err(msg: string): void {
  console.error(`  \x1b[31m✗\x1b[0m ${msg}`);
}

// --- Types ---

export interface SetupOptions {
  dataDir: string;
  auto: boolean;
  upgrade: boolean;
  legacy: boolean;
  openclawPath?: string;
  template: "minimal" | "full";
}

// --- Migration registry ---

/**
 * Returns all registered migrations in order.
 */
function getAllMigrations(): Migration[] {
  return [migration001, migration003, migration004, migration005];
}

// --- Helpers ---

/**
 * Read the .version file from the install directory.
 * Returns "0.0.0" if the file doesn't exist (legacy installs).
 */
async function readVersionFile(dataDir: string): Promise<string> {
  try {
    const content = await readFile(join(dataDir, ".version"), "utf-8");
    return content.trim();
  } catch {
    return "0.0.0";
  }
}

/**
 * Read the version from package.json in the install directory.
 */
async function readPackageVersion(dataDir: string): Promise<string> {
  try {
    const content = await readFile(join(dataDir, "package.json"), "utf-8");
    const pkg = JSON.parse(content) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Migrate data from legacy install at ~/.openclaw/aof/ to the new dataDir.
 * Copies directories (does NOT move — keeps originals as implicit backup).
 */
async function migrateLegacyData(dataDir: string): Promise<void> {
  const legacyDir = join(homedir(), ".openclaw", "aof");
  const dataDirs = ["tasks", "events", "memory", "data", "state", "org"];
  let migrated = 0;

  for (const dir of dataDirs) {
    const src = join(legacyDir, dir);
    const dest = join(dataDir, dir);
    try {
      await access(src);
      await mkdir(dest, { recursive: true });
      await cp(src, dest, { recursive: true });
      migrated++;
      say(`Migrated ${dir}/ from legacy install`);
    } catch {
      // Directory doesn't exist in legacy install, skip
    }
  }

  // Also copy individual data files
  const dataFiles = ["memory.db", "memory-hnsw.dat"];
  for (const file of dataFiles) {
    const src = join(legacyDir, file);
    const dest = join(dataDir, file);
    try {
      await access(src);
      await cp(src, dest);
      migrated++;
      say(`Migrated ${file} from legacy install`);
    } catch {
      // File doesn't exist, skip
    }
  }

  if (migrated > 0) {
    say(`Legacy migration complete: ${migrated} items migrated`);
  } else {
    warn("No data found in legacy install to migrate");
  }

  // Write .version as 0.0.0 to mark as migrated legacy
  await writeFile(join(dataDir, ".version"), "0.0.0", "utf-8");
}

/**
 * Wire AOF as an OpenClaw plugin.
 * Soft requirement: skips with warning if OpenClaw not found.
 */
async function wireOpenClawPlugin(dataDir: string, openclawPath?: string): Promise<void> {
  // Detect OpenClaw
  let detected = false;

  if (openclawPath) {
    try {
      await access(openclawPath);
      detected = true;
      say(`OpenClaw config found at ${openclawPath}`);
    } catch {
      warn(`Specified OpenClaw path not found: ${openclawPath}`);
      return;
    }
  } else {
    const detection = await detectOpenClaw();
    detected = detection.detected;
    if (detected) {
      say(`OpenClaw detected${detection.version ? ` (${detection.version})` : ""}`);
    }
  }

  if (!detected) {
    warn("OpenClaw not detected. Skipping plugin wiring.");
    warn("Install OpenClaw to use AOF as a platform plugin.");
    return;
  }

  // Register AOF plugin
  try {
    const alreadyRegistered = await isAofPluginRegistered();
    await registerAofPlugin();
    say(alreadyRegistered ? "AOF plugin entry updated" : "AOF plugin registered");
  } catch (e) {
    warn(`Failed to register AOF plugin: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // Configure memory plugin
  try {
    const memInfo = await detectMemoryPlugin();
    await configureAofAsMemoryPlugin(memInfo.slotHolder);
    if (memInfo.slotHolder && memInfo.slotHolder !== "aof") {
      say(`Replaced ${memInfo.slotHolder} as memory plugin`);
    } else {
      say("AOF configured as memory plugin");
    }
  } catch (e) {
    warn(`Failed to configure memory plugin: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Set plugin load paths to include dataDir
  try {
    const existingPaths = (await openclawConfigGet("plugins.load.paths")) as string[] | undefined;
    const paths = Array.isArray(existingPaths) ? [...existingPaths] : [];

    // Remove old AOF paths and add current dataDir
    const filtered = paths.filter((p) => {
      if (p === dataDir) return true;
      return !(p.endsWith("/.aof") || p.endsWith("/aof"));
    });
    if (!filtered.includes(dataDir)) {
      filtered.push(dataDir);
    }
    await openclawConfigSet("plugins.load.paths", filtered);
    say("Plugin load paths updated");
  } catch (e) {
    warn(`Failed to update plugin load paths: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Set dataDir in plugin config
  try {
    await openclawConfigSet("plugins.entries.aof.config.dataDir", dataDir);
    say("Plugin dataDir configured");
  } catch (e) {
    warn(`Failed to set plugin dataDir: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Health check: verify the plugin entry exists
  try {
    const entry = await openclawConfigGet("plugins.entries.aof");
    if (!entry) {
      throw new Error("Plugin entry not found after registration");
    }
    say("Plugin health check passed");
  } catch (e) {
    err(`Plugin health check failed: ${e instanceof Error ? e.message : String(e)}`);
    warn("Rolling back plugin wiring...");
    try {
      await openclawConfigUnset("plugins.entries.aof");
      await openclawConfigUnset("plugins.slots.memory");
      warn("Plugin wiring rolled back. AOF files are still installed.");
      warn("Re-run 'aof setup' or manually configure the plugin.");
    } catch (rollbackErr) {
      warn(`Rollback also failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
    }
  }

  // Ensure AOF plugin tools are in tools.alsoAllow so agents can call them
  try {
    const aofTools = [
      "aof_task_complete", "aof_task_update", "aof_task_block",
      "aof_status_report",
    ];
    const current = (await openclawConfigGet("tools.alsoAllow")) as string[] | undefined;
    const list = Array.isArray(current) ? [...current] : [];
    const missing = aofTools.filter((t) => !list.includes(t));

    if (missing.length === 0) {
      say("AOF tools already in tools.alsoAllow");
    } else {
      list.push(...missing);
      await openclawConfigSet("tools.alsoAllow", list);
      say(`Added ${missing.length} AOF tool(s) to tools.alsoAllow`);
    }
  } catch (e) {
    warn(`Failed to update tools.alsoAllow: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Deploy skill files to ~/.openclaw/skills/aof/
  try {
    const skillTargetDir = join(homedir(), ".openclaw", "skills", "aof");
    await rm(skillTargetDir, { recursive: true, force: true });
    await mkdir(skillTargetDir, { recursive: true });

    const skillFiles = [
      { name: "SKILL.md", required: true },
      { name: "SKILL-SEED.md", required: false },
      { name: "skill.json", required: false },
    ];

    for (const { name, required } of skillFiles) {
      const src = join(dataDir, "skills", "aof", name);
      try {
        await access(src);
        await cp(src, join(skillTargetDir, name));
        say(`Deployed ${name} to skills directory`);
      } catch {
        if (required) {
          warn(`Required skill file not found: ${name}`);
        }
      }
    }
  } catch (e) {
    warn(`Failed to deploy skill files: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Main setup function ---

/**
 * Run the full setup flow.
 */
export async function runSetup(opts: SetupOptions): Promise<void> {
  const { dataDir, auto, upgrade, legacy, openclawPath, template } = opts;

  console.log(`\n  AOF Setup${auto ? " (auto mode)" : ""}`);
  console.log(`  Target: ${dataDir}\n`);

  // 1. If legacy install detected, migrate data
  if (legacy) {
    console.log("  Migrating legacy data...");
    await migrateLegacyData(dataDir);
  }

  // 2. If upgrade or legacy: run migrations with snapshot wrapper
  if (upgrade || legacy) {
    const currentVersion = await readVersionFile(dataDir);
    const targetVersion = await readPackageVersion(dataDir);
    console.log(`  Running migrations (${currentVersion} -> ${targetVersion})...`);

    const markerPath = join(dataDir, ".aof", "migration-in-progress");

    // Check for interrupted migration marker
    try {
      await access(markerPath);
      warn("Previous migration was interrupted. Re-running from clean state.");
    } catch {
      // No marker — normal flow
    }

    // Create pre-migration snapshot
    const snapshotPath = await createSnapshot(dataDir);
    say("Pre-migration snapshot created");

    // Prune old snapshots (keep last 2)
    await pruneSnapshots(dataDir, 2);

    // Write in-progress marker (atomic write for crash safety)
    await mkdir(join(dataDir, ".aof"), { recursive: true });
    await writeFileAtomic(markerPath, new Date().toISOString());

    try {
      const result = await runMigrations({
        aofRoot: dataDir,
        migrations: getAllMigrations(),
        targetVersion,
      });

      // Success: remove marker file
      try { await unlink(markerPath); } catch { /* ignore if already gone */ }
      say(`Migrations: ${result.applied.length} applied`);
    } catch (error) {
      // Failure: restore snapshot, remove marker, report error
      err(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
      await restoreSnapshot(dataDir, snapshotPath);
      try { await unlink(markerPath); } catch { /* ignore if already gone */ }
      say("Data restored from pre-migration snapshot");
      throw error;
    }
  }

  // 3. If fresh install: run wizard for workspace scaffolding
  if (!upgrade && !legacy) {
    console.log("  Scaffolding workspace...");

    const result = await runWizard({
      installDir: dataDir,
      template: template || "minimal",
      interactive: !auto,
      skipOpenClaw: true, // We handle OpenClaw wiring separately
      healthCheck: true,
      force: false,
    });

    say(`Workspace scaffolded: ${result.created.length} items created`);

    if (result.warnings && result.warnings.length > 0) {
      for (const w of result.warnings) {
        warn(w);
      }
    }

    // Write version metadata for fresh installs too
    const freshVersion = await readPackageVersion(dataDir);
    await migration003.up({ aofRoot: dataDir, version: freshVersion });
    say("Version metadata written");
  }

  // 4. Ensure scaffold integrity (repairs broken installs on upgrade)
  const repaired = await ensureScaffold(dataDir);
  if (repaired.length > 0) {
    say(`Repaired: ${repaired.join(", ")}`);
  }

  // 5. OpenClaw plugin wiring
  console.log("\n  Configuring OpenClaw integration...");
  await wireOpenClawPlugin(dataDir, openclawPath);

  say("Setup complete");
}

// --- CLI registration ---

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Run post-installation setup (wizard, migrations, plugin wiring)")
    .option("--auto", "Fully automatic mode, no prompts", false)
    .option("--data-dir <path>", "AOF root directory", join(homedir(), ".aof"))
    .option("--upgrade", "Existing installation detected, run upgrade flow", false)
    .option("--legacy", "Legacy installation detected at ~/.openclaw/aof/", false)
    .option("--openclaw-path <path>", "Explicit OpenClaw config path")
    .option("--template <template>", "Org chart template (minimal or full)", "minimal")
    .action(
      async (opts: {
        auto: boolean;
        dataDir: string;
        upgrade: boolean;
        legacy: boolean;
        openclawPath?: string;
        template: string;
      }) => {
        try {
          await runSetup({
            dataDir: normalizePath(opts.dataDir),
            auto: opts.auto,
            upgrade: opts.upgrade,
            legacy: opts.legacy,
            openclawPath: opts.openclawPath,
            template: (opts.template === "full" ? "full" : "minimal") as "minimal" | "full",
          });
        } catch (e) {
          err(e instanceof Error ? e.message : String(e));
          process.exitCode = 1;
        }
      },
    );
}
