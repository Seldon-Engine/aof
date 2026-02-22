/**
 * Register the `aof init` command — OpenClaw integration wizard.
 */

import type { Command } from "commander";
import { init } from "../init.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Set up AOF integration with OpenClaw (plugin registration, memory, skill)")
    .option("-y, --yes", "Non-interactive mode — accept all defaults", false)
    .option("--skip-openclaw", "Skip OpenClaw integration steps", false)
    .action(async (opts: { yes: boolean; skipOpenclaw: boolean }) => {
      await init({ yes: opts.yes, skipOpenclaw: opts.skipOpenclaw });
    });
}
