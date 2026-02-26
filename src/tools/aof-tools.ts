/**
 * AOF Tools — Re-export hub for all AOF tool modules.
 * 
 * This file acts as a thin orchestrator, re-exporting tools from domain-specific modules:
 * - project-tools.ts: Task creation/dispatch
 * - query-tools.ts: Read-only queries and reports
 * - task-tools.ts: Task manipulation (update, complete, cancel, deps, block)
 */

import type { ITaskStore } from "../store/interfaces.js";
import { EventLogger } from "../events/logger.js";

export interface ToolContext {
  store: ITaskStore;
  logger: EventLogger;
  projectId?: string;  // Auto-populated from active task's project
}

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
