/**
 * Shared types for action handler modules.
 *
 * Each handler returns an ActionHandlerResult so the orchestrator
 * (action-executor.ts) can track stats consistently.
 */

export interface ActionHandlerResult {
  /** true only for "assign" actions (counts toward actionsExecuted) */
  executed: boolean;
  /** true if handler encountered a fatal error */
  failed: boolean;
  leasesExpired?: number;
  tasksRequeued?: number;
  tasksPromoted?: number;
}
