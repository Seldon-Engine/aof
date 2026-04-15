/**
 * Regression tests for the "duplicate task ID" race.
 *
 * Scenario: two async code paths both observe a task in some status S
 * and concurrently call `store.transition(id, A)` and `store.transition(id, B)`.
 *
 * Before the per-task mutex (see src/store/task-lock.ts), this would
 * leave the same task file in TWO status directories simultaneously —
 * every subsequent `store.get(id)` would throw
 * "Duplicate task ID detected: <id> exists in multiple statuses (…)"
 * until operator intervention.
 *
 * After the mutex, concurrent transitions serialize: the late contender
 * re-reads fresh state inside `transitionTask` and either no-ops (if
 * already in target), throws `Invalid transition`, or performs a valid
 * follow-up transition — always leaving a single canonical file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../task-store.js";

// Suppress the structured logger (matches pattern used elsewhere in this
// directory's tests).
vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
    warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(),
  }),
}));

describe("FilesystemTaskStore — concurrent transition race", () => {
  let tmpDir: string;
  let store: FilesystemTaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-concurrent-transition-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function countTaskFilesByStatus(id: string): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    const tasksDir = join(tmpDir, "tasks");
    const statusDirs = await readdir(tasksDir);
    for (const status of statusDirs) {
      try {
        const entries = await readdir(join(tasksDir, status));
        const hits = entries.filter((e) => e === `${id}.md`).length;
        if (hits > 0) result[status] = hits;
      } catch {
        // not a directory
      }
    }
    return result;
  }

  it("two concurrent transitions from in-progress do not leave the task file in two status directories", async () => {
    const task = await store.create({
      title: "Race target",
      body: "",
      priority: "normal",
      routing: { agent: "researcher" },
      metadata: {},
      createdBy: "test",
    });
    const id = task.frontmatter.id;

    // Get task into in-progress, mirroring the real lifecycle that
    // triggered the production incident.
    await store.transition(id, "ready");
    await store.transition(id, "in-progress");

    // Both handlers fire "simultaneously" — one thinks the agent timed
    // out (→ blocked), one thinks the scheduler should reclaim (→ ready).
    // Each path is semantically valid on its own.
    const results = await Promise.allSettled([
      store.transition(id, "blocked", { reason: "agent-timeout" }),
      store.transition(id, "ready", { reason: "stale-heartbeat-reclaim" }),
    ]);

    const counts = await countTaskFilesByStatus(id);
    const totalCopies = Object.values(counts).reduce((a, b) => a + b, 0);

    expect(totalCopies).toBe(1);

    // And the single surviving copy must be gettable without throwing
    // "Duplicate task ID detected".
    const finalTask = await store.get(id);
    expect(finalTask).toBeDefined();
    expect(finalTask!.frontmatter.id).toBe(id);

    // At least one of the two transitions must have succeeded; both
    // succeeding is fine too (second re-reads fresh state and does a
    // valid follow-up transition).
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    expect(succeeded).toBeGreaterThanOrEqual(1);
  });

  it("concurrent transition + cancel do not leave two files", async () => {
    const task = await store.create({
      title: "Cancel-vs-transition race",
      body: "",
      priority: "normal",
      routing: { agent: "researcher" },
      metadata: {},
      createdBy: "test",
    });
    const id = task.frontmatter.id;

    await store.transition(id, "ready");

    // One handler cancels, another transitions to in-progress at the
    // same time. Before the shared mutex, these could both rename a
    // stale snapshot of the ready copy.
    const results = await Promise.allSettled([
      store.cancel(id, "user-cancelled"),
      store.transition(id, "in-progress"),
    ]);

    const counts = await countTaskFilesByStatus(id);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);

    const finalTask = await store.get(id);
    expect(finalTask).toBeDefined();

    // At least one should have succeeded; the later one either no-ops
    // (same target) or throws a clean InvalidTransition error.
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    expect(succeeded).toBeGreaterThanOrEqual(1);
  });

  it("many concurrent transitions on the same task converge to a single file", async () => {
    const task = await store.create({
      title: "Storm target",
      body: "",
      priority: "normal",
      routing: { agent: "researcher" },
      metadata: {},
      createdBy: "test",
    });
    const id = task.frontmatter.id;
    await store.transition(id, "ready");

    // Ten simultaneous attempts to move it around. Valid transitions
    // from `ready` include `in-progress`, `blocked`, `cancelled`.
    const targets: Array<"in-progress" | "blocked" | "cancelled" | "ready"> = [
      "in-progress", "ready", "blocked", "in-progress", "ready",
      "blocked", "cancelled", "ready", "in-progress", "blocked",
    ];
    await Promise.allSettled(
      targets.map((t) => store.transition(id, t).catch(() => undefined)),
    );

    const counts = await countTaskFilesByStatus(id);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);

    const finalTask = await store.get(id);
    expect(finalTask).toBeDefined();
  });

  it("transitions on different tasks do NOT serialize (per-id locking, not global)", async () => {
    const taskA = await store.create({
      title: "A", body: "", priority: "normal",
      routing: { agent: "x" }, metadata: {}, createdBy: "test",
    });
    const taskB = await store.create({
      title: "B", body: "", priority: "normal",
      routing: { agent: "y" }, metadata: {}, createdBy: "test",
    });

    // If transitions on different IDs somehow shared a global lock,
    // this would deadlock or serialize unnecessarily. It's a
    // correctness-adjacent check: per-id granularity.
    const [a, b] = await Promise.all([
      store.transition(taskA.frontmatter.id, "ready"),
      store.transition(taskB.frontmatter.id, "ready"),
    ]);
    expect(a.frontmatter.status).toBe("ready");
    expect(b.frontmatter.status).toBe("ready");
  });
});
