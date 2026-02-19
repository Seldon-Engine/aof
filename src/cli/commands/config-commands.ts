/**
 * Configuration, metrics, and notification commands.
 */

import { join } from "node:path";
import type { Command } from "commander";
import { getConfigValue, setConfigValue, validateConfig } from "../../config/index.js";
import { startMetricsServer, AOFMetrics } from "../../metrics/exporter.js";
import { collectMetrics } from "../../metrics/collector.js";
import { MockNotificationAdapter } from "../../events/notifier.js";
import type { BaseEvent } from "../../schemas/event.js";
import {
  NotificationPolicyEngine,
  findMatchingRule,
  renderTemplate,
  loadNotificationRules,
} from "../../events/notification-policy/index.js";
import type { NotificationRule } from "../../events/notification-policy/index.js";

/**
 * Register configuration management commands.
 */
export function registerConfigCommands(program: Command): void {
  const config = program
    .command("config")
    .description("Configuration management (CLI-gated)");

  config
    .command("get <key>")
    .description("Get config value (dot-notation)")
    .action(async (key: string) => {
      const root = program.opts()["root"] as string;
      const configPath = join(root, "org", "org-chart.yaml");
      const value = await getConfigValue(configPath, key);
      if (value === undefined) {
        console.log(`Key '${key}' not found`);
        process.exitCode = 1;
      } else {
        console.log(typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
      }
    });

  config
    .command("set <key> <value>")
    .description("Set config value (validates + atomic write)")
    .option("--dry-run", "Preview change without applying", false)
    .action(async (key: string, value: string, opts: { dryRun: boolean }) => {
      const root = program.opts()["root"] as string;
      const configPath = join(root, "org", "org-chart.yaml");
      const result = await setConfigValue(configPath, key, value, opts.dryRun);
      const errors = result.issues.filter(i => i.severity === "error");

      if (opts.dryRun) {
        console.log(`[DRY RUN] Would update ${key}:`);
      } else if (errors.length > 0) {
        console.log("❌ Config change rejected:");
      } else {
        console.log(`✅ Config updated: ${key}`);
      }

      const fmt = (v: unknown) => v === undefined ? "undefined" : typeof v === "object" ? JSON.stringify(v) : String(v);
      console.log(`  ${key}: ${fmt(result.change.oldValue)} → ${fmt(result.change.newValue)}`);

      if (result.issues.length > 0) {
        console.log("\nIssues:");
        for (const issue of result.issues) {
          const icon = issue.severity === "error" ? "✗" : "⚠";
          console.log(`  ${icon} ${issue.message}`);
        }
      }

      if (errors.length > 0) process.exitCode = 1;
    });

  config
    .command("validate")
    .description("Validate entire config (schema + integrity)")
    .action(async () => {
      const root = program.opts()["root"] as string;
      const configPath = join(root, "org", "org-chart.yaml");
      const result = await validateConfig(configPath);

      if (result.schemaErrors.length > 0) {
        console.log("❌ Schema validation failed:");
        for (const err of result.schemaErrors) {
          console.log(`  ✗ ${err.path}: ${err.message}`);
        }
        process.exitCode = 1;
        return;
      }

      for (const issue of result.lintIssues) {
        const icon = issue.severity === "error" ? "✗" : "⚠";
        console.log(`  ${icon} [${issue.rule}] ${issue.message}`);
      }

      if (result.valid) {
        console.log("✅ Config valid");
      } else {
        process.exitCode = 1;
      }
    });
}

/**
 * Register metrics commands.
 */
export function registerMetricsCommands(program: Command): void {
  const metrics = program
    .command("metrics")
    .description("Metrics and observability");

  metrics
    .command("serve")
    .description("Start Prometheus metrics HTTP server")
    .option("-p, --port <port>", "HTTP port", "9090")
    .option("--project <id>", "Project ID", "_inbox")
    .action(async (opts: { port: string; project: string }) => {
      const { createProjectStore } = await import("../project-utils.js");
      const root = program.opts()["root"] as string;
      const port = parseInt(opts.port, 10);
      if (Number.isNaN(port) || port < 1 || port > 65535) {
        console.error(`❌ Invalid port: ${opts.port}`);
        process.exitCode = 1;
        return;
      }

      const { store } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
      await store.init();
      const metricsRegistry = new AOFMetrics();

      const server = startMetricsServer(port, metricsRegistry, async () => {
        return collectMetrics(store);
      });

      console.log(`📊 Metrics server started on http://localhost:${port}/metrics`);
      console.log(`   Health check: http://localhost:${port}/health`);
      console.log(`   Press Ctrl+C to stop`);

      const shutdown = () => {
        console.log("\n🛑 Shutting down metrics server...");
        server.close(() => {
          console.log("✅ Metrics server stopped");
          process.exit(0);
        });
      };

      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    });
}

/**
 * Register notification testing commands.
 */
/**
 * Register notification testing commands.
 *
 * Usage:
 *   aof notifications test                     # routing table for all severity tiers
 *   aof notifications test --event=<type>      # targeted dry-run for a specific event type
 */
export function registerNotificationsCommands(program: Command): void {
  const notifications = program
    .command("notifications")
    .description("Notification system testing and diagnostics");

  notifications
    .command("test")
    .description("Dry-run notification routing (no actual messages sent)")
    .option("--event <type>", "Target a specific event type (e.g. task.transitioned)")
    .action(async (opts: { event?: string }) => {
      const root = program.opts()["root"] as string;
      const rulesPath = join(root, "org", "notification-rules.yaml");

      const rules = await loadNotificationRules(rulesPath);
      const adapter = new MockNotificationAdapter();
      const engine = new NotificationPolicyEngine(adapter, rules, { enabled: true });

      console.log(`📋 Notification dry-run (rules: ${rulesPath})\n`);

      if (opts.event) {
        await runTargetedTest(opts.event, rules, engine, adapter);
      } else {
        await runSeveritySweep(rules, engine, adapter);
      }
    });
}

/** Builds a minimal stub event for dry-run display. */
function makeStubEvent(
  eventType: string,
  payload: Record<string, unknown> = {}
): BaseEvent {
  // Type cast: BaseEvent.type is an enum union; "unknown" type is used for dry-run display only
  return {
    eventId: 0,
    type: eventType as BaseEvent["type"],
    timestamp: new Date().toISOString(),
    actor: "cli-test",
    taskId: "TASK-DRY-RUN",
    payload,
  };
}

/** Runs a targeted dry-run for a single event type. */
async function runTargetedTest(
  eventType: string,
  rules: NotificationRule[],
  engine: NotificationPolicyEngine,
  adapter: MockNotificationAdapter
): Promise<void> {
  const event = makeStubEvent(eventType);
  const matchedRule = findMatchingRule(rules, event);

  if (!matchedRule) {
    console.log(`❌ No rule matches event type: ${eventType}`);
    console.log(`   Check org/notification-rules.yaml for a matching rule.`);
    process.exitCode = 1;
    return;
  }

  const message = renderTemplate(matchedRule.template, event);

  console.log(`Event type : ${eventType}`);
  console.log(`Rule match : ${matchedRule.match.eventType}${
    matchedRule.match.payload
      ? ` + payload(${JSON.stringify(matchedRule.match.payload)})`
      : ""
  }`);
  console.log(`Severity   : ${matchedRule.severity}`);
  console.log(`Channel    : ${matchedRule.channel}`);
  console.log(`Message    : ${message}`);
  console.log(`Dedupe     : ${matchedRule.neverSuppress ? "never suppressed" : matchedRule.dedupeWindowMs !== undefined ? `${matchedRule.dedupeWindowMs}ms` : "default (5 min)"}`);

  // Drive the event through the engine so stats reflect the dry-run
  await engine.handleEvent(event);
  const stats = engine.getStats();
  console.log(`\n✅ Dry-run complete (sent: ${stats.sent}, suppressed: ${stats.suppressed})`);
}

/** Sample events: one per severity tier. */
const SEVERITY_SWEEP_EVENTS: Array<{ label: string; event: Parameters<typeof makeStubEvent> }> = [
  { label: "info",     event: ["task.created",    { title: "Sample task" }] },
  { label: "warn",     event: ["lease.expired",   {}] },
  { label: "critical", event: ["system.shutdown", {}] },
];

/** Runs a sweep across all severity tiers and prints a routing table. */
async function runSeveritySweep(
  rules: NotificationRule[],
  engine: NotificationPolicyEngine,
  adapter: MockNotificationAdapter
): Promise<void> {
  console.log("Severity sweep — one event per tier:\n");
  console.log(`${"Event Type".padEnd(28)} ${"Severity".padEnd(10)} ${"Channel".padEnd(20)} Message`);
  console.log("─".repeat(90));

  for (const { label, event: [type, payload] } of SEVERITY_SWEEP_EVENTS) {
    const ev = makeStubEvent(type, payload as Record<string, unknown>);
    const rule = findMatchingRule(rules, ev);

    if (!rule) {
      console.log(`${type.padEnd(28)} ${"(no match)".padEnd(10)} ${"—".padEnd(20)} —`);
      continue;
    }

    const msg = renderTemplate(rule.template, ev);
    console.log(
      `${type.padEnd(28)} ${rule.severity.padEnd(10)} ${rule.channel.padEnd(20)} ${msg}`
    );
    await engine.handleEvent(ev);
    void label; // used only for documentation
  }

  const stats = engine.getStats();
  console.log("\n" + "─".repeat(90));
  console.log(`✅ Sweep complete — sent: ${stats.sent}, no-match: ${stats.noMatch}`);
  console.log(`   (No actual notifications sent — dry-run only)`);
}
