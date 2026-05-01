/**
 * Regression: when the daemon has a ready task but no plugin is attached
 * (SelectingAdapter returns { success: false, error: "no-plugin-attached" }),
 * the scheduler MUST hold the task in `ready/` — not deadletter, not blocked,
 * not retried. Matches PROJECT.md core value: "tasks never get dropped".
 *
 * The `assign-executor` branch on `result.error === "no-plugin-attached"`
 * releases the lease, emits a `dispatch.held` event with
 * `reason: "no-plugin-attached"`, and returns `{ executed: false, failed: false }`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";
import type { GatewayAdapter, TaskContext, SpawnResult, SessionStatus } from "../executor.js";
import type { BaseEvent } from "../../schemas/event.js";

/**
 * Hold-emitting adapter stub: returns the D-12 sentinel on every spawn.
 * Used in place of MockAdapter because MockAdapter maps `setShouldFail(true)`
 * to a free-form `error` string — it cannot emit the exact sentinel
 * `"no-plugin-attached"` required to drive the new branch in assign-executor.
 */
class HoldAdapter implements GatewayAdapter {
  async spawnSession(_ctx: TaskContext): Promise<SpawnResult> {
    return { success: false, error: "no-plugin-attached" };
  }
  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    return { sessionId, alive: false };
  }
  async forceCompleteSession(_sessionId: string): Promise<void> {
    return;
  }
}

describe("BUG-043 D-12: dispatch-hold on no-plugin-attached", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: HoldAdapter;
  let events: BaseEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug043-hold-test-"));

    events = [];
    logger = new EventLogger(join(tmpDir, "events"), {
      onEvent: (event) => events.push(event),
    });

    store = new FilesystemTaskStore(tmpDir, { logger });
    await store.init();

    executor = new HoldAdapter();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("D-12: task stays in `ready/` — NOT deadletter, NOT blocked", async () => {
    const task = await store.create({
      title: "Hold me",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60_000,
      executor,
    });

    const refreshed = await store.get(task.frontmatter.id);
    expect(refreshed?.frontmatter.status).toBe("ready");
  });

  it("D-12: retryCount is NOT incremented (hold ≠ failure)", async () => {
    const task = await store.create({
      title: "No retry on hold",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60_000,
      executor,
    });

    const refreshed = await store.get(task.frontmatter.id);
    expect(refreshed?.frontmatter.metadata?.retryCount).toBeUndefined();
  });

  it("D-12: lease is released after hold (so next poll can re-try)", async () => {
    const task = await store.create({
      title: "Release lease on hold",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60_000,
      executor,
    });

    const refreshed = await store.get(task.frontmatter.id);
    // Lease absent after hold — next poll must be free to retry.
    expect(refreshed?.frontmatter.lease).toBeFalsy();
  });

  it("D-12: emits `dispatch.held` event with reason 'no-plugin-attached'", async () => {
    const task = await store.create({
      title: "Emit held event",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60_000,
      executor,
    });

    const heldEvent = events.find((e) => e.type === "dispatch.held");
    expect(heldEvent).toBeDefined();
    expect(heldEvent?.taskId).toBe(task.frontmatter.id);
    expect(heldEvent?.payload?.reason).toBe("no-plugin-attached");
  });

  it("D-12: no `dispatch.error` emitted (hold is not an error)", async () => {
    const task = await store.create({
      title: "No error on hold",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60_000,
      executor,
    });

    const errorEvent = events.find(
      (e) =>
        e.type === "dispatch.error" &&
        (e as { taskId?: string }).taskId === task.frontmatter.id,
    );
    expect(errorEvent).toBeUndefined();
  });

  it("D-12: scheduler.poll reports hold as neither executed nor failed", async () => {
    const task = await store.create({
      title: "Counted properly",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60_000,
      executor,
    });

    const pollEvent = events.find((e) => e.type === "scheduler.poll");
    expect(pollEvent).toBeDefined();
    // Hold does not count toward dispatched or failed counts.
    expect(pollEvent?.payload?.actionsFailed).toBe(0);
  });
});
