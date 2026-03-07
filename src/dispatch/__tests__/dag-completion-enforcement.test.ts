/**
 * Tests for DAG hop completion enforcement in dag-transition-handler.ts.
 *
 * When a DAG hop agent exits without calling aof_task_complete, the hop
 * is failed and the parent task's dispatch failure count is incremented.
 * After 3 enforcement failures, the parent task transitions to deadletter.
 *
 * Phase 25: Completion Enforcement
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import type { BaseEvent } from "../../schemas/event.js";
import type { AgentRunOutcome, GatewayAdapter, SpawnResult, SessionStatus, TaskContext } from "../executor.js";
import { dispatchDAGHop } from "../dag-transition-handler.js";

// Capture adapter that records onRunComplete callback
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
    return { success: true, sessionId: "mock-dag-session-456" };
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    return { sessionId, alive: false };
  }

  async forceCompleteSession(_sessionId: string): Promise<void> {}
}

// Helper: create a DAG task with a single hop
async function createDAGTask(
  testDir: string,
  taskId: string,
  hopId: string,
  hopStatus: string = "ready",
  metadata: Record<string, unknown> = {},
): Promise<string> {
  const dir = join(testDir, "tasks", "in-progress");
  await mkdir(dir, { recursive: true });
  // Create work dir for hop
  await mkdir(join(dir, "work", hopId), { recursive: true });

  const content = `---
schemaVersion: 1
id: ${taskId}
project: test
title: DAG Task ${taskId}
status: in-progress
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
workflow:
  definition:
    name: test-workflow
    hops:
      - id: ${hopId}
        role: coder
        autoAdvance: true
  state:
    status: running
    hops:
      ${hopId}:
        status: ${hopStatus}
---

DAG task body
`;
  const filePath = join(dir, `${taskId}.md`);
  await writeFile(filePath, content);
  return filePath;
}

describe("DAG Hop Completion Enforcement", () => {
  let testDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let capturedEvents: BaseEvent[];
  let adapter: CaptureAdapter;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "aof-dag-enforcement-test-"));
    await mkdir(join(testDir, "tasks", "ready"), { recursive: true });
    await mkdir(join(testDir, "tasks", "in-progress"), { recursive: true });
    await mkdir(join(testDir, "tasks", "blocked"), { recursive: true });
    await mkdir(join(testDir, "tasks", "deadletter"), { recursive: true });
    await mkdir(join(testDir, "events"), { recursive: true });

    capturedEvents = [];
    store = new FilesystemTaskStore(testDir, { projectId: "test" });
    logger = new EventLogger(join(testDir, "events"), {
      onEvent: (event) => capturedEvents.push(event),
    });

    adapter = new CaptureAdapter();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("Test 1: dispatchDAGHop passes onRunComplete to executor.spawnSession", async () => {
    const taskId = "TASK-2026-03-07-201";
    const hopId = "hop-build";
    const filePath = await createDAGTask(testDir, taskId, hopId);

    const task = await store.get(taskId);
    expect(task).toBeDefined();

    await dispatchDAGHop(store, logger, { spawnTimeoutMs: 30_000 }, adapter, task!, hopId);

    // onRunComplete should have been captured
    expect(adapter.capturedOnRunComplete).toBeDefined();
  });

  it("Test 2: hop agent exits without completion -> hop failed, trackDispatchFailure called on parent", async () => {
    const taskId = "TASK-2026-03-07-202";
    const hopId = "hop-build";
    await createDAGTask(testDir, taskId, hopId);

    const task = await store.get(taskId);
    expect(task).toBeDefined();

    await dispatchDAGHop(store, logger, { spawnTimeoutMs: 30_000 }, adapter, task!, hopId);

    // Fire onRunComplete to simulate agent exit without aof_task_complete
    await adapter.capturedOnRunComplete!({
      taskId,
      sessionId: "mock-dag-session-456",
      success: true,
      aborted: false,
      durationMs: 8000,
    });

    const updatedTask = await store.get(taskId);
    // Dispatch failure should be tracked on the parent task
    expect(updatedTask?.frontmatter.metadata.dispatchFailures).toBe(1);
    expect(updatedTask?.frontmatter.metadata.lastDispatchFailureReason).toContain(
      "agent exited without calling aof_task_complete",
    );

    // Hop should be marked as failed
    const hopState = updatedTask?.frontmatter.workflow?.state.hops[hopId];
    expect(hopState?.status).toBe("failed");
  });

  it("Test 3: completion.enforcement event emitted with hopId in payload", async () => {
    const taskId = "TASK-2026-03-07-203";
    const hopId = "hop-review";
    await createDAGTask(testDir, taskId, hopId);

    const task = await store.get(taskId);
    await dispatchDAGHop(store, logger, { spawnTimeoutMs: 30_000 }, adapter, task!, hopId);

    await adapter.capturedOnRunComplete!({
      taskId,
      sessionId: "mock-dag-session-456",
      success: true,
      aborted: false,
      durationMs: 5000,
    });

    const enforcementEvents = capturedEvents.filter(e => e.type === "completion.enforcement");
    expect(enforcementEvents.length).toBeGreaterThanOrEqual(1);

    const evt = enforcementEvents[0]!;
    expect(evt.taskId).toBe(taskId);
    expect(evt.payload.hopId).toBe(hopId);
    expect(evt.payload.reason).toBe("agent_exited_without_completion");
  });

  it("Test 4: after 3 enforcement failures, parent task transitions to deadletter", async () => {
    const taskId = "TASK-2026-03-07-204";
    const hopId = "hop-build";
    // Pre-seed with 2 dispatch failures
    await createDAGTask(testDir, taskId, hopId, "ready", { dispatchFailures: 2 });

    const task = await store.get(taskId);
    await dispatchDAGHop(store, logger, { spawnTimeoutMs: 30_000 }, adapter, task!, hopId);

    await adapter.capturedOnRunComplete!({
      taskId,
      sessionId: "mock-dag-session-456",
      success: true,
      aborted: false,
      durationMs: 2000,
    });

    const updatedTask = await store.get(taskId);
    expect(updatedTask?.frontmatter.status).toBe("deadletter");
  });

  it("Test 5: if hop already completed, no enforcement action taken", async () => {
    const taskId = "TASK-2026-03-07-205";
    const hopId = "hop-build";
    await createDAGTask(testDir, taskId, hopId);

    const task = await store.get(taskId);
    await dispatchDAGHop(store, logger, { spawnTimeoutMs: 30_000 }, adapter, task!, hopId);

    // Simulate agent calling aof_task_complete: hop status changes to "completed"
    const freshTask = await store.get(taskId);
    if (freshTask?.frontmatter.workflow) {
      freshTask.frontmatter.workflow.state.hops[hopId] = {
        ...freshTask.frontmatter.workflow.state.hops[hopId]!,
        status: "completed",
      };
      const { serializeTask } = await import("../../store/task-store.js");
      const writeFileAtomic = (await import("write-file-atomic")).default;
      await writeFileAtomic(freshTask.path!, serializeTask(freshTask));
    }

    // Fire onRunComplete — should be a no-op
    await adapter.capturedOnRunComplete!({
      taskId,
      sessionId: "mock-dag-session-456",
      success: true,
      aborted: false,
      durationMs: 3000,
    });

    const updatedTask = await store.get(taskId);
    // No dispatch failure tracked
    expect(updatedTask?.frontmatter.metadata.dispatchFailures ?? 0).toBe(0);
    // No enforcement events
    const enforcementEvents = capturedEvents.filter(e => e.type === "completion.enforcement");
    expect(enforcementEvents).toHaveLength(0);
  });
});
