/**
 * Workflow DAG schema — Zod type definitions for DAG-based task workflows.
 *
 * Defines the complete type system for workflow DAGs: hop definitions, execution
 * state, condition expressions, and structural validation. This is the foundational
 * schema layer that the evaluator (Phase 11), scheduler (Phase 12), and template
 * registry (Phase 14) depend on.
 *
 * Key design decisions:
 * - Per-hop `dependsOn` array for DAG edges (mirrors task `dependsOn` pattern)
 * - Hop state stored as map keyed by hop ID for O(1) lookup
 * - `validateDAG()` is standalone (not in Zod `.superRefine()`) per Pitfall 3
 * - `initializeWorkflowState()` derives initial state from definition
 *
 * @module workflow-dag
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Condition Expression (JSON DSL)
// ---------------------------------------------------------------------------

/**
 * Recursive type for the condition expression discriminated union.
 * Required for `z.lazy()` type annotation.
 */
export type ConditionExprType =
  | { op: "eq"; field: string; value?: unknown }
  | { op: "neq"; field: string; value?: unknown }
  | { op: "gt"; field: string; value: number }
  | { op: "gte"; field: string; value: number }
  | { op: "lt"; field: string; value: number }
  | { op: "lte"; field: string; value: number }
  | { op: "in"; field: string; value: unknown[] }
  | { op: "has_tag"; value: string }
  | { op: "hop_status"; hop: string; status: string }
  | { op: "and"; conditions: ConditionExprType[] }
  | { op: "or"; conditions: ConditionExprType[] }
  | { op: "not"; condition: ConditionExprType }
  | { op: "true" }
  | { op: "false" };

/**
 * JSON DSL condition expression for hop activation.
 *
 * Structured as a recursive discriminated union of operator nodes.
 * The Phase 11 evaluator consumes this schema to decide whether a hop
 * should execute or be skipped. Additional operators may be added in
 * future phases without breaking changes.
 *
 * Operators:
 * - Comparison: eq, neq (field+value), gt, gte, lt, lte (field+number)
 * - Collection: in (field+array), has_tag (string value)
 * - DAG-aware: hop_status (hop ID + expected status)
 * - Logical: and, or (recursive array), not (recursive single)
 * - Literal: true, false (no args)
 */
export const ConditionExpr: z.ZodType<ConditionExprType> = z.lazy(() =>
  z.discriminatedUnion("op", [
    // Comparison operators
    z.object({ op: z.literal("eq"), field: z.string(), value: z.unknown() }),
    z.object({ op: z.literal("neq"), field: z.string(), value: z.unknown() }),
    z.object({ op: z.literal("gt"), field: z.string(), value: z.number() }),
    z.object({ op: z.literal("gte"), field: z.string(), value: z.number() }),
    z.object({ op: z.literal("lt"), field: z.string(), value: z.number() }),
    z.object({ op: z.literal("lte"), field: z.string(), value: z.number() }),
    // Collection operators
    z.object({
      op: z.literal("in"),
      field: z.string(),
      value: z.array(z.unknown()),
    }),
    z.object({ op: z.literal("has_tag"), value: z.string() }),
    z.object({
      op: z.literal("hop_status"),
      hop: z.string(),
      status: z.string(),
    }),
    // Logical operators (recursive)
    z.object({
      op: z.literal("and"),
      conditions: z.array(ConditionExpr),
    }),
    z.object({
      op: z.literal("or"),
      conditions: z.array(ConditionExpr),
    }),
    z.object({ op: z.literal("not"), condition: ConditionExpr }),
    // Literal operators
    z.object({ op: z.literal("true") }),
    z.object({ op: z.literal("false") }),
  ]),
);

// ---------------------------------------------------------------------------
// Hop Definition
// ---------------------------------------------------------------------------

/**
 * Hop definition — a node in the workflow DAG.
 *
 * Each hop represents a discrete unit of work assigned to a specific role.
 * Edges are defined via the `dependsOn` array (predecessor hop IDs).
 * Hops with empty `dependsOn` are root hops, eligible for parallel dispatch.
 */
export const Hop = z.object({
  /** Unique hop ID within the workflow (e.g., "implement", "review", "deploy"). */
  id: z.string().min(1),
  /** Role responsible for this hop (from org chart, e.g., "swe-backend", "swe-qa"). */
  role: z.string().min(1),
  /** Hop IDs that must complete before this hop can start. Empty = root hop. */
  dependsOn: z.array(z.string()).default([]),
  /** Join type for hops with multiple predecessors. "all" = AND-join, "any" = OR-join. */
  joinType: z.enum(["all", "any"]).default("all"),
  /** Whether scheduler advances immediately on completion (true) or waits for review (false). */
  autoAdvance: z.boolean().default(true),
  /** JSON DSL condition expression for hop activation (execute vs skip). */
  condition: ConditionExpr.optional(),
  /** Human-readable description of the hop's purpose. */
  description: z.string().optional(),
  /** Whether this hop can reject work back. Schema placeholder — logic in Phase 13. */
  canReject: z.boolean().default(false),
  /** Rejection strategy. Schema placeholder — logic in Phase 13. */
  rejectionStrategy: z.enum(["origin", "predecessors"]).optional(),
  /** Maximum time before escalation (e.g., "1h", "30m", "2d"). Schema only — behavior in Phase 13. */
  timeout: z.string().optional(),
  /** Escalation target role on timeout. Schema only — behavior in Phase 13. */
  escalateTo: z.string().optional(),
});
export type Hop = z.infer<typeof Hop>;

// ---------------------------------------------------------------------------
// Workflow Definition (Immutable Shape)
// ---------------------------------------------------------------------------

/**
 * Workflow DAG definition — the immutable shape of the workflow.
 *
 * Set at task creation time and never modified. The DAG structure is
 * determined by `dependsOn` edges on each hop, not by array order.
 */
export const WorkflowDefinition = z.object({
  /** Workflow name (for identification and template matching). */
  name: z.string().min(1),
  /** Hop definitions forming the DAG (at least one required). */
  hops: z.array(Hop).min(1),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

// ---------------------------------------------------------------------------
// Execution State (Mutable)
// ---------------------------------------------------------------------------

/**
 * Status of a single hop in DAG execution.
 *
 * Lifecycle: pending -> ready -> dispatched -> complete/failed/skipped
 */
export const HopStatus = z.enum([
  "pending", // Not yet eligible (predecessors incomplete)
  "ready", // All predecessors complete, eligible for dispatch
  "dispatched", // Scheduler has dispatched this hop to an agent
  "complete", // Hop completed successfully
  "failed", // Hop failed (agent error, timeout, etc.)
  "skipped", // Condition evaluated to false, hop will not execute
]);
export type HopStatus = z.infer<typeof HopStatus>;

/**
 * Runtime state of a single hop.
 *
 * Tracks execution lifecycle including timestamps, assigned agent,
 * correlation ID for tracing, and arbitrary result data for downstream hops.
 */
export const HopState = z.object({
  /** Hop execution status. */
  status: HopStatus,
  /** ISO-8601 timestamp when hop started execution. */
  startedAt: z.string().datetime().optional(),
  /** ISO-8601 timestamp when hop completed/failed/skipped. */
  completedAt: z.string().datetime().optional(),
  /** Agent assigned to this hop (set on dispatch). */
  agent: z.string().optional(),
  /** Correlation ID for tracing (links to session/run). */
  correlationId: z.string().optional(),
  /** Arbitrary output data from hop execution (for downstream hops). */
  result: z.record(z.string(), z.unknown()).optional(),
});
export type HopState = z.infer<typeof HopState>;

/**
 * DAG-level execution status.
 *
 * Persisted for quick inspection without scanning all hop states.
 */
export const WorkflowStatus = z.enum([
  "pending", // Workflow created but not yet started
  "running", // At least one hop has been dispatched
  "complete", // All hops in terminal state, DAG succeeded
  "failed", // DAG failed (at least one hop failed without recovery path)
]);
export type WorkflowStatus = z.infer<typeof WorkflowStatus>;

/**
 * Mutable execution state of the workflow DAG.
 *
 * Updated atomically on each hop transition via writeFileAtomic.
 * The `hops` map provides O(1) lookup by hop ID.
 */
export const WorkflowState = z.object({
  /** DAG-level status for quick inspection. */
  status: WorkflowStatus,
  /** Per-hop state map: hop ID -> HopState. */
  hops: z.record(z.string(), HopState),
  /** ISO-8601 timestamp when workflow execution started. */
  startedAt: z.string().datetime().optional(),
  /** ISO-8601 timestamp when workflow completed. */
  completedAt: z.string().datetime().optional(),
});
export type WorkflowState = z.infer<typeof WorkflowState>;

// ---------------------------------------------------------------------------
// TaskWorkflow (Top-Level Field)
// ---------------------------------------------------------------------------

/**
 * Top-level workflow field on task frontmatter.
 *
 * Contains both the immutable DAG definition (set at creation) and the
 * mutable execution state (updated on each hop transition).
 */
export const TaskWorkflow = z.object({
  /** Immutable DAG shape set at creation. */
  definition: WorkflowDefinition,
  /** Mutable execution progress. */
  state: WorkflowState,
});
export type TaskWorkflow = z.infer<typeof TaskWorkflow>;

// ---------------------------------------------------------------------------
// DAG Validation
// ---------------------------------------------------------------------------

/** Valid timeout format: digits followed by m (minutes), h (hours), or d (days). */
const TIMEOUT_REGEX = /^\d+[mhd]$/;

/**
 * Validate a workflow DAG definition for structural correctness.
 *
 * Checks:
 * - Hop IDs are unique
 * - All dependsOn references point to existing hop IDs
 * - At least one root hop exists (empty dependsOn)
 * - No cycles (via Kahn's algorithm / topological sort)
 * - All hops are reachable from root hops
 * - Timeout format is valid (if specified)
 * - escalateTo is non-empty (if specified)
 *
 * This is a standalone function (not in Zod `.superRefine()`) to avoid
 * running heavyweight graph validation on every task parse/load.
 * Call explicitly at task creation time.
 *
 * @param definition - Parsed WorkflowDefinition to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateDAG(definition: WorkflowDefinition): string[] {
  const errors: string[] = [];
  const hopIds = new Set<string>();
  const hopMap = new Map<string, Hop>();

  // --- Check hop ID uniqueness ---
  for (const hop of definition.hops) {
    if (hopIds.has(hop.id)) {
      errors.push(`Duplicate hop ID: "${hop.id}"`);
    }
    hopIds.add(hop.id);
    hopMap.set(hop.id, hop);
  }

  // --- Check dependsOn references exist ---
  for (const hop of definition.hops) {
    for (const dep of hop.dependsOn) {
      if (!hopIds.has(dep)) {
        errors.push(
          `Hop "${hop.id}" depends on "${dep}" which does not exist`,
        );
      }
    }
  }

  // --- Check at least one root hop ---
  const rootHops = definition.hops.filter((h) => h.dependsOn.length === 0);
  if (rootHops.length === 0) {
    errors.push("No root hops found (all hops have dependsOn)");
  }

  // --- Check for cycles (Kahn's algorithm) ---
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const hop of definition.hops) {
    inDegree.set(hop.id, 0);
    adjacency.set(hop.id, []);
  }

  for (const hop of definition.hops) {
    for (const dep of hop.dependsOn) {
      if (adjacency.has(dep)) {
        adjacency.get(dep)!.push(hop.id);
        inDegree.set(hop.id, (inDegree.get(hop.id) ?? 0) + 1);
      }
    }
  }

  const queue = [...inDegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([id]) => id);
  let processed = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    processed++;
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  if (processed !== definition.hops.length) {
    const cycleHops = [...inDegree.entries()]
      .filter(([, deg]) => deg > 0)
      .map(([id]) => id);
    errors.push(`Cycle detected involving hops: ${cycleHops.join(", ")}`);
  }

  // --- Check all hops reachable from root hops (BFS) ---
  if (rootHops.length > 0) {
    const visited = new Set<string>();
    const bfsQueue = rootHops.map((h) => h.id);

    while (bfsQueue.length > 0) {
      const current = bfsQueue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          bfsQueue.push(neighbor);
        }
      }
    }

    const unreachable = definition.hops
      .filter((h) => !visited.has(h.id))
      .map((h) => h.id);
    if (unreachable.length > 0) {
      errors.push(
        `Unreachable hops (not connected to any root): ${unreachable.join(", ")}`,
      );
    }
  }

  // --- Validate timeout format ---
  for (const hop of definition.hops) {
    if (hop.timeout !== undefined && !TIMEOUT_REGEX.test(hop.timeout)) {
      errors.push(
        `Invalid timeout format for hop "${hop.id}": "${hop.timeout}" (expected: "1h", "30m", "2d", etc.)`,
      );
    }
  }

  // --- Validate escalateTo non-empty ---
  for (const hop of definition.hops) {
    if (hop.escalateTo !== undefined && hop.escalateTo.trim().length === 0) {
      errors.push(`Hop "${hop.id}" has empty escalateTo role`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// State Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize workflow state from a definition.
 *
 * Pure helper that derives the initial execution state from a workflow
 * definition. Root hops (empty `dependsOn`) start as "ready", all
 * others start as "pending". Workflow-level status is "pending".
 * No timestamps are set.
 *
 * @param definition - Parsed WorkflowDefinition to initialize state for
 * @returns Initial WorkflowState ready for execution
 */
export function initializeWorkflowState(
  definition: WorkflowDefinition,
): WorkflowState {
  const hops: Record<string, HopState> = {};

  for (const hop of definition.hops) {
    const isRoot = hop.dependsOn.length === 0;
    hops[hop.id] = {
      status: isRoot ? "ready" : "pending",
    };
  }

  return {
    status: "pending",
    hops,
  };
}
