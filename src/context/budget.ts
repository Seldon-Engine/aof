/**
 * Context budget tracking — token/char estimation and budget evaluation.
 *
 * Provides simple heuristic-based token counting (no model-specific tokenizers)
 * and budget policy evaluation for context bundles.
 */

import type { ContextBundle } from "./assembler.js";

/** Context budget policy (optional org chart node policy). */
export interface ContextBudgetPolicy {
  /** Target budget (chars) — ideal context size. */
  target: number;
  /** Warning threshold (chars). */
  warn: number;
  /** Critical threshold (chars) — must truncate. */
  critical: number;
}

/** Budget evaluation result. */
export interface BudgetUsage {
  taskId: string;
  totalChars: number;
  estimatedTokens: number;
  policy?: ContextBudgetPolicy;
  status: "ok" | "warn" | "critical" | "over";
}

/**
 * Estimate token count using simple 4-chars-per-token heuristic.
 *
 * @param text - Input text
 * @returns Estimated token count (ceiling)
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimate character count from token count.
 *
 * @param tokens - Token count
 * @returns Estimated character count
 */
export function estimateChars(tokens: number): number {
  return tokens * 4;
}

/**
 * Evaluate a context bundle against a budget policy.
 *
 * @param bundle - Context bundle to evaluate
 * @param policy - Optional budget policy
 * @returns Budget usage with status
 */
export function evaluateBudget(
  bundle: ContextBundle,
  policy?: ContextBudgetPolicy
): BudgetUsage {
  const totalChars = bundle.totalChars;
  const estimatedTokens = estimateTokens(bundle.summary);

  // No policy = always ok
  if (!policy) {
    return {
      taskId: bundle.manifest.taskId,
      totalChars,
      estimatedTokens,
      policy: undefined,
      status: "ok",
    };
  }

  // Determine status based on policy thresholds
  let status: BudgetUsage["status"];
  if (totalChars > policy.critical) {
    status = "over";
  } else if (totalChars > policy.warn) {
    status = "critical";
  } else if (totalChars > policy.target) {
    status = "warn";
  } else {
    status = "ok";
  }

  return {
    taskId: bundle.manifest.taskId,
    totalChars,
    estimatedTokens,
    policy,
    status,
  };
}
