/**
 * Gate-to-DAG lazy migration — converts gate-format task workflows to DAG format.
 *
 * This module provides a one-time, on-load migration for tasks that still use
 * the legacy gate workflow format. After migration, gate fields are cleared
 * so the task uses only the DAG workflow engine going forward.
 *
 * Key behaviors:
 * - Tasks without gate fields pass through unchanged (no-op)
 * - Tasks already having workflow field pass through unchanged (skip)
 * - In-flight tasks preserve their current position (no restart)
 * - Gate fields cleared after conversion to avoid mutual exclusivity error
 * - Simple `when` expressions converted to JSON DSL conditions
 *
 * @module gate-to-dag
 */

import { initializeWorkflowState } from "../schemas/workflow-dag.js";
import type {
  WorkflowDefinition,
  Hop,
  ConditionExprType,
  HopState,
  WorkflowState,
} from "../schemas/workflow-dag.js";
import type { Task } from "../schemas/task.js";

// ---------------------------------------------------------------------------
// Gate config types (from workflow config, not Zod-validated here)
// ---------------------------------------------------------------------------

export interface GateConfig {
  id: string;
  role: string;
  canReject?: boolean;
  when?: string;
  description?: string;
  requireHuman?: boolean;
  timeout?: string;
  escalateTo?: string;
}

export interface WorkflowConfig {
  name: string;
  gates: GateConfig[];
}

// ---------------------------------------------------------------------------
// Condition Conversion (gate `when` string -> JSON DSL)
// ---------------------------------------------------------------------------

/**
 * Convert a gate `when` string expression to a JSON DSL condition.
 * Returns undefined if the expression cannot be parsed (logs warning).
 */
export function convertWhenToCondition(
  when: string,
): ConditionExprType | undefined {
  const trimmed = when.trim();

  // tags.includes('X') or tags.includes("X")
  const tagMatch = trimmed.match(
    /^tags\.includes\(\s*['"]([^'"]+)['"]\s*\)$/,
  );
  if (tagMatch) {
    return { op: "has_tag", value: tagMatch[1]! };
  }

  // !tags.includes('X')
  const negTagMatch = trimmed.match(
    /^!tags\.includes\(\s*['"]([^'"]+)['"]\s*\)$/,
  );
  if (negTagMatch) {
    return { op: "not", condition: { op: "has_tag", value: negTagMatch[1]! } };
  }

  // metadata.X > N (and >=, <, <=, ===, !==)
  const metaMatch = trimmed.match(
    /^(metadata\.\w+)\s*(>|>=|<|<=|===|!==)\s*(\d+(?:\.\d+)?)$/,
  );
  if (metaMatch) {
    const field = metaMatch[1]!;
    const op = metaMatch[2]!;
    const value = Number(metaMatch[3]);
    const opMap: Record<string, string> = {
      ">": "gt",
      ">=": "gte",
      "<": "lt",
      "<=": "lte",
      "===": "eq",
      "!==": "neq",
    };
    const dslOp = opMap[op];
    if (dslOp === "eq" || dslOp === "neq") {
      return { op: dslOp as "eq" | "neq", field, value };
    }
    return {
      op: dslOp as "gt" | "gte" | "lt" | "lte",
      field,
      value,
    };
  }

  // || combinations: split and recurse
  if (trimmed.includes(" || ")) {
    const parts = trimmed.split(" || ").map((p) => convertWhenToCondition(p));
    if (parts.every((p) => p !== undefined)) {
      return { op: "or", conditions: parts as ConditionExprType[] };
    }
  }

  // && combinations: split and recurse
  if (trimmed.includes(" && ")) {
    const parts = trimmed.split(" && ").map((p) => convertWhenToCondition(p));
    if (parts.every((p) => p !== undefined)) {
      return { op: "and", conditions: parts as ConditionExprType[] };
    }
  }

  // Unparseable
  console.warn(
    `[gate-to-dag] Cannot convert gate 'when' expression to JSON DSL, skipping condition: "${when}"`,
  );
  return undefined;
}

// ---------------------------------------------------------------------------
// Core Migration
// ---------------------------------------------------------------------------

/**
 * Migrate a gate-format task to DAG format.
 *
 * - No-op if task has no gate field and no workflow field
 * - Skip if task already has workflow field
 * - Convert gates to linear DAG hops with correct dependsOn chain
 * - Map in-flight position to hop statuses
 * - Clear gate fields after conversion
 *
 * Mutates and returns the task. Caller handles persistence.
 *
 * @param task - Task to migrate
 * @param workflowConfig - Optional workflow config with gate definitions
 * @returns The (possibly mutated) task
 */
export function migrateGateToDAG(
  task: Task,
  workflowConfig?: WorkflowConfig,
): Task {
  const fm = task.frontmatter as Record<string, any>;

  // Skip: already has DAG workflow
  if (fm.workflow) {
    return task;
  }

  // No-op: no gate fields present
  if (!fm.gate) {
    return task;
  }

  // Need workflow config to know the gate definitions
  if (!workflowConfig || !workflowConfig.gates?.length) {
    console.warn(
      `[gate-to-dag] Task ${fm.id} has gate fields but no workflow config provided, skipping migration`,
    );
    return task;
  }

  const gates = workflowConfig.gates;
  const currentGateId: string | undefined = fm.gate?.current;

  // --- Convert gates to hops (linear chain) ---
  const hops: Hop[] = gates.map((gate, index) => {
    const hop: Record<string, any> = {
      id: gate.id,
      role: gate.role,
      dependsOn: index === 0 ? [] : [gates[index - 1]!.id],
    };

    if (gate.description) hop.description = gate.description;
    if (gate.canReject) {
      hop.canReject = true;
      hop.rejectionStrategy = "origin";
    }
    if (gate.timeout) hop.timeout = gate.timeout;
    if (gate.escalateTo) hop.escalateTo = gate.escalateTo;

    // Convert when expression to condition
    if (gate.when) {
      const condition = convertWhenToCondition(gate.when);
      if (condition) hop.condition = condition;
    }

    return hop as Hop;
  });

  const definition: WorkflowDefinition = {
    name: workflowConfig.name,
    hops,
  };

  // --- Initialize state, then overlay position mapping ---
  const state: WorkflowState = initializeWorkflowState(definition);

  if (currentGateId) {
    const currentIndex = gates.findIndex((g) => g.id === currentGateId);
    if (currentIndex >= 0) {
      const isInProgress = fm.status === "in-progress";

      for (let i = 0; i < gates.length; i++) {
        const gateId = gates[i]!.id;
        const hopState: HopState = state.hops[gateId]!;

        if (i < currentIndex) {
          hopState.status = "complete";
        } else if (i === currentIndex) {
          hopState.status = isInProgress ? "dispatched" : "ready";
        } else {
          hopState.status = "pending";
        }
      }

      // Update workflow-level status if in-flight
      if (currentIndex > 0 || isInProgress) {
        state.status = "running";
      }
    }
  }

  // --- Set workflow field ---
  fm.workflow = { definition, state };

  // --- Clear gate fields (mutual exclusivity) ---
  fm.gate = undefined;
  fm.gateHistory = [];
  fm.reviewContext = undefined;

  return task;
}
