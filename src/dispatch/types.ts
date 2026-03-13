/**
 * Shared type definitions for the dispatch subsystem.
 *
 * Extracted from scheduler.ts and task-dispatcher.ts to break circular
 * dependencies between handler modules and their parent orchestrators.
 */

import type { GatewayAdapter } from "./executor.js";
import type { SLAChecker } from "./sla-checker.js";
import type { TaskLockManager } from "../protocol/task-lock.js";
import type { TaskStatus } from "../schemas/task.js";

export interface SchedulerConfig {
  /** Root data directory. */
  dataDir: string;
  /** Dry-run mode: log decisions but don't mutate state. */
  dryRun: boolean;
  /** Default lease TTL in ms. */
  defaultLeaseTtlMs: number;
  /** Heartbeat TTL in ms (default 5min). */
  heartbeatTtlMs?: number;
  /** Executor for spawning agent sessions (optional — if absent, assign actions are logged only). */
  executor?: GatewayAdapter;
  /** Spawn timeout in ms (default 30s). */
  spawnTimeoutMs?: number;
  /** SLA checker instance (optional — created if not provided). */
  slaChecker?: SLAChecker;
  /** Maximum concurrent in-progress tasks across all agents (default: 3). */
  maxConcurrentDispatches?: number;
  /** Minimum interval between dispatches in milliseconds (default: 5000). */
  minDispatchIntervalMs?: number;
  /** Maximum dispatches per poll cycle (default: 2). */
  maxDispatchesPerPoll?: number;
  /**
   * When true, blocking a task cascades to its direct dependents in backlog/ready.
   * Default: false (opt-in — cascade-blocking can be heavy-handed in multi-parent scenarios).
   */
  cascadeBlocks?: boolean;
  /** Maximum dispatch retries before deadletter (default: 3). */
  maxDispatchRetries?: number;
  /** Maximum time for a single poll cycle in ms (default: 30_000). Consumed by AOFService. */
  pollTimeoutMs?: number;
  /** Maximum time for a single task action in ms (default: 10_000). */
  taskActionTimeoutMs?: number;
  /** Task lock manager for serializing per-task operations. Shared with ProtocolRouter. */
  lockManager?: TaskLockManager;
}

export interface SchedulerAction {
  type: "expire_lease" | "assign" | "requeue" | "block" | "deadletter" | "alert" | "stale_heartbeat" | "sla_violation" | "promote" | "murmur_create_task";
  taskId: string;
  taskTitle: string;
  agent?: string;
  reason: string;
  fromStatus?: TaskStatus;
  toStatus?: TaskStatus;  // For promote actions
  duration?: number;  // For SLA violations: actual duration
  limit?: number;     // For SLA violations: SLA limit
  sourceTaskId?: string;
  murmurCandidateId?: string;
  blockers?: string[];
}

export interface DispatchConfig {
  dataDir: string;
  dryRun: boolean;
  defaultLeaseTtlMs: number;
  spawnTimeoutMs?: number;
  executor?: GatewayAdapter;
  maxConcurrentDispatches?: number;
  minDispatchIntervalMs?: number;
  maxDispatchesPerPoll?: number;
  /** Task lock manager for serializing per-task operations. Shared with ProtocolRouter. */
  lockManager?: TaskLockManager;
}
