/**
 * Tests for completion enforcement in assign-executor.ts.
 *
 * When an agent exits without calling aof_task_complete, the task is
 * blocked (not auto-completed) and the failure is tracked. After 3
 * enforcement failures the task transitions to deadletter.
 *
 * Phase 25: Completion Enforcement
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import type { BaseEvent } from "../../schemas/event.js";
import type { AgentRunOutcome, GatewayAdapter, SpawnResult, SessionStatus, TaskContext } from "../executor.js";
import { executeAssignAction } from "../assign-executor.js";
import type { DispatchConfig, SchedulerAction } from "../task-dispatcher.js";

// Helper: create a minimal task file on disk
async function createTask(
  testDir: string,
  taskId: string,
  status: string = "ready",
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const dir = join(testDir, "tasks", status);
  await mkdir(dir, { recursive: true });
  const content = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task ${taskId}
status: ${status}
priority: normal
createdAt: 2026-01-01T00:00:00Z
updatedAt: 2026-01-01T00:00:00Z
lastTransitionAt: 2026-01-01T00:00:00Z
createdBy: system
routing:
  team: backend
  role: developer
  tags: []
metadata: ${JSON.stringify(metadata)}
---

Test task body
`;
  await writeFile(join(dir, `${taskId}.md`), content);
}

// Helper: build a SchedulerAction
function buildAction(taskId: string, agent: string = "test-agent"): SchedulerAction {
  return {
    type: "assign",
    taskId,
    taskTitle: "test task",
    agent,
    reason: "test",
  };
}

// Capture-style mock executor that lets us invoke onRunComplete manually
class CaptureAdapter implements GatewayAdapter {
  capturedOnRunComplete: ((outcome: AgentRunOutcome) => void | Promise<void>) | undefined;
  capturedCorrelationId: string | undefined;

  async spawnSession(
    _context: TaskContext,
    opts?: {
      timeoutMs?: number;
      correlationId?: string;
      onRunComplete?: (outcome: AgentRunOutcome) => void | Promise<void>;
    },
  ): Promise<SpawnResult> {
    this.capturedOnRunComplete = opts?.onRunComplete;
    this.capturedCorrelationId = opts?.correlationId;
    return { success: true, sessionId: "mock-session-123" };
  }

  async getSessionStatus(_sessionId: string): Promise<SessionStatus> {
    return { sessionId: _sessionId, alive: false };
  }

  async forceCompleteSession(_sessionId: string): Promise<void> {}
}

describe("Completion Enforcement (top-level)", () => {
  let testDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let capturedEvents: BaseEvent[];
  let adapter: CaptureAdapter;
  let config: DispatchConfig;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "aof-enforcement-test-"));
    await mkdir(join(testDir, "tasks", "ready"), { recursive: true });
    await mkdir(join(testDir, "tasks", "in-progress"), { recursive: true });
    await mkdir(join(testDir, "tasks", "blocked"), { recursive: true });
    await mkdir(join(testDir, "tasks", "review"), { recursive: true });
    await mkdir(join(testDir, "tasks", "done"), { recursive: true });
    await mkdir(join(testDir, "tasks", "deadletter"), { recursive: true });
    await mkdir(join(testDir, "events"), { recursive: true });

    capturedEvents = [];
    store = new FilesystemTaskStore(testDir, { projectId: "test" });
    logger = new EventLogger(join(testDir, "events"), {
      onEvent: (event) => capturedEvents.push(event),
    });

    adapter = new CaptureAdapter();
    config = {
      dataDir: testDir,
      dryRun: false,
      executor: adapter,
      maxConcurrentDispatches: 3,
      defaultLeaseTtlMs: 60_000,
      spawnTimeoutMs: 30_000,
    };
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // Helper to dispatch and get onRunComplete
  async function dispatchAndCapture(taskId: string): Promise<(outcome: AgentRunOutcome) => void | Promise<void>> {
    const task = await store.get(taskId);
    await executeAssignAction(
      buildAction(taskId),
      store,
      logger,
      config,
      task ? [task] : [],
    );
    expect(adapter.capturedOnRunComplete).toBeDefined();
    return adapter.capturedOnRunComplete!;
  }

  it("Test 1: task in-progress after agent success -> transitions to blocked (not review/done)", async () => {
    const taskId = "TASK-2026-03-07-101";
    await createTask(testDir, taskId, "ready");

    const onRunComplete = await dispatchAndCapture(taskId);

    // Fire onRunComplete with success=true while task is still in-progress.
    // Use a duration above SILENT_FAILURE_DURATION_MS_THRESHOLD (60s) so this
    // exercises the "real agent did work but forgot to complete" path, not
    // the silent-failure heuristic (which deadletters on first occurrence).
    // See bug-2026-05-02-embedded-run-silent-failure-detection.test.ts.
    await onRunComplete({
      taskId,
      sessionId: "mock-session-123",
      success: true,
      aborted: false,
      durationMs: 600_000,
    });

    const task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("blocked");
    // Must NOT be review or done
    expect(task?.frontmatter.status).not.toBe("review");
    expect(task?.frontmatter.status).not.toBe("done");
  });

  it("Test 2: trackDispatchFailure is called with enforcement reason", async () => {
    const taskId = "TASK-2026-03-07-102";
    await createTask(testDir, taskId, "ready");

    const onRunComplete = await dispatchAndCapture(taskId);

    await onRunComplete({
      taskId,
      sessionId: "mock-session-123",
      success: true,
      aborted: false,
      durationMs: 600_000, // >60s — real-agent-forgot path, not silent-failure
    });

    const task = await store.get(taskId);
    // trackDispatchFailure increments dispatchFailures
    expect(task?.frontmatter.metadata.dispatchFailures).toBe(1);
    expect(task?.frontmatter.metadata.lastDispatchFailureReason).toContain("agent exited without calling aof_task_complete");
  });

  it("Test 3: enforcement reason includes durationMs and aof trace reference", async () => {
    const taskId = "TASK-2026-03-07-103";
    await createTask(testDir, taskId, "ready");

    const onRunComplete = await dispatchAndCapture(taskId);

    await onRunComplete({
      taskId,
      sessionId: "mock-session-123",
      success: true,
      aborted: false,
      durationMs: 750_000, // 12.5min — real-agent-forgot path, not silent-failure
    });

    const task = await store.get(taskId);
    const reason = task?.frontmatter.metadata.enforcementReason as string;
    expect(reason).toBeDefined();
    expect(reason).toContain("750.0s");
    expect(reason).toContain(`aof trace ${taskId}`);
  });

  it("Test 4: enforcement metadata (enforcementReason, enforcementAt) stored on task", async () => {
    const taskId = "TASK-2026-03-07-104";
    await createTask(testDir, taskId, "ready");

    const onRunComplete = await dispatchAndCapture(taskId);

    await onRunComplete({
      taskId,
      sessionId: "mock-session-123",
      success: true,
      aborted: false,
      durationMs: 300_000, // 5min — real-agent-forgot path, not silent-failure
    });

    const task = await store.get(taskId);
    expect(task?.frontmatter.metadata.enforcementReason).toBeDefined();
    expect(typeof task?.frontmatter.metadata.enforcementReason).toBe("string");
    expect(task?.frontmatter.metadata.enforcementAt).toBeDefined();
    // enforcementAt should be an ISO timestamp
    const at = task?.frontmatter.metadata.enforcementAt as string;
    expect(new Date(at).toISOString()).toBe(at);
  });

  it("Test 5: completion.enforcement event emitted with correct payload", async () => {
    const taskId = "TASK-2026-03-07-105";
    await createTask(testDir, taskId, "ready");

    const onRunComplete = await dispatchAndCapture(taskId);

    await onRunComplete({
      taskId,
      sessionId: "mock-session-123",
      success: true,
      aborted: false,
      durationMs: 400_000, // 6.7min — real-agent-forgot path, not silent-failure
    });

    const enforcementEvents = capturedEvents.filter(e => e.type === "completion.enforcement");
    expect(enforcementEvents.length).toBeGreaterThanOrEqual(1);

    const evt = enforcementEvents[0]!;
    expect(evt.taskId).toBe(taskId);
    expect(evt.payload.agent).toBe("test-agent");
    expect(evt.payload.sessionId).toBe("mock-session-123");
    expect(evt.payload.durationMs).toBe(400_000);
    expect(evt.payload.correlationId).toBeDefined();
    expect(evt.payload.reason).toBe("agent_exited_without_completion");
  });

  it("Test 6: after 3 enforcement failures, task transitions to deadletter", async () => {
    const taskId = "TASK-2026-03-07-106";
    // Pre-seed with 2 dispatch failures so the next one triggers deadletter
    await createTask(testDir, taskId, "ready", { dispatchFailures: 2 });

    const onRunComplete = await dispatchAndCapture(taskId);

    await onRunComplete({
      taskId,
      sessionId: "mock-session-123",
      success: true,
      aborted: false,
      durationMs: 1000,
    });

    const task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("deadletter");
  });

  it("Test 7: if task not in-progress (agent called aof_task_complete), no enforcement", async () => {
    const taskId = "TASK-2026-03-07-107";
    await createTask(testDir, taskId, "ready");

    const onRunComplete = await dispatchAndCapture(taskId);

    // Simulate the agent calling aof_task_complete (moves task to done)
    await store.transition(taskId, "review", { reason: "agent completed" });
    await store.transition(taskId, "done", { reason: "agent completed" });

    // Now fire onRunComplete — should do nothing
    await onRunComplete({
      taskId,
      sessionId: "mock-session-123",
      success: true,
      aborted: false,
      durationMs: 2000,
    });

    const task = await store.get(taskId);
    // Task should still be done, not blocked
    expect(task?.frontmatter.status).toBe("done");

    // No enforcement events
    const enforcementEvents = capturedEvents.filter(e => e.type === "completion.enforcement");
    expect(enforcementEvents).toHaveLength(0);
  });

  it("Test 8: failure branch (outcome.success=false) still transitions to blocked", async () => {
    const taskId = "TASK-2026-03-07-108";
    await createTask(testDir, taskId, "ready");

    const onRunComplete = await dispatchAndCapture(taskId);

    await onRunComplete({
      taskId,
      sessionId: "mock-session-123",
      success: false,
      aborted: false,
      error: { kind: "runtime", message: "Agent crashed" },
      durationMs: 500,
    });

    const task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("blocked");
  });
});
