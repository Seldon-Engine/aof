/**
 * Trace capture helper — safe wrapper around captureTrace.
 *
 * Provides captureTraceSafely() which guards on sessionId+agentId presence,
 * reads the debug flag from task metadata, and swallows+logs any errors.
 * Single canonical trace capture function (REF-05).
 */

import { createLogger } from "../logging/index.js";
import { captureTrace } from "../trace/trace-writer.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import type { Task } from "../schemas/task.js";

const log = createLogger("trace-helpers");

/** Parameters for captureTraceSafely. */
export interface TraceCaptureParams {
  taskId: string;
  sessionId?: string;
  agentId?: string;
  durationMs: number;
  store: ITaskStore;
  logger: EventLogger;
  /** Current task object — used to read debug flag from frontmatter.metadata.debug */
  currentTask?: Task;
}

/**
 * Safely capture a trace for a completed agent session.
 *
 * - Guards: skips (no-op) when sessionId or agentId is missing.
 * - Reads debug flag from currentTask.frontmatter.metadata.debug.
 * - Swallows all errors and logs at warn level — never throws.
 */
export async function captureTraceSafely(params: TraceCaptureParams): Promise<void> {
  const { taskId, sessionId, agentId, durationMs, store, logger, currentTask } = params;

  if (!sessionId || !agentId) {
    return;
  }

  try {
    const debug = currentTask?.frontmatter.metadata?.debug === true;
    await captureTrace({
      taskId,
      sessionId,
      agentId,
      durationMs,
      store,
      logger,
      debug,
    });
  } catch (err) {
    log.warn({ err, taskId, op: "traceCapture" }, "trace capture failed (best-effort)");
  }
}
