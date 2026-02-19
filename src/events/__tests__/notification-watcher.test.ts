/**
 * Tests for notification hot-reload:
 *   - NotificationPolicyEngine.updateRules() replaces active rule set
 *   - NotificationRulesWatcher.reload() re-reads file → engine gets new rules
 *   - onReload callback is called with correct rule count
 *   - New rules take effect immediately for subsequent events
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BaseEvent } from "../../schemas/event.js";
import type { NotificationAdapter } from "../notifier.js";
import {
  NotificationPolicyEngine,
  DEFAULT_RULES,
} from "../notification-policy/index.js";
import type { NotificationRule } from "../notification-policy/index.js";
import { NotificationRulesWatcher } from "../notification-policy/watcher.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const TMP_DIR = join(tmpdir(), "aof-watcher-tests");
let tmpFile = "";

async function writeTmpRules(content: string): Promise<string> {
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

function makeMockAdapter(): NotificationAdapter & {
  sent: Array<{ channel: string; message: string }>;
} {
  const sent: Array<{ channel: string; message: string }> = [];
  return {
    sent,
    async send(channel: string, message: string): Promise<void> {
      sent.push({ channel, message });
    },
  };
}

function makeEvent(type: BaseEvent["type"], payload: Record<string, unknown> = {}): BaseEvent {
  return {
    eventId: 1,
    type,
    timestamp: new Date().toISOString(),
    actor: "test-agent",
    taskId: "TASK-TEST-001",
    payload,
  };
}

const CUSTOM_RULE: NotificationRule = {
  match: { eventType: "task.created" },
  severity: "warn",
  audience: ["operator"],
  channel: "#custom-channel",
  template: "Custom: {taskId}",
  dedupeWindowMs: 0, // always send in tests — avoids dedupe cross-contamination
};

// ── engine.updateRules() ────────────────────────────────────────────────────

describe("NotificationPolicyEngine.updateRules()", () => {
  it("routes events using the updated rule set", async () => {
    const adapter = makeMockAdapter();
    const engine = new NotificationPolicyEngine(adapter, DEFAULT_RULES);

    // Initially routes to #aof-dispatch
    await engine.handleEvent(makeEvent("task.created", { title: "test" }));
    expect(adapter.sent[0].channel).toBe("#aof-dispatch");

    // Swap rules — task.created now routes to #custom-channel
    engine.updateRules([CUSTOM_RULE]);
    adapter.sent.length = 0;

    // Different taskId to bypass the deduper's 5-min window for TASK-TEST-001
    const updatedEvent = { ...makeEvent("task.created", { title: "test" }), taskId: "TASK-TEST-002" };
    await engine.handleEvent(updatedEvent);
    expect(adapter.sent[0].channel).toBe("#custom-channel");
    expect(adapter.sent[0].message).toContain("Custom: TASK-TEST-002");
  });

  it("silently drops events with no matching rule after update", async () => {
    const adapter = makeMockAdapter();
    const engine = new NotificationPolicyEngine(adapter, DEFAULT_RULES);

    // Replace with a rule that only matches "lease.expired"
    engine.updateRules([
      {
        match: { eventType: "lease.expired" },
        severity: "warn",
        audience: ["team-lead"],
        channel: "#lease",
        template: "lease: {taskId}",
      },
    ]);

    await engine.handleEvent(makeEvent("task.created", { title: "ignored" }));
    expect(adapter.sent).toHaveLength(0);
    expect(engine.getStats().noMatch).toBe(1);
  });

  it("getRules() returns the current active rule set", () => {
    const adapter = makeMockAdapter();
    const engine = new NotificationPolicyEngine(adapter, DEFAULT_RULES);

    expect(engine.getRules()).toBe(DEFAULT_RULES);
    engine.updateRules([CUSTOM_RULE]);
    expect(engine.getRules()).toEqual([CUSTOM_RULE]);
  });
});

// ── NotificationRulesWatcher ─────────────────────────────────────────────────

describe("NotificationRulesWatcher.reload()", () => {
  it("loads rules from file and updates the engine", async () => {
    const path = await writeTmpRules(`
version: 1
rules:
  - match:
      eventType: "task.created"
    severity: warn
    audience: [operator]
    channel: "#reloaded-channel"
    template: "Reloaded: {taskId}"
`);

    const adapter = makeMockAdapter();
    const engine = new NotificationPolicyEngine(adapter, DEFAULT_RULES);
    const watcher = new NotificationRulesWatcher(path, engine);

    // Trigger reload manually
    await watcher.reload();

    expect(engine.getRules()).toHaveLength(1);
    expect(engine.getRules()[0].channel).toBe("#reloaded-channel");

    // Event now routes to reloaded channel
    await engine.handleEvent(makeEvent("task.created", { title: "test" }));
    expect(adapter.sent[0].channel).toBe("#reloaded-channel");
  });

  it("invokes onReload callback with rule count after successful reload", async () => {
    const path = await writeTmpRules(`
version: 1
rules:
  - match:
      eventType: "sla.violation"
    severity: warn
    audience: [team-lead]
    channel: "#alerts"
    template: "SLA: {taskId}"
  - match:
      eventType: "lease.expired"
    severity: warn
    audience: [team-lead]
    channel: "#alerts"
    template: "Lease: {taskId}"
`);

    const adapter = makeMockAdapter();
    const engine = new NotificationPolicyEngine(adapter, DEFAULT_RULES);
    const onReload = vi.fn();
    const watcher = new NotificationRulesWatcher(path, engine, { onReload });

    await watcher.reload();

    expect(onReload).toHaveBeenCalledOnce();
    expect(onReload).toHaveBeenCalledWith(2);
  });

  it("falls back to DEFAULT_RULES when file is missing", async () => {
    const adapter = makeMockAdapter();
    const engine = new NotificationPolicyEngine(adapter, [CUSTOM_RULE]);
    const watcher = new NotificationRulesWatcher("/nonexistent/rules.yaml", engine);

    // Should fall back to DEFAULT_RULES, not throw
    await watcher.reload();

    // After reload with missing file, engine has DEFAULT_RULES
    expect(engine.getRules()).toBe(DEFAULT_RULES);
  });

  it("invokes onError callback when watcher cannot start (bad path)", () => {
    const adapter = makeMockAdapter();
    const engine = new NotificationPolicyEngine(adapter, DEFAULT_RULES);
    const onError = vi.fn();

    // Pass a non-existent directory path — fs.watch should fail
    const watcher = new NotificationRulesWatcher(
      "/nonexistent/dir/rules.yaml",
      engine,
      { onError }
    );
    watcher.start();

    // fs.watch throws synchronously for non-existent paths in Node.js
    expect(onError).toHaveBeenCalledOnce();

    watcher.stop();
  });

  it("stop() is idempotent", async () => {
    const path = await writeTmpRules(`
version: 1
rules:
  - match:
      eventType: "task.created"
    severity: info
    audience: [agent]
    channel: "#ch"
    template: "msg"
`);
    const adapter = makeMockAdapter();
    const engine = new NotificationPolicyEngine(adapter, DEFAULT_RULES);
    const watcher = new NotificationRulesWatcher(path, engine);

    watcher.start();
    watcher.stop();
    watcher.stop(); // second stop should not throw
  });
});
