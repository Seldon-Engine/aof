/**
 * Tests for the notification rules YAML loader.
 *
 * Coverage:
 * - Parses a valid YAML rules file → NotificationRule[]
 * - Falls back to DEFAULT_RULES when file is missing
 * - Falls back to DEFAULT_RULES when YAML is invalid
 * - Skips rules missing required fields (channel, template, match.eventType)
 * - Falls back to DEFAULT_RULES when 0 valid rules remain after filtering
 */

import { describe, it, expect, afterEach } from "vitest";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadNotificationRules } from "../notification-policy/loader.js";
import { DEFAULT_RULES } from "../notification-policy/rules.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const TMP_DIR = join(tmpdir(), "aof-loader-tests");
let tmpFile = "";

async function writeTmpYaml(content: string): Promise<string> {
  await mkdir(TMP_DIR, { recursive: true });
  tmpFile = join(TMP_DIR, `rules-${Date.now()}.yaml`);
  await writeFile(tmpFile, content, "utf-8");
  return tmpFile;
}

afterEach(async () => {
  if (tmpFile) {
    await unlink(tmpFile).catch(() => undefined);
    tmpFile = "";
  }
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("loadNotificationRules", () => {
  it("parses a valid YAML rules file", async () => {
    const path = await writeTmpYaml(`
version: 1
rules:
  - match:
      eventType: "task.created"
    severity: info
    audience: [agent]
    channel: "#test-channel"
    template: "Task {taskId} was created"
  - match:
      eventType: "sla.violation"
      payload:
        severe: true
    severity: critical
    audience: [operator]
    channel: "#critical"
    template: "SLA breach: {taskId}"
    neverSuppress: true
    dedupeWindowMs: 0
`);

    const rules = await loadNotificationRules(path);
    expect(rules).toHaveLength(2);

    expect(rules[0].match.eventType).toBe("task.created");
    expect(rules[0].severity).toBe("info");
    expect(rules[0].channel).toBe("#test-channel");
    expect(rules[0].template).toBe("Task {taskId} was created");
    expect(rules[0].match.payload).toBeUndefined();

    expect(rules[1].match.eventType).toBe("sla.violation");
    expect(rules[1].match.payload).toEqual({ severe: true });
    expect(rules[1].severity).toBe("critical");
    expect(rules[1].neverSuppress).toBe(true);
    expect(rules[1].dedupeWindowMs).toBe(0);
  });

  it("falls back to DEFAULT_RULES when file is missing", async () => {
    const rules = await loadNotificationRules("/nonexistent/path/rules.yaml");
    expect(rules).toBe(DEFAULT_RULES);
  });

  it("falls back to DEFAULT_RULES on invalid YAML", async () => {
    const path = await writeTmpYaml("not: valid: yaml: [\nmissing bracket");
    const rules = await loadNotificationRules(path);
    expect(rules).toBe(DEFAULT_RULES);
  });

  it("falls back to DEFAULT_RULES when 'rules' key is missing", async () => {
    const path = await writeTmpYaml("version: 1\n# no rules key");
    const rules = await loadNotificationRules(path);
    expect(rules).toBe(DEFAULT_RULES);
  });

  it("skips rules missing eventType", async () => {
    const path = await writeTmpYaml(`
version: 1
rules:
  - match: {}
    severity: info
    audience: [agent]
    channel: "#ch"
    template: "msg"
  - match:
      eventType: "task.created"
    severity: info
    audience: [agent]
    channel: "#valid"
    template: "valid rule"
`);
    const rules = await loadNotificationRules(path);
    expect(rules).toHaveLength(1);
    expect(rules[0].channel).toBe("#valid");
  });

  it("skips rules missing channel or template", async () => {
    const path = await writeTmpYaml(`
version: 1
rules:
  - match:
      eventType: "task.created"
    severity: info
    audience: [agent]
    template: "no channel here"
  - match:
      eventType: "task.updated"
    severity: info
    audience: [agent]
    channel: "#ch"
  - match:
      eventType: "task.closed"
    severity: info
    audience: [agent]
    channel: "#ok"
    template: "all fields present"
`);
    const rules = await loadNotificationRules(path);
    expect(rules).toHaveLength(1);
    expect(rules[0].match.eventType).toBe("task.closed");
  });

  it("falls back to DEFAULT_RULES when all rules are invalid", async () => {
    const path = await writeTmpYaml(`
version: 1
rules:
  - match:
      eventType: "task.created"
    severity: info
    audience: [agent]
`);
    const rules = await loadNotificationRules(path);
    expect(rules).toBe(DEFAULT_RULES);
  });

  it("defaults unknown severity to 'info'", async () => {
    const path = await writeTmpYaml(`
version: 1
rules:
  - match:
      eventType: "task.created"
    severity: "extreme"
    audience: [agent]
    channel: "#ch"
    template: "msg"
`);
    const rules = await loadNotificationRules(path);
    expect(rules[0].severity).toBe("info");
  });

  it("filters invalid audience values", async () => {
    const path = await writeTmpYaml(`
version: 1
rules:
  - match:
      eventType: "task.created"
    severity: info
    audience: [agent, "unknown-audience", operator]
    channel: "#ch"
    template: "msg"
`);
    const rules = await loadNotificationRules(path);
    expect(rules[0].audience).toEqual(["agent", "operator"]);
  });
});
