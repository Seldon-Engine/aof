/**
 * Phase 999.3 — bug-2026-04-15 regression.
 *
 * Production incident TASK-2026-04-15-010: two unrelated handlers responded
 * to the same underlying session-end signal within the same event-loop tick.
 *
 *   1. assign-helpers.ts:111 (in-process completion enforcement) reacted to a
 *      Promise.race timeout and called store.transition(id, "blocked").
 *   2. recovery-handlers.ts handleStaleHeartbeat (scheduler poll) reacted to
 *      the heartbeat TTL expiring and would have called store.transition
 *      (id, "ready") — even though by the time the action ran, the task
 *      had already moved to "blocked".
 *
 * Fix A (v1.14.8) — per-task transition mutex inside store.transition —
 * mechanically serialized the two renames so the filesystem ended up
 * consistent. But the second handler still ran and still re-transitioned
 * the task on stale intent, undoing the first handler's decision.
 *
 * Phase 999.3 (this regression test) — handleStaleHeartbeat now re-reads
 * the task at function entry and short-circuits when status is no longer
 * "in-progress". The handler does not call store.transition; the task's
 * "blocked" status is preserved.
 */

import { describe, it, expect, afterEach } from "vitest";
import { handleStaleHeartbeat } from "../recovery-handlers.js";
import { createTestHarness, type TestHarness } from "../../testing/harness.js";
import type { SchedulerAction, SchedulerConfig } from "../scheduler.js";

let harness: TestHarness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

describe("bug-2026-04-15: stale_heartbeat precondition guard", () => {
  it("no-ops when the task moved away from in-progress between queue-time and execute-time", async () => {
    harness = await createTestHarness("aof-bug-2026-04-15-");
    const { store, logger } = harness;

    // Walk the task to in-progress (the state the scheduler observed when
    // it queued the stale_heartbeat action).
    const task = await store.create({
      title: "stale-heartbeat race candidate",
      body: "b",
      createdBy: "test",
      routing: { agent: "swe-backend" },
    });
    const id = task.frontmatter.id;
    await store.transition(id, "ready");
    await store.transition(id, "in-progress");

    const action: SchedulerAction = {
      type: "stale_heartbeat",
      taskId: id,
      taskTitle: task.frontmatter.title,
      agent: "swe-backend",
      reason: "stale heartbeat",
    };

    // The race winner — assign-helpers' completion enforcement transitions
    // the task to "blocked" before our action gets dispatched.
    await store.transition(id, "blocked");

    const config: SchedulerConfig = {
      dataDir: harness.tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60_000,
    };

    const result = await handleStaleHeartbeat(action, store, logger, config);

    // Post-fix: handler short-circuits without mutating.
    expect(result).toEqual({ executed: false, failed: false });

    const after = await store.get(id);
    expect(after?.frontmatter.status).toBe("blocked");
  });

  it("no-ops when the lease was reassigned to a different agent before execution", async () => {
    harness = await createTestHarness("aof-bug-2026-04-15-lease-");
    const { store, logger } = harness;

    const task = await store.create({
      title: "lease-reassignment race candidate",
      body: "b",
      createdBy: "test",
      routing: { agent: "agent-1" },
    });
    const id = task.frontmatter.id;
    await store.transition(id, "ready");
    await store.transition(id, "in-progress");

    // The task currently holds no lease; install one for "agent-2" to
    // mimic a reassignment after the action was queued for "agent-1".
    const current = await store.get(id);
    expect(current).toBeDefined();
    current!.frontmatter.lease = {
      agent: "agent-2",
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      renewCount: 0,
    };
    await store.save(current!);

    const action: SchedulerAction = {
      type: "stale_heartbeat",
      taskId: id,
      taskTitle: task.frontmatter.title,
      agent: "agent-1", // queued for agent-1; lease is now agent-2
      reason: "stale heartbeat",
    };

    const config: SchedulerConfig = {
      dataDir: harness.tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60_000,
    };

    const result = await handleStaleHeartbeat(action, store, logger, config);

    expect(result).toEqual({ executed: false, failed: false });

    // Status untouched; lease untouched.
    const after = await store.get(id);
    expect(after?.frontmatter.status).toBe("in-progress");
    expect(after?.frontmatter.lease?.agent).toBe("agent-2");
  });
});
