/**
 * Lease Manager — manages task lease lifecycle (acquisition, renewal, cleanup).
 *
 * Extracted from scheduler.ts to maintain focused module size.
 */

import { renewLease } from "../store/lease.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { Task } from "../schemas/task.js";

/** Maximum number of lease renewals before auto-expiry. */
export const LEASE_RENEWAL_MAX = 20;

/** Active lease renewal timers, keyed by `projectId:taskId`. */
const leaseRenewalTimers = new Map<string, NodeJS.Timeout>();

/**
 * Check if a lease is currently active (not expired).
 */
export function isLeaseActive(lease?: Task["frontmatter"]["lease"]): boolean {
  if (!lease) return false;
  const expiresAt = new Date(lease.expiresAt).getTime();
  return expiresAt > Date.now();
}

/**
 * Generate a unique key for lease renewal tracking.
 */
function leaseRenewalKey(store: ITaskStore, taskId: string): string {
  return `${store.projectId}:${taskId}`;
}

/**
 * Stop lease renewal for a specific task.
 */
export function stopLeaseRenewal(store: ITaskStore, taskId: string): void {
  const key = leaseRenewalKey(store, taskId);
  const timer = leaseRenewalTimers.get(key);
  if (!timer) return;
  clearInterval(timer);
  leaseRenewalTimers.delete(key);
}

/**
 * Start automatic lease renewal for a task.
 * Renews at half the TTL interval to ensure lease stays active.
 */
export function startLeaseRenewal(
  store: ITaskStore,
  taskId: string,
  agentId: string,
  leaseTtlMs: number,
): void {
  const key = leaseRenewalKey(store, taskId);
  if (leaseRenewalTimers.has(key)) return;

  const intervalMs = Math.max(1, Math.floor(leaseTtlMs / 2));
  const timer = setInterval(() => {
    void renewLease(store, taskId, agentId, {
      ttlMs: leaseTtlMs,
      maxRenewals: LEASE_RENEWAL_MAX,
    }).catch(() => {
      stopLeaseRenewal(store, taskId);
    });
  }, intervalMs);

  timer.unref?.();
  leaseRenewalTimers.set(key, timer);
}

/**
 * Clean up stale lease renewal timers.
 * Removes timers for tasks that are no longer in-progress or have expired leases.
 */
export function cleanupLeaseRenewals(store: ITaskStore, tasks: Task[]): void {
  const active = new Set<string>();
  for (const task of tasks) {
    if (task.frontmatter.status !== "in-progress") continue;
    const lease = task.frontmatter.lease;
    if (!lease || !lease.agent) continue;
    if (!isLeaseActive(lease)) continue;
    active.add(leaseRenewalKey(store, task.frontmatter.id));
  }

  const prefix = `${store.projectId}:`;
  for (const key of leaseRenewalTimers.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (active.has(key)) continue;
    const taskId = key.slice(prefix.length);
    stopLeaseRenewal(store, taskId);
  }
}
