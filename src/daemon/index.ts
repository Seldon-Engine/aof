#!/usr/bin/env node

import { resolve } from "node:path";
import { Command } from "commander";
import { startAofDaemon } from "./daemon.js";
import { getConfig } from "../config/registry.js";

const program = new Command()
  .name("aof-daemon")
  .description("AOF scheduler daemon (poll-only)")
  .option("--root <path>", "AOF root directory")
  .option("--interval <ms>", "Poll interval in ms", "30000")
  .option("--dry-run", "Dry-run mode (log only, no mutations)", false);

program.action(async (opts: { root?: string; interval: string; dryRun: boolean }) => {
  const cfg = getConfig();
  const root = opts.root ?? cfg.core.dataDir;
  opts.root = root;

  const pollIntervalMs = Number(opts.interval);
  if (Number.isNaN(pollIntervalMs) || pollIntervalMs <= 0) {
    console.error("Invalid --interval (must be positive number)");
    process.exitCode = 1;
    return;
  }

  // Socket path from config registry
  const socketPath = cfg.daemon.socketPath;

  const { service, healthServer } = await startAofDaemon({
    dataDir: opts.root,
    pollIntervalMs,
    dryRun: opts.dryRun,
    enableHealthServer: true,
    socketPath,
  });

  const resolvedSocket = socketPath ?? resolve(opts.root, "daemon.sock");
  console.log(`[AOF] Daemon started. Health endpoint: ${resolvedSocket}`);

  const shutdown = async () => {
    if (healthServer) {
      await new Promise<void>((resolve) => {
        healthServer.close(() => resolve());
      });
    }
    await service.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
});

program.parseAsync().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
