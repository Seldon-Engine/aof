/**
 * DAG hop timeout escalation logic.
 *
 * Scans in-progress DAG tasks for hop timeout violations,
 * following the pattern: scan -> detect timeout -> escalate or alert.
 */

import { randomUUID } from "node:crypto";
import type { Task } from "../schemas/task.js";
import type { ITaskStore } from "../store/interfaces.js";
import { serializeTask } from "../store/task-store.js";
import { EventLogger } from "../events/logger.js";
import { createLogger } from "../logging/index.js";
import writeFileAtomic from "write-file-atomic";
import { parseDuration } from "./duration-parser.js";
import type { TaskContext } from "./executor.js";
import { buildHopContext } from "./dag-context-builder.js";

// Import types from scheduler to avoid duplication
export type { SchedulerConfig, SchedulerAction } from "./scheduler.js";
import type { SchedulerConfig, SchedulerAction } from "./scheduler.js";

const log = createLogger("escalation");

// ---------------------------------------------------------------------------
// DAG Hop Timeout Checking
// ---------------------------------------------------------------------------

/**
 * Escalate a single timed-out DAG hop.
 *
 * Handles three scenarios:
 * 1. hop.escalated=true (one-shot) -> alert only, no re-escalation
 * 2. No escalateTo configured -> alert only, no state change
 * 3. escalateTo configured -> force-complete, re-dispatch to escalateTo role
 *
 * On spawn failure after force-complete, sets hop to "ready" with escalated=true
 * so the standard poll cycle can retry dispatch.
 *
 * @internal Not exported — called by checkHopTimeouts.
 */
async function escalateHopTimeout(
  task: Task,
  hopId: string,
  hop: { role: string; timeout?: string; escalateTo?: string },
  elapsedMs: number,
  store: ITaskStore,
  logger: EventLogger,
  config: SchedulerConfig,
  metrics?: import("../metrics/exporter.js").AOFMetrics,
): Promise<SchedulerAction> {
  const workflow = task.frontmatter.workflow!;
  const hopState = workflow.state.hops[hopId]!;
  const escalateToRole = hop.escalateTo;

  // One-shot rule: already escalated — alert only, no re-escalation
  if (hopState.escalated) {
    try {
      await logger.log("dag.hop_timeout", "scheduler", {
        taskId: task.frontmatter.id,
        payload: {
          hopId,
          elapsed: elapsedMs,
          timeout: hop.timeout,
          escalated: true,
          reason: "already escalated (one-shot rule)",
        },
      });
    } catch (err) {
      log.warn({ err, taskId: task.frontmatter.id, op: "eventLog" }, "event logger write failed (best-effort)");
    }

    return {
      type: "alert",
      taskId: task.frontmatter.id,
      taskTitle: task.frontmatter.title,
      reason: `Hop ${hopId} timeout (${Math.floor(elapsedMs / 1000)}s), already escalated (one-shot), no re-escalation`,
    };
  }

  // No escalateTo configured — alert only, no state change
  if (!escalateToRole) {
    try {
      await logger.log("dag.hop_timeout", "scheduler", {
        taskId: task.frontmatter.id,
        payload: {
          hopId,
          elapsed: elapsedMs,
          timeout: hop.timeout,
          reason: "no escalation configured",
        },
      });
    } catch (err) {
      log.warn({ err, taskId: task.frontmatter.id, op: "eventLog" }, "event logger write failed (best-effort)");
    }

    return {
      type: "alert",
      taskId: task.frontmatter.id,
      taskTitle: task.frontmatter.title,
      reason: `Hop ${hopId} timeout (${Math.floor(elapsedMs / 1000)}s), no escalation configured`,
    };
  }

  // Dry-run mode — return alert but do not mutate state
  if (config.dryRun) {
    return {
      type: "alert",
      taskId: task.frontmatter.id,
      taskTitle: task.frontmatter.title,
      agent: escalateToRole,
      reason: `Hop ${hopId} timeout (dry-run), would escalate from ${hop.role} to ${escalateToRole}`,
    };
  }

  // --- Active escalation path ---

  // 1. Force-complete the original session (if executor + correlationId available)
  if (config.executor && hopState.correlationId) {
    try {
      await config.executor.forceCompleteSession(hopState.correlationId);
    } catch (err) {
      log.warn({ err, taskId: task.frontmatter.id, hopId, op: "forceCompleteSession" }, "force-complete failed, continuing with escalation");
    }
  }

  // 2. Build context and spawn new session with escalateTo role
  if (config.executor) {
    const hopContext = buildHopContext(task, hopId);
    const correlationId = randomUUID();
    const context: TaskContext = {
      taskId: task.frontmatter.id,
      taskPath: task.path!,
      agent: escalateToRole,
      priority: task.frontmatter.priority,
      routing: { role: escalateToRole },
      projectId: task.frontmatter.project,
      hopContext: { ...hopContext, role: escalateToRole },
    };

    const spawnResult = await config.executor.spawnSession(context, {
      timeoutMs: config.spawnTimeoutMs ?? 30_000,
      correlationId,
    });

    if (spawnResult.success) {
      // Success: update hop state to dispatched with new agent
      workflow.state.hops[hopId] = {
        ...hopState,
        status: "dispatched",
        agent: escalateToRole,
        startedAt: new Date().toISOString(),
        correlationId: spawnResult.sessionId,
        escalated: true,
      };
    } else {
      // Spawn failure: set hop to "ready" with escalated=true for retry
      workflow.state.hops[hopId] = {
        ...hopState,
        status: "ready",
        agent: escalateToRole,
        startedAt: undefined,
        correlationId: undefined,
        escalated: true,
      };
    }
  } else {
    // No executor: set hop to "ready" with escalated=true for retry
    workflow.state.hops[hopId] = {
      ...hopState,
      status: "ready",
      agent: escalateToRole,
      startedAt: undefined,
      correlationId: undefined,
      escalated: true,
    };
  }

  // 3. Persist workflow state atomically
  task.frontmatter.updatedAt = new Date().toISOString();
  await writeFileAtomic(task.path!, serializeTask(task));

  // 4. Log escalation event
  try {
    await logger.log("dag.hop_timeout_escalation", "scheduler", {
      taskId: task.frontmatter.id,
      payload: {
        hopId,
        fromRole: hop.role,
        toRole: escalateToRole,
        elapsed: elapsedMs,
        timeout: hop.timeout,
      },
    });
  } catch (err) {
    log.warn({ err, taskId: task.frontmatter.id, op: "eventLog" }, "event logger write failed (best-effort)");
  }

  return {
    type: "alert",
    taskId: task.frontmatter.id,
    taskTitle: task.frontmatter.title,
    agent: escalateToRole,
    reason: `Hop ${hopId} timeout, escalated from ${hop.role} to ${escalateToRole}`,
  };
}

/**
 * Check for DAG tasks with dispatched hops exceeding their configured timeout.
 *
 * Scans all in-progress tasks with DAG workflows. For each dispatched hop
 * with a timeout configured, compares elapsed time against the timeout.
 * Timed-out hops get escalated via escalateHopTimeout.
 *
 * Mirrors the checkGateTimeouts pattern for the DAG path.
 *
 * @param store - Task store
 * @param logger - Event logger
 * @param config - Scheduler config
 * @param metrics - Optional metrics instance
 * @returns Array of scheduler actions (alerts for timeouts)
 */
export async function checkHopTimeouts(
  store: ITaskStore,
  logger: EventLogger,
  config: SchedulerConfig,
  metrics?: import("../metrics/exporter.js").AOFMetrics,
): Promise<SchedulerAction[]> {
  const actions: SchedulerAction[] = [];
  const now = Date.now();

  // Scan all in-progress tasks
  const tasks = await store.list({ status: "in-progress" });

  for (const task of tasks) {
    // Skip tasks without DAG workflow
    const workflow = task.frontmatter.workflow;
    if (!workflow) continue;

    const { definition, state } = workflow;

    // Iterate hops in the DAG
    for (const hop of definition.hops) {
      const hopState = state.hops[hop.id];
      if (!hopState) continue;

      // Only check dispatched hops
      if (hopState.status !== "dispatched") continue;

      // Skip if no timeout configured on this hop
      if (!hop.timeout) continue;

      // Skip if no startedAt (defensive — can't calculate elapsed)
      if (!hopState.startedAt) continue;

      // Parse timeout duration
      const timeoutMs = parseDuration(hop.timeout);
      if (!timeoutMs) {
        log.warn({ hopId: hop.id, timeout: hop.timeout, taskId: task.frontmatter.id, op: "parseTimeout" }, "invalid timeout format for hop");
        continue;
      }

      // Calculate elapsed time
      const startedAt = new Date(hopState.startedAt).getTime();
      const elapsed = now - startedAt;

      // Check if timeout exceeded
      if (elapsed > timeoutMs) {
        const action = await escalateHopTimeout(
          task,
          hop.id,
          hop,
          elapsed,
          store,
          logger,
          config,
          metrics,
        );
        actions.push(action);
      }
    }
  }

  return actions;
}
