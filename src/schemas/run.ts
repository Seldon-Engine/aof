import { z } from "zod";

/**
 * Run artifact schema — captures execution state for a task.
 * 
 * Written once when a task execution starts (on lease acquisition).
 * Location: tasks/<status>/<task-id>/run.json
 */
export const RunArtifact = z.object({
  /** Task ID this run is executing. */
  taskId: z.string(),
  /** Agent ID executing this task. */
  agentId: z.string(),
  /** ISO-8601 timestamp when execution started. */
  startedAt: z.string().datetime(),
  /** Current run status. */
  status: z.enum(["running", "completed", "failed", "abandoned"]).default("running"),
  /** Relative paths to key artifacts (inputs, work, output). */
  artifactPaths: z.object({
    inputs: z.string().default("inputs/"),
    work: z.string().default("work/"),
    output: z.string().default("output/"),
  }).default({}),
  /** Optional metadata (e.g., session ID, invocation context). */
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type RunArtifact = z.infer<typeof RunArtifact>;

/**
 * Heartbeat artifact schema — liveness signal for in-flight tasks.
 * 
 * Updated periodically by the executor (e.g., every 60s).
 * Location: tasks/<status>/<task-id>/run_heartbeat.json
 */
export const RunHeartbeat = z.object({
  /** Task ID. */
  taskId: z.string(),
  /** Agent ID. */
  agentId: z.string(),
  /** ISO-8601 timestamp of most recent heartbeat. */
  lastHeartbeat: z.string().datetime(),
  /** Number of heartbeat updates (starts at 0). */
  beatCount: z.number().int().nonnegative().default(0),
  /** Optional: next expected heartbeat (for TTL calculation). */
  expiresAt: z.string().datetime().optional(),
});
export type RunHeartbeat = z.infer<typeof RunHeartbeat>;

/**
 * Resume recovery info — used when restarting a crashed task.
 */
export const ResumeInfo = z.object({
  taskId: z.string(),
  agentId: z.string(),
  status: z.enum(["resumable", "stale", "completed"]),
  runArtifact: RunArtifact.optional(),
  heartbeat: RunHeartbeat.optional(),
  reason: z.string().optional(),
});
export type ResumeInfo = z.infer<typeof ResumeInfo>;
