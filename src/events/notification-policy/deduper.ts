/**
 * DeduplicationStore — per-(taskId, eventType) time-window suppression.
 *
 * Extracted from NotificationService (P2.4) so the policy engine can own
 * it independently. Critical events and rules with neverSuppress bypass
 * this store entirely.
 */

export interface DedupeOptions {
  /** Global dedupe window in ms. Default: 300_000 (5 minutes). */
  windowMs?: number;
}

interface DedupeEntry {
  lastSentAt: number;
  windowMs: number;
}

export class DeduplicationStore {
  private readonly store = new Map<string, DedupeEntry>();
  private readonly defaultWindowMs: number;

  constructor(opts: DedupeOptions = {}) {
    this.defaultWindowMs = opts.windowMs ?? 300_000;
  }

  /**
   * Returns true if the event should be sent (not a duplicate).
   * Updates the store timestamp when returning true.
   *
   * @param taskId   Task ID or undefined for global events
   * @param eventType  Event type string
   * @param windowMs   Override dedupe window for this event (undefined = use default)
   */
  shouldSend(taskId: string | undefined, eventType: string, windowMs?: number): boolean {
    const effectiveWindow = windowMs ?? this.defaultWindowMs;

    // dedupeWindowMs: 0 means always send
    if (effectiveWindow === 0) return true;

    const key = `${taskId ?? "global"}:${eventType}`;
    const now = Date.now();
    const entry = this.store.get(key);

    if (entry !== undefined && now - entry.lastSentAt < effectiveWindow) {
      return false; // Suppressed
    }

    this.store.set(key, { lastSentAt: now, windowMs: effectiveWindow });
    return true;
  }

  /**
   * Forcefully clears the dedupe entry for a given (taskId, eventType).
   * Useful in tests or when a task is reset.
   */
  clear(taskId: string | undefined, eventType: string): void {
    const key = `${taskId ?? "global"}:${eventType}`;
    this.store.delete(key);
  }

  /** Clears all entries. */
  clearAll(): void {
    this.store.clear();
  }

  /** Returns the number of tracked entries (for tests/diagnostics). */
  get size(): number {
    return this.store.size;
  }
}
