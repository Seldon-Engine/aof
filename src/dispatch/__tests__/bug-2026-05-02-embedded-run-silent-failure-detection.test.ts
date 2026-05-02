/**
 * BUG-2026-05-02: Embedded-run silent failure — OpenClaw's
 * `runEmbeddedPiAgent` swallows the "incomplete turn detected: payloads=0"
 * failure mode (model returns HTTP 200 + stop_reason="stop" with zero
 * content). The error is logged on OpenClaw's side but never propagated
 * back via `meta.error`, so AOF's enforcement path sees a clean run that
 * just "happened to not complete."
 *
 * Without detection, these tasks burn the dispatchFailures budget (3
 * attempts) before deadlettering. Production observation: 16+ such failures
 * in 8 hours, every ~30 min (matching the scheduler poll interval) — most
 * AOF dispatches were silently failing while the system appeared healthy.
 *
 * Fix:
 * - `isLikelyModelSilentFailure(outcome)` heuristic in scheduler-helpers:
 *   true when `outcome.error` is undefined AND `outcome.aborted` is false
 *   AND `outcome.durationMs < 60_000`. Real work-doing tasks take longer
 *   than 60 s; silent-failure runs cluster around 20-50 s.
 * - `handleRunComplete` enforcement path detects the heuristic BEFORE
 *   composing the enforcement reason and stamps
 *   `errorClass = "model_silent_failure"`.
 * - `shouldTransitionToDeadletter` short-circuits on
 *   `errorClass === "model_silent_failure"` (parallel to the existing
 *   `"permanent"` short-circuit) — first occurrence deadletters.
 *
 * See .planning/debug/2026-05-02-embedded-run-empty-response-and-error-propagation.md
 * for the full investigation context. Phase 49E-7 tracks the upstream
 * OpenClaw fix that would obsolete this defensive heuristic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock side-effect helpers so we can focus on the
// detect→stamp→deadletter chain without touching the filesystem.
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

import {
  isLikelyModelSilentFailure,
  SILENT_FAILURE_DURATION_MS_THRESHOLD,
} from "../scheduler-helpers.js";
import { shouldTransitionToDeadletter } from "../failure-tracker.js";
import { handleRunComplete, type OnRunCompleteContext } from "../assign-helpers.js";
import type { AgentRunOutcome } from "../executor.js";
import type { Task } from "../../schemas/task.js";

describe("BUG-2026-05-02 — embedded-run silent failure detection", () => {
  describe("isLikelyModelSilentFailure", () => {
    it("returns true for short clean-meta runs", () => {
      expect(isLikelyModelSilentFailure({ aborted: false, durationMs: 500 })).toBe(true);
      expect(isLikelyModelSilentFailure({ aborted: false, durationMs: 30_000 })).toBe(true);
      expect(isLikelyModelSilentFailure({ aborted: false, durationMs: 48_000 })).toBe(true);
    });

    it("returns false at and above the threshold", () => {
      expect(isLikelyModelSilentFailure({ aborted: false, durationMs: SILENT_FAILURE_DURATION_MS_THRESHOLD })).toBe(false);
      expect(isLikelyModelSilentFailure({ aborted: false, durationMs: 60_001 })).toBe(false);
      expect(isLikelyModelSilentFailure({ aborted: false, durationMs: 600_000 })).toBe(false);
    });

    it("returns false when an explicit error is set (already classifiable)", () => {
      expect(
        isLikelyModelSilentFailure({
          aborted: false,
          durationMs: 1_000,
          error: { kind: "exception", message: "anything" },
        }),
      ).toBe(false);
    });

    it("returns false when the run was aborted", () => {
      expect(isLikelyModelSilentFailure({ aborted: true, durationMs: 500 })).toBe(false);
    });
  });

  describe("shouldTransitionToDeadletter short-circuits on model_silent_failure", () => {
    function fakeTask(metadata: Record<string, unknown>): Task {
      return { frontmatter: { metadata } } as unknown as Task;
    }

    it("returns true on first occurrence (no retry budget burn)", () => {
      expect(
        shouldTransitionToDeadletter(
          fakeTask({ errorClass: "model_silent_failure", dispatchFailures: 0 }),
        ),
      ).toBe(true);
      expect(
        shouldTransitionToDeadletter(
          fakeTask({ errorClass: "model_silent_failure", dispatchFailures: 1 }),
        ),
      ).toBe(true);
    });

    it("does not regress the existing permanent and threshold paths", () => {
      expect(
        shouldTransitionToDeadletter(
          fakeTask({ errorClass: "permanent", dispatchFailures: 0 }),
        ),
      ).toBe(true);
      expect(
        shouldTransitionToDeadletter(
          fakeTask({ errorClass: "transient", dispatchFailures: 0 }),
        ),
      ).toBe(false);
      expect(
        shouldTransitionToDeadletter(
          fakeTask({ errorClass: "transient", dispatchFailures: 3 }),
        ),
      ).toBe(true);
    });
  });

  describe("handleRunComplete classifies and deadletters silent-failure runs on first occurrence", () => {
    let store: any;
    let logger: any;
    let baseCtx: OnRunCompleteContext;
    let savedTasks: Array<Task>;

    beforeEach(() => {
      vi.clearAllMocks();
      savedTasks = [];

      const taskState: Task = {
        frontmatter: {
          id: "task-silent-1",
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
        path: "/tmp/tasks/in-progress/task-silent-1.md",
      } as unknown as Task;

      store = {
        tasksDir: "/tmp/tasks",
        get: vi.fn(async () => taskState),
        transition: vi.fn(async (_id: string, status: string) => {
          taskState.frontmatter.status = status as Task["frontmatter"]["status"];
        }),
        save: vi.fn(async (t: Task) => {
          taskState.frontmatter.metadata = { ...t.frontmatter.metadata };
          savedTasks.push(JSON.parse(JSON.stringify(t)));
        }),
      };
      logger = { log: vi.fn().mockResolvedValue(undefined) };

      baseCtx = {
        action: {
          type: "assign" as const,
          taskId: "task-silent-1",
          taskTitle: "test",
          agent: "researcher",
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
        correlationId: "corr-silent-1",
        allTasks: [],
        executor: {} as any,
      } as OnRunCompleteContext;
    });

    it("deadletters a 48s clean-meta run on first occurrence", async () => {
      // Reproduces the production shape from TASK-2026-05-02-Kmxfd5iy:
      // OpenClaw embedded runner returns success=true, no error, run lasted ~48s,
      // task is still in-progress because aof_task_complete was never called.
      const outcome: AgentRunOutcome = {
        taskId: "task-silent-1",
        sessionId: "session-silent-1",
        success: true,
        aborted: false,
        durationMs: 48_032,
      };

      await handleRunComplete(baseCtx, outcome);

      const lastSavedMeta = savedTasks.at(-1)?.frontmatter.metadata;
      expect(lastSavedMeta).toMatchObject({
        errorClass: "model_silent_failure",
        enforcementReason: expect.stringContaining("Likely model silent failure"),
      });

      expect(store.transition).toHaveBeenCalledWith(
        "task-silent-1",
        "deadletter",
        expect.any(Object),
      );
      expect(store.transition).not.toHaveBeenCalledWith(
        "task-silent-1",
        "blocked",
        expect.any(Object),
      );
    });

    it("does not flag long-running clean-meta runs (likely real agent forgot)", async () => {
      const outcome: AgentRunOutcome = {
        taskId: "task-silent-1",
        sessionId: "session-silent-2",
        success: true,
        aborted: false,
        durationMs: 600_000, // 10 min — agent did real work but forgot to complete
      };

      await handleRunComplete(baseCtx, outcome);

      const lastSavedMeta = savedTasks.at(-1)?.frontmatter.metadata;
      // No silent-failure classification — falls through to existing path
      expect(lastSavedMeta?.errorClass).toBeUndefined();
      expect(lastSavedMeta?.enforcementReason).toEqual(
        expect.stringContaining("agent exited without calling aof_task_complete"),
      );

      // Goes to blocked, not deadletter (still has 2 attempts left in the budget)
      expect(store.transition).toHaveBeenCalledWith(
        "task-silent-1",
        "blocked",
        expect.any(Object),
      );
    });

    it("does not interfere with explicit-error classification", async () => {
      // Real OpenClaw error case (e.g. credential miss) — the existing
      // permanent classification path still wins.
      const outcome: AgentRunOutcome = {
        taskId: "task-silent-1",
        sessionId: "session-silent-3",
        success: false,
        aborted: false,
        durationMs: 1_000, // very short, but explicit error present
        error: {
          kind: "exception",
          message: 'No credentials found for profile "openai:default".',
        },
      };

      await handleRunComplete(baseCtx, outcome);

      const lastSavedMeta = savedTasks.at(-1)?.frontmatter.metadata;
      expect(lastSavedMeta?.errorClass).toBe("permanent");
      expect(lastSavedMeta?.enforcementReason).toEqual(
        expect.stringContaining("No credentials found"),
      );
    });
  });
});
