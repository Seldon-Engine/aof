/**
 * In-memory spawn-request queue consumed by long-polling plugins (D-09).
 *
 * The daemon's `PluginBridgeAdapter.spawnSession()` calls `enqueue()` when a
 * task has been assigned. The `GET /v1/spawns/wait` route handler pops the
 * oldest unclaimed request via `claim()`, or subscribes to the `"enqueue"`
 * event and races via `tryClaim(id)` if multiple long-polls are active.
 *
 * FIFO insertion order — `claim()` returns the oldest unclaimed request so
 * backpressure spreads evenly across connected plugins.
 *
 * `releaseClaim()` is a safety valve for mid-delivery drops; the primary
 * crash-recovery path is AOF's existing task lease system (Research §Option 2).
 *
 * Pitfall 2 (Research §Common Pitfalls): listeners must not leak across
 * enqueue/off cycles. The tests assert `listenerCount === 0` after 50 cycles —
 * enforcement is shared with the long-poll handler's `queue.off("enqueue", …)`
 * cleanup paths.
 *
 * @module ipc/spawn-queue
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/index.js";
import type { SpawnRequest } from "./schemas.js";

const log = createLogger("spawn-queue");

export class SpawnQueue extends EventEmitter {
  private pending = new Map<string, SpawnRequest>();
  private claimed = new Set<string>();

  /**
   * Enqueue a spawn request. Generates `id = randomUUID()` and emits
   * `"enqueue"` with the fully-formed request for any active long-poll.
   */
  enqueue(partial: Omit<SpawnRequest, "id">): SpawnRequest {
    const full: SpawnRequest = { id: randomUUID(), ...partial };
    this.pending.set(full.id, full);
    this.emit("enqueue", full);
    log.debug({ id: full.id, taskId: full.taskId }, "spawn enqueued");
    return full;
  }

  /**
   * Pop the oldest unclaimed spawn request (insertion order).
   * Returns `undefined` when the queue is empty.
   */
  claim(): SpawnRequest | undefined {
    for (const [id, sr] of this.pending) {
      if (!this.claimed.has(id)) {
        this.claimed.add(id);
        this.pending.delete(id);
        return sr;
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
   * Return a previously-claimed request to the pending set. Used only when
   * mid-delivery plugin drop is detected (otherwise the AOF task-lease system
   * handles re-dispatch on plugin crash).
   */
  releaseClaim(id: string, sr: SpawnRequest): void {
    this.claimed.delete(id);
    this.pending.set(id, sr);
  }

  /** Test helper — clear pending + claimed + remove all listeners. */
  reset(): void {
    this.pending.clear();
    this.claimed.clear();
    this.removeAllListeners();
  }
}
