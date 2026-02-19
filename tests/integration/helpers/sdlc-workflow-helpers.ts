/**
 * Shared helpers and constants for SDLC workflow integration tests.
 *
 * Centralizes:
 * - SDLC project.yaml with 3-gate workflow definition
 * - Task type tag contracts (feature / bugfix / hotfix)
 * - createWorkflowTask()  — task factory wired into gate workflow
 * - writeProjectYaml()    — writes project.yaml for handleGateTransition
 * - completeGate()        — thin wrapper around handleGateTransition
 * - reloadTask()          — type-safe task reload from store
 */

import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";

import type { ITaskStore } from "../../../src/store/interfaces.js";
import { serializeTask } from "../../../src/store/task-store.js";
import { EventLogger } from "../../../src/events/logger.js";
import { handleGateTransition } from "../../../src/dispatch/gate-transition-handler.js";
import type { Task } from "../../../src/schemas/task.js";
import type { GateOutcome, GateTransition } from "../../../src/schemas/gate.js";

// ─────────────────────────────────────────────────────────────────────────────
// SDLC workflow configuration
//
// Three-gate SWE lifecycle enforced via AOF's gate primitive:
//
//   implement  → code_review (can reject) → qa_review (can reject, skip-qa opt-out)
//
// Gate conditionals drive task-type routing:
//   tags.includes('skip-qa') → qa_review skipped → done after code_review
// ─────────────────────────────────────────────────────────────────────────────
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
  feature: [] as string[],            // all gates: implement → code_review → qa_review
  bugfix: ["skip-qa"],                // short path: implement → code_review → done
  hotfix: ["skip-qa", "hotfix"],      // short path + priority marker
} as const;

/**
 * Write the SDLC project.yaml to the store's project root.
 * `handleGateTransition` loads this file to resolve workflow config.
 */
export async function writeProjectYaml(dir: string): Promise<void> {
  await writeFile(join(dir, "project.yaml"), SDLC_PROJECT_YAML);
}

/**
 * Create a task wired into the SDLC gate workflow at the `implement` gate.
 *
 * Gate workflows require a task in "review" status so the final gate can
 * transition to "done" (review → done is a valid lifecycle transition).
 * Gate state is written atomically after the status transitions.
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

  // Advance through lifecycle to "review" so final gate can reach "done"
  await store.transition(task.frontmatter.id, "ready");
  await store.transition(task.frontmatter.id, "in-progress");
  await store.transition(task.frontmatter.id, "review");

  const reloaded = await store.get(task.frontmatter.id);
  if (!reloaded) throw new Error(`Task ${task.frontmatter.id} disappeared after transition`);

  // Wire gate workflow — routing.tags is what gate conditionals read
  reloaded.frontmatter.gate = {
    current: "implement",
    entered: new Date().toISOString(),
  };
  reloaded.frontmatter.routing = {
    role: "developer",
    workflow: "sdlc-workflow",
    tags: opts.tags ?? [],
  };
  reloaded.frontmatter.gateHistory = [];

  const taskPath = join(
    storeDir,
    "tasks",
    reloaded.frontmatter.status,
    `${reloaded.frontmatter.id}.md`,
  );
  await writeFileAtomic(taskPath, serializeTask(reloaded));
  return reloaded;
}

/** Complete a gate with the given outcome (thin wrapper around handleGateTransition). */
export async function completeGate(
  store: ITaskStore,
  logger: EventLogger,
  taskId: string,
  outcome: GateOutcome,
  ctx: {
    summary: string;
    agent: string;
    blockers?: string[];
    rejectionNotes?: string;
  },
): Promise<GateTransition> {
  return handleGateTransition(store, logger, taskId, outcome, ctx);
}

/** Type-safe task reload — throws if task is missing (indicates a test bug). */
export async function reloadTask(store: ITaskStore, taskId: string): Promise<Task> {
  const task = await store.get(taskId);
  if (!task) throw new Error(`Task ${taskId} not found in store`);
  return task;
}
