/**
 * Workflow template resolution for task create CLI command.
 *
 * Resolves a template name from the project manifest's workflowTemplates
 * record, validates the DAG (belt-and-suspenders), and returns a workflow
 * object ready for store.create().
 *
 * Template resolution is the CLI's responsibility (not the store's).
 * The store only receives a complete workflow object and handles state init.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ProjectManifest } from "../../schemas/project.js";
import { validateDAG } from "../../schemas/workflow-dag.js";
import type { WorkflowDefinition } from "../../schemas/workflow-dag.js";

/**
 * Resolve a workflow template name from the project manifest.
 *
 * Loads project.yaml, looks up the template in workflowTemplates,
 * validates the DAG, and returns the definition + templateName.
 *
 * @param templateName - Template name to look up (e.g., "code-review")
 * @param projectRoot - Absolute path to the project root directory
 * @returns Workflow object with definition and templateName for store.create()
 * @throws Error if template not found or DAG is invalid
 */
export async function resolveWorkflowTemplate(
  templateName: string,
  projectRoot: string,
): Promise<{ definition: WorkflowDefinition; templateName: string }> {
  // Load and parse project manifest
  const projectPath = join(projectRoot, "project.yaml");
  const yaml = await readFile(projectPath, "utf-8");
  const parsed = parseYaml(yaml) as unknown;
  const manifest = ProjectManifest.parse(parsed);

  // Look up template
  const templates = manifest.workflowTemplates ?? {};
  const definition = templates[templateName];

  if (!definition) {
    const available = Object.keys(templates).join(", ");
    throw new Error(
      `Workflow template "${templateName}" not found in project manifest. Available: ${available || "(none)"}`,
    );
  }

  // Belt-and-suspenders DAG validation (templates should already be validated by lint)
  const dagErrors = validateDAG(definition);
  if (dagErrors.length > 0) {
    throw new Error(
      `Workflow template "${templateName}" has invalid DAG: ${dagErrors.join(", ")}`,
    );
  }

  return { definition, templateName };
}
