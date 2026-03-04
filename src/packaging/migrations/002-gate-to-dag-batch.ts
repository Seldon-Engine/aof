/**
 * Migration 002: Batch-convert all gate-based tasks to DAG workflows.
 *
 * Eagerly converts ALL tasks with gate fields across ALL status directories
 * in ALL projects. Reuses the existing migrateGateToDAG() per-task converter.
 * Tasks without gate fields or already migrated to DAG are skipped (idempotent).
 *
 * Reads/writes task files directly (NOT through FilesystemTaskStore) to avoid
 * side effects like lazy migration and event logging.
 */

import { readFile, readdir, access, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import writeFileAtomic from "write-file-atomic";
import type { Migration, MigrationContext } from "../migrations.js";
import { migrateGateToDAG } from "../../migration/gate-to-dag.js";
import type { WorkflowConfig } from "../../migration/gate-to-dag.js";
import { parseTaskFile, serializeTask } from "../../store/task-parser.js";

const STATUS_DIRS = [
  "backlog",
  "ready",
  "in-progress",
  "blocked",
  "review",
  "done",
  "cancelled",
  "deadletter",
];

/**
 * Read project.yaml and extract legacy workflow config (gate-based) if present.
 */
async function readWorkflowConfig(
  projectDir: string,
): Promise<WorkflowConfig | undefined> {
  try {
    const raw = await readFile(join(projectDir, "project.yaml"), "utf-8");
    const parsed = parseYaml(raw) as Record<string, any>;
    if (
      parsed.workflow &&
      parsed.workflow.gates &&
      Array.isArray(parsed.workflow.gates)
    ) {
      return {
        name: parsed.workflow.name || "default",
        gates: parsed.workflow.gates,
      };
    }
  } catch {
    // No project.yaml or invalid, skip
  }
  return undefined;
}

/**
 * Batch-convert gate tasks in a single project directory.
 */
async function batchConvertProject(
  projectDir: string,
  workflowConfig: WorkflowConfig | undefined,
): Promise<number> {
  const tasksDir = join(projectDir, "tasks");
  let converted = 0;

  for (const statusDir of STATUS_DIRS) {
    const dir = join(tasksDir, statusDir);
    let entries: string[];
    try {
      const dirEntries = await readdir(dir);
      entries = dirEntries;
    } catch {
      continue; // Directory doesn't exist, skip
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const filePath = join(dir, entry);

      try {
        const s = await stat(filePath);
        if (!s.isFile()) continue;

        const raw = await readFile(filePath, "utf-8");
        const task = parseTaskFile(raw, filePath);
        const fm = task.frontmatter as Record<string, any>;

        // Skip if no gate fields or already has workflow (idempotent)
        if (!fm.gate || fm.workflow) continue;

        migrateGateToDAG(task, workflowConfig);

        // Only write if migration actually produced a workflow
        if (task.frontmatter.workflow) {
          await writeFileAtomic(filePath, serializeTask(task));
          converted++;
        }
      } catch {
        // Skip files that can't be parsed (corrupted or non-task files)
      }
    }
  }

  return converted;
}

export const migration002: Migration = {
  id: "002-gate-to-dag-batch",
  version: "1.3.0",
  description: "Batch-convert gate-based tasks to DAG workflows",

  up: async (ctx: MigrationContext): Promise<void> => {
    const projectsDir = join(ctx.aofRoot, "Projects");
    let totalConverted = 0;

    try {
      const entries = await readdir(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const projectDir = join(projectsDir, entry.name);
        const workflowConfig = await readWorkflowConfig(projectDir);
        const converted = await batchConvertProject(
          projectDir,
          workflowConfig,
        );
        totalConverted += converted;
      }
    } catch {
      // Projects/ doesn't exist (pre-projects install), skip
    }

    console.log(
      `  \x1b[32m\u2713\x1b[0m 002-gate-to-dag-batch applied (${totalConverted} task${totalConverted !== 1 ? "s" : ""} converted)`,
    );
  },
};
