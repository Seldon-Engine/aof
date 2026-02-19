/**
 * Org chart commands — validate, show, lint, drift.
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { OrgChart } from "../schemas/index.js";
import { detectDrift, createAdapter, formatDriftReport } from "../drift/index.js";

export async function validateOrgChart(path: string): Promise<void> {
  try {
    const content = await readFile(path, "utf-8");
    const raw = parseYaml(content) as unknown;
    const result = OrgChart.safeParse(raw);

    if (result.success) {
      const chart = result.data;
      console.log(`✅ Org chart valid: ${chart.agents.length} agents, ${chart.teams.length} teams, ${chart.routing.length} routing rules`);
      if (chart.template) {
        console.log(`   Template: ${chart.template}`);
      }
    } else {
      console.error("❌ Org chart validation failed:");
      for (const issue of result.error.issues) {
        console.error(`   ${issue.path.join(".")}: ${issue.message}`);
      }
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`❌ Failed to read org chart: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

export async function showOrgChart(path: string): Promise<void> {
  try {
    const content = await readFile(path, "utf-8");
    const raw = parseYaml(content) as unknown;
    const result = OrgChart.safeParse(raw);

    if (!result.success) {
      console.error("❌ Invalid org chart. Run `aof org validate` first.");
      process.exitCode = 1;
      return;
    }

    const chart = result.data;
    console.log(`\n📊 Org Chart${chart.template ? ` (${chart.template})` : ""}`);
    console.log("─".repeat(50));

    if (chart.teams.length > 0) {
      console.log("\nTeams:");
      for (const team of chart.teams) {
        console.log(`  ${team.id}: ${team.name}${team.lead ? ` (lead: ${team.lead})` : ""}`);
      }
    }

    console.log("\nAgents:");
    for (const agent of chart.agents) {
      const status = agent.active ? "🟢" : "🔴";
      const team = agent.team ? ` [${agent.team}]` : "";
      const reports = agent.reportsTo ? ` → ${agent.reportsTo}` : "";
      console.log(`  ${status} ${agent.id}: ${agent.name}${team}${reports}`);
      if (agent.capabilities.tags.length > 0) {
        console.log(`     tags: ${agent.capabilities.tags.join(", ")}`);
      }
    }

    if (chart.routing.length > 0) {
      console.log("\nRouting rules:");
      for (const rule of chart.routing) {
        const match = rule.matchTags.length > 0 ? `tags=[${rule.matchTags.join(",")}]` : "any";
        const target = rule.targetAgent ?? rule.targetRole ?? rule.targetTeam ?? "default";
        console.log(`  ${match} → ${target} (weight: ${rule.weight})`);
      }
    }
  } catch (err) {
    console.error(`❌ Failed to read org chart: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

export async function driftCheck(
  orgChartPath: string,
  source: "fixture" | "live",
  fixturePath?: string
): Promise<void> {
  try {
    // Print header
    const sourceLabel = source === "fixture"
      ? `fixture${fixturePath ? ` (${fixturePath})` : ""}`
      : "live";
    console.log(`Checking drift`);
    console.log(`Source: ${sourceLabel}`);
    console.log();

    // Load org chart
    const content = await readFile(orgChartPath, "utf-8");
    const raw = parseYaml(content) as unknown;
    const result = OrgChart.safeParse(raw);

    if (!result.success) {
      console.error("❌ Invalid org chart. Run `aof org validate` first.");
      for (const issue of result.error.issues) {
        console.error(`   ${issue.path.join(".")}: ${issue.message}`);
      }
      process.exitCode = 1;
      return;
    }

    const orgChart = result.data;

    // Load OpenClaw agents
    const adapter = createAdapter(source, fixturePath);
    const openclawAgents = await adapter.getAgents();

    // Detect drift
    const report = detectDrift(orgChart, openclawAgents);

    // Format and display report
    const output = formatDriftReport(report);
    console.log(output);

    // Set exit code if drift detected
    if (report.summary.hasDrift) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`❌ Drift check failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
