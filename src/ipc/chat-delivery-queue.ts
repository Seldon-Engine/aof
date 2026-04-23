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
   * result — or rejects on plugin-reported failure / queue reset.
   */
  enqueueAndAwait(partial: Omit<ChatDeliveryRequest, "id">): {
    id: string;
    done: Promise<void>;
  } {
    const id = randomUUID();
    const full: ChatDeliveryRequest = { id, ...partial };
    this.pending.set(id, full);

    const done = new Promise<void>((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
    });

    this.emit("enqueue", full);
    log.debug(
      { id, subscriptionId: full.subscriptionId, taskId: full.taskId },
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
