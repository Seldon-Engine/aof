/**
 * BUG-2026-04-28: Credential resolution failures (env-ref'd profile lookup
 * misses, missing API keys) were classified as "transient" and burned the
 * full retry budget before deadlettering — ~30 minutes wasted per
 * occurrence on a deterministic config error that won't fix itself.
 *
 * Two compounding gaps:
 *
 * 1. `PERMANENT_ERROR_PATTERNS` (`scheduler-helpers.ts`) covered
 *    "unauthorized" / "forbidden" but not the "no credentials found" /
 *    "no api key found" shapes the OpenClaw runner actually emits via
 *    its run-complete callback.
 *
 * 2. `handleRunComplete` (`assign-helpers.ts`) never invoked
 *    `classifySpawnError` on the callback's error message.
 *    `errorClass` therefore stayed unset (defaults to "unknown") even
 *    when the underlying error was deterministically permanent, and
 *    `shouldTransitionToDeadletter` only checked failure count — so
 *    permanent errors cycled `blocked → ready → blocked` for three
 *    full lease windows (~30 min) before deadlettering.
 *
 * Fix:
 * - Extend PERMANENT_ERROR_PATTERNS with credential / api-key shapes.
 * - Classify outcome.error.message in handleRunComplete and stamp
 *   metadata.errorClass before the deadletter check.
 * - shouldTransitionToDeadletter short-circuits when
 *   errorClass === "permanent" so config errors deadletter on
 *   failure 1.
 *
 * See .planning/debug/2026-04-28-aof-dispatch-ghosting-and-worker-hygiene.md
 * for the full investigation context.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock side-effect helpers so we can focus on the
// classify→stamp→deadletter chain without touching the filesystem.
vi.mock("../trace-helpers.js", () => ({
  captureTraceSafely: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../callback-helpers.js", () => ({
  deliverAllCallbacksSafely: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lease-manager.js", () => ({
  stopLeaseRenewal: vi.fn(),
}));

// Suppress structured logger noise.
vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
    warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(),
  }),
}));

// We deliberately do NOT mock failure-tracker — that's the unit under
// integration test. trackDispatchFailure must increment the counter on
// the in-memory store, and shouldTransitionToDeadletter must observe
// the freshly-stamped errorClass.

import { classifySpawnError } from "../scheduler-helpers.js";
import { shouldTransitionToDeadletter } from "../failure-tracker.js";
import { handleRunComplete, type OnRunCompleteContext } from "../assign-helpers.js";
import type { AgentRunOutcome } from "../executor.js";
import type { Task } from "../../schemas/task.js";

describe("BUG-2026-04-28 — credential error classification", () => {
  describe("classifySpawnError covers credential/api-key shapes", () => {
    it.each([
      `No credentials found for profile "openai:default".`,
      `Agent error: exception: No credentials found for profile "openai:default".`,
      `No API key found for provider "openai"`,
      `Missing credentials for openrouter`,
      `Missing API key`,
      `Invalid API key provided`,
    ])("returns 'permanent' for %j", (message) => {
      expect(classifySpawnError(message)).toBe("permanent");
    });

    it("still treats network errors as transient", () => {
      expect(classifySpawnError("ECONNRESET")).toBe("transient");
      expect(classifySpawnError("connection timed out")).toBe("transient");
    });

    it("does not regress existing permanent patterns", () => {
      expect(classifySpawnError("agent not found")).toBe("permanent");
      expect(classifySpawnError("Permission denied")).toBe("permanent");
      expect(classifySpawnError("Unauthorized")).toBe("permanent");
    });
  });

  describe("shouldTransitionToDeadletter short-circuits on permanent errorClass", () => {
    function fakeTask(metadata: Record<string, unknown>): Task {
      return { frontmatter: { metadata } } as unknown as Task;
    }

    it("returns true when errorClass=permanent even on the first failure", () => {
      expect(shouldTransitionToDeadletter(fakeTask({ errorClass: "permanent", dispatchFailures: 0 }))).toBe(true);
      expect(shouldTransitionToDeadletter(fakeTask({ errorClass: "permanent", dispatchFailures: 1 }))).toBe(true);
    });

    it("still respects threshold for transient errors", () => {
      expect(shouldTransitionToDeadletter(fakeTask({ errorClass: "transient", dispatchFailures: 0 }))).toBe(false);
      expect(shouldTransitionToDeadletter(fakeTask({ errorClass: "transient", dispatchFailures: 3 }))).toBe(true);
    });

    it("preserves pre-fix behavior when errorClass is unset", () => {
      expect(shouldTransitionToDeadletter(fakeTask({ dispatchFailures: 0 }))).toBe(false);
      expect(shouldTransitionToDeadletter(fakeTask({ dispatchFailures: 3 }))).toBe(true);
    });
  });

  describe("handleRunComplete stamps errorClass and routes credential failures straight to deadletter", () => {
    let store: any;
    let logger: any;
    let baseCtx: OnRunCompleteContext;
    let savedTasks: Array<Task>;

    beforeEach(() => {
      vi.clearAllMocks();
      savedTasks = [];

      // In-memory task that mutates as save() is called, so subsequent
      // get() reflects writes — exercises the real classify→stamp→deadletter
      // pipeline including the inter-step re-reads.
      const taskState: Task = {
        frontmatter: {
          id: "task-cred-1",
          schemaVersion: 1,
          title: "test",
          status: "in-progress",
          priority: "normal",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastTransitionAt: new Date().toISOString(),
          createdBy: "test",
          contentHash: "abcd",
          dependsOn: [],
          gateHistory: [],
          tests: [],
          metadata: { dispatchFailures: 0 },
        },
        body: "",
        path: "/tmp/tasks/in-progress/task-cred-1.md",
      } as unknown as Task;

      store = {
        tasksDir: "/tmp/tasks",
        get: vi.fn(async () => taskState),
        transition: vi.fn(async (_id: string, status: string) => {
          taskState.frontmatter.status = status as Task["frontmatter"]["status"];
        }),
        save: vi.fn(async (t: Task) => {
          // mimic the real store: persist the merged metadata
          taskState.frontmatter.metadata = { ...t.frontmatter.metadata };
          savedTasks.push(JSON.parse(JSON.stringify(t)));
        }),
      };
      logger = { log: vi.fn().mockResolvedValue(undefined) };

      baseCtx = {
        action: {
          type: "assign" as const,
          taskId: "task-cred-1",
          taskTitle: "test",
          agent: "swe-architect",
          reason: "ready",
        },
        store,
        logger,
        config: {
          dataDir: "/tmp",
          dryRun: false,
          executor: {} as any,
          maxConcurrentDispatches: 3,
          defaultLeaseTtlMs: 60000,
        },
        correlationId: "corr-cred-1",
        effectiveConcurrencyLimitRef: { value: null },
        allTasks: [],
        executor: {} as any,
      } as OnRunCompleteContext;
    });

    it("classifies 'No credentials found for profile' as permanent and deadletters on first failure", async () => {
      const outcome: AgentRunOutcome = {
        taskId: "task-cred-1",
        sessionId: "session-cred-1",
        success: false,
        aborted: false,
        error: {
          kind: "exception",
          message: 'No credentials found for profile "openai:default".',
        },
        durationMs: 500,
      };

      await handleRunComplete(baseCtx, outcome);

      // errorClass stamped on the task by handleRunComplete before the
      // deadletter decision. Captured via the in-memory store's save log.
      const lastSavedMeta = savedTasks.at(-1)?.frontmatter.metadata;
      expect(lastSavedMeta).toMatchObject({
        errorClass: "permanent",
        enforcementReason: expect.stringContaining("No credentials found for profile"),
      });

      // Should have deadlettered, NOT transitioned to blocked.
      // We assert the final status is "deadletter" via the in-memory store.
      // (transitionToDeadletter calls store.transition under the hood.)
      expect(store.transition).toHaveBeenCalledWith(
        "task-cred-1",
        "deadletter",
        expect.any(Object),
      );
      expect(store.transition).not.toHaveBeenCalledWith(
        "task-cred-1",
        "blocked",
        expect.any(Object),
      );
    });

    it("does NOT short-circuit for transient errors — they still go to blocked on failure 1", async () => {
      const outcome: AgentRunOutcome = {
        taskId: "task-cred-1",
        sessionId: "session-cred-1",
        success: false,
        aborted: false,
        error: { kind: "exception", message: "ECONNRESET" },
        durationMs: 500,
      };

      await handleRunComplete(baseCtx, outcome);

      expect(store.transition).toHaveBeenCalledWith(
        "task-cred-1",
        "blocked",
        expect.any(Object),
      );
      expect(store.transition).not.toHaveBeenCalledWith(
        "task-cred-1",
        "deadletter",
        expect.any(Object),
      );
    });
  });
});
