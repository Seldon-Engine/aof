/**
 * Org chart loader — reads and validates org chart YAML.
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { OrgChart } from "../schemas/org-chart.js";

export interface LoadResult {
  success: boolean;
  chart?: ReturnType<typeof OrgChart.parse>;
  errors?: Array<{ path: string; message: string }>;
}

/**
 * Load and validate an org chart from a YAML file.
 */
export async function loadOrgChart(path: string): Promise<LoadResult> {
  const content = await readFile(path, "utf-8");
  const raw = parseYaml(content) as unknown;
  const result = OrgChart.safeParse(raw);

  if (result.success) {
    return { success: true, chart: result.data };
  }

  return {
    success: false,
    errors: result.error.issues.map(i => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}
