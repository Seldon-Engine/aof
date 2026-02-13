/**
 * Config manager — CLI-gated configuration management.
 *
 * All org chart config changes go through this module — never raw YAML edits.
 * Provides: get, set, validate, diff, apply (with dry-run).
 * Atomic writes (write to temp, validate, rename).
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { OrgChart } from "../schemas/org-chart.js";
import { lintOrgChart } from "../org/linter.js";

export interface ConfigChange {
  key: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Get a value from the org chart config using dot-notation path.
 * e.g., "agents.swe-backend.active" or "teams.swe.lead"
 */
export async function getConfigValue(configPath: string, key: string): Promise<unknown> {
  const content = await readFile(configPath, "utf-8");
  const raw = parseYaml(content) as Record<string, unknown>;

  return resolveKeyPath(raw, key);
}

/**
 * Set a value in the org chart config using dot-notation path.
 * Validates the entire config after modification.
 * Returns the change that was made.
 */
export async function setConfigValue(
  configPath: string,
  key: string,
  value: string,
  dryRun: boolean = false,
): Promise<{ change: ConfigChange; issues: Array<{ severity: string; message: string }> }> {
  const content = await readFile(configPath, "utf-8");
  const raw = parseYaml(content) as Record<string, unknown>;

  const oldValue = resolveKeyPath(raw, key);
  const parsedValue = parseValue(value);

  // Apply the change in memory
  setKeyPath(raw, key, parsedValue);

  // Validate the modified config
  const parseResult = OrgChart.safeParse(raw);
  if (!parseResult.success) {
    return {
      change: { key, oldValue, newValue: parsedValue },
      issues: parseResult.error.issues.map(i => ({
        severity: "error",
        message: `Schema error at ${i.path.join(".")}: ${i.message}`,
      })),
    };
  }

  // Run referential integrity lint
  const lintIssues = lintOrgChart(parseResult.data);
  const errors = lintIssues.filter(i => i.severity === "error");

  if (!dryRun && errors.length === 0) {
    // Atomic write: temp file → validate → rename
    const tmpPath = join(dirname(configPath), `.org-chart.tmp.${randomUUID().slice(0, 8)}.yaml`);
    const newContent = stringifyYaml(raw, { lineWidth: 120 });
    await writeFile(tmpPath, newContent, "utf-8");
    await rename(tmpPath, configPath);
  }

  return {
    change: { key, oldValue, newValue: parsedValue },
    issues: lintIssues.map(i => ({ severity: i.severity, message: i.message })),
  };
}

/**
 * Validate the entire config (schema + referential integrity).
 */
export async function validateConfig(configPath: string): Promise<{
  valid: boolean;
  schemaErrors: Array<{ path: string; message: string }>;
  lintIssues: Array<{ severity: string; rule: string; message: string }>;
}> {
  const content = await readFile(configPath, "utf-8");
  const raw = parseYaml(content) as unknown;
  const result = OrgChart.safeParse(raw);

  if (!result.success) {
    return {
      valid: false,
      schemaErrors: result.error.issues.map(i => ({
        path: i.path.join("."),
        message: i.message,
      })),
      lintIssues: [],
    };
  }

  const lint = lintOrgChart(result.data);
  const hasErrors = lint.some(i => i.severity === "error");

  return {
    valid: !hasErrors,
    schemaErrors: [],
    lintIssues: lint.map(i => ({ severity: i.severity, rule: i.rule, message: i.message })),
  };
}

// --- Helpers ---

function resolveKeyPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = splitKeyPath(path);
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === "object" && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[part];
    } else if (Array.isArray(current)) {
      // Try numeric index first
      const idx = parseInt(part, 10);
      if (!isNaN(idx)) {
        current = current[idx];
      } else {
        // Try ID-based lookup (for agents, teams arrays)
        const found = current.find((item: any) => item?.id === part);
        current = found;
      }
    } else {
      return undefined;
    }
  }

  return current;
}

function setKeyPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = splitKeyPath(path);
  let current: any = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const nextPart = parts[i + 1];

    if (Array.isArray(current)) {
      // Handle array access
      const idx = parseInt(part, 10);
      if (!isNaN(idx)) {
        // Numeric index
        if (!current[idx]) current[idx] = {};
        current = current[idx];
      } else {
        // ID-based lookup - find or create
        let found = current.find((item: any) => item?.id === part);
        if (!found) {
          // Create new entry with id
          found = { id: part };
          current.push(found);
        }
        current = found;
      }
    } else if (typeof current === "object" && current !== null) {
      // Handle object access
      if (!(part in current) || typeof current[part] !== "object") {
        // Create array if next part looks like an array key
        if (part === "agents" || part === "teams" || part === "routing") {
          current[part] = [];
        } else {
          current[part] = {};
        }
      }
      current = current[part];
    }
  }

  const lastKey = parts[parts.length - 1]!;

  if (Array.isArray(current)) {
    // Setting on array - not typical, but handle gracefully
    const idx = parseInt(lastKey, 10);
    if (!isNaN(idx)) {
      current[idx] = value;
    }
  } else if (typeof current === "object" && current !== null) {
    current[lastKey] = value;
  }
}

/**
 * Split a key path, handling agent/team lookups.
 * "agents.swe-backend.active" → resolve agent by ID, not by array index.
 */
function splitKeyPath(path: string): string[] {
  return path.split(".");
}

/** Parse a string value into the appropriate type. */
function parseValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
  // Remove surrounding quotes
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
