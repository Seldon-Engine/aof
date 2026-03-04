/**
 * `aof smoke` — post-install health checks.
 *
 * Runs without a daemon, reading files directly from the AOF data directory.
 * Validates version, schema, task store, org chart, migration status,
 * and workflow template references.
 */

import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { ProjectManifest } from "../../schemas/project.js";
import { OrgChart } from "../../schemas/org-chart.js";
import { getMigrationHistory } from "../../packaging/migrations.js";

// --- Types ---

export interface SmokeResult {
  pass: boolean;
  detail: string;
}

export interface SmokeCheck {
  name: string;
  run: (root: string) => Promise<SmokeResult>;
}

// --- Individual checks ---

async function versionCheck(root: string): Promise<SmokeResult> {
  try {
    const content = await readFile(join(root, "package.json"), "utf-8");
    const pkg = JSON.parse(content) as { version?: string };
    const version = pkg.version;
    if (version && typeof version === "string" && version.length > 0) {
      return { pass: true, detail: `v${version}` };
    }
    return { pass: false, detail: "package.json missing version field" };
  } catch {
    return { pass: false, detail: "package.json not found or unreadable" };
  }
}

async function schemaCheck(root: string): Promise<SmokeResult> {
  try {
    const projectsDir = join(root, "Projects");
    let entries: string[];
    try {
      entries = await readdir(projectsDir);
    } catch {
      return { pass: true, detail: "No Projects directory (0 validated)" };
    }

    let validated = 0;
    const errors: string[] = [];

    for (const entry of entries) {
      const manifestPath = join(projectsDir, entry, "project.yaml");
      try {
        await access(manifestPath);
      } catch {
        continue; // Not a project directory
      }

      const yaml = await readFile(manifestPath, "utf-8");
      const parsed = parseYaml(yaml);
      const result = ProjectManifest.safeParse(parsed);
      if (result.success) {
        validated++;
      } else {
        const issues = result.error.issues.map((i) => i.message).join(", ");
        errors.push(`${entry}: ${issues}`);
      }
    }

    if (errors.length > 0) {
      return { pass: false, detail: `Schema errors: ${errors.join("; ")}` };
    }
    return { pass: true, detail: `${validated} project(s) validated` };
  } catch (e) {
    return { pass: false, detail: `Schema check error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function taskStoreCheck(root: string): Promise<SmokeResult> {
  try {
    const projectsDir = join(root, "Projects");
    let entries: string[];
    try {
      entries = await readdir(projectsDir);
    } catch {
      return { pass: false, detail: "No Projects directory found" };
    }

    let foundTaskDir = false;
    let totalTasks = 0;
    const statusDirs = ["backlog", "ready", "in-progress", "done", "blocked", "review"];

    for (const entry of entries) {
      const tasksDir = join(projectsDir, entry, "tasks");
      try {
        await access(tasksDir);
        foundTaskDir = true;
      } catch {
        continue;
      }

      for (const status of statusDirs) {
        try {
          const files = await readdir(join(tasksDir, status));
          totalTasks += files.filter((f) => f.endsWith(".md")).length;
        } catch {
          // Status directory may not exist
        }
      }
    }

    if (!foundTaskDir) {
      return { pass: false, detail: "No tasks directory found in any project" };
    }
    return { pass: true, detail: `Task store accessible (${totalTasks} task files)` };
  } catch (e) {
    return { pass: false, detail: `Task store error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function orgChartCheck(root: string): Promise<SmokeResult> {
  const orgChartPath = join(root, "org", "org-chart.yaml");
  try {
    await access(orgChartPath);
  } catch {
    return { pass: true, detail: "No org chart found (optional)" };
  }

  try {
    const yaml = await readFile(orgChartPath, "utf-8");
    const parsed = parseYaml(yaml);
    const result = OrgChart.safeParse(parsed);
    if (result.success) {
      const unitCount = result.data.orgUnits.length;
      const agentCount = result.data.agents.length;
      return { pass: true, detail: `${agentCount} agent(s), ${unitCount} org unit(s)` };
    }
    const issues = result.error.issues.map((i) => i.message).join(", ");
    return { pass: false, detail: `Org chart invalid: ${issues}` };
  } catch (e) {
    return { pass: false, detail: `Org chart error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function migrationCheck(root: string): Promise<SmokeResult> {
  try {
    const history = await getMigrationHistory(root);
    const count = history.migrations.length;
    return { pass: true, detail: `${count} migration(s) applied` };
  } catch (e) {
    return { pass: false, detail: `Migration history error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function workflowCheck(root: string): Promise<SmokeResult> {
  try {
    const projectsDir = join(root, "Projects");
    let entries: string[];
    try {
      entries = await readdir(projectsDir);
    } catch {
      return { pass: true, detail: "No Projects directory (0 checked)" };
    }

    let checked = 0;
    let templateCount = 0;
    const errors: string[] = [];

    for (const entry of entries) {
      const manifestPath = join(projectsDir, entry, "project.yaml");
      try {
        await access(manifestPath);
      } catch {
        continue;
      }

      const yaml = await readFile(manifestPath, "utf-8");
      const parsed = parseYaml(yaml) as Record<string, unknown>;
      checked++;

      const templates = parsed.workflowTemplates as Record<string, unknown> | undefined;
      const defaultWorkflow = parsed.defaultWorkflow as string | undefined;

      if (templates) {
        templateCount += Object.keys(templates).length;
      }

      if (defaultWorkflow) {
        if (!templates || !(defaultWorkflow in templates)) {
          errors.push(`${entry}: defaultWorkflow "${defaultWorkflow}" references nonexistent template`);
        }
      }
    }

    if (errors.length > 0) {
      return { pass: false, detail: errors.join("; ") };
    }
    return { pass: true, detail: `${templateCount} template(s) across ${checked} project(s)` };
  } catch (e) {
    return { pass: false, detail: `Workflow check error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// --- Check registry ---

const SMOKE_CHECKS: SmokeCheck[] = [
  { name: "Version", run: versionCheck },
  { name: "Schema", run: schemaCheck },
  { name: "Task Store", run: taskStoreCheck },
  { name: "Org Chart", run: orgChartCheck },
  { name: "Migration", run: migrationCheck },
  { name: "Workflow Templates", run: workflowCheck },
];

// --- Runner ---

export async function runSmokeChecks(
  root: string,
): Promise<{ checks: Array<{ name: string } & SmokeResult>; allPassed: boolean }> {
  const checks: Array<{ name: string } & SmokeResult> = [];

  for (const check of SMOKE_CHECKS) {
    const result = await check.run(root);
    checks.push({ name: check.name, ...result });
  }

  const allPassed = checks.every((c) => c.pass);
  return { checks, allPassed };
}

// --- CLI registration ---

export function registerSmokeCommand(program: Command): void {
  program
    .command("smoke")
    .description("Run post-install health checks against the AOF data directory")
    .action(async () => {
      const root = program.opts()["root"] as string;

      console.log(`\nRunning health checks against ${root}\n`);

      const { checks, allPassed } = await runSmokeChecks(root);

      for (const check of checks) {
        if (check.pass) {
          console.log(`  \x1b[32m✓\x1b[0m ${check.name}: ${check.detail}`);
        } else {
          console.log(`  \x1b[31m✗\x1b[0m ${check.name}: ${check.detail}`);
        }
      }

      console.log();

      if (allPassed) {
        console.log("\x1b[32mAll health checks passed.\x1b[0m\n");
      } else {
        console.log("\x1b[31mSome health checks failed.\x1b[0m\n");
        process.exitCode = 1;
      }
    });
}
