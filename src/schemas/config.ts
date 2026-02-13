/**
 * AOF configuration schema — CLI-gated, validated, atomic writes.
 *
 * All config changes go through `aof config set/apply` — never raw edits.
 * Config is stored as a single YAML file with schema validation.
 */

import { z } from "zod";

/** Dispatcher configuration. */
export const DispatcherConfig = z.object({
  /** How often the dispatcher scans for pending tasks (ms). */
  intervalMs: z.number().int().positive().default(120_000),
  /** Default lease TTL (ms). */
  defaultLeaseTtlMs: z.number().int().positive().default(600_000),
  /** Max lease renewals before force-expiry. */
  maxLeaseRenewals: z.number().int().nonnegative().default(3),
  /** Enable dry-run mode (log decisions, don't dispatch). */
  dryRun: z.boolean().default(false),
});
export type DispatcherConfig = z.infer<typeof DispatcherConfig>;

/** Metrics/telemetry configuration. */
export const MetricsConfig = z.object({
  /** Enable Prometheus metrics export. */
  enabled: z.boolean().default(true),
  /** Port for the metrics HTTP server. */
  port: z.number().int().positive().default(9101),
  /** Metrics path. */
  path: z.string().default("/metrics"),
});
export type MetricsConfig = z.infer<typeof MetricsConfig>;

/** Event log configuration. */
export const EventLogConfig = z.object({
  /** Enable event logging. */
  enabled: z.boolean().default(true),
  /** Max events per log file before rotation. */
  maxEventsPerFile: z.number().int().positive().default(10_000),
  /** Max total log files to retain. */
  maxFiles: z.number().int().positive().default(30),
});
export type EventLogConfig = z.infer<typeof EventLogConfig>;

/** Communication fallback configuration. */
export const CommsConfig = z.object({
  /** Default dispatch method priority. */
  methodPriority: z.array(z.enum(["spawn", "send", "cli"])).default(["send", "spawn", "cli"]),
  /** Timeout for spawn attempts (ms). */
  spawnTimeoutMs: z.number().int().positive().default(30_000),
  /** Timeout for send attempts (ms). */
  sendTimeoutMs: z.number().int().positive().default(60_000),
  /** Timeout for CLI attempts (ms). */
  cliTimeoutMs: z.number().int().positive().default(120_000),
});
export type CommsConfig = z.infer<typeof CommsConfig>;

/** Top-level AOF configuration. */
export const AofConfig = z.object({
  schemaVersion: z.literal(1),
  /** Root data directory for AOF runtime data. */
  dataDir: z.string().default("~/.openclaw/aof"),
  /** Path to org chart YAML file. */
  orgChartPath: z.string().default("org-chart.yaml"),
  /** Root directory for vault (Projects/, Resources/). */
  vaultRoot: z.string().optional(),
  dispatcher: DispatcherConfig.default({}),
  metrics: MetricsConfig.default({}),
  eventLog: EventLogConfig.default({}),
  comms: CommsConfig.default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AofConfig = z.infer<typeof AofConfig>;
