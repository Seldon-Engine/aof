/**
 * Deterministic Scheduler — scans tasks and dispatches work.
 *
 * Phase 0: dry-run mode only (logs what it would do, no mutations).
 * No LLM calls. Filesystem I/O only.
 */

import { FilesystemTaskStore } from "../store/task-store.js";
import type { ITaskStore } from "../store/interfaces.js";
import { EventLogger } from "../events/logger.js";
import { createLogger } from "../logging/index.js";
import { acquireLease, expireLeases, releaseLease } from "../store/lease.js";
import { checkStaleHeartbeats, markRunArtifactExpired, readRunResult } from "../recovery/run-artifacts.js";
import { resolveCompletionTransitions } from "../protocol/completion-utils.js";
import { SLAChecker } from "./sla-checker.js";
import { join, relative } from "node:path";
import { orgChartPath as orgChartPathFn, projectManifestPath } from "../config/paths.js";
import { readFile, access } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { GatewayAdapter, TaskContext } from "./executor.js";
import type { Task, TaskStatus } from "../schemas/task.js";
import type { SchedulerConfig, SchedulerAction } from "./types.js";
import { ProjectManifest } from "../schemas/project.js";
import { evaluateMurmurTriggers } from "./murmur-integration.js";
import { loadOrgChart } from "../org/loader.js";
import { checkThrottle, updateThrottleState, resetThrottleState as resetThrottleStateInternal } from "./throttle.js";
import { isLeaseActive, startLeaseRenewal, stopLeaseRenewal, cleanupLeaseRenewals } from "./lease-manager.js";
import { checkHopTimeouts } from "./escalation.js";
import { buildDispatchActions } from "./task-dispatcher.js";
import { checkPromotionEligibility } from "./promotion.js";
import { executeActions } from "./action-executor.js";
import { buildTaskStats, buildChildrenMap, checkExpiredLeases, buildResourceOccupancyMap, checkBacklogPromotion, checkBlockedTaskRecovery } from "./scheduler-helpers.js";
import { dispatchDAGHop } from "./dag-transition-handler.js";
import { retryPendingDeliveries } from "./callback-delivery.js";
import { SubscriptionStore } from "../store/subscription-store.js";

// Re-export types from types.ts for backward compatibility
export type { SchedulerConfig, SchedulerAction } from "./types.js";

export interface PollResult {
  scannedAt: string;
  durationMs: number;
  dryRun: boolean;
  actions: SchedulerAction[];
  stats: {
    total: number;
    backlog: number;
    ready: number;
    inProgress: number;
    blocked: number;
    review: number;
    done: number;
    cancelled: number;
    deadletter: number;
  };
}

const log = createLogger("scheduler");

/**
 * Effective concurrency limit — auto-detected from OpenClaw platform limit.
 * Starts null, set to min(platformLimit, config.maxConcurrentDispatches) when detected.
 */
let effectiveConcurrencyLimit: number | null = null;

/** Reset throttle state (for testing). */
export function resetThrottleState(): void {
  resetThrottleStateInternal();
}


/**
 * Run one scheduler poll cycle.
 *
 * In dry-run mode, returns planned actions without executing them.
 * In active mode, executes the actions (Phase 1+).
 */
export async function poll(
  store: ITaskStore,
  logger: EventLogger,
  config: SchedulerConfig,
  metrics?: import("../metrics/exporter.js").AOFMetrics,
): Promise<PollResult> {
  const start = performance.now();
  const actions: SchedulerAction[] = [];

  // 1. List all tasks
  const allTasks = await store.list();
  cleanupLeaseRenewals(store, allTasks);

  const childrenByParent = buildChildrenMap(allTasks);
  const stats = buildTaskStats(allTasks);

  // 3. Check for expired leases (BUG-AUDIT-001: check both in-progress AND blocked)
  const expiredLeaseActions = checkExpiredLeases(allTasks);
  actions.push(...expiredLeaseActions);

  // 3.5. Build resource occupancy map (TASK-054: resource serialization)
  const occupiedResources = buildResourceOccupancyMap(allTasks);
  const inProgressTasks = allTasks.filter(t => t.frontmatter.status === "in-progress");

  // 3.6. Check for stale heartbeats (P2.3 resume protocol)
  const heartbeatTtl = config.heartbeatTtlMs ?? 300_000; // 5min default
  const staleHeartbeats = await checkStaleHeartbeats(store, heartbeatTtl);
  
  for (const heartbeat of staleHeartbeats) {
    const task = allTasks.find(t => t.frontmatter.id === heartbeat.taskId);
    if (!task) continue;

    actions.push({
      type: "stale_heartbeat",
      taskId: heartbeat.taskId,
      taskTitle: task.frontmatter.title,
      agent: heartbeat.agentId,
      reason: `Heartbeat expired at ${heartbeat.expiresAt} (no update from ${heartbeat.agentId})`,
    });
  }

  const blockedBySubtasks = new Set<string>();
  for (const [parentId, children] of childrenByParent) {
    const hasIncomplete = children.some(child => child.frontmatter.status !== "done");
    if (hasIncomplete) blockedBySubtasks.add(parentId);
  }

  // 3.7. TASK-055: Build dependency graph and check for circular dependencies
  // AOF-cq1: O(n + e) — single-pass DFS with O(1) map lookup instead of O(n²) per-node restarts
  const circularDeps = new Set<string>();
  const taskMap = new Map(allTasks.map(t => [t.frontmatter.id, t]));

  // globalVisited: nodes whose entire subgraph has been explored — shared across all start nodes
  // so each node is visited at most once across the whole loop.
  const globalVisited = new Set<string>();

  function detectCircularDeps(taskId: string, stack: Set<string>): void {
    if (stack.has(taskId)) {
      // Cycle detected — mark every member of the cycle
      const stackArr = Array.from(stack);
      const cycleStart = stackArr.indexOf(taskId);
      const cycle = stackArr.slice(cycleStart).concat(taskId);
      log.error({ cycle }, "circular dependency detected");
      for (const id of cycle) circularDeps.add(id);
      return;
    }

    if (globalVisited.has(taskId)) {
      return; // Already fully explored — no cycle reachable from here
    }

    globalVisited.add(taskId);
    stack.add(taskId);

    const task = taskMap.get(taskId); // O(1) lookup
    if (task) {
      for (const depId of task.frontmatter.dependsOn) {
        detectCircularDeps(depId, stack);
      }
    }

    stack.delete(taskId);
  }

  // Single-pass DFS — O(n + e) total across all tasks
  for (const task of allTasks) {
    if (!globalVisited.has(task.frontmatter.id)) {
      detectCircularDeps(task.frontmatter.id, new Set<string>());
    }
  }

  // 3.8. Check for SLA violations (AOF-ae6: SLA scheduler integration)
  const slaChecker = config.slaChecker ?? new SLAChecker();
  let projectManifest: Record<string, unknown> = {};
  const projectYamlPath = projectManifestPath(config.dataDir);
  try {
    const projectYamlContent = await readFile(projectYamlPath, "utf-8");
    projectManifest = parseYaml(projectYamlContent) ?? {};
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn({ err, op: "parseProjectYaml", path: projectYamlPath }, "failed to parse project.yaml");
    }
  }
  const slaViolations = slaChecker.checkViolations(allTasks, projectManifest);
  
  for (const violation of slaViolations) {
    const shouldAlert = slaChecker.shouldAlert(violation.taskId);
    const durationHrs = (violation.duration / 3600000).toFixed(1);
    const limitHrs = (violation.limit / 3600000).toFixed(1);
    
    actions.push({
      type: "sla_violation",
      taskId: violation.taskId,
      taskTitle: violation.title,
      agent: violation.agent,
      reason: shouldAlert
        ? `SLA violation: ${durationHrs}h in-progress (limit: ${limitHrs}h) — alert will be sent`
        : `SLA violation: ${durationHrs}h in-progress (limit: ${limitHrs}h) — alert rate-limited`,
      duration: violation.duration,
      limit: violation.limit,
    });
  }

  // 3.9. Check for DAG hop timeouts (Phase 13: hop timeout + escalation)
  const hopTimeoutActions = await checkHopTimeouts(store, logger, config, metrics);
  actions.push(...hopTimeoutActions);

  // 3.1. Check for backlog tasks that can be promoted
  const promotionActions = checkBacklogPromotion(allTasks, childrenByParent, checkPromotionEligibility);
  actions.push(...promotionActions);

  // 4. Check for ready tasks that can be assigned (AOF-8s8: extracted to task-dispatcher.ts)
  const readyTasks = allTasks.filter(t => t.frontmatter.status === "ready");
  const dispatchActions = await buildDispatchActions(
    readyTasks,
    allTasks,
    store,
    config,
    {
      currentInProgress: stats.inProgress,
      blockedBySubtasks,
      circularDeps,
      occupiedResources,
      inProgressTasks,
    },
    effectiveConcurrencyLimit,
    childrenByParent
  );
  actions.push(...dispatchActions);

  // 5. Check for blocked tasks that might be unblocked
  const recoveryActions = checkBlockedTaskRecovery(allTasks, childrenByParent, config.maxDispatchRetries);
  actions.push(...recoveryActions);
  // 6. Execute actions (only in active mode)
  const effectiveConcurrencyLimitRef = { value: effectiveConcurrencyLimit };
  const executionStats = await executeActions(
    actions,
    allTasks,
    store,
    logger,
    config,
    effectiveConcurrencyLimitRef,
    metrics
  );
  
  const actionsExecuted = executionStats.actionsExecuted;
  const actionsFailed = executionStats.actionsFailed;
  const leasesExpired = executionStats.leasesExpired;
  const tasksRequeued = executionStats.tasksRequeued;
  const tasksPromoted = executionStats.tasksPromoted;
  effectiveConcurrencyLimit = executionStats.updatedConcurrencyLimit;

  // 6.5. DAG hop dispatch: check in-progress DAG tasks for ready hops
  if (!config.dryRun && config.executor) {
    const inProgressDAGTasks = allTasks.filter(
      t => t.frontmatter.status === "in-progress" && t.frontmatter.workflow
    );

    for (const dagTask of inProgressDAGTasks) {
      const state = dagTask.frontmatter.workflow!.state;
      // One hop at a time invariant: skip if any hop is already dispatched
      const hasDispatched = Object.values(state.hops).some(
        h => h.status === "dispatched"
      );
      if (hasDispatched) continue;

      // Find first ready hop
      const readyHopId = Object.entries(state.hops)
        .find(([, h]) => h.status === "ready")
        ?.[0];

      if (readyHopId) {
        try {
          // Re-read task for fresh state (handleSessionEnd may have updated it)
          const freshTask = await store.get(dagTask.frontmatter.id);
          if (!freshTask || !freshTask.frontmatter.workflow) continue;

          // Check again after fresh read
          const freshHasDispatched = Object.values(
            freshTask.frontmatter.workflow.state.hops
          ).some(h => h.status === "dispatched");
          if (freshHasDispatched) continue;

          const dispatched = await dispatchDAGHop(
            store, logger, config, config.executor, freshTask, readyHopId
          );

          if (dispatched) {
            actions.push({
              type: "assign" as const,
              taskId: dagTask.frontmatter.id,
              taskTitle: dagTask.frontmatter.title,
              agent: dagTask.frontmatter.workflow!.definition.hops.find(
                h => h.id === readyHopId
              )?.role ?? "unknown",
              reason: `DAG hop dispatch: ${readyHopId}`,
            });
          }
        } catch (err) {
          log.error({ err, taskId: dagTask.frontmatter.id, hopId: readyHopId, op: "dagHopDispatch" }, "DAG hop dispatch failed");
        }
      }
    }
  }

  // 6.6. Callback delivery retry scan (Phase 30)
  if (!config.dryRun && config.executor) {
    const tasksDir = store.tasksDir;
    const taskDirResolver = async (tid: string): Promise<string> => {
      const t = await store.get(tid);
      if (!t) throw new Error(`Task not found: ${tid}`);
      return join(tasksDir, t.frontmatter.status, tid);
    };
    const subscriptionStore = new SubscriptionStore(taskDirResolver);

    const terminalTasks = allTasks.filter(t =>
      ["done", "cancelled", "deadletter"].includes(t.frontmatter.status)
    );

    for (const task of terminalTasks) {
      try {
        await retryPendingDeliveries({
          taskId: task.frontmatter.id,
          store,
          subscriptionStore,
          executor: config.executor,
          logger,
        });
      } catch (err) {
        log.warn({ err, taskId: task.frontmatter.id, op: "retryPendingDeliveries" }, "callback delivery retry failed (best-effort)");
      }
    }
  }

  // 7. Recalculate stats after actions (reflect post-execution state)
  if (!config.dryRun && actionsExecuted > 0) {
    const updatedTasks = await store.list();
    stats.total = updatedTasks.length;
    stats.backlog = 0;
    stats.ready = 0;
    stats.inProgress = 0;
    stats.blocked = 0;
    stats.review = 0;
    stats.done = 0;
    stats.cancelled = 0;
    stats.deadletter = 0;

    for (const task of updatedTasks) {
      const s = task.frontmatter.status;
      if (s === "backlog") stats.backlog++;
      else if (s === "ready") stats.ready++;
      else if (s === "in-progress") stats.inProgress++;
      else if (s === "blocked") stats.blocked++;
      else if (s === "review") stats.review++;
      else if (s === "done") stats.done++;
      else if (s === "cancelled") stats.cancelled++;
      else if (s === "deadletter") stats.deadletter++;
    }
  }

  // 8. Log the poll with comprehensive metadata
  // BUG-TELEMETRY-001: Count alert actions separately
  const alertActions = actions.filter(a => a.type === "alert");
  const assignActions = actions.filter(a => a.type === "assign");
  
  const pollPayload: Record<string, unknown> = {
    dryRun: config.dryRun,
    tasksEvaluated: allTasks.length,
    tasksReady: readyTasks.length,
    actionsPlanned: actions.length,
    actionsExecuted: config.dryRun ? 0 : actionsExecuted,
    actionsFailed: config.dryRun ? 0 : actionsFailed,
    alertsRaised: alertActions.length,  // BUG-TELEMETRY-001: Include alert count
    leasesExpired: config.dryRun ? 0 : leasesExpired,  // BUG-AUDIT-004: Lease expiry count
    tasksRequeued: config.dryRun ? 0 : tasksRequeued,  // BUG-AUDIT-004: Requeue count
    tasksPromoted: config.dryRun ? 0 : tasksPromoted,  // TASK-2026-02-14: Promotion count
    stats,
  };

  // BUG-TELEMETRY-001: Improved reason mapping
  if (actionsExecuted === 0 && actions.length === 0) {
    if (allTasks.length === 0) {
      pollPayload.reason = "no_tasks";
    } else if (readyTasks.length === 0) {
      pollPayload.reason = "no_ready_tasks";
    } else {
      pollPayload.reason = "no_executable_actions";
    }
  } else if (actionsExecuted === 0 && actions.length > 0) {
    if (config.dryRun) {
      pollPayload.reason = "dry_run_mode";
    } else if (alertActions.length > 0 && assignActions.length === 0) {
      // BUG-TELEMETRY-001: Only alerts, no executable actions
      pollPayload.reason = "alert_only";
    } else if (!config.executor) {
      pollPayload.reason = "no_executor";
    } else if (actionsFailed > 0) {
      // BUG-TELEMETRY-001: Actions were attempted but failed
      pollPayload.reason = "action_failed";
    } else {
      // Fallback: should not normally reach here
      pollPayload.reason = "execution_failed";
    }
  }

  try {
    await logger.logSchedulerPoll(pollPayload);
  } catch (err) {
    log.warn({ err, op: "logSchedulerPoll" }, "event logger poll write failed (best-effort)");
  }

  // BUG-004 fix: Add gateway log visibility for scheduler activity
  if (config.dryRun) {
    log.info({ dryRun: true, ready: stats.ready, actionsPlanned: actions.length }, "scheduler poll complete");
  } else {
    log.info({ ready: stats.ready, actionsExecuted, actionsFailed }, "scheduler poll complete");
  }

  // Log warnings for common issues
  if (!config.dryRun && actions.length > 0 && actionsExecuted === 0) {
    if (!config.executor) {
      log.error({ actionsPlanned: actions.length, op: "dispatch" }, "scheduler cannot dispatch: executor is undefined");
    } else if (actionsFailed > 0) {
      log.error({ actionsFailed, op: "dispatch" }, "scheduler dispatch failures (check events.jsonl)");
    }
  }

  // BUG-003: Task progression telemetry and alerting
  if (!config.dryRun && stats.total > 0) {
    // Alert when all non-done tasks are blocked
    const activeTasks = stats.total - stats.done - stats.cancelled - stats.deadletter;
    if (activeTasks > 0 && stats.blocked === activeTasks) {
      log.error({ blocked: stats.blocked }, "ALERT: all active tasks are blocked, manual intervention required");
    }

    // Alert when many tasks are blocked
    const blockedThreshold = 5;
    if (stats.blocked >= blockedThreshold) {
      // Find oldest blocked task
      let oldestBlockedAge = 0;
      const blockedTasks = allTasks.filter(t => t.frontmatter.status === "blocked");
      let oldestBlockedId = "";
      for (const task of blockedTasks) {
        const lastBlockedAt = task.frontmatter.metadata?.lastBlockedAt as string | undefined;
        if (lastBlockedAt) {
          const age = Date.now() - new Date(lastBlockedAt).getTime();
          if (age > oldestBlockedAge) {
            oldestBlockedAge = age;
            oldestBlockedId = task.frontmatter.id;
          }
        }
      }

      const ageMinutes = Math.round(oldestBlockedAge / 1000 / 60);
      log.warn({ blocked: stats.blocked, oldestBlockedId, ageMinutes }, "many tasks blocked, investigate dispatch failures or dependencies");
    }

    // Alert when no successful dispatches in active mode
    if (actionsExecuted === 0 && stats.ready > 0 && actionsFailed > 0) {
      log.error({ ready: stats.ready, actionsFailed }, "ALERT: no successful dispatches this poll, check gateway credentials");
    }
  }

  // 9. AOF-yea: Murmur orchestration review evaluation
  // Runs after normal dispatch cycle to evaluate triggers and create review tasks
  try {
    // Load org chart to get team configurations
    const orgPath = orgChartPathFn(config.dataDir);
    let orgChartExists = true;
    try {
      await access(orgPath);
    } catch {
      orgChartExists = false;
    }

    if (orgChartExists) {
      const orgChartResult = await loadOrgChart(orgPath);
      
      if (orgChartResult.success && orgChartResult.chart) {
        const teams = orgChartResult.chart.teams ?? [];
        
        // Evaluate murmur triggers for teams with orchestrator config
        const murmurResult = await evaluateMurmurTriggers(teams, {
          store,
          logger,
          executor: config.executor,
          dryRun: config.dryRun,
          defaultLeaseTtlMs: config.defaultLeaseTtlMs,
          spawnTimeoutMs: config.spawnTimeoutMs ?? 30_000,
          maxConcurrentDispatches: effectiveConcurrencyLimit ?? config.maxConcurrentDispatches ?? 3,
          currentInProgress: stats.inProgress,
        });
        
        // Log murmur evaluation results
        if (murmurResult.teamsEvaluated > 0) {
          try {
            await logger.log("murmur.poll", "scheduler", {
              taskId: undefined,
              payload: {
                teamsEvaluated: murmurResult.teamsEvaluated,
                reviewsTriggered: murmurResult.reviewsTriggered,
                reviewsDispatched: murmurResult.reviewsDispatched,
                reviewsFailed: murmurResult.reviewsFailed,
                reviewsSkipped: murmurResult.reviewsSkipped,
              },
            });
          } catch (err) {
            log.warn({ err, op: "logMurmurPoll" }, "event logger murmur poll write failed (best-effort)");
          }
        }
      }
    }
  } catch (error) {
    log.error({ err: error, op: "murmurEvaluation" }, "murmur evaluation failed");
    try {
      await logger.log("murmur.evaluation.failed", "scheduler", {
        taskId: undefined,
        payload: {
          error: (error as Error).message,
        },
      });
    } catch (err) {
      log.warn({ err, op: "logMurmurEvalFailed" }, "event logger write failed (best-effort)");
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - start),
    dryRun: config.dryRun,
    actions,
    stats,
  };
}
