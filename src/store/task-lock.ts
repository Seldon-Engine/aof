/**
 * Per-task mutex for serializing status-changing filesystem operations.
 *
 * AOF stores tasks as files under `tasks/<status>/<id>.md`, and a status
 * change is physically a `rename()` between sibling directories. The
 * transition sequence (write-then-rename inside `transitionTask`) is NOT
 * atomic under cooperative concurrency: if two async code paths both
 * observe a task in `in-progress` and race to transition it to different
 * new statuses, both will `writeFileAtomic(oldPath, …)` and both will
 * `rename(oldPath, newPath)` — and because `writeFileAtomic` creates the
 * file when it's missing, the second rename can resurrect a phantom file
 * at the old path and move it to the second new status. Result: the same
 * task file exists in two status directories, and every subsequent
 * `store.get(id)` throws "Duplicate task ID detected".
 *
 * This mutex serializes same-task transitions so the second contender
 * re-reads fresh state and either no-ops, throws `Invalid transition`,
 * or performs a legitimate follow-up transition — all single-copy.
 *
 * Scope: intra-process only. AOF currently runs single-process inside
 * the OpenClaw gateway, so this is sufficient for today. Multi-process
 * safety needs a filesystem-level lock (separate follow-up).
 */

type PromiseLike<T> = Promise<T>;

/**
 * Serializes async operations keyed by task ID.
 *
 * `run(id, op)` awaits any in-flight op for the same id, then runs
 * `op()` exclusively. Different ids do NOT contend.
 */
export class TaskLocks {
  private readonly inflight = new Map<string, PromiseLike<unknown>>();

  async run<T>(id: string, op: () => Promise<T>): Promise<T> {
    // Wait for any prior transition for this id to finish (success or
    // failure) before starting ours. We swallow the prior result — we're
    // only using it as a barrier — but the caller's own op will
    // propagate its own errors normally.
    const prior = this.inflight.get(id);
    const ours = (async () => {
      if (prior) {
        try {
          await prior;
        } catch {
          // prior failure does not block our attempt
        }
      }
      return op();
    })();

    this.inflight.set(id, ours);
    try {
      return await ours;
    } finally {
      // Only clear the slot if we're still the latest registered op —
      // otherwise we'd evict a newer queued op's entry.
      if (this.inflight.get(id) === ours) {
        this.inflight.delete(id);
      }
    }
  }

  /** Number of task IDs with in-flight operations. Intended for tests. */
  size(): number {
    return this.inflight.size;
  }
}
