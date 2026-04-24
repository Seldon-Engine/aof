/**
 * In-memory chat-delivery queue consumed by long-polling plugins.
 *
 * Fired by the daemon's `QueueBackedMessageTool` (wrapping
 * `OpenClawChatDeliveryNotifier`) when a completion-notification subscription
 * needs to go out. The plugin pulls each request via `GET /v1/deliveries/wait`
 * and POSTs the outcome to `POST /v1/deliveries/{id}/result`.
 *
 * Mirrors `spawn-queue.ts`: FIFO insertion order, atomic claim via
 * `tryClaim(id)`, event emitter for live long-polls. Additionally exposes
 * `awaitAck(id)` so the enqueuer can block on plugin confirmation — this
 * preserves the existing `MatrixMessageTool.send(): Promise<void>` contract
 * that `OpenClawChatDeliveryNotifier.deliverOne` depends on (resolve → mark
 * subscription delivered; reject → record failure).
 *
 * @module ipc/chat-delivery-queue
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/index.js";
import type { ChatDeliveryRequest, ChatDeliveryResultPost } from "./schemas.js";

const log = createLogger("chat-delivery-queue");

/**
 * Default bound on how long `enqueueAndAwait` will block waiting for the
 * plugin to POST a delivery result. Mitigates CLAUDE.md's "chat-delivery
 * chain blocks on plugin ACK" fragility warning — without this cap a slow
 * or broken plugin stalls the `EventLogger` callback indefinitely. Per
 * Phase 44 D-44-TIMEOUT.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class ChatDeliveryQueue extends EventEmitter {
  private pending = new Map<string, ChatDeliveryRequest>();
  private claimed = new Set<string>();
  private waiters = new Map<string, Waiter>();

  /**
   * Enqueue a chat delivery. Generates `id = randomUUID()`, emits `"enqueue"`,
   * and returns a promise that resolves when the plugin POSTs a successful
   * result — or rejects on plugin-reported failure / queue reset / timeout.
   *
   * The optional `opts.timeoutMs` bounds how long `done` will stay pending
   * before rejecting with `Error & { kind: "timeout" }`. When undefined the
   * module-level `DEFAULT_TIMEOUT_MS` (60s) applies. Pass `Infinity` or `0` to
   * disable the timer entirely (useful in tests that assert "no timeout
   * happens" without racing real time). A late `deliverResult` call after a
   * timeout fires is an idempotent no-op — the existing `if (!waiter) return`
   * guard in `deliverResult` covers this because the waiter was already
   * removed when the timer fired.
   */
  enqueueAndAwait(
    partial: Omit<ChatDeliveryRequest, "id">,
    opts?: { timeoutMs?: number },
  ): {
    id: string;
    done: Promise<void>;
  } {
    const id = randomUUID();
    const full: ChatDeliveryRequest = { id, ...partial };
    this.pending.set(id, full);
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const done = new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.waiters.has(id)) {
            this.waiters.delete(id);
            this.pending.delete(id);
            this.claimed.delete(id);
            const err = new Error(`chat delivery timed out after ${timeoutMs}ms`);
            (err as Error & { kind?: string }).kind = "timeout";
            reject(err);
          }
        }, timeoutMs);
      }

      this.waiters.set(id, {
        resolve: () => {
          if (timer !== undefined) clearTimeout(timer);
          resolve();
        },
        reject: (e: Error) => {
          if (timer !== undefined) clearTimeout(timer);
          reject(e);
        },
      });
    });

    this.emit("enqueue", full);
    log.debug(
      { id, subscriptionId: full.subscriptionId, taskId: full.taskId, timeoutMs },
      "chat delivery enqueued",
    );
    return { id, done };
  }

  /**
   * Pop the oldest unclaimed request (insertion order).
   * Returns `undefined` when the queue is empty.
   */
  claim(): ChatDeliveryRequest | undefined {
    for (const [id, req] of this.pending) {
      if (!this.claimed.has(id)) {
        this.claimed.add(id);
        this.pending.delete(id);
        return req;
      }
    }
    return undefined;
  }

  /**
   * Atomically claim a specific request id. Returns true exactly once;
   * subsequent calls with the same id return false. Used by the long-poll
   * handler's `onEnqueue` listener to race across multiple waiters.
   */
  tryClaim(id: string): boolean {
    if (!this.pending.has(id)) return false;
    this.claimed.add(id);
    this.pending.delete(id);
    return true;
  }

  /**
   * Resolve or reject the awaiter for a claimed delivery. Called by the
   * POST /v1/deliveries/{id}/result route handler. No-op if the id is unknown
   * (idempotent — a second POST with the same id does nothing).
   */
  deliverResult(id: string, result: ChatDeliveryResultPost): void {
    const waiter = this.waiters.get(id);
    if (!waiter) {
      log.debug({ id }, "deliverResult: no waiter (already settled)");
      return;
    }
    this.waiters.delete(id);
    this.claimed.delete(id);
    if (result.success) {
      waiter.resolve();
    } else {
      const msg = result.error?.message ?? "plugin reported delivery failure";
      const err = new Error(msg);
      (err as Error & { kind?: string }).kind = result.error?.kind;
      waiter.reject(err);
    }
  }

  /** Test helper — reject all outstanding waiters and clear state. */
  reset(): void {
    for (const [id, waiter] of this.waiters) {
      waiter.reject(new Error(`queue reset: ${id}`));
    }
    this.waiters.clear();
    this.pending.clear();
    this.claimed.clear();
    this.removeAllListeners();
  }
}
