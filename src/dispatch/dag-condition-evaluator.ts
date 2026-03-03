/**
 * DAG condition evaluator — interprets ConditionExprType expressions from
 * the JSON DSL to determine whether a hop should execute or be skipped.
 *
 * Three exported functions:
 * - `getField(obj, path)` — dot-path field resolution
 * - `buildConditionContext(state, taskMeta)` — builds flat context for field resolution
 * - `evaluateCondition(expr, ctx)` — per-operator dispatch table evaluation
 *
 * Design decisions (from CONTEXT.md):
 * - Missing fields resolve to undefined, treated as falsy
 * - hop_status reads directly from WorkflowState.hops map (special operator)
 * - has_tag checks ctx.task.tags directly (special operator)
 * - Per-operator dispatch table (not switch/if-chain)
 * - Pure function, no side effects, deterministic
 *
 * @module dag-condition-evaluator
 */

import type {
  ConditionExprType,
  WorkflowState,
  HopState,
} from "../schemas/workflow-dag.js";

// ---------------------------------------------------------------------------
// Condition Context
// ---------------------------------------------------------------------------

/**
 * Context object for condition evaluation.
 *
 * Wraps a flat dot-path-resolvable context object, live hop states for
 * the hop_status operator, and task metadata for the has_tag operator.
 */
export interface ConditionContext {
  /** Flat nested object for dot-path field resolution (hop results + task metadata). */
  context: Record<string, unknown>;
  /** Live WorkflowState.hops map for hop_status operator. */
  hopStates: Record<string, HopState>;
  /** Task metadata with tags array for has_tag operator. */
  task: {
    status: string;
    tags: string[];
    priority: string;
    routing: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Dot-Path Field Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a dot-delimited path against a nested object.
 *
 * @param obj - Root object to resolve against (may be null/undefined)
 * @param path - Dot-delimited field path (e.g., "hops.review.result.approved")
 * @returns The resolved value, or undefined if any segment is missing
 */
export function getField(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Condition Context Building
// ---------------------------------------------------------------------------

/**
 * Build a flat context object for dot-path field resolution.
 *
 * Merges hop results under "hops.{hopId}" prefix and task metadata
 * under "task." prefix. This context is consumed by comparison operators
 * (eq, neq, gt, etc.) via `getField()`.
 *
 * @param state - Current workflow state (for hop results)
 * @param taskMeta - Task metadata (status, tags, priority, routing)
 * @returns Flat nested object suitable for dot-path resolution
 */
export function buildConditionContext(
  state: WorkflowState,
  taskMeta: ConditionContext["task"],
): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};

  // Hop results: hops.{hopId}.result.{field}
  const hops: Record<string, unknown> = {};
  for (const [hopId, hopState] of Object.entries(state.hops)) {
    hops[hopId] = { result: hopState.result ?? {} };
  }
  ctx.hops = hops;

  // Task metadata: task.{field}
  ctx.task = taskMeta;

  return ctx;
}

// ---------------------------------------------------------------------------
// Per-Operator Dispatch Table
// ---------------------------------------------------------------------------

/**
 * Handler type for a single condition operator.
 * Takes the expression and full context, returns a boolean.
 */
type ConditionHandler = (
  expr: ConditionExprType,
  ctx: ConditionContext,
) => boolean;

/**
 * Dispatch table mapping each ConditionExprType.op to its evaluation function.
 *
 * TypeScript narrowing is not available inside the dispatch table since handlers
 * receive the union type. We use type assertions for field access — this is safe
 * because the Zod schema guarantees the correct shape per operator.
 */
const OPERATORS: Record<string, ConditionHandler> = {
  // --- Comparison operators ---
  eq: (expr, ctx) => {
    const e = expr as Extract<ConditionExprType, { op: "eq" }>;
    const fieldValue = getField(ctx.context, e.field);
    return fieldValue === e.value;
  },

  neq: (expr, ctx) => {
    const e = expr as Extract<ConditionExprType, { op: "neq" }>;
    const fieldValue = getField(ctx.context, e.field);
    return fieldValue !== e.value;
  },

  gt: (expr, ctx) => {
    const e = expr as Extract<ConditionExprType, { op: "gt" }>;
    const fieldValue = getField(ctx.context, e.field);
    if (fieldValue === undefined) return false;
    return (fieldValue as number) > e.value;
  },

  gte: (expr, ctx) => {
    const e = expr as Extract<ConditionExprType, { op: "gte" }>;
    const fieldValue = getField(ctx.context, e.field);
    if (fieldValue === undefined) return false;
    return (fieldValue as number) >= e.value;
  },

  lt: (expr, ctx) => {
    const e = expr as Extract<ConditionExprType, { op: "lt" }>;
    const fieldValue = getField(ctx.context, e.field);
    if (fieldValue === undefined) return false;
    return (fieldValue as number) < e.value;
  },

  lte: (expr, ctx) => {
    const e = expr as Extract<ConditionExprType, { op: "lte" }>;
    const fieldValue = getField(ctx.context, e.field);
    if (fieldValue === undefined) return false;
    return (fieldValue as number) <= e.value;
  },

  // --- Collection operators ---
  in: (expr, ctx) => {
    const e = expr as Extract<ConditionExprType, { op: "in" }>;
    const fieldValue = getField(ctx.context, e.field);
    if (fieldValue === undefined) return false;
    return e.value.includes(fieldValue);
  },

  // --- Special operators ---
  has_tag: (expr, ctx) => {
    const e = expr as Extract<ConditionExprType, { op: "has_tag" }>;
    return ctx.task.tags?.includes(e.value) ?? false;
  },

  hop_status: (expr, ctx) => {
    const e = expr as Extract<ConditionExprType, { op: "hop_status" }>;
    return ctx.hopStates[e.hop]?.status === e.status;
  },

  // --- Logical operators ---
  and: (expr, ctx) => {
    const e = expr as Extract<ConditionExprType, { op: "and" }>;
    return e.conditions.every((c) => evaluateCondition(c, ctx));
  },

  or: (expr, ctx) => {
    const e = expr as Extract<ConditionExprType, { op: "or" }>;
    return e.conditions.some((c) => evaluateCondition(c, ctx));
  },

  not: (expr, ctx) => {
    const e = expr as Extract<ConditionExprType, { op: "not" }>;
    return !evaluateCondition(e.condition, ctx);
  },

  // --- Literal operators ---
  true: () => true,
  false: () => false,
};

// ---------------------------------------------------------------------------
// Main Evaluation Function
// ---------------------------------------------------------------------------

/**
 * Evaluate a ConditionExprType expression against a condition context.
 *
 * Uses a per-operator dispatch table for clean, extensible evaluation.
 * Unknown operators return false defensively (shouldn't happen with
 * Zod validation, but provides a safe default).
 *
 * @param expr - The condition expression to evaluate
 * @param ctx - The condition context (field context, live hop states, task metadata)
 * @returns true if the condition is satisfied, false otherwise
 */
export function evaluateCondition(
  expr: ConditionExprType,
  ctx: ConditionContext,
): boolean {
  const handler = OPERATORS[expr.op];
  if (!handler) return false; // Defensive: unknown op = false
  return handler(expr, ctx);
}
