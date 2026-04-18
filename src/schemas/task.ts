/**
 * Task schema — canonical representation for AOF tasks.
 *
 * Tasks are single Markdown files with YAML frontmatter.
 * The `tasks/` directory is the single source of truth.
 * Mailbox/Kanban views are derived (computed, never written to).
 */

import { z } from "zod";
import { TaskWorkflow } from "./workflow-dag.js";

// ---------------------------------------------------------------------------
// Inlined from gate.ts (legacy gate types, kept for backward compat of persisted data)
// ---------------------------------------------------------------------------

/** Gate outcome — the result of passing through a gate. */
const GateOutcome = z.enum(["complete", "needs_review", "blocked"]);

/** Gate history entry — audit trail record for a task passing through a gate. */
export const GateHistoryEntry = z.object({
  gate: z.string(),
  role: z.string(),
  agent: z.string().optional(),
  entered: z.string().datetime(),
  exited: z.string().datetime().optional(),
  outcome: GateOutcome.optional(),
  summary: z.string().optional(),
  blockers: z.array(z.string()).default([]),
  rejectionNotes: z.string().optional(),
  duration: z.number().int().nonnegative().optional(),
});
export type GateHistoryEntry = z.infer<typeof GateHistoryEntry>;

/** Review context — feedback from a previous gate rejection. */
export const ReviewContext = z.object({
  fromGate: z.string(),
  fromAgent: z.string().optional(),
  fromRole: z.string(),
  timestamp: z.string().datetime(),
  blockers: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type ReviewContext = z.infer<typeof ReviewContext>;

/** Test specification — BDD-style test case for gate validation. */
export const TestSpec = z.object({
  given: z.string(),
  when: z.string(),
  then: z.object({
    status: z.number().int().optional(),
    body_contains: z.array(z.string()).optional(),
  }),
});
export type TestSpec = z.infer<typeof TestSpec>;

/** Task ID format: TASK-YYYY-MM-DD-NNN. */
export const TaskId = z.string().regex(/^TASK-\d{4}-\d{2}-\d{2}-\d{3}(-\d{2})?$/, "Invalid task id");
export type TaskId = z.infer<typeof TaskId>;

/** Valid task statuses per BRD — shared across all schemas. */
export const TaskStatus = z.enum([
  "backlog",      // Created, not yet triaged
  "ready",        // Ready to be picked up by scheduler
  "in-progress",  // Agent actively working (has lease)
  "blocked",      // Waiting on external dependency
  "review",       // Work complete, awaiting review
  "done",         // Successfully completed
  "cancelled",    // Cancelled by user or system
  "deadletter",   // Failed dispatch 3 times, requires manual intervention
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Task priority levels. */
export const TaskPriority = z.enum([
  "critical",
  "high",
  "normal",
  "low",
]);
export type TaskPriority = z.infer<typeof TaskPriority>;

/** Lease information for task assignment. */
export const TaskLease = z.object({
  agent: z.string().describe("Agent ID holding the lease"),
  acquiredAt: z.string().datetime().describe("ISO-8601 lease acquisition time"),
  expiresAt: z.string().datetime().describe("ISO-8601 lease expiry time"),
  renewCount: z.number().int().nonnegative().default(0),
});
export type TaskLease = z.infer<typeof TaskLease>;

/** Gate state — tracks current gate and entry timestamp for workflow progression. */
export const GateState = z.object({
  /** Current gate ID (e.g., "dev", "qa", "deploy"). */
  current: z.string().min(1),
  /** ISO-8601 timestamp when task entered this gate. */
  entered: z.string().datetime(),
});
export type GateState = z.infer<typeof GateState>;

/** Routing hints for the deterministic dispatcher. */
export const TaskRouting = z.object({
  /** Target role from org chart (e.g., "swe-backend", "qa"). */
  role: z.string().optional(),
  /** Target team from org chart (e.g., "swe-suite"). */
  team: z.string().optional(),
  /** Specific agent ID override (bypasses org chart routing). */
  agent: z.string().optional(),
  /** Tags for capability-based matching. */
  tags: z.array(z.string()).default([]),
  /** Workflow name from project.yaml (e.g., "standard-sdlc"). */
  workflow: z.string().optional(),
});
export type TaskRouting = z.infer<typeof TaskRouting>;

/** SLA (Service Level Agreement) configuration for task execution time limits. */
export const TaskSLA = z.object({
  /** Maximum in-progress duration in milliseconds (per-task override). */
  maxInProgressMs: z.number().int().positive().optional(),
  /** Action to take on SLA violation. Phase 1: only 'alert' is supported. */
  onViolation: z.enum(["alert", "block", "deadletter"]).optional(),
});
export type TaskSLA = z.infer<typeof TaskSLA>;

/** Task frontmatter schema (YAML section of the Markdown file). */
export const TaskFrontmatter = z.preprocess((input) => {
  if (!input || typeof input !== "object") return input;
  const data = input as Record<string, unknown>;
  if (data.requiredRunbook === undefined && data.required_runbook !== undefined) {
    return {
      ...data,
      requiredRunbook: data.required_runbook,
    };
  }
  return input;
}, z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]).describe("Schema version for migration support"),
  id: TaskId.describe("Stable task identifier"),
  // BUG-044: `project` is optional at the schema layer. Project-scoped
  // stores (`createProjectStore`) stamp it; the unscoped base store at
  // `~/.aof/data/` does not (it has no manifest, so stamping a made-up
  // value caused task-dispatcher to probe for a non-existent project.yaml
  // and log ENOENT on every poll). The `string().min(1)` floor still
  // rejects empty-string values written by buggy upgrades.
  project: z.string().min(1).optional().describe("Project identifier (set by project-scoped stores; omitted for unscoped base store)"),
  title: z.string().min(1).describe("Human-readable task title"),
  status: TaskStatus,
  priority: TaskPriority.default("normal"),
  routing: TaskRouting.default({}),
  sla: TaskSLA.optional().describe("SLA configuration (time limits and violation policy)"),
  lease: TaskLease.nullable().optional().transform(v => v ?? undefined).describe("Present when status is assigned/in-progress"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastTransitionAt: z.string().datetime().describe("Last status change timestamp"),
  createdBy: z.string().describe("Agent or system that created this task"),
  parentId: TaskId.optional().describe("Parent task for sub-task hierarchy"),
  dependsOn: z.array(TaskId).default([]).describe("Task IDs this depends on"),
  contentHash: z.string().optional().describe("SHA-256 of body content for idempotency"),
  metadata: z.record(z.string(), z.unknown()).default({}),
  contextTier: z.enum(["seed", "full"]).optional().describe("Context tier for skill injection (seed=minimal, full=complete)"),
  requiredRunbook: z.string().optional().describe("Required runbook path or ID for compliance"),
  instructionsRef: z.string().min(1).optional().describe("Path to instructions file (optional)"),
  guidanceRef: z.string().min(1).optional().describe("Path to guidance/conventions file (optional)"),
  resource: z.string().optional().describe("Resource identifier for serialization (e.g., workspace path). Only one task per resource can be in-progress at a time."),
  callbackDepth: z.number().int().min(0).optional().describe("Callback chain depth -- 0 for normal tasks, incremented for callback-spawned tasks"),
  
  // Gate workflow fields (optional for backward compatibility)
  gate: GateState.optional().describe("Current gate and entry timestamp"),
  gateHistory: z.array(GateHistoryEntry).default([]).describe("Audit trail of gate transitions"),
  reviewContext: ReviewContext.optional().describe("Feedback from previous gate rejection"),
  tests: z.array(TestSpec).default([]).describe("BDD-style test specifications"),
  testsFile: z.string().optional().describe("Reference to external test file (e.g., tests/acceptance.yaml)"),

  // DAG workflow fields (optional, mutually exclusive with gate fields)
  workflow: TaskWorkflow.optional().describe("Workflow DAG definition and execution state"),
}).superRefine((data, ctx) => {
  if (data.gate && data.workflow) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Task cannot have both 'gate' (linear workflow) and 'workflow' (DAG workflow) fields. They are mutually exclusive -- use one or the other.",
      path: ["workflow"],
    });
  }
}));
export type TaskFrontmatter = z.infer<typeof TaskFrontmatter>;

/** Full task representation (frontmatter + body). */
export const Task = z.object({
  frontmatter: TaskFrontmatter,
  /** Markdown body content (instructions, context, deliverables). */
  body: z.string(),
  /** Filesystem path (set at load time, not serialized). */
  path: z.string().optional(),
});
export type Task = z.infer<typeof Task>;

/**
 * Valid status transitions per BRD — enforced by the task store.
 * Key = current status, Value = allowed next statuses.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  "backlog":     ["ready", "blocked", "cancelled"],
  "ready":       ["in-progress", "blocked", "deadletter", "cancelled"],
  "in-progress": ["review", "ready", "blocked", "deadletter", "cancelled"],
  "blocked":     ["ready", "deadletter", "cancelled"],
  "review":      ["done", "in-progress", "blocked", "cancelled"],
  "done":        [],
  "cancelled":   [],
  "deadletter":  ["ready"],
} as const;

/** Check if a status transition is valid. */
export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (VALID_TRANSITIONS[from] as readonly string[]).includes(to);
}

/** Thinking level for task execution. */
export type TaskThinking = "off" | "low" | "medium" | "high";
