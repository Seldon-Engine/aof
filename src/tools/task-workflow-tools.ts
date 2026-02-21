/**
 * AOF task workflow tools — complete, dependencies, block/unblock operations.
 */

import type { ITaskStore } from "../store/interfaces.js";
import type { TaskStatus, Task } from "../schemas/task.js";
import { compactResponse, type ToolResponseEnvelope } from "./envelope.js";
import { handleGateTransition } from "../dispatch/gate-transition-handler.js";
import type { ToolContext } from "./aof-tools.js";

async function resolveTask(store: ITaskStore, taskId: string) {
  const task = await store.get(taskId);
  if (task) return task;
  const byPrefix = await store.getByPrefix(taskId);
  if (byPrefix) return byPrefix;
  throw new Error(`Task not found: ${taskId}`);
}

/**
 * Validate gate completion parameters with teaching error messages.
 * 
 * Progressive Disclosure Level 3 — when agents make mistakes, the error teaches
 * them the correct approach.
 */
async function validateGateCompletion(
  store: ITaskStore,
  task: Task,
  input: AOFTaskCompleteInput,
): Promise<void> {
  if (!task.frontmatter.gate) {
    throw new Error(
      `Task ${task.frontmatter.id} is not in a gate workflow.\n\n` +
      `This task doesn't require outcome/blockers parameters. Use:\n` +
      `  aofTaskComplete({ taskId: "${task.frontmatter.id}", summary: "..." })`
    );
  }

  if (!input.outcome) {
    throw new Error(
      `Task ${task.frontmatter.id} is in a gate workflow (current gate: "${task.frontmatter.gate.current}").\n\n` +
      `Gate tasks REQUIRE an 'outcome' parameter. Use:\n` +
      `  aofTaskComplete({\n` +
      `    taskId: "${task.frontmatter.id}",\n` +
      `    outcome: "complete" | "needs_review" | "blocked",\n` +
      `    summary: "..."\n` +
      `  })\n\n` +
      `Current gate: ${task.frontmatter.gate.current}`
    );
  }

  const validOutcomes: string[] = ["complete", "needs_review", "blocked"];
  if (!validOutcomes.includes(input.outcome)) {
    throw new Error(
      `Invalid outcome: "${input.outcome}".\n\n` +
      `Valid outcomes for gate workflows:\n` +
      `- "complete": Mark work done and advance to next gate\n` +
      `- "needs_review": Request changes (requires rejectionNotes)\n` +
      `- "blocked": Cannot proceed due to external dependency (requires blockers)\n\n` +
      `Use:\n` +
      `  aofTaskComplete({\n` +
      `    taskId: "${task.frontmatter.id}",\n` +
      `    outcome: "complete",\n` +
      `    summary: "..."\n` +
      `  })`
    );
  }

  // blocked → requires blockers
  if (input.outcome === "blocked" && (!input.blockers || input.blockers.length === 0)) {
    throw new Error(
      `Outcome "blocked" requires 'blockers'.\n\n` +
      `When blocking a task, list what's preventing progress.\n\n` +
      `Use:\n` +
      `  aofTaskComplete({\n` +
      `    taskId: "${task.frontmatter.id}",\n` +
      `    outcome: "blocked",\n` +
      `    blockers: ["Waiting for API key from platform team"],\n` +
      `    summary: "..."\n` +
      `  })`
    );
  }

  // needs_review → requires blockers
  if (input.outcome === "needs_review" && (!input.blockers || input.blockers.length === 0)) {
    throw new Error(
      `Outcome "needs_review" requires 'blockers' (specific issues to fix).\n\n` +
      `Specify what needs to be fixed before this can proceed.\n\n` +
      `Use:\n` +
      `  aofTaskComplete({\n` +
      `    taskId: "${task.frontmatter.id}",\n` +
      `    outcome: "needs_review",\n` +
      `    blockers: ["Missing error handling in auth flow"],\n` +
      `    summary: "Waiting on fixes"\n` +
      `  })`
    );
  }
}

// ===== TYPES =====

export interface AOFTaskCompleteInput {
  taskId: string;
  actor?: string;
  summary?: string;
  // Gate workflow fields (optional — only used when task is in a workflow)
  outcome?: import("../schemas/gate.js").GateOutcome;
  blockers?: string[];
  rejectionNotes?: string;
  /**
   * Declared role of the calling agent (e.g., "swe-architect", "swe-qa").
   *
   * When provided, the runtime validates this against the gate's required role
   * and rejects the transition if they don't match. This is the primary
   * mechanism that prevents, for example, a backend agent from approving the
   * code-review or qa gates.
   *
   * Production callers (agents in the SDLC pipeline) MUST supply this field.
   * Omitting it allows the transition without role validation (backwards-compat
   * only — do not rely on this in new code).
   */
  callerRole?: string;
}

export interface AOFTaskCompleteResult extends ToolResponseEnvelope {
  taskId: string;
  status: TaskStatus;
}

export interface AOFTaskDepAddInput {
  taskId: string;
  blockerId: string;
  actor?: string;
}

export interface AOFTaskDepAddResult extends ToolResponseEnvelope {
  taskId: string;
  blockerId: string;
  dependsOn: string[];
}

export interface AOFTaskDepRemoveInput {
  taskId: string;
  blockerId: string;
  actor?: string;
}

export interface AOFTaskDepRemoveResult extends ToolResponseEnvelope {
  taskId: string;
  blockerId: string;
  dependsOn: string[];
}

export interface AOFTaskBlockInput {
  taskId: string;
  reason: string;
  actor?: string;
}

export interface AOFTaskBlockResult extends ToolResponseEnvelope {
  taskId: string;
  status: TaskStatus;
  reason: string;
}

export interface AOFTaskUnblockInput {
  taskId: string;
  actor?: string;
}

export interface AOFTaskUnblockResult extends ToolResponseEnvelope {
  taskId: string;
  status: TaskStatus;
}

// ===== FUNCTIONS =====

export async function aofTaskComplete(
  ctx: ToolContext,
  input: AOFTaskCompleteInput,
): Promise<AOFTaskCompleteResult> {
  const actor = input.actor ?? "unknown";
  const task = await resolveTask(ctx.store, input.taskId);
  let updatedTask = task;

  // AC-3: Done-state lock — tasks already marked done cannot be re-completed.
  // Resurrection goes through a dedicated admin pathway, not task completion.
  if (task.frontmatter.status === "done") {
    throw new Error(
      `Task ${task.frontmatter.id} is already done and cannot be re-transitioned. ` +
      `If you need to re-open this task, contact an administrator.`
    );
  }

  // AC-2: Gate workflow tasks MUST use the gate path — no legacy bypass allowed.
  // Previously, a gate task called without `outcome` would fall through to the
  // legacy completion path and mark the task `done` without any gate validation.
  // Now we gate the legacy path behind `!task.frontmatter.gate`.
  if (task.frontmatter.gate) {
    // Gate task: always validate and use gate transition handler
    await validateGateCompletion(ctx.store, task, input);

    await handleGateTransition(
      ctx.store,
      ctx.logger,
      input.taskId,
      input.outcome!,  // validated above — will be defined
      {
        summary: input.summary ?? "Completed",
        blockers: input.blockers,
        rejectionNotes: input.rejectionNotes,
        agent: actor,
        callerRole: input.callerRole,
      }
    );

    // Reload task to get updated state
    const reloadedTask = await ctx.store.get(input.taskId);
    if (!reloadedTask) {
      throw new Error(`Task ${input.taskId} not found after gate transition`);
    }

    const summary = `Task ${input.taskId} transitioned through gate workflow`;
    const envelope = compactResponse(summary, {
      taskId: input.taskId,
      status: reloadedTask.frontmatter.status,
    });

    return {
      ...envelope,
      taskId: input.taskId,
      status: reloadedTask.frontmatter.status,
    };
  }

  // Legacy completion path (non-gate tasks only)
  if (input.summary) {
    const body = task.body ? `${task.body}\n\n## Completion Summary\n${input.summary}` : `## Completion Summary\n${input.summary}`;
    updatedTask = await ctx.store.updateBody(task.frontmatter.id, body);
  }

  if (updatedTask.frontmatter.status !== "done") {
    const from = updatedTask.frontmatter.status;
    
    // BUG-008: Enforce lifecycle consistency - tasks must pass through in-progress and review before done
    // Valid path: any → ready → in-progress → review → done
    
    // Step 1: Get to in-progress
    if (from !== "in-progress" && from !== "review") {
      // Special case: blocked can only go to ready first
      if (from === "blocked") {
        // blocked → ready
        updatedTask = await ctx.store.transition(updatedTask.frontmatter.id, "ready", {
          reason: "manual_completion_unblock",
          agent: actor,
        });
        await ctx.logger.logTransition(updatedTask.frontmatter.id, from, "ready", actor, 
          "Manual completion: unblocking task");
      }
      
      // Now transition to in-progress (from ready or backlog)
      const currentStatus = updatedTask.frontmatter.status;
      updatedTask = await ctx.store.transition(updatedTask.frontmatter.id, "in-progress", {
        reason: "manual_completion_lifecycle_guard",
        agent: actor,
      });
      await ctx.logger.logTransition(updatedTask.frontmatter.id, currentStatus, "in-progress", actor, 
        "Manual completion: enforcing lifecycle consistency");
    }
    
    // Step 2: Transition to review (if not already there)
    if (updatedTask.frontmatter.status === "in-progress") {
      updatedTask = await ctx.store.transition(updatedTask.frontmatter.id, "review", {
        reason: "manual_completion_review",
        agent: actor,
      });
      await ctx.logger.logTransition(updatedTask.frontmatter.id, "in-progress", "review", actor, 
        "Manual completion: moving to review");
    }
    
    // Step 3: Transition to done
    updatedTask = await ctx.store.transition(updatedTask.frontmatter.id, "done", {
      reason: "task_complete",
      agent: actor,
    });
    await ctx.logger.logTransition(updatedTask.frontmatter.id, "review", "done", actor, "task_complete");
  }

  await ctx.logger.log("task.completed", actor, { taskId: updatedTask.frontmatter.id });

  const summary = `Task ${updatedTask.frontmatter.id} completed successfully`;
  const envelope = compactResponse(summary, {
    taskId: updatedTask.frontmatter.id,
    status: updatedTask.frontmatter.status,
  });

  return {
    ...envelope,
    taskId: updatedTask.frontmatter.id,
    status: updatedTask.frontmatter.status,
  };
}

export async function aofTaskDepAdd(
  ctx: ToolContext,
  input: AOFTaskDepAddInput,
): Promise<AOFTaskDepAddResult> {
  const actor = input.actor ?? "unknown";
  
  // Validate both tasks exist
  const task = await resolveTask(ctx.store, input.taskId);
  const blocker = await resolveTask(ctx.store, input.blockerId);

  const updatedTask = await ctx.store.addDep(task.frontmatter.id, blocker.frontmatter.id);

  await ctx.logger.log("task.dep.added", actor, {
    taskId: updatedTask.frontmatter.id,
    payload: { blockerId: blocker.frontmatter.id },
  });

  const summary = `Task ${updatedTask.frontmatter.id} now depends on ${blocker.frontmatter.id}`;
  const envelope = compactResponse(summary, {
    taskId: updatedTask.frontmatter.id,
    blockerId: blocker.frontmatter.id,
  });

  return {
    ...envelope,
    taskId: updatedTask.frontmatter.id,
    blockerId: blocker.frontmatter.id,
    dependsOn: updatedTask.frontmatter.dependsOn ?? [],
  };
}

export async function aofTaskDepRemove(
  ctx: ToolContext,
  input: AOFTaskDepRemoveInput,
): Promise<AOFTaskDepRemoveResult> {
  const actor = input.actor ?? "unknown";
  
  // Validate both tasks exist
  const task = await resolveTask(ctx.store, input.taskId);
  const blocker = await resolveTask(ctx.store, input.blockerId);

  const updatedTask = await ctx.store.removeDep(task.frontmatter.id, blocker.frontmatter.id);

  await ctx.logger.log("task.dep.removed", actor, {
    taskId: updatedTask.frontmatter.id,
    payload: { blockerId: blocker.frontmatter.id },
  });

  const summary = `Task ${updatedTask.frontmatter.id} no longer depends on ${blocker.frontmatter.id}`;
  const envelope = compactResponse(summary, {
    taskId: updatedTask.frontmatter.id,
    blockerId: blocker.frontmatter.id,
  });

  return {
    ...envelope,
    taskId: updatedTask.frontmatter.id,
    blockerId: blocker.frontmatter.id,
    dependsOn: updatedTask.frontmatter.dependsOn ?? [],
  };
}

export async function aofTaskBlock(
  ctx: ToolContext,
  input: AOFTaskBlockInput,
): Promise<AOFTaskBlockResult> {
  const actor = input.actor ?? "unknown";
  const task = await resolveTask(ctx.store, input.taskId);

  if (!input.reason || input.reason.trim().length === 0) {
    throw new Error("Block reason is required. Provide a clear explanation of what's blocking progress.");
  }

  const blockedTask = await ctx.store.block(task.frontmatter.id, input.reason);

  await ctx.logger.log("task.blocked", actor, {
    taskId: blockedTask.frontmatter.id,
    payload: { reason: input.reason },
  });

  const summary = `Task ${blockedTask.frontmatter.id} blocked: ${input.reason}`;
  const envelope = compactResponse(summary, {
    taskId: blockedTask.frontmatter.id,
    status: blockedTask.frontmatter.status,
  });

  return {
    ...envelope,
    taskId: blockedTask.frontmatter.id,
    status: blockedTask.frontmatter.status,
    reason: input.reason,
  };
}

export async function aofTaskUnblock(
  ctx: ToolContext,
  input: AOFTaskUnblockInput,
): Promise<AOFTaskUnblockResult> {
  const actor = input.actor ?? "unknown";
  const task = await resolveTask(ctx.store, input.taskId);

  const unblockedTask = await ctx.store.unblock(task.frontmatter.id);

  await ctx.logger.log("task.unblocked", actor, {
    taskId: unblockedTask.frontmatter.id,
  });

  const summary = `Task ${unblockedTask.frontmatter.id} unblocked and moved to ready`;
  const envelope = compactResponse(summary, {
    taskId: unblockedTask.frontmatter.id,
    status: unblockedTask.frontmatter.status,
  });

  return {
    ...envelope,
    taskId: unblockedTask.frontmatter.id,
    status: unblockedTask.frontmatter.status,
  };
}
