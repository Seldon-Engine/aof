/**
 * NotificationRulesWatcher — hot-reloads notification-rules.yaml into the engine.
 *
 * Uses Node.js fs.watch() (no extra deps). Debounces rapid successive events
 * (e.g. editor write + rename) with a short settle delay.
 */

import { watch as fsWatch, type FSWatcher } from "node:fs";
import type { NotificationPolicyEngine } from "./engine.js";
import { loadNotificationRules } from "./loader.js";

export interface WatcherOptions {
  /** Debounce delay in ms before triggering a reload. Default: 200. */
  debounceMs?: number;
  /** Called after a successful reload with the new rule count. */
  onReload?: (ruleCount: number) => void;
  /** Called if reload fails (file unreadable / invalid YAML). */
  onError?: (err: Error) => void;
}

export class NotificationRulesWatcher {
  private readonly rulesPath: string;
  private readonly engine: NotificationPolicyEngine;
  private readonly debounceMs: number;
  private readonly onReload?: (ruleCount: number) => void;
  private readonly onError?: (err: Error) => void;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    rulesPath: string,
    engine: NotificationPolicyEngine,
    opts: WatcherOptions = {}
  ) {
    this.rulesPath = rulesPath;
    this.engine = engine;
    this.debounceMs = opts.debounceMs ?? 200;
    this.onReload = opts.onReload;
    this.onError = opts.onError;
  }

  /** Start watching. Idempotent — calling start() twice is safe. */
  start(): void {
    if (this.watcher) return;

    try {
      this.watcher = fsWatch(this.rulesPath, () => {
        this.scheduleReload();
      });
      this.watcher.on("error", (err: Error) => {
        this.onError?.(err);
      });
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Stop watching and clean up timers. */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /** Exposed for testing: trigger a reload directly. */
  async reload(): Promise<void> {
    try {
      const rules = await loadNotificationRules(this.rulesPath);
      this.engine.updateRules(rules);
      this.onReload?.(rules.length);
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.reload();
    }, this.debounceMs);
  }
}
