/**
 * Shared helpers and constants for SDLC workflow integration tests.
 *
 * Centralizes:
 * - SDLC project.yaml with 3-hop DAG workflow definition
 * - Task type tag contracts (feature / bugfix / hotfix)
 * - createWorkflowTask()  — task factory wired into DAG workflow
 * - writeProjectYaml()    — writes project.yaml for test setup
 * - completeHop()         — thin wrapper around handleDAGHopCompletion
 * - reloadTask()          — type-safe task reload from store
 */

import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";

import type { ITaskStore } from "../../../src/store/interfaces.js";
import { serializeTask } from "../../../src/store/task-store.js";
import { EventLogger } from "../../../src/events/logger.js";
import { handleDAGHopCompletion } from "../../../src/dispatch/dag-transition-handler.js";
import type { Task } from "../../../src/schemas/task.js";
import type { RunResult } from "../../../src/schemas/run-result.js";
import type {
  TaskWorkflow,
  WorkflowDefinition,
  Hop,
} from "../../../src/schemas/workflow-dag.js";
import { initializeWorkflowState } from "../../../src/schemas/workflow-dag.js";
import type { DAGHopCompletionResult } from "../../../src/dispatch/dag-transition-handler.js";

// ─────────────────────────────────────────────────────────────────────────────
// SDLC workflow configuration (DAG format)
//
// Three-hop SWE lifecycle:
//
//   implement  → code_review (can reject) → qa_review (can reject, skip-qa opt-out)
//
// Hop conditions drive task-type routing:
//   !tags.includes('skip-qa') → qa_review active for features, skipped for bugfix/hotfix
// ─────────────────────────────────────────────────────────────────────────────

export const SDLC_WORKFLOW_DEFINITION: WorkflowDefinition = {
  name: "sdlc-workflow",
  hops: [
    {
      id: "implement",
      role: "developer",
      dependsOn: [],
      description: "Build the feature with tests — no rejection from here",
      autoAdvance: true,
    },
    {
      id: "code_review",
      role: "reviewer",
      dependsOn: ["implement"],
      canReject: true,
      rejectionStrategy: "origin",
      description:
        "Code review: approves or rejects with notes back to implement",
      autoAdvance: true,
    },
    {
      id: "qa_review",
      role: "qa",
      dependsOn: ["code_review"],
      canReject: true,
      rejectionStrategy: "origin",
      condition: {
        op: "not",
        condition: {
          op: "has_tag",
          value: "skip-qa",
        },
      },
      description:
        "QA sign-off: active for features, skipped for bugfix/hotfix",
      autoAdvance: true,
    },
  ] as Hop[],
};

// Also write project.yaml (some tests may need it for manifest loading)
export const SDLC_PROJECT_YAML = `
id: sdlc-test
title: SDLC Integration Test Project
type: swe
status: active
owner:
  team: eng
  lead: architect
workflow:
  name: sdlc-workflow
  rejectionStrategy: origin
  gates:
    - id: implement
      role: developer
      description: "Build the feature with tests — no rejection from here"
    - id: code_review
      role: reviewer
      canReject: true
      description: "Code review: approves or rejects with notes back to implement"
    - id: qa_review
      role: qa
      canReject: true
      when: "!tags.includes('skip-qa')"
      description: "QA sign-off: active for features, skipped for bugfix/hotfix"
`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// Task type tag contracts
// ─────────────────────────────────────────────────────────────────────────────
export const SDLC_TAGS = {
  feature: [] as string[], // all hops: implement → code_review → qa_review
  bugfix: ["skip-qa"], // short path: implement → code_review → done
  hotfix: ["skip-qa", "hotfix"], // short path + priority marker
} as const;

/**
 * Write the SDLC project.yaml to the store's project root.
 */
export async function writeProjectYaml(dir: string): Promise<void> {
  await writeFile(join(dir, "project.yaml"), SDLC_PROJECT_YAML);
}

/**
 * Create a task wired into the SDLC DAG workflow at the `implement` hop.
 *
 * The task is created via the store, transitioned to "in-progress" (standard
 * status for active DAG tasks), then has its workflow field set with the DAG
 * definition and initial state (implement=dispatched, rest=pending).
 */
export async function createWorkflowTask(
  store: ITaskStore,
  storeDir: string,
  title: string,
  opts: {
    tags?: string[];
    metadata?: Record<string, unknown>;
    dependsOn?: string[];
  } = {},
): Promise<Task> {
  const task = await store.create({
    title,
    createdBy: "sdlc-test",
    dependsOn: opts.dependsOn,
    metadata: opts.metadata,
  });

  // Advance to in-progress (standard DAG task status)
  await store.transition(task.frontmatter.id, "ready");
  await store.transition(task.frontmatter.id, "in-progress");

  const reloaded = await store.get(task.frontmatter.id);
  if (!reloaded)
    throw new Error(`Task ${task.frontmatter.id} disappeared after transition`);

  // Wire DAG workflow — tags are on routing for condition evaluation
  const state = initializeWorkflowState(SDLC_WORKFLOW_DEFINITION);
  // Set implement hop to dispatched (simulating scheduler dispatch)
  state.hops["implement"] = {
    ...state.hops["implement"]!,
    status: "dispatched",
    startedAt: new Date().toISOString(),
    agent: "developer",
  };
  state.status = "running";

  reloaded.frontmatter.workflow = {
    definition: SDLC_WORKFLOW_DEFINITION,
    state,
  };
  reloaded.frontmatter.routing = {
    ...reloaded.frontmatter.routing,
    role: "developer",
    tags: opts.tags ?? [],
  };

  const taskPath = join(
    storeDir,
    "tasks",
    reloaded.frontmatter.status,
    `${reloaded.frontmatter.id}.md`,
  );
  await writeFileAtomic(taskPath, serializeTask(reloaded));
  return reloaded;
}

/**
 * Complete the current dispatched hop with the given outcome.
 *
 * After completion, if there are ready hops, the first one is automatically
 * set to "dispatched" to simulate scheduler dispatch (mimicking the real
 * poll cycle). Returns the DAGHopCompletionResult.
 */
export async function completeHop(
  store: ITaskStore,
  logger: EventLogger,
  taskId: string,
  outcome: "done" | "needs_review" | "blocked",
  ctx: {
    summary: string;
    agent: string;
    blockers?: string[];
    rejectionNotes?: string;
  },
): Promise<DAGHopCompletionResult> {
  // Read current task state from disk
  const task = await store.get(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const runResult: RunResult = {
    taskId,
    agentId: ctx.agent,
    completedAt: new Date().toISOString(),
    outcome,
    summaryRef: "summary.md",
    handoffRef: "handoff.md",
    deliverables: [],
    tests: { passed: 1, failed: 0, total: 1 },
    blockers: ctx.blockers ?? [],
    notes: ctx.rejectionNotes ?? ctx.summary,
  };

  const result = await handleDAGHopCompletion(store, logger, task, runResult);

  // Auto-dispatch next ready hop (simulates scheduler poll cycle)
  if (result.readyHops.length > 0 && !result.dagComplete) {
    // Re-read task (handleDAGHopCompletion persisted new state)
    const updated = await store.get(taskId);
    if (updated?.frontmatter.workflow) {
      const nextHopId = result.readyHops[0]!;
      const hopDef = updated.frontmatter.workflow.definition.hops.find(
        (h) => h.id === nextHopId,
      );
      updated.frontmatter.workflow.state.hops[nextHopId] = {
        ...updated.frontmatter.workflow.state.hops[nextHopId]!,
        status: "dispatched",
        startedAt: new Date().toISOString(),
        agent: hopDef?.role ?? "unknown",
      };
      await writeFileAtomic(updated.path!, serializeTask(updated));
    }
  }

  // If DAG complete, transition task to done
  if (result.dagComplete) {
    const updated = await store.get(taskId);
    if (updated && updated.frontmatter.status !== "done") {
      // Walk through lifecycle: in-progress → review → done
      if (updated.frontmatter.status === "in-progress") {
        await store.transition(taskId, "review");
      }
      await store.transition(taskId, "done");
    }
  }

  return result;
}

/** Type-safe task reload — throws if task is missing (indicates a test bug). */
export async function reloadTask(
  store: ITaskStore,
  taskId: string,
): Promise<Task> {
  const task = await store.get(taskId);
  if (!task) throw new Error(`Task ${taskId} not found in store`);
  return task;
}
