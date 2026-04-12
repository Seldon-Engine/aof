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

import type { Task } from "../schemas/task.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import { createLogger } from "../logging/index.js";
import type { DispatchConfig, SchedulerAction } from "./types.js";
import { isLeaseActive } from "./lease-manager.js";
import { checkThrottle, updateThrottleState } from "./throttle.js";
import { loadOrgChart } from "../org/loader.js";
import { orgChartPath } from "../config/paths.js";

export { executeAssignAction, loadProjectManifest } from "./assign-executor.js";
import { loadProjectManifest } from "./assign-executor.js";

const log = createLogger("task-dispatcher");

// Re-export types from types.ts for backward compatibility
export type { DispatchConfig, SchedulerAction } from "./types.js";

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

/**
 * Load project manifest from disk.
 */
export async function buildDispatchActions(
  readyTasks: Task[],
  allTasks: Task[],
  store: ITaskStore,
  config: DispatchConfig,
  metrics: {
    currentInProgress: number;
    blockedBySubtasks: Set<string>;
    circularDeps: Set<string>;
    occupiedResources: Map<string, string>;
    inProgressTasks: Task[];
  },
  effectiveConcurrencyLimit: number | null,
  childrenByParent: Map<string, Task[]>
): Promise<SchedulerAction[]> {
  const actions: SchedulerAction[] = [];
  
  const maxDispatches = effectiveConcurrencyLimit ?? config.maxConcurrentDispatches ?? 3;
  const currentInProgress = metrics.currentInProgress;
  let pendingDispatches = 0;
  
  // AOF-adf: Load org chart for per-team throttling
  let orgChart: Awaited<ReturnType<typeof loadOrgChart>> | null = null;
  try {
    const result = await loadOrgChart(orgChartPath(config.dataDir));
    if (result.success) {
      orgChart = result;
    }
  } catch (err) {
    log.warn({ err, op: "loadOrgChart" }, "org chart load failed, continuing without per-team overrides");
  }
  
  // AOF-adf: Build team configuration map
  const teamConfigMap = new Map<string, { maxConcurrent?: number; minIntervalMs?: number }>();
  if (orgChart?.chart?.teams) {
    for (const team of orgChart.chart.teams) {
      if (team.dispatch) {
        teamConfigMap.set(team.id, {
          maxConcurrent: team.dispatch.maxConcurrent,
          minIntervalMs: team.dispatch.minIntervalMs,
        });
      }
    }
  }
  
  // AOF-adf: Track in-progress tasks by team
  const inProgressByTeam = new Map<string, number>();
  for (const task of metrics.inProgressTasks) {
    const team = task.frontmatter.routing.team;
    if (team) {
      inProgressByTeam.set(team, (inProgressByTeam.get(team) ?? 0) + 1);
    }
  }
  
  // AOF-adf: Throttle config with defaults (conservative - opt-in)
  const minDispatchIntervalMs = config.minDispatchIntervalMs ?? 0; // 0 = disabled
  const maxDispatchesPerPoll = config.maxDispatchesPerPoll ?? 10; // 10 = effectively disabled
  let dispatchesThisPoll = 0;
  
  // Log concurrency status
  log.info({ currentInProgress, maxDispatches, platformAdjusted: effectiveConcurrencyLimit !== null }, "concurrency limit status");
  
  for (const task of readyTasks) {
    if (metrics.blockedBySubtasks.has(task.frontmatter.id)) continue;
    
    // TASK-055: Check for circular dependencies - block if detected
    if (metrics.circularDeps.has(task.frontmatter.id)) {
      actions.push({
        type: "block",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        reason: "Circular dependency detected",
        fromStatus: task.frontmatter.status,
      });
      continue;
    }
    
    // TASK-055: Dependency gating - check if all dependencies are done
    const deps = task.frontmatter.dependsOn;
    if (deps.length > 0) {
      const unresolvedDeps: string[] = [];
      
      for (const depId of deps) {
        const dep = allTasks.find(t => t.frontmatter.id === depId);
        if (!dep) {
          unresolvedDeps.push(depId);
        } else if (dep.frontmatter.status !== "done") {
          unresolvedDeps.push(depId);
        }
      }
      
      if (unresolvedDeps.length > 0) {
        log.warn({ taskId: task.frontmatter.id, unresolvedDeps, op: "dependencyGate" }, "dependency gate: skipping task");
        continue;
      }
    }
    
    if (isLeaseActive(task.frontmatter.lease)) {
      const lease = task.frontmatter.lease;
      log.warn({ taskId: task.frontmatter.id, leaseAgent: lease?.agent, leaseExpiresAt: lease?.expiresAt, op: "dispatchDedup" }, "dispatch dedup: skipping task (active lease)");
      continue;
    }

    // TASK-054: Resource serialization - skip if resource is occupied
    const resource = task.frontmatter.resource;
    if (resource && metrics.occupiedResources.has(resource)) {
      const occupyingTaskId = metrics.occupiedResources.get(resource)!;
      log.warn({ taskId: task.frontmatter.id, resource, occupyingTaskId, op: "resourceLock" }, "resource lock: skipping task");
      continue;
    }
    
    // AOF-adf: Throttle checks
    const routing = task.frontmatter.routing;
    const team = routing.team;
    
    // Get team config
    const teamConfig = team && teamConfigMap.has(team) ? teamConfigMap.get(team)! : undefined;
    const teamInProgress = team ? (inProgressByTeam.get(team) ?? 0) : undefined;
    
    const throttleCheck = checkThrottle({
      taskId: task.frontmatter.id,
      team,
      currentInProgress,
      pendingDispatches,
      maxDispatches,
      teamInProgress,
      teamMaxConcurrent: teamConfig?.maxConcurrent,
      minDispatchIntervalMs: minDispatchIntervalMs > 0 ? minDispatchIntervalMs : undefined,
      teamMinIntervalMs: teamConfig?.minIntervalMs,
      dispatchesThisPoll,
      maxDispatchesPerPoll,
    });
    
    if (!throttleCheck.allowed) {
      log.info({ taskId: task.frontmatter.id, reason: throttleCheck.reason, op: "throttle" }, "dispatch throttled");
      // If global interval not elapsed, throttle ALL remaining tasks in this poll
      if (throttleCheck.reason?.includes("global interval")) {
        break;
      }
      continue;
    }
    
    // Resolve routing target to a concrete agent ID.
    // If routing.agent or routing.team matches a team ID in the org chart,
    // resolve to the team's lead/orchestrator so the gateway spawns a real agent.
    let targetAgent = routing.agent ?? routing.role ?? routing.team;
    if (targetAgent && orgChart?.chart?.teams) {
      const matchedTeam = orgChart.chart.teams.find((t: { id: string }) => t.id === targetAgent);
      if (matchedTeam) {
        const resolved = (matchedTeam as { orchestrator?: string; lead?: string }).orchestrator
          ?? (matchedTeam as { lead?: string }).lead;
        if (resolved) {
          log.info({ taskId: task.frontmatter.id, from: targetAgent, to: resolved, op: "team-resolve" },
            "resolved team routing to lead");
          targetAgent = resolved;
        }
      }
    }

    // PROJ-03: Check project participant list before assigning
    const projectId = task.frontmatter.project;
    if (projectId && targetAgent) {
      const manifest = await loadProjectManifest(store, projectId);
      if (manifest?.participants && manifest.participants.length > 0) {
        if (!manifest.participants.includes(targetAgent)) {
          actions.push({
            type: "alert",
            taskId: task.frontmatter.id,
            taskTitle: task.frontmatter.title,
            reason: `Agent "${targetAgent}" is not a participant in project "${projectId}". Participants: ${manifest.participants.join(", ")}`,
          });
          continue;
        }
      }
      // Empty participants list = unrestricted access (opt-in isolation per user decision)
    }

    if (targetAgent) {
      actions.push({
        type: "assign",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        agent: targetAgent,
        reason: `Pending task with routing target: ${targetAgent}`,
      });
      pendingDispatches++;
      dispatchesThisPoll++; // AOF-adf: Track dispatches this poll cycle

      // AOF-adf: Reserve team concurrency slot for this planned dispatch
      if (team && !config.dryRun) {
        inProgressByTeam.set(team, (inProgressByTeam.get(team) ?? 0) + 1);
      }
    } else if (routing.tags && routing.tags.length > 0) {
      // GAP-004 fix: Task has tags but no explicit agent/role/team
      // Log error and create alert action (tags-only routing not supported)
      log.error({ taskId: task.frontmatter.id, tags: routing.tags, op: "routing" }, "task has tags-only routing (not supported), needs explicit agent/role/team assignment");

      actions.push({
        type: "alert",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        reason: `Task has tags (${routing.tags.join(", ")}) but no routing target — needs explicit agent/role/team assignment`,
      });
    } else {
      actions.push({
        type: "alert",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        reason: "Pending task with no routing target — needs manual assignment",
      });
    }
  }

  // Block parents with incomplete subtasks
  for (const task of allTasks) {
    if (!metrics.blockedBySubtasks.has(task.frontmatter.id)) continue;
    if (task.frontmatter.status === "blocked" || task.frontmatter.status === "done") continue;

    actions.push({
      type: "block",
      taskId: task.frontmatter.id,
      taskTitle: task.frontmatter.title,
      reason: "Parent task has incomplete subtasks",
      fromStatus: task.frontmatter.status,
    });
  }

  return actions;
}
