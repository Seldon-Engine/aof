/**
 * Org chart CLI commands.
 * Registers org chart validation, display, and drift detection commands.
 */

import { join } from "node:path";
import type { Command } from "commander";
import { validateOrgChart, showOrgChart, driftCheck } from "../../commands/org.js";
import { loadOrgChart, lintOrgChart } from "../../org/index.js";

/**
 * Register org chart commands with the CLI program.
 */
export function registerOrgCommands(program: Command): void {
  const org = program
    .command("org")
    .description("Org chart management");

  org
    .command("validate [path]")
    .description("Validate org chart schema")
    .action(async (path?: string) => {
      const root = program.opts()["root"] as string;
      await validateOrgChart(path ?? join(root, "org", "org-chart.yaml"));
    });

  org
    .command("show [path]")
    .description("Display org chart")
    .action(async (path?: string) => {
      const root = program.opts()["root"] as string;
      await showOrgChart(path ?? join(root, "org", "org-chart.yaml"));
    });

  org
    .command("lint [path]")
    .description("Lint org chart (referential integrity)")
    .action(async (path?: string) => {
      const root = program.opts()["root"] as string;
      const orgPath = path ?? join(root, "org", "org-chart.yaml");
      console.log(`Linting org chart at ${orgPath}...\n`);

      const result = await loadOrgChart(orgPath);
      if (!result.success) {
        console.error("❌ Schema validation failed:");
        for (const err of result.errors ?? []) {
          console.error(`  ${err.path}: ${err.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const issues = lintOrgChart(result.chart!);
      if (issues.length === 0) {
        console.log(`✅ Org chart valid: ${result.chart!.agents.length} agents, ${result.chart!.teams.length} teams — 0 issues`);
        return;
      }

      for (const issue of issues) {
        const icon = issue.severity === "error" ? "✗" : "⚠";
        console.log(`  ${icon} [${issue.rule}] ${issue.message}`);
      }

      const errors = issues.filter(i => i.severity === "error");
      const warnings = issues.filter(i => i.severity === "warning");
      console.log(`\n${errors.length} errors, ${warnings.length} warnings`);
      if (errors.length > 0) process.exitCode = 1;
    });

  org
    .command("drift [path]")
    .description("Detect drift between org chart and actual state")
    .option("--vault-root <path>", "Vault root path")
    .action(async (path?: string, opts?: { vaultRoot?: string }) => {
      const root = program.opts()["root"] as string;
      const orgPath = path ?? join(root, "org", "org-chart.yaml");
      const vaultRoot = opts?.vaultRoot ?? process.env["AOF_VAULT_ROOT"];

      await driftCheck(orgPath, (vaultRoot ?? "live") as "fixture" | "live");
    });
}
