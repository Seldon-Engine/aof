/**
 * AOF Init lifecycle steps: lint, gateway restart, daemon.
 * Separate file to keep init-steps.ts under the 500-LOC hard gate.
 */

import { confirm } from "@inquirer/prompts";
import { readFile, access } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { OrgChart } from "../schemas/org-chart.js";
import { isAofInAllowList, openclawConfigGet, execFileAsync } from "../packaging/openclaw-cli.js";
import { resolveDataDir, orgChartPath, daemonPidPath } from "../config/paths.js";
import type { WizardState } from "./init-steps.js";

// Step 6: Lint org chart + allow-list check
export async function runLintStep(state: WizardState, _yes: boolean): Promise<void> {
  console.log("🔍 Linting configuration...");
  const chartPath = orgChartPath(resolveDataDir());
  try {
    await access(chartPath);
    const raw = await readFile(chartPath, "utf-8");
    const result = OrgChart.safeParse(parseYaml(raw) as unknown);
    if (result.success) {
      console.log("  ✅ Org chart is valid.\n");
      state.orgChartValid = true;
    } else {
      const issues = result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      state.warnings.push(`Org chart has validation errors: ${issues}`);
      console.log(`  ⚠️  Org chart invalid: ${issues}\n`);
    }
  } catch {
    console.log("  ℹ️  No org chart found at org/org-chart.yaml — skipping.\n");
    state.skipped.push("Org chart lint (no org chart found)");
    state.orgChartValid = true; // absent ≠ invalid
  }
  const inAllowList = await isAofInAllowList();
  if (!inAllowList) {
    state.warnings.push("AOF is not in the plugin allow list — run `aof init` plugin step.");
    console.log("  ⚠️  AOF not in plugin allow list.\n");
  } else {
    console.log("  ✅ AOF is in the plugin allow list.\n");
  }
}

// Step 7: Restart gateway + health poll
export async function runRestartStep(state: WizardState, yes: boolean): Promise<void> {
  console.log("🔄 Gateway restart...");
  const doRestart =
    yes || (await confirm({ message: "Restart the OpenClaw gateway to apply changes?", default: true }));
  if (!doRestart) {
    state.skipped.push("Gateway restart");
    console.log();
    return;
  }
  try {
    console.log("  Running `openclaw gateway restart`...");
    await execFileAsync("openclaw", ["gateway", "restart"]);
  } catch (err) {
    const msg = `Gateway restart failed: ${err instanceof Error ? err.message : String(err)}`;
    state.warnings.push(msg);
    console.log(`  ❌ ${msg}\n`);
    return;
  }
  const baseUrl =
    ((await openclawConfigGet("api.config.gateway.url")) as string | undefined) ??
    "http://127.0.0.1:3000";
  const healthUrl = `${baseUrl.replace(/\/$/, "")}/health`;
  console.log(`  Waiting for gateway at ${healthUrl}...`);
  const up = await pollHealth(healthUrl, { maxAttempts: 15, intervalMs: 2000 });
  if (up) {
    state.gatewayRestarted = true;
    console.log("  ✅ Gateway is back up.\n");
  } else {
    state.warnings.push("Gateway did not respond at /health within 30s — check manually.");
    console.log("  ⚠️  Gateway health check timed out.\n");
  }
}

async function pollHealth(url: string, opts: { maxAttempts: number; intervalMs: number }): Promise<boolean> {
  for (let i = 0; i < opts.maxAttempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch { /* not yet up */ }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  return false;
}

// Step 8: AOF daemon
export async function runDaemonStep(state: WizardState, yes: boolean): Promise<void> {
  console.log("🤖 AOF daemon...");
  const dataDir = resolveDataDir();
  const pidFile = daemonPidPath(dataDir);
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (!isNaN(pid) && isDaemonRunning(pid)) {
      console.log(`  ✅ AOF daemon is already running (PID: ${pid}).\n`);
      state.daemonRunning = true;
      state.skipped.push("AOF daemon start (already running)");
      return;
    }
  }
  const doStart = yes || (await confirm({ message: "Start the AOF daemon?", default: true }));
  if (!doStart) {
    state.skipped.push("AOF daemon start");
    console.log();
    return;
  }
  console.log("  Installing AOF daemon under OS supervision...");
  try {
    const { installService } = await import("../daemon/service-file.js");
    await installService({ dataDir });
    state.daemonRunning = true;
    console.log("  ✅ AOF daemon installed and started.\n");
  } catch (err) {
    const msg = `Daemon install failed: ${err instanceof Error ? err.message : String(err)}`;
    state.warnings.push(msg);
    console.log(`  ❌ ${msg}\n`);
  }
}

function isDaemonRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
