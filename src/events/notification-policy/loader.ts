/**
 * YAML-to-NotificationRule loader.
 *
 * Reads org/notification-rules.yaml and returns a validated NotificationRule[].
 * Falls back to DEFAULT_RULES if the file is missing or malformed.
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { NotificationRule, Severity, Audience } from "./rules.js";
import { DEFAULT_RULES } from "./rules.js";

interface RawRule {
  match: {
    eventType: string;
    payload?: Record<string, unknown>;
  };
  severity?: string;
  audience?: string[];
  channel?: string;
  template?: string;
  dedupeWindowMs?: number;
  neverSuppress?: boolean;
}

interface RawRulesFile {
  version?: number;
  rules?: RawRule[];
}

const VALID_SEVERITIES = new Set<string>(["info", "warn", "critical"]);
const VALID_AUDIENCES = new Set<string>(["agent", "team-lead", "operator"]);

/**
 * Parses and validates a single raw YAML rule entry.
 * Returns null if the rule is invalid (missing required fields).
 */
function parseRule(raw: RawRule, index: number): NotificationRule | null {
  if (!raw.match?.eventType) {
    console.warn(`[notification-rules] Rule #${index}: missing match.eventType — skipped`);
    return null;
  }
  if (!raw.channel) {
    console.warn(`[notification-rules] Rule #${index}: missing channel — skipped`);
    return null;
  }
  if (!raw.template) {
    console.warn(`[notification-rules] Rule #${index}: missing template — skipped`);
    return null;
  }

  const severity: Severity = VALID_SEVERITIES.has(raw.severity ?? "")
    ? (raw.severity as Severity)
    : "info";

  const audience: Audience[] = (raw.audience ?? []).filter((a): a is Audience =>
    VALID_AUDIENCES.has(a)
  );

  return {
    match: {
      eventType: raw.match.eventType,
      ...(raw.match.payload ? { payload: raw.match.payload } : {}),
    },
    severity,
    audience,
    channel: raw.channel,
    template: raw.template,
    ...(raw.dedupeWindowMs !== undefined ? { dedupeWindowMs: raw.dedupeWindowMs } : {}),
    ...(raw.neverSuppress ? { neverSuppress: true } : {}),
  };
}

/**
 * Loads notification rules from a YAML file.
 * Returns DEFAULT_RULES if the file cannot be read or parsed.
 */
export async function loadNotificationRules(filePath: string): Promise<NotificationRule[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    // File missing — fall back to defaults silently
    return DEFAULT_RULES;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    console.warn(`[notification-rules] YAML parse error in ${filePath}:`, err);
    return DEFAULT_RULES;
  }

  const file = parsed as RawRulesFile;
  if (!file?.rules || !Array.isArray(file.rules)) {
    console.warn(`[notification-rules] ${filePath}: no 'rules' array found — using defaults`);
    return DEFAULT_RULES;
  }

  const rules: NotificationRule[] = [];
  for (let i = 0; i < file.rules.length; i++) {
    const rule = parseRule(file.rules[i] as RawRule, i);
    if (rule) rules.push(rule);
  }

  if (rules.length === 0) {
    console.warn(`[notification-rules] ${filePath}: 0 valid rules parsed — using defaults`);
    return DEFAULT_RULES;
  }

  return rules;
}
