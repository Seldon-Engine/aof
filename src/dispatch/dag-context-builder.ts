/**
 * DAG context builder — hop-scoped context construction for agent dispatch.
 *
 * When AOF dispatches a hop within a DAG workflow, this module builds the
 * HopContext that provides the agent with exactly what it needs: its hop ID,
 * role, description, upstream results from completed predecessors, and
 * whether auto-advance is enabled.
 *
 * Per user decision: agents receive hop-scoped context ONLY — no full DAG
 * visibility. This is Progressive Disclosure for DAG workflows.
 *
 * @module dag-context-builder
 */

import type { Task } from "../schemas/task.js";

// ---------------------------------------------------------------------------
// HopContext Type
// ---------------------------------------------------------------------------

/**
 * Hop-scoped context injected into TaskContext when dispatching a DAG hop.
 *
 * Provides the agent with everything it needs for its current hop without
 * exposing the full DAG structure. Upstream results let the agent build
 * on predecessor work.
 */
export interface HopContext {
  /** ID of the hop being dispatched. */
  hopId: string;
  /** Human-readable description of the hop's purpose (if set in definition). */
  description?: string;
  /** Role responsible for this hop (e.g., "swe-backend", "qa"). */
  role: string;
  /** Results from completed predecessor hops, keyed by predecessor hop ID. */
  upstreamResults: Record<string, Record<string, unknown>>;
  /** Whether scheduler advances immediately on completion (true) or waits for review (false). */
  autoAdvance: boolean;
}

// ---------------------------------------------------------------------------
// Builder Function
// ---------------------------------------------------------------------------

/**
 * Build hop-scoped context for agent dispatch.
 *
 * Reads the hop definition and predecessor results from task frontmatter.
 * Only completed predecessors with result data are included in upstreamResults.
 *
 * @param task - Task with workflow frontmatter (definition + state)
 * @param hopId - ID of the hop to build context for
 * @returns HopContext for injection into TaskContext
 * @throws Error if hopId is not found in the workflow definition
 */
export function buildHopContext(task: Task, hopId: string): HopContext {
  const workflow = task.frontmatter.workflow!;
  const { definition, state } = workflow;

  // Find the hop definition
  const hop = definition.hops.find((h) => h.id === hopId);
  if (!hop) {
    throw new Error(
      `Hop "${hopId}" not found in workflow definition "${definition.name}". ` +
        `Available hops: ${definition.hops.map((h) => h.id).join(", ")}`,
    );
  }

  // Collect upstream results from completed predecessors
  const upstreamResults: Record<string, Record<string, unknown>> = {};
  for (const predId of hop.dependsOn) {
    const predState = state.hops[predId];
    if (predState?.status === "complete" && predState.result) {
      upstreamResults[predId] = predState.result;
    }
  }

  return {
    hopId,
    description: hop.description,
    role: hop.role,
    upstreamResults,
    autoAdvance: hop.autoAdvance,
  };
}
