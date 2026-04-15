/**
 * System management commands: install, deps, channel, update.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { install, update, list } from "../../packaging/installer.js";
import { getChannel, setChannel, checkForUpdates, getVersionManifest } from "../../packaging/channels.js";
import { selfUpdate, rollbackUpdate } from "../../packaging/updater.js";
import { runMigrations } from "../../packaging/migrations.js";

/**
 * Register install command.
 */
export function registerInstallCommand(program: Command): void {
  program
    .command("install")
    .description("Install AOF and dependencies")
    .option("--no-lockfile", "Skip lockfile (use npm install instead of npm ci)")
    .option("--strict", "Fail if lockfile is missing", false)
    .action(async (opts: { lockfile: boolean; strict: boolean }) => {
      const root = program.opts()["root"] as string;

      console.log("📦 Installing AOF dependencies...\n");

      try {
        const result = await install({
          cwd: root,
          useLockfile: opts.lockfile,
          strict: opts.strict,
          healthCheck: true,
        });

        console.log(`✅ Installation complete!`);
        console.log(`   Command: ${result.command}`);
        console.log(`   Installed: ${result.installed} packages`);
        if (result.warnings && result.warnings.length > 0) {
          console.log(`   ⚠️  Warnings:`);
          for (const warning of result.warnings) {
            console.log(`      - ${warning}`);
          }
        }
      } catch (error) {
        console.error(`❌ Installation failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}

/**
 * Register dependency management commands.
 */
export function registerDepsCommands(program: Command): void {
  const deps = program
    .command("deps")
    .description("Dependency management commands");

  deps
    .command("update")
    .description("Update dependencies")
    .option("--preserve <paths...>", "Paths to preserve during update", ["config", "data", "bin", "node_modules", ".aof"])
    .option("--no-lockfile", "Skip lockfile (use npm install instead of npm ci)")
    .action(async (opts: { preserve: string[]; lockfile: boolean }) => {
      const root = program.opts()["root"] as string;

      console.log("🔄 Updating dependencies...\n");

      try {
        const result = await update({
          cwd: root,
          useLockfile: opts.lockfile,
          healthCheck: true,
          preservePaths: opts.preserve,
        });

        console.log(`✅ Update complete!`);
        console.log(`   Command: ${result.command}`);
        console.log(`   Installed: ${result.installed} packages`);
        if (result.backupCreated) {
          console.log(`   💾 Backup created: ${result.backupPath}`);
        }
      } catch (error) {
        console.error(`❌ Update failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  deps
    .command("list")
    .description("Show installed package versions")
    .option("--prod", "Show only production dependencies", false)
    .option("--dev", "Show only dev dependencies", false)
    .action(async (opts: { prod: boolean; dev: boolean }) => {
      const root = program.opts()["root"] as string;

      try {
        const packages = await list({ cwd: root });

        if (packages.length === 0) {
          console.log("No packages installed. Run 'aof install' first.");
          return;
        }

        let filtered = packages;
        if (opts.prod) {
          filtered = packages.filter(p => p.type === "prod");
        } else if (opts.dev) {
          filtered = packages.filter(p => p.type === "dev");
        }

        console.log(`📦 Installed packages (${filtered.length}):\n`);

        const prodPackages = filtered.filter(p => p.type === "prod");
        const devPackages = filtered.filter(p => p.type === "dev");

        if (prodPackages.length > 0 && !opts.dev) {
          console.log("Production dependencies:");
          for (const pkg of prodPackages) {
            console.log(`  ${pkg.name}@${pkg.version}`);
          }
          console.log();
        }

        if (devPackages.length > 0 && !opts.prod) {
          console.log("Dev dependencies:");
          for (const pkg of devPackages) {
            console.log(`  ${pkg.name}@${pkg.version}`);
          }
        }
      } catch (error) {
        console.error(`❌ Failed to list packages: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}

/**
 * Register channel management commands.
 */
export function registerChannelCommands(program: Command): void {
  const channel = program
    .command("channel")
    .description("Update channel management");

  channel
    .command("show")
    .alias("")
    .description("Show current channel and version")
    .action(async () => {
      const root = program.opts()["root"] as string;

      try {
        const currentChannel = await getChannel(root);
        console.log(`📡 Current channel: ${currentChannel}\n`);

        // Try to get current version from config
        const configPath = join(root, ".aof", "channel.json");
        try {
          const content = await readFile(configPath, "utf-8");
          const config = JSON.parse(content);
          if (config.version) {
            console.log(`   Version: ${config.version}`);
          }
          if (config.lastCheck) {
            const lastCheck = new Date(config.lastCheck);
            console.log(`   Last update check: ${lastCheck.toLocaleString()}`);
          }
        } catch {
          // No version info available
        }

        console.log(`\n💡 Available channels: stable, beta, canary`);
      } catch (error) {
        console.error(`❌ Failed to get channel: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  channel
    .command("set <name>")
    .description("Switch to a different channel (stable/beta/canary)")
    .action(async (name: string) => {
      const root = program.opts()["root"] as string;

      try {
        await setChannel(root, name as "stable" | "beta" | "canary");
        console.log(`✅ Channel switched to: ${name}`);
        console.log(`   Run 'aof channel check' to see available updates`);
      } catch (error) {
        console.error(`❌ Failed to set channel: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  channel
    .command("check")
    .description("Check for updates on current channel")
    .option("--force", "Force check even if checked recently", false)
    .action(async (opts: { force: boolean }) => {
      const root = program.opts()["root"] as string;

      console.log("🔍 Checking for updates...\n");

      try {
        const result = await checkForUpdates(root, { force: opts.force });

        if (result.skipped) {
          console.log(`ℹ️  Skipped: ${result.reason}`);
          console.log(`   Use --force to check anyway`);
          return;
        }

        if (result.updateAvailable) {
          console.log(`🎉 Update available!`);
          console.log(`   Current: ${result.currentVersion}`);
          console.log(`   Latest: ${result.latestVersion}`);
          if (result.manifest?.changelog) {
            console.log(`\n📝 Changelog:\n${result.manifest.changelog.split("\n").slice(0, 5).join("\n")}`);
          }
        } else {
          console.log(`✅ You're up to date!`);
          if (result.currentVersion) {
            console.log(`   Version: ${result.currentVersion}`);
          }
        }
      } catch (error) {
        console.error(`❌ Failed to check for updates: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  channel
    .command("info <name>")
    .description("Show version info for a channel")
    .action(async (name: string) => {
      console.log(`📡 Fetching info for channel: ${name}\n`);

      try {
        const manifest = await getVersionManifest(name as "stable" | "beta" | "canary");
        console.log(`   Channel: ${manifest.channel}`);
        console.log(`   Version: ${manifest.version}`);
        console.log(`   Published: ${new Date(manifest.publishedAt).toLocaleString()}`);
        if (manifest.changelog) {
          console.log(`\n📝 Changelog:\n${manifest.changelog.split("\n").slice(0, 10).join("\n")}`);
        }
      } catch (error) {
        console.error(`❌ Failed to fetch channel info: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}

/**
 * Register update command.
 */
export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Update AOF to latest version")
    .option("--channel <name>", "Switch channel and update (stable/beta/canary)")
    .option("--rollback", "Rollback to previous version", false)
    .option("--backup <path>", "Backup path for rollback")
    .option("--yes", "Skip confirmation prompt", false)
    .action(async (opts: { channel?: string; rollback: boolean; backup?: string; yes: boolean }) => {
      const root = program.opts()["root"] as string;

      try {
        // Handle rollback
        if (opts.rollback) {
          if (!opts.backup) {
            console.error("❌ --backup path required for rollback");
            process.exitCode = 1;
            return;
          }

          console.log("🔄 Rolling back to previous version...\n");

          const result = await rollbackUpdate({
            aofRoot: root,
            backupPath: opts.backup,
            preservePaths: ["config", "data", "bin", "node_modules", ".aof"],
          });

          console.log(`✅ Rollback successful!`);
          console.log(`   Restored version: ${result.restoredVersion}`);
          return;
        }

        // Handle channel switch
        if (opts.channel) {
          console.log(`🔄 Switching to ${opts.channel} channel...\n`);
          await setChannel(root, opts.channel as "stable" | "beta" | "canary");
        }

        // Check for updates
        console.log("🔍 Checking for updates...\n");
        const updateCheck = await checkForUpdates(root, { force: true });

        if (!updateCheck.updateAvailable) {
          console.log("✅ Already on latest version");
          if (updateCheck.currentVersion) {
            console.log(`   Version: ${updateCheck.currentVersion}`);
          }
          return;
        }

        // Show update info
        console.log(`🎉 Update available!`);
        console.log(`   Current: ${updateCheck.currentVersion}`);
        console.log(`   Latest: ${updateCheck.latestVersion}`);

        if (updateCheck.manifest?.changelog) {
          console.log(`\n📝 Changelog:\n${updateCheck.manifest.changelog.split("\n").slice(0, 10).join("\n")}`);
        }

        // Confirm update
        if (!opts.yes) {
          console.log("\n⚠️  This will update your AOF installation.");
          console.log("   Config and data will be preserved.");
          console.log("   A backup will be created for rollback.\n");
          console.log("Run with --yes to skip this prompt.");
          return;
        }

        // Perform update
        console.log("\n🚀 Updating AOF...");

        const downloadUrl = `https://github.com/d0labs/aof/releases/download/v${updateCheck.latestVersion}/aof-v${updateCheck.latestVersion}.tar.gz`;

        const result = await selfUpdate({
          aofRoot: root,
          targetVersion: updateCheck.latestVersion!,
          downloadUrl,
          preservePaths: ["config", "data", "bin", "node_modules", ".aof"],
          healthCheck: async (installRoot: string) => {
            // Basic health check: verify key directories exist
            const { access } = await import("node:fs/promises");
            try {
              await access(join(installRoot, "package.json"));
              return true;
            } catch {
              return false;
            }
          },
          hooks: {
            preUpdate: async (ctx) => {
              console.log(`   📦 Backing up current version (${ctx.currentVersion})...`);
            },
            postUpdate: async (ctx) => {
              console.log(`   ⚡ Running migrations...`);
              // Run any necessary migrations
              // In a real implementation, load migrations from a registry
              await runMigrations({
                aofRoot: root,
                migrations: [], // Load from registry
                targetVersion: ctx.currentVersion,
              });
            },
          },
        });

        console.log(`\n✅ Update successful!`);
        console.log(`   Version: ${result.version}`);
        console.log(`   Backup: ${result.backupPath}`);
        console.log(`\n💡 To rollback: aof update --rollback --backup ${result.backupPath}`);
      } catch (error) {
        console.error(`❌ Update failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}
