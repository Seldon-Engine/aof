/**
 * Migration 001: Add defaultWorkflow to project.yaml files.
 *
 * For each project with workflowTemplates defined, picks the first template
 * name and sets it as defaultWorkflow. Projects without workflowTemplates
 * are skipped (they stay bare-task). Already-set projects are also skipped
 * (idempotent).
 *
 * Uses parseDocument() for comment-preserving YAML round-trips.
 */

import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import writeFileAtomic from "write-file-atomic";
import type { Migration, MigrationContext } from "../migrations.js";

/**
 * Discover all project.yaml files under aofRoot/Projects/<id>/project.yaml.
 */
async function discoverProjectYamlFiles(aofRoot: string): Promise<string[]> {
  const projectsDir = join(aofRoot, "Projects");
  const results: string[] = [];

  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(projectsDir, entry.name, "project.yaml");
      try {
        await access(manifestPath);
        results.push(manifestPath);
      } catch {
        // No project.yaml in this directory, skip
      }
    }
  } catch {
    // Projects/ doesn't exist (pre-projects install), skip
  }

  return results;
}

export const migration001: Migration = {
  id: "001-default-workflow-template",
  version: "1.3.0",
  description: "Add defaultWorkflow field to project manifests",

  up: async (ctx: MigrationContext): Promise<void> => {
    const projectFiles = await discoverProjectYamlFiles(ctx.aofRoot);
    let applied = 0;

    for (const projectPath of projectFiles) {
      const raw = await readFile(projectPath, "utf-8");
      const doc = parseDocument(raw);

      // Idempotent: skip if already has defaultWorkflow
      if (doc.getIn(["defaultWorkflow"])) continue;

      // Get workflowTemplates AST node
      const templateMap = doc.get("workflowTemplates", true);
      if (!templateMap || !("items" in (templateMap as any))) continue;

      const items = (templateMap as any).items;
      if (!items || items.length === 0) continue;

      const firstKey = items[0]?.key;
      if (!firstKey) continue;

      doc.setIn(["defaultWorkflow"], String(firstKey));
      await writeFileAtomic(projectPath, doc.toString());
      applied++;
    }

    console.log(
      `  \x1b[32m\u2713\x1b[0m 001-default-workflow-template applied (${applied} project${applied !== 1 ? "s" : ""})`,
    );
  },
};
