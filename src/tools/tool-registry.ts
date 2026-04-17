/**
 * Shared tool registry — single source of truth for all AOF tools.
 *
 * Both MCP and OpenClaw adapters consume this registry to register tools,
 * eliminating duplicated schemas and handler logic. Adding a new tool means
 * defining it here; both adapters pick it up automatically.
 */

import { z } from "zod";
import type { ToolContext } from "./types.js";

// Domain module imports — schemas
import { dispatchSchema } from "./project-tools.js";
import { taskUpdateSchema, taskEditSchema, taskCancelSchema } from "./task-crud-tools.js";
import {
  taskCompleteSchema,
  taskDepAddSchema,
  taskDepRemoveSchema,
  taskBlockSchema,
  taskUnblockSchema,
} from "./task-workflow-tools.js";
import { statusReportSchema } from "./query-tools.js";
import { contextLoadSchema } from "./context-tools.js";

// Domain module imports — handlers
import { aofDispatch } from "./project-tools.js";
import { aofTaskUpdate, aofTaskEdit, aofTaskCancel } from "./task-crud-tools.js";
import {
  aofTaskComplete,
  aofTaskDepAdd,
  aofTaskDepRemove,
  aofTaskBlock,
  aofTaskUnblock,
} from "./task-workflow-tools.js";
import { aofStatusReport } from "./query-tools.js";
import { aofContextLoad } from "./context-tools.js";
import {
  taskSubscribeInputSchema,
  taskUnsubscribeInputSchema,
  aofTaskSubscribe,
  aofTaskUnsubscribe,
} from "./subscription-tools.js";
import {
  projectCreateSchema,
  projectListSchema,
  projectAddParticipantSchema,
  aofProjectCreate,
  aofProjectList,
  aofProjectAddParticipant,
} from "./project-management-tools.js";

/**
 * A tool definition that pairs a Zod schema with a framework-agnostic handler.
 * Handlers receive a ToolContext (store + logger) and parsed input, returning plain results.
 */
export interface ToolDefinition<TSchema extends z.ZodType = z.ZodType> {
  description: string;
  schema: TSchema;
  handler: (ctx: ToolContext, input: z.infer<TSchema>) => Promise<unknown>;
}

export type ToolRegistry = Record<string, ToolDefinition>;

/**
 * The shared tool registry consumed by both MCP and OpenClaw adapters.
 */
export const toolRegistry: ToolRegistry = {
  aof_dispatch: {
    description: "Create a new AOF task and assign to an agent or team. Returns taskId, status, and filePath.",
    schema: dispatchSchema,
    handler: async (ctx, input) => aofDispatch(ctx, input),
  },

  aof_task_update: {
    description: "Update an AOF task's status/body/work log; use for progress notes, blockers, or outputs on the task card.",
    schema: taskUpdateSchema,
    handler: async (ctx, input) => aofTaskUpdate(ctx, input),
  },

  aof_task_complete: {
    description: "Mark a task as complete through the lifecycle completion path.",
    schema: taskCompleteSchema,
    handler: async (ctx, input) => aofTaskComplete(ctx, input),
  },

  aof_status_report: {
    description: "Summarize AOF tasks by status/agent; use to check your queue or team workload without scanning task files.",
    schema: statusReportSchema,
    handler: async (ctx, input) => aofStatusReport(ctx, input),
  },

  aof_task_edit: {
    description: "Edit task frontmatter (title, priority, routing) without changing status.",
    schema: taskEditSchema,
    handler: async (ctx, input) => aofTaskEdit(ctx, input),
  },

  aof_task_cancel: {
    description: "Cancel a task with optional reason. Moves task to cancelled status.",
    schema: taskCancelSchema,
    handler: async (ctx, input) => aofTaskCancel(ctx, input),
  },

  aof_task_dep_add: {
    description: "Add a dependency -- task will be blocked until blocker completes.",
    schema: taskDepAddSchema,
    handler: async (ctx, input) => aofTaskDepAdd(ctx, input),
  },

  aof_task_dep_remove: {
    description: "Remove a dependency from a task.",
    schema: taskDepRemoveSchema,
    handler: async (ctx, input) => aofTaskDepRemove(ctx, input),
  },

  aof_task_block: {
    description: "Block a task with a reason, preventing dispatch until unblocked.",
    schema: taskBlockSchema,
    handler: async (ctx, input) => aofTaskBlock(ctx, input),
  },

  aof_task_unblock: {
    description: "Unblock a previously blocked task, moving it back to ready.",
    schema: taskUnblockSchema,
    handler: async (ctx, input) => aofTaskUnblock(ctx, input),
  },

  aof_context_load: {
    description: "Load a skill's context on demand for lazy context injection.",
    schema: contextLoadSchema,
    handler: async (ctx, input) => {
      // Context load requires registry and skillsDir which come from the adapter context,
      // not the base ToolContext. The adapter wraps this to provide those extras.
      // The handler here provides the base signature for the registry.
      return aofContextLoad({
        skillName: input.skillName,
        registry: (ctx as any)._contextRegistry,
        skillsDir: (ctx as any)._skillsDir,
      });
    },
  },

  aof_task_subscribe: {
    description: "Subscribe to task outcome notifications",
    schema: taskSubscribeInputSchema,
    handler: async (ctx, input) => aofTaskSubscribe(ctx, input),
  },

  aof_task_unsubscribe: {
    description: "Cancel a task outcome subscription",
    schema: taskUnsubscribeInputSchema,
    handler: async (ctx, input) => aofTaskUnsubscribe(ctx, input),
  },

  aof_project_create: {
    description: "Create a new project with standard directory structure and manifest.",
    schema: projectCreateSchema,
    handler: async (ctx, input) => aofProjectCreate(ctx, input),
  },

  aof_project_list: {
    description: "List all projects on this AOF instance.",
    schema: projectListSchema,
    handler: async (ctx, input) => aofProjectList(ctx, input),
  },

  aof_project_add_participant: {
    description: "Add an agent to a project's participant list.",
    schema: projectAddParticipantSchema,
    handler: async (ctx, input) => aofProjectAddParticipant(ctx, input),
  },
};
