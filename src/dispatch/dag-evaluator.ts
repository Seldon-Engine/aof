/**
 * DAG evaluator — pure function that processes hop completion/failure/skip
 * events against a workflow definition and current state, producing an
 * updated immutable state and a change summary.
 *
 * Pipeline ordering:
 * 1. If rejected: handle rejection cascade (origin/predecessors) or circuit-breaker
 * 2. Apply primary hop event (complete/failed/skipped)
 * 3. Cascade skips downstream (if hop failed/skipped)
 * 4. Evaluate conditions on newly eligible hops, cascade any new skips
 * 5. Determine newly ready hops (AND-join vs OR-join)
 * 6. Check DAG completion
 * 7. Return new state + change summary
 *
 * Design decisions (from CONTEXT.md):
 * - Input state is NEVER mutated (structuredClone)
 * - Skip cascade is fully recursive in a single call
 * - AND-join: all predecessors complete or skipped (none pending/dispatched)
 * - OR-join: any predecessor "complete" (only complete triggers, not skip/fail)
 * - DAG complete = all terminal + no failed; DAG failed = all terminal + at least one failed
 *
 * @module dag-evaluator
 */

import type {
  WorkflowDefinition,
  WorkflowState,
  WorkflowStatus,
  HopStatus,
} from "../schemas/workflow-dag.js";

import {
  evaluateCondition,
  buildConditionContext,
  type ConditionContext,
} from "./dag-condition-evaluator.js";

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/**
 * Hop event that triggers DAG evaluation.
 */
export interface HopEvent {
  /** ID of the hop that completed/failed/was skipped. */
  hopId: string;
  /** Outcome of the hop. */
  outcome: "complete" | "failed" | "skipped" | "rejected";
  /** Arbitrary result data from the hop (stored on HopState.result). */
  result?: Record<string, unknown>;
}

/**
 * Record of a single hop status transition.
 */
export interface HopTransition {
  /** Hop that transitioned. */
  hopId: string;
  /** Previous status. */
  from: HopStatus;
  /** New status. */
  to: HopStatus;
  /** Reason for the transition (e.g., "cascade", "condition"). */
  reason?: string;
}

/**
 * Evaluation context provided by the caller (scheduler).
 * Contains hop results for condition evaluation and task metadata.
 */
export interface EvalContext {
  /** All completed hop results keyed by hop ID. */
  hopResults: Record<string, Record<string, unknown>>;
  /** Basic task metadata for condition evaluation. */
  task: {
    status: string;
    tags: string[];
    priority: string;
    routing: Record<string, unknown>;
  };
}

/**
 * Input for DAG evaluation — everything needed to determine state transitions.
 */
export interface DAGEvaluationInput {
  /** Immutable DAG definition. */
  definition: WorkflowDefinition;
  /** Current workflow execution state (will NOT be mutated). */
  state: WorkflowState;
  /** The hop event to process. */
  event: HopEvent;
  /** Evaluation context for condition checking. */
  context: EvalContext;
}

/**
 * Result of DAG evaluation — new state and change summary.
 */
export interface DAGEvaluationResult {
  /** New immutable WorkflowState (original input is untouched). */
  state: WorkflowState;
  /** All hop status transitions that occurred. */
  changes: HopTransition[];
  /** Hop IDs that became ready in this evaluation. */
  readyHops: string[];
  /** DAG-level status change, if any (complete or failed). */
  dagStatus?: WorkflowStatus;
  /** Suggested task status ("done" for complete, "failed" for failed). */
  taskStatus?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum rejection count before circuit-breaker triggers. */
export const DEFAULT_MAX_REJECTIONS = 3;

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Build reverse adjacency index: for each hop, list its downstream dependents.
 *
 * @param definition - Workflow definition
 * @returns Map from hopId to array of downstream hopIds
 */
function buildDownstreamIndex(
  definition: WorkflowDefinition,
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const hop of definition.hops) {
    if (!index.has(hop.id)) index.set(hop.id, []);
    for (const dep of hop.dependsOn) {
      if (!index.has(dep)) index.set(dep, []);
      index.get(dep)!.push(hop.id);
    }
  }
  return index;
}

/**
 * Recursively cascade skips to downstream hops.
 *
 * A downstream hop is cascade-skipped only if ALL its predecessors are in
 * terminal non-success state (skipped or failed). If any predecessor completed,
 * the hop can still proceed and is not skipped.
 *
 * Only pending hops are eligible for cascade-skipping (already terminal hops
 * are left unchanged).
 *
 * @param definition - Workflow definition
 * @param state - Mutable working copy of state
 * @param changes - Accumulator for hop transitions
 * @param downstreamIndex - Reverse adjacency index
 * @param startHopId - Hop that just became terminal non-success
 * @param timestamp - ISO timestamp for completedAt
 */
function cascadeSkips(
  definition: WorkflowDefinition,
  state: WorkflowState,
  changes: HopTransition[],
  downstreamIndex: Map<string, string[]>,
  startHopId: string,
  timestamp: string,
): void {
  const downstream = downstreamIndex.get(startHopId) ?? [];
  for (const hopId of downstream) {
    if (state.hops[hopId]?.status !== "pending") continue;

    const hop = definition.hops.find((h) => h.id === hopId)!;
    const allPredecessorsTerminalNonSuccess = hop.dependsOn.every((depId) => {
      const depStatus = state.hops[depId]?.status;
      return depStatus === "skipped" || depStatus === "failed";
    });

    if (allPredecessorsTerminalNonSuccess) {
      state.hops[hopId] = {
        ...state.hops[hopId]!,
        status: "skipped",
        completedAt: timestamp,
      };
      changes.push({ hopId, from: "pending", to: "skipped", reason: "cascade" });
      // Recurse: this skip may cascade further downstream
      cascadeSkips(definition, state, changes, downstreamIndex, hopId, timestamp);
    }
  }
}

/**
 * Evaluate conditions on hops that are newly eligible (all predecessors terminal).
 *
 * A hop is eligible for condition evaluation when:
 * - It is "pending"
 * - It has a condition
 * - All its predecessors are in a terminal state (complete, skipped, or failed)
 *
 * If the condition evaluates to false, the hop is skipped with reason "condition"
 * and skip cascading is triggered for its downstream dependents.
 *
 * @param definition - Workflow definition
 * @param state - Mutable working copy of state
 * @param changes - Accumulator for hop transitions
 * @param downstreamIndex - Reverse adjacency index
 * @param condContext - Flat context for dot-path field resolution
 * @param timestamp - ISO timestamp for completedAt
 */
function evaluateNewlyEligibleConditions(
  definition: WorkflowDefinition,
  state: WorkflowState,
  changes: HopTransition[],
  downstreamIndex: Map<string, string[]>,
  condContext: Record<string, unknown>,
  timestamp: string,
): void {
  for (const hop of definition.hops) {
    if (state.hops[hop.id]?.status !== "pending") continue;
    if (!hop.condition) continue;

    // Check if all predecessors are terminal
    const allTerminal = hop.dependsOn.every((depId) => {
      const s = state.hops[depId]?.status;
      return s === "complete" || s === "skipped" || s === "failed";
    });
    if (!allTerminal) continue;

    // Build ConditionContext with live hop states from working copy
    const ctx: ConditionContext = {
      context: condContext,
      hopStates: state.hops,
      task: {
        status: (condContext.task as Record<string, unknown>)?.status as string ?? "",
        tags: ((condContext.task as Record<string, unknown>)?.tags as string[]) ?? [],
        priority: (condContext.task as Record<string, unknown>)?.priority as string ?? "",
        routing: ((condContext.task as Record<string, unknown>)?.routing as Record<string, unknown>) ?? {},
      },
    };

    const condResult = evaluateCondition(hop.condition, ctx);
    if (!condResult) {
      state.hops[hop.id] = {
        ...state.hops[hop.id]!,
        status: "skipped",
        completedAt: timestamp,
      };
      changes.push({ hopId: hop.id, from: "pending", to: "skipped", reason: "condition" });
      // NOTE: condition-skipped hops do NOT cascade-skip downstream.
      // Downstream hops treat condition-skipped predecessors as satisfied,
      // allowing optional hops to be truly optional.
    }
  }
}

/**
 * Determine which pending hops should become ready based on join type.
 *
 * AND-join (joinType: "all"): ready when ALL predecessors are complete or skipped
 *   (none pending/dispatched). BUT if ALL predecessors are terminal non-success
 *   (all skipped/failed), the hop should have been cascade-skipped already.
 *
 * OR-join (joinType: "any"): ready when ANY predecessor is "complete"
 *   (only complete triggers, not skip/fail). If all predecessors are terminal
 *   and none completed, the hop should have been cascade-skipped already.
 *
 * Root hops (empty dependsOn) are NOT handled here — they are set to "ready"
 * by initializeWorkflowState() at creation time.
 *
 * @param definition - Workflow definition
 * @param state - Current state (after cascades and condition evaluation)
 * @returns Array of hop IDs that should become ready
 */
function determineReadyHops(
  definition: WorkflowDefinition,
  state: WorkflowState,
): string[] {
  const newlyReady: string[] = [];

  for (const hop of definition.hops) {
    if (state.hops[hop.id]?.status !== "pending") continue;
    if (hop.dependsOn.length === 0) continue; // Roots handled at init

    if (hop.joinType === "any") {
      // OR-join: ready when ANY predecessor is "complete"
      const anyComplete = hop.dependsOn.some(
        (depId) => state.hops[depId]?.status === "complete",
      );
      if (anyComplete) {
        newlyReady.push(hop.id);
      }
    } else {
      // AND-join: ready when ALL predecessors are complete or skipped (none pending/dispatched)
      const allSatisfied = hop.dependsOn.every((depId) => {
        const s = state.hops[depId]?.status;
        return s === "complete" || s === "skipped";
      });
      if (allSatisfied) {
        newlyReady.push(hop.id);
      }
    }
  }

  return newlyReady;
}

/**
 * Check if the DAG has reached a terminal state.
 *
 * - "complete": all hops are complete or skipped (no failed)
 * - "failed": all hops are terminal and at least one is failed
 * - undefined: some hops are still pending/ready/dispatched
 *
 * @param state - Current workflow state
 * @returns Terminal status or undefined if still running
 */
function checkDAGCompletion(state: WorkflowState): WorkflowStatus | undefined {
  const statuses = Object.values(state.hops).map((h) => h.status);
  const allTerminal = statuses.every(
    (s) => s === "complete" || s === "skipped" || s === "failed",
  );

  if (!allTerminal) return undefined;

  const hasFailed = statuses.some((s) => s === "failed");
  if (hasFailed) return "failed";

  return "complete";
}

// ---------------------------------------------------------------------------
// Rejection Helpers
// ---------------------------------------------------------------------------

/**
 * Reset ALL hops for origin rejection strategy.
 *
 * Every hop is reset to "pending" (or "ready" if root — empty dependsOn).
 * Clears result, startedAt, completedAt, agent, correlationId on each hop.
 * Preserves rejectionCount ONLY on the rejected hop (set to currentCount).
 *
 * @param definition - Workflow definition
 * @param state - Mutable working copy of state
 * @param changes - Accumulator for hop transitions
 * @param rejectedHopId - The hop that was rejected
 * @param currentCount - New rejectionCount for the rejected hop
 * @param timestamp - ISO timestamp (unused but kept for consistency)
 */
function resetAllHopsForOrigin(
  definition: WorkflowDefinition,
  state: WorkflowState,
  changes: HopTransition[],
  rejectedHopId: string,
  currentCount: number,
  _timestamp: string,
): void {
  for (const hop of definition.hops) {
    const prev = state.hops[hop.id]!;
    const isRoot = hop.dependsOn.length === 0;
    const newStatus: HopStatus = isRoot ? "ready" : "pending";

    const prevStatus = prev.status;
    state.hops[hop.id] = {
      status: newStatus,
      ...(hop.id === rejectedHopId ? { rejectionCount: currentCount } : {}),
    };

    if (prevStatus !== newStatus || hop.id === rejectedHopId) {
      changes.push({
        hopId: hop.id,
        from: prevStatus,
        to: newStatus,
        reason: "rejection_cascade_origin",
      });
    }
  }
}

/**
 * Reset ONLY the rejected hop and its immediate dependsOn predecessors.
 *
 * Hops in the reset set have their result, startedAt, completedAt, agent,
 * correlationId cleared. Their new status depends on whether their own
 * dependencies are all satisfied (complete and outside the reset set).
 *
 * Hops NOT in the reset set remain untouched.
 *
 * @param definition - Workflow definition
 * @param state - Mutable working copy of state
 * @param changes - Accumulator for hop transitions
 * @param rejectedHopId - The hop that was rejected
 * @param currentCount - New rejectionCount for the rejected hop
 * @param timestamp - ISO timestamp (unused but kept for consistency)
 */
function resetPredecessorHops(
  definition: WorkflowDefinition,
  state: WorkflowState,
  changes: HopTransition[],
  rejectedHopId: string,
  currentCount: number,
  _timestamp: string,
): void {
  const rejectedHop = definition.hops.find((h) => h.id === rejectedHopId)!;
  const resetSet = new Set([rejectedHopId, ...rejectedHop.dependsOn]);

  for (const hopId of resetSet) {
    const hop = definition.hops.find((h) => h.id === hopId)!;
    const prev = state.hops[hopId]!;
    const prevStatus = prev.status;

    // Determine new status: "ready" if all own deps are outside reset set and
    // complete/satisfied; "pending" otherwise
    let newStatus: HopStatus;
    if (hop.dependsOn.length === 0) {
      // Root hop — always ready
      newStatus = "ready";
    } else {
      const allDepsSatisfied = hop.dependsOn.every((depId) => {
        if (resetSet.has(depId)) return false; // Dep is being reset, not satisfied
        const depStatus = state.hops[depId]?.status;
        return depStatus === "complete" || depStatus === "skipped";
      });
      newStatus = allDepsSatisfied ? "ready" : "pending";
    }

    state.hops[hopId] = {
      status: newStatus,
      ...(hopId === rejectedHopId ? { rejectionCount: currentCount } : {}),
    };

    changes.push({
      hopId,
      from: prevStatus,
      to: newStatus,
      reason: "rejection_cascade_predecessors",
    });
  }
}

// ---------------------------------------------------------------------------
// Main Evaluation Function
// ---------------------------------------------------------------------------

/**
 * Evaluate a DAG hop event and return the new workflow state plus change summary.
 *
 * This is the single entry point for all DAG state transitions. It is a pure
 * function: the input state is never mutated, and the output is deterministic
 * given the same inputs (modulo timestamps).
 *
 * @param input - DAG evaluation input (definition, state, event, context)
 * @returns New state, all transitions, ready hops, and optional DAG/task status
 */
export function evaluateDAG(input: DAGEvaluationInput): DAGEvaluationResult {
  const { definition, state, event, context } = input;
  const timestamp = new Date().toISOString();
  const changes: HopTransition[] = [];

  // Deep copy state for immutable output
  const newState: WorkflowState = structuredClone(state);

  // Build reverse adjacency index
  const downstreamIndex = buildDownstreamIndex(definition);

  // --- 1. Handle rejection (short-circuits normal flow) ---
  if (event.outcome === "rejected") {
    const hopDef = definition.hops.find((h) => h.id === event.hopId)!;
    const currentCount = (newState.hops[event.hopId]?.rejectionCount ?? 0) + 1;

    if (currentCount >= DEFAULT_MAX_REJECTIONS) {
      // Circuit-breaker: fail the hop permanently
      const prevStatus = newState.hops[event.hopId]?.status;
      newState.hops[event.hopId] = {
        ...newState.hops[event.hopId]!,
        status: "failed",
        completedAt: timestamp,
        rejectionCount: currentCount,
      };
      changes.push({
        hopId: event.hopId,
        from: prevStatus!,
        to: "failed",
        reason: "circuit_breaker",
      });
      // Cascade skips downstream
      cascadeSkips(definition, newState, changes, downstreamIndex, event.hopId, timestamp);
    } else {
      // Apply rejection strategy
      const strategy = hopDef.rejectionStrategy ?? "origin";
      if (strategy === "origin") {
        resetAllHopsForOrigin(definition, newState, changes, event.hopId, currentCount, timestamp);
      } else {
        resetPredecessorHops(definition, newState, changes, event.hopId, currentCount, timestamp);
      }
    }

    // Determine ready hops after reset/circuit-breaker
    const readyHops = determineReadyHops(definition, newState);
    // Also include root hops that are already "ready" from the reset
    for (const hop of definition.hops) {
      if (newState.hops[hop.id]?.status === "ready" && !readyHops.includes(hop.id)) {
        readyHops.push(hop.id);
      }
    }

    // Check DAG completion (may be failed after circuit-breaker)
    const dagStatus = checkDAGCompletion(newState);
    if (dagStatus) {
      newState.status = dagStatus;
      if (dagStatus === "complete" || dagStatus === "failed") {
        newState.completedAt = timestamp;
      }
    }

    const taskStatus =
      dagStatus === "complete"
        ? "done"
        : dagStatus === "failed"
          ? "failed"
          : undefined;

    return { state: newState, changes, readyHops, dagStatus, taskStatus };
  }

  // --- 2. Apply primary hop event (non-rejection) ---
  const prevStatus = newState.hops[event.hopId]?.status;
  newState.hops[event.hopId] = {
    ...newState.hops[event.hopId]!,
    status: event.outcome as HopStatus,
    completedAt: timestamp,
    result: event.result,
  };
  changes.push({
    hopId: event.hopId,
    from: prevStatus!,
    to: event.outcome as HopStatus,
  });

  // --- 3. If hop failed/skipped, cascade skips downstream ---
  if (event.outcome !== "complete") {
    cascadeSkips(
      definition,
      newState,
      changes,
      downstreamIndex,
      event.hopId,
      timestamp,
    );
  }

  // --- 4. Evaluate conditions on newly eligible hops ---
  const condContext = buildConditionContext(newState, context.task);
  evaluateNewlyEligibleConditions(
    definition,
    newState,
    changes,
    downstreamIndex,
    condContext,
    timestamp,
  );

  // --- 5. Determine newly ready hops ---
  const readyHops = determineReadyHops(definition, newState);
  for (const hopId of readyHops) {
    newState.hops[hopId] = { ...newState.hops[hopId]!, status: "ready" };
    changes.push({ hopId, from: "pending", to: "ready" });
  }

  // --- 6. Check DAG completion ---
  const dagStatus = checkDAGCompletion(newState);
  if (dagStatus) {
    newState.status = dagStatus;
    if (dagStatus === "complete" || dagStatus === "failed") {
      newState.completedAt = timestamp;
    }
  }

  // --- 7. Suggest task status ---
  const taskStatus =
    dagStatus === "complete"
      ? "done"
      : dagStatus === "failed"
        ? "failed"
        : undefined;

  return { state: newState, changes, readyHops, dagStatus, taskStatus };
}
