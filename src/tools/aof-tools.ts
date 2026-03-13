/**
 * AOF Tools — Re-export hub for all AOF tool modules.
 * 
 * This file acts as a thin orchestrator, re-exporting tools from domain-specific modules:
 * - project-tools.ts: Task creation/dispatch
 * - query-tools.ts: Read-only queries and reports
 * - task-tools.ts: Task manipulation (update, complete, cancel, deps, block)
 */

// Re-export ToolContext from types.ts for backward compatibility
export type { ToolContext } from "./types.js";

// Project tools (task creation/dispatch)
export type { AOFDispatchInput, AOFDispatchResult } from "./project-tools.js";
export { aofDispatch } from "./project-tools.js";

// Query tools (read-only)
export type { AOFStatusReportInput, AOFStatusReportResult } from "./query-tools.js";
export { aofStatusReport } from "./query-tools.js";

// Task tools (mutations)
export type {
  AOFTaskUpdateInput,
  AOFTaskUpdateResult,
  AOFTaskCompleteInput,
  AOFTaskCompleteResult,
  AOFTaskEditInput,
  AOFTaskEditResult,
  AOFTaskCancelInput,
  AOFTaskCancelResult,
  AOFTaskDepAddInput,
  AOFTaskDepAddResult,
  AOFTaskDepRemoveInput,
  AOFTaskDepRemoveResult,
  AOFTaskBlockInput,
  AOFTaskBlockResult,
  AOFTaskUnblockInput,
  AOFTaskUnblockResult,
} from "./task-tools.js";

export {
  aofTaskUpdate,
  aofTaskComplete,
  aofTaskEdit,
  aofTaskCancel,
  aofTaskDepAdd,
  aofTaskDepRemove,
  aofTaskBlock,
  aofTaskUnblock,
} from "./task-tools.js";

// Shared tool registry (consumed by both MCP and OpenClaw adapters)
export { toolRegistry, type ToolDefinition, type ToolRegistry } from "./tool-registry.js";
