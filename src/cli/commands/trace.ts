/**
 * Trace CLI command -- show agent activity traces for a task.
 *
 * Three output modes:
 * - Default: human-readable summary (model, duration, tool counts)
 * - --debug: full detail (tool inputs/outputs, reasoning text)
 * - --json: machine-readable JSON to stdout (errors to stderr only)
 *
 * DAG workflow tasks get per-hop grouping via buildHopMap().
 */

import { join } from "node:path";
import type { Command } from "commander";
import type { TraceSchema } from "../../schemas/trace.js";
import type { TaskWorkflow } from "../../schemas/workflow-dag.js";
import { readTraceFiles } from "../../trace/trace-reader.js";
import {
  formatTraceSummary,
  formatTraceDebug,
  formatTraceJson,
} from "../../trace/trace-formatter.js";
import type { HopInfo } from "../../trace/trace-formatter.js";

/**
 * Build a HopInfo[] map correlating traces to workflow hops.
 *
 * Strategy:
 * 1. For each hop, check if its correlationId matches any trace's sessionId
 * 2. If no correlationId match, fall back to sequential ordering
 * 3. Unmatched traces go into an "unassigned" group
 */
export function buildHopMap(
  workflow: TaskWorkflow,
  traces: TraceSchema[],
): HopInfo[] {
  const hops = workflow.definition.hops;
  const stateHops = workflow.state.hops;
  const result: HopInfo[] = [];
  const assignedTraceIndices = new Set<number>();

  // Build sessionId -> trace index map for O(1) lookup
  const sessionToIndex = new Map<string, number[]>();
  for (let i = 0; i < traces.length; i++) {
    const sid = traces[i].sessionId;
    const indices = sessionToIndex.get(sid) ?? [];
    indices.push(i);
    sessionToIndex.set(sid, indices);
  }

  // First pass: match by correlationId
  let hasAnyCorrelation = false;
  for (const hop of hops) {
    const hopState = stateHops[hop.id];
    const correlationId = hopState?.correlationId;

    if (correlationId) {
      hasAnyCorrelation = true;
      const indices = sessionToIndex.get(correlationId) ?? [];
      for (const idx of indices) {
        assignedTraceIndices.add(idx);
      }
      result.push({ hopId: hop.id, role: hop.role, traceIndices: indices });
    } else {
      // Placeholder -- will fill in second pass if no correlations
      result.push({ hopId: hop.id, role: hop.role, traceIndices: [] });
    }
  }

  // If no correlationIds found at all, fall back to sequential ordering
  if (!hasAnyCorrelation) {
    for (let i = 0; i < result.length && i < traces.length; i++) {
      result[i].traceIndices = [i];
      assignedTraceIndices.add(i);
    }
  }

  // Collect unassigned traces
  const unassigned: number[] = [];
  for (let i = 0; i < traces.length; i++) {
    if (!assignedTraceIndices.has(i)) {
      unassigned.push(i);
    }
  }

  if (unassigned.length > 0) {
    result.push({ hopId: "unassigned", role: "unknown", traceIndices: unassigned });
  }

  return result;
}

/**
 * Register the `trace <task-id>` command on the Commander program.
 */
export function registerTraceCommand(program: Command): void {
  program
    .command("trace <task-id>")
    .description("Show trace of agent activity for a task")
    .option("--debug", "Show full tool call details and reasoning text")
    .option("--json", "Output structured trace data as JSON")
    .option("--project <id>", "Project ID", "_inbox")
    .action(async (taskId: string, opts: { debug?: boolean; json?: boolean; project: string }) => {
      const { createProjectStore } = await import("../project-utils.js");

      const root = program.opts()["root"] as string;
      const { store, projectRoot } = await createProjectStore({
        projectId: opts.project,
        vaultRoot: root,
      });

      // Look up task by prefix
      const task = await store.getByPrefix(taskId);
      if (!task) {
        console.error(`Task not found: ${taskId}`);
        process.exitCode = 1;
        return;
      }

      const fullTaskId = task.frontmatter.id;
      const taskDir = join(projectRoot, "state", "runs", fullTaskId);

      // Read trace files
      const traces = await readTraceFiles(taskDir);
      if (traces.length === 0) {
        console.error(
          `No traces found for task ${fullTaskId}. Traces are captured after agent sessions complete.`,
        );
        process.exitCode = 1;
        return;
      }

      // Build hop map if workflow task
      let hopMap: HopInfo[] | undefined;
      if (task.frontmatter.workflow) {
        hopMap = buildHopMap(task.frontmatter.workflow as TaskWorkflow, traces);
      }

      // Dispatch to formatter
      if (opts.json) {
        console.log(formatTraceJson(traces));
        return;
      }

      if (opts.debug) {
        console.log(formatTraceDebug(fullTaskId, traces, hopMap));
        return;
      }

      console.log(formatTraceSummary(fullTaskId, traces, hopMap));
    });
}
