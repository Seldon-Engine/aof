/**
 * Trace writer -- captures structured trace data from agent sessions.
 *
 * Orchestrates: session parsing, no-op detection, trace file writing,
 * and event emission. Best-effort: never throws, never blocks transitions.
 *
 * Trace files are written to state/runs/<taskId>/trace-N.json where N
 * is the attempt number (1-based, accumulating across retries).
 */

import { readdir, mkdir, access, constants } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import writeFileAtomic from "write-file-atomic";
import { parseSession } from "./session-parser.js";
import { detectNoop } from "./noop-detector.js";
import type { TraceSchema as TraceSchemaType } from "../schemas/trace.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";

/** Options for captureTrace(). */
export interface CaptureTraceOptions {
  taskId: string;
  sessionId: string;
  agentId: string;
  durationMs: number;
  store: ITaskStore;
  logger: EventLogger;
  debug: boolean;
}

/** Result of captureTrace(). */
export interface CaptureTraceResult {
  success: boolean;
  noopDetected: boolean;
  tracePath?: string;
  error?: string;
}

/** Maximum trace file size in bytes (1MB). */
const MAX_TRACE_BYTES = 1_000_000;

/**
 * Capture a trace from a completed agent session.
 *
 * Best-effort: on any error, emits trace.capture_failed and returns
 * { success: false } -- never throws.
 */
export async function captureTrace(
  opts: CaptureTraceOptions,
): Promise<CaptureTraceResult> {
  try {
    // 1. Resolve session file path
    const normalizedAgent = opts.agentId.replace(/^agent:/, "");
    const sessionFilePath = join(
      homedir(),
      ".openclaw",
      "agents",
      normalizedAgent,
      "sessions",
      `${opts.sessionId}.jsonl`,
    );

    // 2. Check if session file exists
    try {
      await access(sessionFilePath, constants.R_OK);
    } catch {
      // Session file missing -- emit failure event, return error
      try {
        await opts.logger.log("trace.capture_failed", "scheduler", {
          taskId: opts.taskId,
          payload: { error: "Session file not found", sessionId: opts.sessionId },
        });
      } catch {
        // Even logging is best-effort
      }
      return {
        success: false,
        noopDetected: false,
        error: "Session file not found",
      };
    }

    // 3. Parse session
    const parsed = await parseSession(sessionFilePath, { debug: opts.debug });

    // 4. Detect no-op
    const noopResult = detectNoop({
      toolCallCount: parsed.toolCallCount,
      sessionMissing: false, // We already verified file exists above
    });

    // 5. Determine attempt number
    const taskDir = join(opts.store.projectRoot, "state", "runs", opts.taskId);
    let attemptNumber = 1;
    try {
      const entries = await readdir(taskDir);
      const traceFiles = entries.filter(
        (f) => /^trace-\d+\.json$/.test(f),
      );
      attemptNumber = traceFiles.length + 1;
    } catch {
      // Directory doesn't exist yet -- attempt 1
    }

    // 6. Build trace object
    const mode = opts.debug ? "debug" : "summary";
    const trace: TraceSchemaType = {
      version: 1,
      taskId: opts.taskId,
      sessionId: opts.sessionId,
      attemptNumber,
      capturedAt: new Date().toISOString(),
      session: {
        sessionFilePath,
        durationMs: opts.durationMs,
        model: parsed.model,
        provider: parsed.provider,
        thinkingLevel: parsed.thinkingLevel,
      },
      toolCalls: parsed.toolCalls,
      toolCallCount: parsed.toolCallCount,
      reasoning: parsed.reasoning,
      noopDetected: noopResult.noopDetected,
      meta: {
        mode,
        unknownEntries: parsed.unknownEntries,
        parseErrors: parsed.parseErrors,
        truncated: false,
        totalEntriesParsed: parsed.totalEntriesParsed,
      },
    };

    // 7. 1MB cap (debug mode only)
    let serialized = JSON.stringify(trace, null, 2);
    if (opts.debug && Buffer.byteLength(serialized) > MAX_TRACE_BYTES) {
      // Truncate tool outputs from the end until under cap
      for (let i = trace.toolCalls.length - 1; i >= 0; i--) {
        if (trace.toolCalls[i].output !== undefined) {
          trace.toolCalls[i].output = "";
          trace.meta.truncated = true;
          serialized = JSON.stringify(trace, null, 2);
          if (Buffer.byteLength(serialized) <= MAX_TRACE_BYTES) break;
        }
      }
    }

    // 8. Write trace file
    await mkdir(taskDir, { recursive: true });
    const tracePath = join(taskDir, `trace-${attemptNumber}.json`);
    await writeFileAtomic(tracePath, serialized);

    // 9. Emit events (best-effort)
    try {
      await opts.logger.log("trace.captured", "scheduler", {
        taskId: opts.taskId,
        payload: {
          attemptNumber,
          toolCallCount: parsed.toolCallCount,
          mode,
          tracePath,
        },
      });

      if (noopResult.noopDetected) {
        await opts.logger.log("completion.noop_detected", "scheduler", {
          taskId: opts.taskId,
          payload: {
            sessionId: opts.sessionId,
            toolCallCount: 0,
          },
        });
      }
    } catch {
      // Event logging is best-effort -- don't fail the trace capture
    }

    // 10. Return result
    return {
      success: true,
      noopDetected: noopResult.noopDetected,
      tracePath,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Try to emit failure event (also best-effort)
    try {
      await opts.logger.log("trace.capture_failed", "scheduler", {
        taskId: opts.taskId,
        payload: { error: message },
      });
    } catch {
      // Even failure logging is best-effort
    }

    return {
      success: false,
      noopDetected: false,
      error: message,
    };
  }
}
