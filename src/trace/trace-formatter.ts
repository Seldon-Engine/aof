/**
 * Trace formatter -- pure presentation functions for trace data.
 *
 * Three output modes:
 * - Summary: human-readable overview (model, duration, tool counts)
 * - Debug: full detail (tool inputs/outputs, reasoning text)
 * - JSON: machine-readable, pretty-printed JSON
 *
 * All functions are pure: typed data in, string out. No I/O.
 */

import type { TraceSchema as TraceSchemaType } from "../schemas/trace.js";

/** Maps traces to DAG workflow hops for grouped display. */
export interface HopInfo {
  hopId: string;
  role: string;
  /** Indices into the traces array that belong to this hop. */
  traceIndices: number[];
}

/**
 * Format duration in milliseconds to human-readable string.
 *
 * - 0ms -> "0s"
 * - 5000ms -> "5s"
 * - 65000ms -> "1m 5s"
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

/**
 * Build tool usage breakdown: counts per tool name.
 */
function toolUsageBreakdown(
  toolCalls: TraceSchemaType["toolCalls"],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tc of toolCalls) {
    counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1);
  }
  return counts;
}

/**
 * Format a single trace attempt in summary style.
 */
function formatAttemptSummary(trace: TraceSchemaType): string {
  const lines: string[] = [];
  const { session, meta } = trace;

  lines.push(`Attempt ${trace.attemptNumber} (trace-${trace.attemptNumber}.json)`);

  const modelStr = session.model ?? "unknown";
  const providerStr = session.provider ? ` (${session.provider})` : "";
  lines.push(`  Model: ${modelStr}${providerStr}`);
  lines.push(`  Duration: ${formatDuration(session.durationMs)}`);
  lines.push(`  Tool Calls: ${trace.toolCallCount}`);
  lines.push(`  No-op: ${trace.noopDetected ? "Yes" : "No"}`);
  lines.push(`  Mode: ${meta.mode}`);

  // Tool usage breakdown
  const usage = toolUsageBreakdown(trace.toolCalls);
  if (usage.size > 0) {
    lines.push("");
    lines.push("  Tools Used:");
    for (const [name, count] of usage) {
      lines.push(`    ${name}    x${count}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format a single trace attempt in debug style (summary + details).
 */
function formatAttemptDebug(trace: TraceSchemaType): string {
  const lines: string[] = [formatAttemptSummary(trace)];

  // Tool call details
  if (trace.toolCalls.length > 0) {
    lines.push("");
    lines.push("  Tool Call Details:");
    trace.toolCalls.forEach((tc, i) => {
      lines.push(`    ${i + 1}. ${tc.name}`);
      lines.push(`       Input: ${tc.input}`);
      lines.push(`       Output: ${tc.output ?? "(not captured)"}`);
    });
  }

  // Reasoning
  if (trace.reasoning && trace.reasoning.length > 0) {
    lines.push("");
    lines.push("  Reasoning:");
    for (const text of trace.reasoning) {
      lines.push(`    ${text}`);
    }
  }

  // Summary-mode warning
  if (trace.meta.mode === "summary") {
    lines.push("");
    lines.push(
      "  Trace captured in summary mode. Re-run task with debug=true for full details.",
    );
  }

  return lines.join("\n");
}

/**
 * Format traces in human-readable summary mode.
 *
 * @param taskId - Task identifier for the header
 * @param traces - Validated trace objects
 * @param hopMap - Optional DAG hop grouping
 */
export function formatTraceSummary(
  taskId: string,
  traces: TraceSchemaType[],
  hopMap?: HopInfo[],
): string {
  if (traces.length === 0) {
    return "No traces found.";
  }

  const lines: string[] = [`Trace: ${taskId}`, ""];

  if (hopMap) {
    for (const hop of hopMap) {
      lines.push(`Hop: ${hop.hopId} (role: ${hop.role})`);
      lines.push("");
      for (const idx of hop.traceIndices) {
        if (idx < traces.length) {
          lines.push(formatAttemptSummary(traces[idx]!));
          lines.push("");
        }
      }
    }
  } else {
    for (const trace of traces) {
      lines.push(formatAttemptSummary(trace));
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

/**
 * Format traces in debug mode (full detail).
 *
 * @param taskId - Task identifier for the header
 * @param traces - Validated trace objects
 * @param hopMap - Optional DAG hop grouping
 */
export function formatTraceDebug(
  taskId: string,
  traces: TraceSchemaType[],
  hopMap?: HopInfo[],
): string {
  if (traces.length === 0) {
    return "No traces found.";
  }

  const lines: string[] = [`Trace: ${taskId}`, ""];

  if (hopMap) {
    for (const hop of hopMap) {
      lines.push(`Hop: ${hop.hopId} (role: ${hop.role})`);
      lines.push("");
      for (const idx of hop.traceIndices) {
        if (idx < traces.length) {
          lines.push(formatAttemptDebug(traces[idx]!));
          lines.push("");
        }
      }
    }
  } else {
    for (const trace of traces) {
      lines.push(formatAttemptDebug(trace));
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

/**
 * Format traces as JSON output.
 *
 * Single trace returns object, multiple returns array.
 * Pretty-printed with 2-space indent.
 */
export function formatTraceJson(traces: TraceSchemaType[]): string {
  const output = traces.length === 1 ? traces[0] : traces;
  return JSON.stringify(output, null, 2);
}
