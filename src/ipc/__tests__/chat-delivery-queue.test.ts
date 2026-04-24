/**
 * Unit tests for ChatDeliveryQueue (plugin-owned notification long-poll).
 *
 * Coverage: enqueue+await semantics, FIFO claim, atomic tryClaim, idempotent
 * deliverResult, listener-leak guard matching spawn-queue.
 */

import { describe, it, expect, vi } from "vitest";
import { ChatDeliveryQueue } from "../chat-delivery-queue.js";
import type { ChatDeliveryRequest } from "../schemas.js";

function partial(overrides: Partial<ChatDeliveryRequest> = {}): Omit<ChatDeliveryRequest, "id"> {
  return {
    subscriptionId: overrides.subscriptionId ?? "sub-1",
    taskId: overrides.taskId ?? "TASK-1",
    toStatus: overrides.toStatus ?? "done",
    message: overrides.message ?? "Task complete",
    delivery: overrides.delivery ?? {
      kind: "openclaw-chat",
      target: "telegram:-100",
    },
  };
}

describe("ChatDeliveryQueue", () => {
  it("claim() returns undefined on empty queue", () => {
    const q = new ChatDeliveryQueue();
    expect(q.claim()).toBeUndefined();
  });

  it("enqueueAndAwait generates an id, emits 'enqueue', returns a pending promise", async () => {
    const q = new ChatDeliveryQueue();
    let emittedId: string | undefined;
    q.on("enqueue", (req: ChatDeliveryRequest) => {
      emittedId = req.id;
    });

    const { id, done } = q.enqueueAndAwait(partial());

    expect(id).toBeTypeOf("string");
    expect(id.length).toBeGreaterThan(0);
    expect(emittedId).toBe(id);

    // `done` is pending until deliverResult
    let settled = false;
    void done.then(() => (settled = true)).catch(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    q.deliverResult(id, { success: true });
    await done;
    expect(settled).toBe(true);
  });

  it("claim() returns entries in FIFO insertion order", () => {
    const q = new ChatDeliveryQueue();
    const { id: id1 } = q.enqueueAndAwait(partial({ subscriptionId: "s1" }));
    const { id: id2 } = q.enqueueAndAwait(partial({ subscriptionId: "s2" }));

    const claimed1 = q.claim();
    expect(claimed1?.id).toBe(id1);
    const claimed2 = q.claim();
    expect(claimed2?.id).toBe(id2);
    expect(q.claim()).toBeUndefined();
    // Quiet unused-id warning.
    expect(id2).toBe(claimed2?.id);
  });

  it("tryClaim(id) is atomic — succeeds once then returns false", () => {
    const q = new ChatDeliveryQueue();
    const { id } = q.enqueueAndAwait(partial());

    expect(q.tryClaim(id)).toBe(true);
    expect(q.tryClaim(id)).toBe(false);
    expect(q.tryClaim("nonexistent")).toBe(false);
  });

  it("deliverResult(success: false) rejects the awaiter with the plugin's error", async () => {
    const q = new ChatDeliveryQueue();
    const { id, done } = q.enqueueAndAwait(partial());
    q.claim();

    q.deliverResult(id, {
      success: false,
      error: { kind: "send-failed", message: "telegram API returned 403" },
    });

    await expect(done).rejects.toThrow("telegram API returned 403");
  });

  it("deliverResult is idempotent — second call with the same id is a no-op", async () => {
    const q = new ChatDeliveryQueue();
    const { id, done } = q.enqueueAndAwait(partial());
    q.deliverResult(id, { success: true });
    await done;
    // Second call must not throw and must not double-settle.
    expect(() => q.deliverResult(id, { success: true })).not.toThrow();
  });

  it("reset() rejects all pending awaiters and clears listeners", async () => {
    const q = new ChatDeliveryQueue();
    q.on("enqueue", () => {});
    const { done } = q.enqueueAndAwait(partial());

    q.reset();

    await expect(done).rejects.toThrow(/queue reset/);
    expect(q.listenerCount("enqueue")).toBe(0);
    expect(q.claim()).toBeUndefined();
  });

  it("does not leak listeners across enqueue/off cycles (pitfall parity with spawn-queue)", () => {
    const q = new ChatDeliveryQueue();
    for (let i = 0; i < 50; i++) {
      const listener = () => {};
      q.on("enqueue", listener);
      const { id } = q.enqueueAndAwait(partial({ subscriptionId: `s${i}` }));
      q.off("enqueue", listener);
      q.tryClaim(id);
      q.deliverResult(id, { success: true });
    }
    expect(q.listenerCount("enqueue")).toBe(0);
  });

  // --- Phase 44: D-44-TIMEOUT -------------------------------------------------
  // RED: Plan 05 will add a configurable timeoutMs on enqueueAndAwait with a
  // 60_000ms default, tagging the rejection with kind="timeout" so the
  // notifier's existing catch branch writes {error: {kind, message}} into the
  // subscription attempt ledger. Late deliverResult after a timeout fires must
  // remain an idempotent no-op (preserves the deliverResult contract at
  // chat-delivery-queue.ts:95-98).

  it("enqueueAndAwait rejects with kind='timeout' when timeoutMs elapses without deliverResult", async () => {
    const q = new ChatDeliveryQueue();
    const { done } = q.enqueueAndAwait(partial(), { timeoutMs: 10 });
    await expect(done).rejects.toMatchObject({
      kind: "timeout",
      message: expect.stringContaining("timed out"),
    });
  });

  it("deliverResult after timeout fires is idempotent no-op (no throw)", async () => {
    const q = new ChatDeliveryQueue();
    const { id, done } = q.enqueueAndAwait(partial(), { timeoutMs: 10 });
    // Swallow the expected rejection so it doesn't surface as an unhandled rejection.
    await done.catch(() => undefined);
    expect(() => q.deliverResult(id, { success: true })).not.toThrow();
  });

  it("enqueueAndAwait without opts uses a 60_000ms default timeout", async () => {
    vi.useFakeTimers();
    try {
      const q = new ChatDeliveryQueue();
      const { done } = q.enqueueAndAwait(partial()); // no opts — exercise default
      const rejected = done.catch((err: Error & { kind?: string }) => err);
      await vi.advanceTimersByTimeAsync(60_001);
      const err = await rejected;
      expect(err).toMatchObject({
        kind: "timeout",
        message: expect.stringContaining("timed out"),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
