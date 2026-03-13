/**
 * Memory module barrel — pure re-exports only.
 *
 * All logic lives in dedicated sub-modules. This file must contain
 * no function definitions, only re-exports.
 */

export { registerMemoryModule, rebuildHnswFromDb } from "./register.js";
export { generateMemoryConfig, resolvePoolPath } from "./generator.js";
export { auditMemoryConfig, formatMemoryAuditReport } from "./audit.js";
export { getProjectMemoryStore, saveAllProjectMemory, clearProjectMemoryCache } from "./project-memory.js";
export type { ProjectMemoryStore } from "./project-memory.js";
export { ColdTier } from "./cold-tier.js";
export { WarmAggregator } from "./warm-aggregation.js";
export { HotPromotion } from "./hot-promotion.js";
export type {
  MemoryConfig,
  MemoryConfigOptions,
  MemoryConfigResult,
  AgentMemoryExplanation,
  PoolMatch,
} from "./generator.js";
export type { OpenClawConfig, MemoryAuditEntry, MemoryAuditReport } from "./audit.js";
export type { ColdTierOptions, IncidentReport } from "./cold-tier.js";
export type {
  AggregationRule,
  AggregationOptions,
  AggregationResult,
} from "./warm-aggregation.js";
export type { PromotionOptions, PromotionResult } from "./hot-promotion.js";
