/**
 * TaskLockManager provides per-task serialization of asynchronous operations.
 * Used to prevent race conditions when concurrent protocol messages target the same task.
 */

export interface TaskLockManager {
  /**
   * Execute a function with exclusive access to the given taskId.
   * Concurrent calls for the same taskId are queued and executed serially.
   * @param taskId The task identifier to lock
   * @param fn The async function to execute while holding the lock
   * @returns The result of fn
   */
  withLock<T>(taskId: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * In-memory lock manager using promise chaining per task.
 * Safe for single-process execution; does not support distributed locking.
 */
export class InMemoryTaskLockManager implements TaskLockManager {
  private readonly locks: Map<string, Promise<unknown>>;

  constructor() {
    this.locks = new Map();
  }

  async withLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    // Get the current chain for this task (or a resolved promise if first call)
    const currentLock = this.locks.get(taskId) ?? Promise.resolve();

    // Build a new promise that:
    // 1. Waits for the current lock to settle (regardless of success/failure)
    // 2. Executes fn and captures its result
    // 3. Returns the result to the caller (propagates errors)
    const resultPromise = new Promise<T>((resolve, reject) => {
      currentLock
        .catch(() => {
          // Swallow previous errors to continue the chain
        })
        .then(() => fn())
        .then(resolve, reject);
    });

    // Create the next lock in the chain
    // This settles when fn settles, but swallows errors to keep chain alive
    const nextLock = resultPromise
      .catch(() => {
        // Swallow errors to keep the chain alive for next operations
      })
      .finally(() => {
        // Clean up lock if this was the last pending operation
        if (this.locks.get(taskId) === nextLock) {
          this.locks.delete(taskId);
        }
      });

    // Store the new chain
    this.locks.set(taskId, nextLock);

    // Return the result (will throw if fn throws)
    return resultPromise;
  }
}
