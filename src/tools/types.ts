/**
 * Shared type definitions for the tools subsystem.
 *
 * Extracted from aof-tools.ts to break circular dependencies between
 * the barrel file and tool sub-modules that it re-exports.
 */

import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";

/**
 * Shared context passed to every AOF tool function, providing access to
 * the task store, event logger, and optional project scope.
 */
export interface ToolContext {
  /** The task store used for all CRUD and state-transition operations. */
  store: ITaskStore;
  /** Event logger for recording audit events and triggering notifications. */
  logger: EventLogger;
  /** Project ID for scoping operations; auto-populated from the active task's project. */
  projectId?: string;
  /** Path to the org chart file; used for subscriber validation in subscription tools. */
  orgChartPath?: string;
}
