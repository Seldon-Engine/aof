/**
 * Task Dispatcher — handles ready task dispatch execution.
 * 
 * Extracted from scheduler.ts (AOF-8s8) to reduce file size and improve modularity.
 * 
 * Responsibilities:
 * - Iterate ready tasks and check dispatch eligibility (deps, leases, throttles)
 * - Build assign/alert actions for eligible tasks
 * - Execute assign actions (lease acquisition, executor.spawn, lease renewal)
 * - Handle dispatch failures and retry logic
 */

import type { Task, TaskStatus } from "../schemas/task.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import type { DispatchExecutor, TaskContext } from "./executor.js";
import { acquireLease, releaseLease } from "../store/lease.js";
import { isLeaseActive, startLeaseRenewal } from "./lease-manager.js";
import { checkThrottle, updateThrottleState } from "./throttle.js";
import { serializeTask } from "../store/task-store.js";
import { buildGateContext } from "./gate-context-builder.js";
import { join, relative } from "node:path";
import writeFileAtomic from "write-file-atomic";

export interface DispatchConfig {
  dryRun: boolean;
  defaultLeaseTtlMs: number;
  spawnTimeoutMs?: number;
  executor?: DispatchExecutor;
  maxConcurrentDispatches?: number;
  minDispatchIntervalMs?: number;
  maxDispatchesPerPoll?: number;
}

export interface SchedulerAction {
  type: "expire_lease" | "assign" | "requeue" | "block" | "deadletter" | "alert" | "stale_heartbeat" | "sla_violation" | "promote";
  taskId: string;
  taskTitle: string;
  agent?: string;
  reason: string;
  fromStatus?: TaskStatus;
  toStatus?: TaskStatus;
  duration?: number;
  limit?: number;
}

export interface DispatchMetrics {
  currentInProgress: number;
  pendingDispatches: number;
  blockedBySubtasks: Set<string>;
  circularDeps: Set<string>;
  occupiedResources: Map<string, string>;
  effectiveConcurrencyLimit: number | null;
}

export interface DispatchResult {
  actions: SchedulerAction[];
  actionsExecuted: number;
  actionsFailed: number;
}

// Placeholder for future extraction
// TODO: Extract dispatch logic from scheduler.ts
