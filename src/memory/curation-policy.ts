/**
 * Curation policy schema and parser for memory maintenance tasks.
 * 
 * Policies define adaptive thresholds that trigger curation tasks based on
 * entry count pressure. Supports per-pool overrides and guardrails.
 */

import { z } from "zod";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

/** Duration string pattern (e.g., "30d", "7d", "2h", "15m"). */
const DURATION_REGEX = /^(\d+)(d|h|m)$/;

/** Pressure threshold defining when to run curation and at what interval. */
export const CurationThreshold = z.object({
  /** Maximum entries before this threshold applies (null = infinity). */
  maxEntries: z.number().int().positive().nullable(),
  /** Minimum interval between curation runs at this threshold. */
  interval: z.string().regex(DURATION_REGEX, "Invalid duration format (use: 30d, 7d, 2h, 15m)"),
});
export type CurationThreshold = z.infer<typeof CurationThreshold>;

/** Guardrails for curation operations (what NOT to delete). */
export const CurationGuardrails = z.object({
  /** Preserve entries with these tags. */
  preserveTags: z.array(z.string()).default([]),
  /** Preserve entries modified within this duration. */
  preserveRecent: z.string().regex(DURATION_REGEX).optional(),
  /** Minimum entries to keep (never delete below this). */
  minEntries: z.number().int().nonnegative().optional(),
  /** Maximum entries to delete in a single run. */
  maxDeletePerRun: z.number().int().positive().optional(),
});
export type CurationGuardrails = z.infer<typeof CurationGuardrails>;

/** Per-pool override for specific memory pools. */
export const PoolOverride = z.object({
  /** Pool ID to override. */
  poolId: z.string().min(1),
  /** Override thresholds (if provided). */
  thresholds: z.array(CurationThreshold).optional(),
  /** Override guardrails (merged with global). */
  guardrails: CurationGuardrails.optional(),
  /** Disable curation for this pool. */
  disabled: z.boolean().default(false),
});
export type PoolOverride = z.infer<typeof PoolOverride>;

/** Top-level curation policy schema. */
export const CurationPolicy = z.object({
  schemaVersion: z.literal(1),
  /** Human-readable description. */
  description: z.string().optional(),
  /** Default thresholds (ascending by maxEntries). */
  thresholds: z.array(CurationThreshold).min(1),
  /** Global guardrails. */
  guardrails: CurationGuardrails.default({}),
  /** Per-pool overrides. */
  poolOverrides: z.array(PoolOverride).default([]),
  /** Curation strategy (prune, archive, compress). */
  strategy: z.enum(["prune", "archive", "compress"]).default("prune"),
  /** Metadata for tracking policy evolution. */
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CurationPolicy = z.infer<typeof CurationPolicy>;

/**
 * Parse a duration string into milliseconds.
 * Supports: d (days), h (hours), m (minutes).
 */
export function parseDuration(duration: string): number {
  const match = duration.match(DURATION_REGEX);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration} (expected: 30d, 7d, 2h, 15m)`);
  }

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;

  switch (unit) {
    case "d": return value * 24 * 60 * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "m": return value * 60 * 1000;
    default: throw new Error(`Invalid duration unit: ${unit}`);
  }
}

/**
 * Normalize thresholds by sorting ascending by maxEntries.
 * Null maxEntries (infinity) goes last.
 */
export function normalizeThresholds(thresholds: CurationThreshold[]): CurationThreshold[] {
  return [...thresholds].sort((a, b) => {
    if (a.maxEntries === null) return 1;
    if (b.maxEntries === null) return -1;
    return a.maxEntries - b.maxEntries;
  });
}

/**
 * Validate policy guardrails and thresholds.
 * Throws if policy is invalid.
 */
export function validatePolicy(policy: CurationPolicy): void {
  // Validate thresholds are in ascending order (check original, not normalized)
  for (let i = 0; i < policy.thresholds.length - 1; i++) {
    const current = policy.thresholds[i]!;
    const next = policy.thresholds[i + 1]!;
    
    // Both are numbers
    if (current.maxEntries !== null && next.maxEntries !== null) {
      if (current.maxEntries >= next.maxEntries) {
        throw new Error("Thresholds must have ascending maxEntries values");
      }
    }
    
    // Current is null but next is not (invalid: null must be last)
    if (current.maxEntries === null && next.maxEntries !== null) {
      throw new Error("Thresholds with maxEntries=null must be last");
    }
  }

  // Validate duration strings
  for (const threshold of policy.thresholds) {
    parseDuration(threshold.interval);
  }

  if (policy.guardrails.preserveRecent) {
    parseDuration(policy.guardrails.preserveRecent);
  }

  // Validate pool overrides
  for (const override of policy.poolOverrides) {
    if (override.thresholds) {
      for (let i = 0; i < override.thresholds.length - 1; i++) {
        const current = override.thresholds[i]!;
        const next = override.thresholds[i + 1]!;
        
        if (current.maxEntries !== null && next.maxEntries !== null) {
          if (current.maxEntries >= next.maxEntries) {
            throw new Error(`Pool override ${override.poolId}: thresholds must have ascending maxEntries`);
          }
        }
        
        if (current.maxEntries === null && next.maxEntries !== null) {
          throw new Error(`Pool override ${override.poolId}: thresholds with maxEntries=null must be last`);
        }
      }

      for (const threshold of override.thresholds) {
        parseDuration(threshold.interval);
      }
    }

    if (override.guardrails?.preserveRecent) {
      parseDuration(override.guardrails.preserveRecent);
    }
  }
}

/**
 * Load and parse a curation policy from a YAML file.
 */
export async function loadCurationPolicy(path: string): Promise<CurationPolicy> {
  const content = await readFile(path, "utf-8");
  const raw = parseYaml(content);
  const policy = CurationPolicy.parse(raw);
  validatePolicy(policy);
  return policy;
}

/**
 * Get effective thresholds for a specific pool (applying overrides).
 */
export function getPoolThresholds(
  policy: CurationPolicy,
  poolId: string
): CurationThreshold[] {
  const override = policy.poolOverrides.find(o => o.poolId === poolId);
  if (override?.disabled) {
    return [];
  }
  const thresholds = override?.thresholds ?? policy.thresholds;
  return normalizeThresholds(thresholds);
}

/**
 * Get effective guardrails for a specific pool (merging global + override).
 */
export function getPoolGuardrails(
  policy: CurationPolicy,
  poolId: string
): CurationGuardrails {
  const override = policy.poolOverrides.find(o => o.poolId === poolId);
  if (!override?.guardrails) {
    return policy.guardrails;
  }

  // Merge: override values take precedence, but preserve tags are concatenated
  return {
    preserveTags: [
      ...policy.guardrails.preserveTags,
      ...(override.guardrails.preserveTags ?? []),
    ],
    preserveRecent: override.guardrails.preserveRecent ?? policy.guardrails.preserveRecent,
    minEntries: override.guardrails.minEntries ?? policy.guardrails.minEntries,
    maxDeletePerRun: override.guardrails.maxDeletePerRun ?? policy.guardrails.maxDeletePerRun,
  };
}
