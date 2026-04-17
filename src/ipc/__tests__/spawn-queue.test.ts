/**
 * Phase 43 — Wave 0 RED test
 *
 * Covers decision D-09: plugin long-polls daemon for SpawnRequests; queue
 * must support enqueue/claim/tryClaim/reset and pub-sub semantics (Pitfall 2:
 * listeners must not leak).
 *
 * RED anchor: imports from "../spawn-queue.js" which does not yet exist.
 * Wave 2 lands `src/ipc/spawn-queue.ts` exporting `SpawnQueue`.
 */

import { describe, it, expect } from "vitest";
import { SpawnQueue } from "../spawn-queue.js"; // INTENTIONALLY MISSING — Wave 2 creates this (D-09).

describe("SpawnQueue (D-09 pub-sub queue)", () => {
  it("claim() returns undefined on empty queue", () => {
    const queue = new SpawnQueue();
    expect(queue.claim()).toBeUndefined();
  });

  it("enqueue returns a SpawnRequest with a generated `id` and emits 'enqueue'", () => {
    const queue = new SpawnQueue();
    let emittedId: string | undefined;
    queue.on("enqueue", (sr: { id: string }) => {
      emittedId = sr.id;
    });

    const sr = queue.enqueue({
      taskId: "t1",
      taskPath: "/tmp/tasks/ready/t1",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    });

    expect(sr.id).toBeTypeOf("string");
    expect(sr.id.length).toBeGreaterThan(0);
    expect(emittedId).toBe(sr.id);
  });

  it("claim() pops oldest unclaimed; second claim() returns undefined", () => {
    const queue = new SpawnQueue();
    const sr = queue.enqueue({
      taskId: "t1",
      taskPath: "/tmp/tasks/ready/t1",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    });

    const first = queue.claim();
    expect(first?.id).toBe(sr.id);

    const second = queue.claim();
    expect(second).toBeUndefined();
  });

  it("tryClaim(id) returns true once then false on repeat", () => {
    const queue = new SpawnQueue();
    const sr = queue.enqueue({
      taskId: "t1",
      taskPath: "/tmp/tasks/ready/t1",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    });

    expect(queue.tryClaim(sr.id)).toBe(true);
    expect(queue.tryClaim(sr.id)).toBe(false);
  });

  it("tryClaim(id) returns false for unknown id", () => {
    const queue = new SpawnQueue();
    expect(queue.tryClaim("nonexistent")).toBe(false);
  });

  it("reset() clears pending + removes all listeners", () => {
    const queue = new SpawnQueue();
    queue.on("enqueue", () => {});

    queue.enqueue({
      taskId: "t1",
      taskPath: "/tmp/tasks/ready/t1",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    });

    queue.reset();

    expect(queue.claim()).toBeUndefined();
    expect(queue.listenerCount("enqueue")).toBe(0);
  });

  it("Pitfall 2: 50 enqueue/off cycles leave zero listeners", () => {
    const queue = new SpawnQueue();

    for (let i = 0; i < 50; i++) {
      const handler = (): void => {};
      queue.on("enqueue", handler);
      queue.enqueue({
        taskId: `t${i}`,
        taskPath: `/tmp/tasks/ready/t${i}`,
        agent: "swe-backend",
        priority: "normal",
        routing: {},
      });
      queue.off("enqueue", handler);
    }

    expect(queue.listenerCount("enqueue")).toBe(0);
  });
});
