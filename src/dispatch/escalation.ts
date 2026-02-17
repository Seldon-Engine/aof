/**
 * Gate timeout escalation logic.
 */

import type { Task } from "../schemas/task.js";
import type { ITaskStore } from "../store/interfaces.js";
import { serializeTask } from "../store/task-store.js";
import { EventLogger } from "../events/logger.js";
import type { WorkflowConfig } from "../schemas/workflow.js";
import { ProjectManifest } from "../schemas/project.js";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import writeFileAtomic from "write-file-atomic";
import { parseDuration } from "./duration-parser.js";

// Import types from scheduler to avoid duplication
export type { SchedulerConfig, SchedulerAction } from "./scheduler.js";
import type { SchedulerConfig, SchedulerAction } from "./scheduler.js";

/**
 * Load project manifest from project.yaml file.
 * Internal helper for gate timeout checking.
 */
async function loadProjectManifest(
  store: ITaskStore,
  projectId: string
): Promise<ProjectManifest | null> {
  try {
    const projectPath = join(store.projectRoot, "projects", projectId, "project.yaml");
    const content = await readFile(projectPath, "utf-8");
    const manifest = parseYaml(content) as ProjectManifest;
    return manifest;
  } catch {
    return null;
  }
}

/**
 * Escalate a task that has exceeded its gate timeout.
 */
export async function escalateGateTimeout(
  task: Task,
  gate: { id: string; role: string; timeout?: string; escalateTo?: string },
  workflow: WorkflowConfig,
  elapsedMs: number,
  store: ITaskStore,
  logger: EventLogger,
  config: SchedulerConfig,
  metrics?: import("../metrics/exporter.js").AOFMetrics
): Promise<SchedulerAction> {
  const escalateToRole = gate.escalateTo;
  
  if (!escalateToRole) {
    // No escalation target - just log and emit metric
    console.warn(
      `[AOF] Gate timeout: task ${task.frontmatter.id} exceeded ${gate.timeout} at gate ${gate.id}, no escalation configured`
    );
    
    try {
      await logger.log("gate_timeout", "scheduler", {
        taskId: task.frontmatter.id,
        payload: {
          gate: gate.id,
          elapsed: elapsedMs,
          timeout: gate.timeout,
        },
      });
      
      // Record timeout metric
      if (metrics) {
        const project = task.frontmatter.project ?? store.projectId;
        metrics.recordGateTimeout(project, workflow.name, gate.id);
      }
    } catch {
      // Logging errors should not crash the scheduler
    }
    
    return {
      type: "alert",
      taskId: task.frontmatter.id,
      taskTitle: task.frontmatter.title,
      reason: `Gate ${gate.id} timeout (${Math.floor(elapsedMs / 1000)}s), no escalation configured`,
    };
  }
  
  // Don't mutate in dry-run mode
  if (!config.dryRun) {
    // Update task routing to escalation role
    task.frontmatter.routing.role = escalateToRole;
    task.frontmatter.updatedAt = new Date().toISOString();
    
    // Add note to gate history
    const historyEntry = {
      gate: gate.id,
      role: gate.role,
      entered: task.frontmatter.gate!.entered,
      exited: new Date().toISOString(),
      outcome: "blocked" as const,
      summary: `Timeout exceeded (${Math.floor(elapsedMs / 1000)}s), escalated to ${escalateToRole}`,
      blockers: [`Timeout: no response from ${gate.role} within ${gate.timeout}`],
      duration: Math.floor(elapsedMs / 1000),
    };
    
    task.frontmatter.gateHistory = [
      ...(task.frontmatter.gateHistory ?? []),
      historyEntry,
    ];
    
    // Update task
    const serialized = serializeTask(task);
    const taskPath = task.path ?? join(store.tasksDir, task.frontmatter.status, `${task.frontmatter.id}.md`);
    await writeFileAtomic(taskPath, serialized);
    
    // Log event
    try {
      await logger.log("gate_timeout_escalation", "scheduler", {
        taskId: task.frontmatter.id,
        payload: {
          gate: gate.id,
          fromRole: gate.role,
          toRole: escalateToRole,
          elapsed: elapsedMs,
          timeout: gate.timeout,
        },
      });
      
      // Record timeout and escalation metrics
      if (metrics) {
        const project = task.frontmatter.project ?? store.projectId;
        metrics.recordGateTimeout(project, workflow.name, gate.id);
        metrics.recordGateEscalation(project, workflow.name, gate.id, escalateToRole);
      }
    } catch {
      // Logging errors should not crash the scheduler
    }
  }
  
  return {
    type: "alert",
    taskId: task.frontmatter.id,
    taskTitle: task.frontmatter.title,
    agent: escalateToRole,
    reason: `Gate ${gate.id} timeout, escalated from ${gate.role} to ${escalateToRole}`,
  };
}

/**
 * Check for tasks exceeding gate timeouts and escalate.
 * 
 * Scans all in-progress tasks for gate workflow violations.
 * Returns scheduler actions for any timeouts detected.
 * 
 * @param store - Task store
 * @param logger - Event logger
 * @param config - Scheduler config
 * @param metrics - Optional metrics instance
 * @returns Array of scheduler actions (alerts for timeouts)
 */
export async function checkGateTimeouts(
  store: ITaskStore,
  logger: EventLogger,
  config: SchedulerConfig,
  metrics?: import("../metrics/exporter.js").AOFMetrics
): Promise<SchedulerAction[]> {
  const actions: SchedulerAction[] = [];
  const now = Date.now();
  
  // Scan all in-progress tasks
  const tasks = await store.list({ status: "in-progress" });
  
  for (const task of tasks) {
    // Skip tasks not in gate workflow
    if (!task.frontmatter.gate) continue;
    
    // Load project workflow
    const projectId = task.frontmatter.project;
    if (!projectId) continue;
    
    const projectManifest = await loadProjectManifest(store, projectId);
    if (!projectManifest?.workflow) continue;
    
    const workflow = projectManifest.workflow;
    const currentGate = workflow.gates.find(g => g.id === task.frontmatter.gate?.current);
    if (!currentGate) continue;
    
    // Check if gate has timeout configured
    if (!currentGate.timeout) continue;
    
    // Parse timeout duration
    const timeoutMs = parseDuration(currentGate.timeout);
    if (!timeoutMs) {
      console.warn(
        `[AOF] Invalid timeout format for gate ${currentGate.id}: ${currentGate.timeout}`
      );
      continue;
    }
    
    // Check if task has exceeded timeout
    const entered = new Date(task.frontmatter.gate.entered).getTime();
    const elapsed = now - entered;
    
    if (elapsed > timeoutMs) {
      // Timeout exceeded - escalate
      const action = await escalateGateTimeout(
        task,
        currentGate,
        workflow,
        elapsed,
        store,
        logger,
        config,
        metrics
      );
      actions.push(action);
    }
  }
  
  return actions;
}
