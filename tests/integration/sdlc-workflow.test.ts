/**
 * SDLC Workflow Integration Test
 *
 * Proves AOF's core value proposition: encoding complex real-world workflows as
 * deterministic, enforceable DAG processes. This test models a complete Software
 * Development Lifecycle (SDLC) with hop-based progression, rejection loops,
 * task-type routing, and dependency enforcement.
 *
 * WORKFLOW DEFINITION (DAG)
 * ────────────────────────
 *   backlog → ready → in_progress → [implement hop]
 *                                        ↓
 *                              [code_review hop] ──reject──→ [implement hop]
 *                                        ↓ approve
 *                              [qa_review hop]   ──reject──→ [implement hop]
 *                                        ↓ approve (skipped for bugfix/hotfix)
 *                                      done
 *
 * TASK TYPE ROUTING (hop conditions)
 * ───────────────────────────────────
 *   feature  → implement → code_review → qa_review → done  (all hops)
 *   bugfix   → implement → code_review → done              (qa_review skipped)
 *   hotfix   → implement → code_review → done              (qa_review skipped)
 *
 * SCENARIOS
 * ──────────
 *   A: Happy path feature   — full 3-hop lifecycle, audit trail verified
 *   B: Rejection loop       — code_review rejects → fixes → re-review → done
 *   C: Bugfix/hotfix paths  — qa_review hop skipped per task type
 *   D: Blocked w/ cascade   — block A, B stays in backlog; unblock A → B unblocked
 *   E: Concurrent mixed     — 5 tasks of 3 types, each follows its own path
 *   F: Audit trail          — events ordered, rejection preserved
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FilesystemTaskStore } from "../../src/store/task-store.js";
import type { ITaskStore } from "../../src/store/interfaces.js";
import { EventLogger } from "../../src/events/logger.js";
import { MockAdapter } from "../../src/dispatch/executor.js";
import { ProtocolRouter } from "../../src/protocol/router.js";
import { poll, resetThrottleState } from "../../src/dispatch/scheduler.js";
import type { Task } from "../../src/schemas/task.js";
import {
  SDLC_TAGS,
  writeProjectYaml,
  createWorkflowTask,
  completeHop,
  reloadTask,
} from "./helpers/sdlc-workflow-helpers.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("SDLC Workflow Integration — lifecycle enforcement", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockAdapter;
  let router: ProtocolRouter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-sdlc-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();

    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);

    executor = new MockAdapter();
    router = new ProtocolRouter({ store, logger });
    resetThrottleState();

    await writeProjectYaml(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeSchedulerConfig(overrides: Record<string, unknown> = {}) {
    return {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60_000,
      maxConcurrentDispatches: 10,
      minDispatchIntervalMs: 0,
      maxDispatchesPerPoll: 10,
      executor,
      ...overrides,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario A: Happy Path Feature — full 3-hop lifecycle
  // ───────────────────────────────────────────────────────────────────────────
  describe("Scenario A: Happy path feature — full 3-hop lifecycle", () => {
    it("walks implement → code_review → qa_review → done with full audit trail", async () => {
      const task = await createWorkflowTask(store, tmpDir, "Add OAuth2 login", {
        tags: SDLC_TAGS.feature,
        metadata: { type: "feature" },
      });
      const taskId = task.frontmatter.id;

      // Hop 1: implement
      await completeHop(store, logger, taskId, "done", {
        summary: "OAuth2 middleware implemented, 90% test coverage",
        agent: "dev-agent",
      });

      let updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.workflow?.state.hops["implement"]?.status).toBe("complete");
      expect(updated.frontmatter.workflow?.state.hops["code_review"]?.status).toBe("dispatched");

      // Hop 2: code_review
      await completeHop(store, logger, taskId, "done", {
        summary: "Architecture clean, tests comprehensive — approved",
        agent: "reviewer-agent",
      });

      updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.workflow?.state.hops["code_review"]?.status).toBe("complete");
      expect(updated.frontmatter.workflow?.state.hops["qa_review"]?.status).toBe("dispatched");

      // Hop 3: qa_review → done
      await completeHop(store, logger, taskId, "done", {
        summary: "All acceptance tests pass, edge cases covered",
        agent: "qa-agent",
      });

      updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.status).toBe("done");
      expect(updated.frontmatter.workflow?.state.status).toBe("complete");

      // All hops completed
      for (const hopId of ["implement", "code_review", "qa_review"]) {
        expect(updated.frontmatter.workflow?.state.hops[hopId]?.status).toBe("complete");
      }

      // Event log must contain DAG hop events
      const events = await logger.query({ taskId });
      const dagEvents = events.filter((e) => e.type === "dag.hop_completed");
      expect(dagEvents.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario B: Rejection Loop
  // ───────────────────────────────────────────────────────────────────────────
  describe("Scenario B: Rejection loop — code_review rejects, task loops back", () => {
    it("preserves rejection context on loop-back, then completes on second pass", async () => {
      const task = await createWorkflowTask(store, tmpDir, "Add payment gateway", {
        tags: SDLC_TAGS.feature,
        metadata: { type: "feature" },
      });
      const taskId = task.frontmatter.id;

      // Pass 1: implement → code_review
      await completeHop(store, logger, taskId, "done", {
        summary: "Payment gateway integrated, initial tests passing",
        agent: "dev-agent",
      });

      // code_review REJECTS
      await completeHop(store, logger, taskId, "needs_review", {
        summary: "Sending back — error handling missing",
        agent: "reviewer-agent",
        blockers: ["missing error handling", "no retry logic for transient failures"],
        rejectionNotes: "Error handling is incomplete — payment failures must be retried",
      });

      let updated = await reloadTask(store, taskId);

      // Origin rejection: implement reset to dispatched, code_review pending
      expect(updated.frontmatter.workflow?.state.hops["implement"]?.status).toBe("dispatched");
      expect(updated.frontmatter.workflow?.state.hops["code_review"]?.status).toBe("pending");
      expect(updated.frontmatter.workflow?.state.hops["code_review"]?.rejectionCount).toBe(1);

      // Pass 2: implement (fixes) → code_review → qa_review
      await completeHop(store, logger, taskId, "done", {
        summary: "Added error handling with exponential-backoff retry; all tests pass",
        agent: "dev-agent",
      });

      updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.workflow?.state.hops["code_review"]?.status).toBe("dispatched");

      await completeHop(store, logger, taskId, "done", {
        summary: "All issues addressed — approved",
        agent: "reviewer-agent",
      });

      updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.workflow?.state.hops["qa_review"]?.status).toBe("dispatched");

      await completeHop(store, logger, taskId, "done", {
        summary: "Payment flows verified end-to-end",
        agent: "qa-agent",
      });

      updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.status).toBe("done");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario C: Bugfix / Hotfix Fast Path — qa_review skipped
  // ───────────────────────────────────────────────────────────────────────────
  describe("Scenario C: Bugfix/hotfix fast path — qa_review hop skipped", () => {
    it("routes bugfix through implement → code_review → done (no qa_review)", async () => {
      const task = await createWorkflowTask(store, tmpDir, "Fix null pointer in auth handler", {
        tags: SDLC_TAGS.bugfix,
        metadata: { type: "bugfix" },
      });
      const taskId = task.frontmatter.id;

      await completeHop(store, logger, taskId, "done", {
        summary: "Null check added, regression test included",
        agent: "dev-agent",
      });

      let updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.workflow?.state.hops["code_review"]?.status).toBe("dispatched");

      // code_review approves → qa_review conditionally SKIPPED → done
      await completeHop(store, logger, taskId, "done", {
        summary: "Simple null guard — approved",
        agent: "reviewer-agent",
      });

      updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.status).toBe("done");
      expect(updated.frontmatter.workflow?.state.hops["qa_review"]?.status).toBe("skipped");
      expect(updated.frontmatter.workflow?.state.hops["implement"]?.status).toBe("complete");
      expect(updated.frontmatter.workflow?.state.hops["code_review"]?.status).toBe("complete");
    });

    it("routes hotfix (also skip-qa tagged) through the same fast path", async () => {
      const task = await createWorkflowTask(store, tmpDir, "HOTFIX: auth regression in prod", {
        tags: SDLC_TAGS.hotfix,
        metadata: { type: "hotfix", priority: "critical" },
      });
      const taskId = task.frontmatter.id;

      await completeHop(store, logger, taskId, "done", {
        summary: "Regression patched",
        agent: "dev-agent",
      });
      await completeHop(store, logger, taskId, "done", {
        summary: "Hotfix verified — approved",
        agent: "reviewer-agent",
      });

      const updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.status).toBe("done");
      expect(updated.frontmatter.workflow?.state.hops["qa_review"]?.status).toBe("skipped");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario D: Blocked Task with Cascading Impact
  // ───────────────────────────────────────────────────────────────────────────
  describe("Scenario D: Blocked task with cascading impact on dependents", () => {
    it("holds dependent B in backlog while A is blocked; B unblocked when A completes", async () => {
      // Task A: no workflow — pure dependency gating demonstration
      const taskA = await store.create({
        title: "Design API spec for payments",
        createdBy: "sdlc-test",
        routing: { agent: "test-agent" },
        metadata: { reviewRequired: false },
      });

      // Task B: depends on A
      const taskB = await store.create({
        title: "Implement payments API endpoint",
        createdBy: "sdlc-test",
        routing: { agent: "test-agent" },
        dependsOn: [taskA.frontmatter.id],
        metadata: { reviewRequired: false },
      });

      expect(taskA.frontmatter.status).toBe("backlog");
      expect(taskB.frontmatter.status).toBe("backlog");

      // Block A
      await store.block(taskA.frontmatter.id, "waiting for API spec from design team");
      expect((await store.get(taskA.frontmatter.id))?.frontmatter.status).toBe("blocked");

      // Poll: B must stay in backlog
      const pollWhileBlocked = await poll(store, logger, makeSchedulerConfig());
      expect((await store.get(taskB.frontmatter.id))?.frontmatter.status).toBe("backlog");

      // Unblock A
      await store.unblock(taskA.frontmatter.id);
      expect((await store.get(taskA.frontmatter.id))?.frontmatter.status).toBe("ready");

      // Dispatch A
      executor.clear();
      resetThrottleState();
      await poll(store, logger, makeSchedulerConfig());
      expect((await store.get(taskA.frontmatter.id))?.frontmatter.status).toBe("in-progress");

      // Complete A via protocol router
      const inProgressA = await store.get(taskA.frontmatter.id);
      await router.route({
        protocol: "aof",
        version: 1,
        projectId: store.projectId,
        taskId: taskA.frontmatter.id,
        fromAgent: inProgressA?.frontmatter.lease?.agent ?? "test-agent",
        toAgent: "orchestrator",
        sentAt: new Date().toISOString(),
        type: "completion.report",
        payload: {
          outcome: "done",
          summaryRef: "outputs/api-spec.md",
          deliverables: [],
          tests: { total: 5, passed: 5, failed: 0 },
          blockers: [],
          notes: "API spec finalized",
        },
      });

      expect((await store.get(taskA.frontmatter.id))?.frontmatter.status).toBe("done");

      // Poll after A completes: B promoted
      executor.clear();
      resetThrottleState();
      await poll(store, logger, makeSchedulerConfig());

      expect(["ready", "in-progress"]).toContain(
        (await store.get(taskB.frontmatter.id))?.frontmatter.status,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario E: Concurrent Workflow Enforcement
  // ───────────────────────────────────────────────────────────────────────────
  describe("Scenario E: Concurrent workflow enforcement for mixed task types", () => {
    it("routes each of 5 mixed-type tasks through its correct hop path", async () => {
      const f1 = await createWorkflowTask(store, tmpDir, "Feature: add search",
        { tags: SDLC_TAGS.feature, metadata: { type: "feature" } });
      const f2 = await createWorkflowTask(store, tmpDir, "Feature: add exports",
        { tags: SDLC_TAGS.feature, metadata: { type: "feature" } });
      const b1 = await createWorkflowTask(store, tmpDir, "Bugfix: fix login timeout",
        { tags: SDLC_TAGS.bugfix, metadata: { type: "bugfix" } });
      const b2 = await createWorkflowTask(store, tmpDir, "Bugfix: fix CSV export",
        { tags: SDLC_TAGS.bugfix, metadata: { type: "bugfix" } });
      const h1 = await createWorkflowTask(store, tmpDir, "Hotfix: prod crash on login",
        { tags: SDLC_TAGS.hotfix, metadata: { type: "hotfix", priority: "critical" } });

      const allTasks = [f1, f2, b1, b2, h1];

      for (const task of allTasks) {
        const id = task.frontmatter.id;
        const isSkipQa = task.frontmatter.routing.tags?.includes("skip-qa") ?? false;
        const taskType = task.frontmatter.metadata?.["type"] as string;

        await completeHop(store, logger, id, "done", {
          summary: `${taskType}: implementation done`,
          agent: "dev-agent",
        });
        expect((await reloadTask(store, id)).frontmatter.workflow?.state.hops["code_review"]?.status).toBe("dispatched");

        await completeHop(store, logger, id, "done", {
          summary: `${taskType}: code review approved`,
          agent: "reviewer-agent",
        });

        const afterCR = await reloadTask(store, id);

        if (isSkipQa) {
          expect(afterCR.frontmatter.status).toBe("done");
          expect(afterCR.frontmatter.workflow?.state.hops["qa_review"]?.status).toBe("skipped");
        } else {
          expect(afterCR.frontmatter.workflow?.state.hops["qa_review"]?.status).toBe("dispatched");

          await completeHop(store, logger, id, "done", {
            summary: "feature: QA approved",
            agent: "qa-agent",
          });

          const afterQA = await reloadTask(store, id);
          expect(afterQA.frontmatter.status).toBe("done");
        }
      }

      // Verify all tasks completed
      for (const task of allTasks) {
        const final = await reloadTask(store, task.frontmatter.id);
        expect(final.frontmatter.status).toBe("done");
        expect(final.frontmatter.workflow?.state.hops["implement"]?.status).toBe("complete");
        expect(final.frontmatter.workflow?.state.hops["code_review"]?.status).toBe("complete");
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario F: Audit Trail Completeness
  // ───────────────────────────────────────────────────────────────────────────
  describe("Scenario F: Audit trail completeness across a full rejection cycle", () => {
    it("every DAG event has task IDs and hop context", async () => {
      const task = await createWorkflowTask(store, tmpDir, "Feature: rebuild dashboard", {
        tags: SDLC_TAGS.feature,
        metadata: { type: "feature" },
      });
      const taskId = task.frontmatter.id;

      // implement → code_review
      await completeHop(store, logger, taskId, "done", {
        summary: "Dashboard rebuilt with new component library",
        agent: "dev-alice",
      });

      // code_review rejects
      await completeHop(store, logger, taskId, "needs_review", {
        summary: "Several issues found",
        agent: "reviewer-bob",
        blockers: [
          "Accessibility: missing ARIA labels on interactive elements",
          "Performance: no virtualization for large datasets",
        ],
        rejectionNotes: "Dashboard needs accessibility and perf fixes before we can ship",
      });

      // Fix, re-submit, approve, QA
      await completeHop(store, logger, taskId, "done", {
        summary: "ARIA labels added, virtual scroll implemented",
        agent: "dev-alice",
      });
      await completeHop(store, logger, taskId, "done", {
        summary: "All issues resolved — approved",
        agent: "reviewer-bob",
      });
      await completeHop(store, logger, taskId, "done", {
        summary: "Accessibility and perf verified with automated tools",
        agent: "qa-carol",
      });

      const finalTask = await reloadTask(store, taskId);
      expect(finalTask.frontmatter.status).toBe("done");
      expect(finalTask.frontmatter.workflow?.state.status).toBe("complete");

      // Event log must contain DAG events
      const allEvents = await logger.query({ taskId });
      const dagCompletedEvents = allEvents.filter((e) => e.type === "dag.hop_completed");
      const dagRejectedEvents = allEvents.filter((e) => e.type === "dag.hop_rejected");

      // At least: 1st implement, 2nd implement, 1st code_review, 2nd code_review, qa
      expect(dagCompletedEvents.length).toBeGreaterThanOrEqual(4);
      expect(dagRejectedEvents.length).toBeGreaterThanOrEqual(1);

      for (const ev of [...dagCompletedEvents, ...dagRejectedEvents]) {
        expect(ev.taskId).toBe(taskId);
      }
    });
  });
});
