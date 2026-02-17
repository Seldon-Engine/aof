/**
 * Murmur state manager — persistent state tracking for orchestration review cycles.
 *
 * Tracks per-team murmur state so triggers can evaluate correctly across scheduler restarts.
 * State files are stored in `.murmur/<team-id>.json` with atomic writes.
 */

import { readFile, mkdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";

/** Per-team murmur state. */
export interface MurmurState {
  teamId: string;
  lastReviewAt: string | null; // ISO timestamp of last murmur review
  completionsSinceLastReview: number; // tasks completed since last review
  failuresSinceLastReview: number; // tasks failed/dead-lettered since last review
  currentReviewTaskId: string | null; // if a murmur review is currently in-progress
  lastTriggeredBy: string | null; // which trigger kind fired last
}

/** Options for MurmurStateManager. */
export interface MurmurStateManagerOptions {
  /** Base directory for state files (default: .murmur). */
  stateDir?: string;
  /** Logger for warnings/errors. */
  logger?: {
    warn: (message: string, meta?: unknown) => void;
    error: (message: string, meta?: unknown) => void;
  };
}

/**
 * State manager for murmur orchestration reviews.
 *
 * Provides atomic reads/writes for per-team state tracking.
 * State files use JSON format with atomic writes (write-tmp-then-rename).
 * Per-team locks prevent concurrent modifications.
 */
export class MurmurStateManager {
  private readonly stateDir: string;
  private readonly logger?: MurmurStateManagerOptions["logger"];
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: MurmurStateManagerOptions = {}) {
    this.stateDir = options.stateDir ?? ".murmur";
    this.logger = options.logger;
  }

  /**
   * Acquire a lock for a team to serialize operations.
   * Returns a function that must be called to release the lock.
   */
  private async acquireLock(teamId: string): Promise<() => void> {
    // Wait for any existing lock
    while (this.locks.has(teamId)) {
      await this.locks.get(teamId);
    }

    // Create new lock
    let releaseLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    this.locks.set(teamId, lockPromise);

    // Return release function
    return () => {
      this.locks.delete(teamId);
      releaseLock();
    };
  }

  /**
   * Load state for a team. Returns default state if file doesn't exist.
   * Handles corrupt JSON gracefully by returning defaults with warning.
   */
  async load(teamId: string): Promise<MurmurState> {
    const filePath = this.getStatePath(teamId);

    try {
      await access(filePath);
    } catch {
      // File doesn't exist — return defaults
      return this.getDefaultState(teamId);
    }

    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);

      // Validate required fields
      if (typeof parsed.teamId !== "string") {
        throw new Error("Invalid state: missing teamId");
      }

      return {
        teamId: parsed.teamId,
        lastReviewAt: parsed.lastReviewAt ?? null,
        completionsSinceLastReview: parsed.completionsSinceLastReview ?? 0,
        failuresSinceLastReview: parsed.failuresSinceLastReview ?? 0,
        currentReviewTaskId: parsed.currentReviewTaskId ?? null,
        lastTriggeredBy: parsed.lastTriggeredBy ?? null,
      };
    } catch (error) {
      // Corrupt JSON or invalid format — return defaults with warning
      this.logger?.warn("Failed to load murmur state, using defaults", {
        teamId,
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.getDefaultState(teamId);
    }
  }

  /**
   * Save state for a team. Uses atomic write (write-tmp-then-rename).
   * Creates state directory if it doesn't exist.
   */
  async save(teamId: string, state: MurmurState): Promise<void> {
    const filePath = this.getStatePath(teamId);

    // Ensure state directory exists
    await this.ensureStateDir();

    // Validate state
    if (state.teamId !== teamId) {
      throw new Error(`State teamId mismatch: expected ${teamId}, got ${state.teamId}`);
    }

    // Atomic write
    const serialized = JSON.stringify(state, null, 2);
    await writeFileAtomic(filePath, serialized, "utf-8");
  }

  /**
   * Increment completions counter for a team.
   */
  async incrementCompletions(teamId: string): Promise<void> {
    const release = await this.acquireLock(teamId);
    try {
      const state = await this.load(teamId);
      state.completionsSinceLastReview += 1;
      await this.save(teamId, state);
    } finally {
      release();
    }
  }

  /**
   * Increment failures counter for a team.
   */
  async incrementFailures(teamId: string): Promise<void> {
    const release = await this.acquireLock(teamId);
    try {
      const state = await this.load(teamId);
      state.failuresSinceLastReview += 1;
      await this.save(teamId, state);
    } finally {
      release();
    }
  }

  /**
   * Start a review for a team.
   * Sets currentReviewTaskId, updates lastReviewAt, resets counters.
   */
  async startReview(teamId: string, taskId: string, triggeredBy: string): Promise<void> {
    const release = await this.acquireLock(teamId);
    try {
      const state = await this.load(teamId);
      state.currentReviewTaskId = taskId;
      state.lastReviewAt = new Date().toISOString();
      state.lastTriggeredBy = triggeredBy;
      state.completionsSinceLastReview = 0;
      state.failuresSinceLastReview = 0;
      await this.save(teamId, state);
    } finally {
      release();
    }
  }

  /**
   * End a review for a team. Clears currentReviewTaskId.
   */
  async endReview(teamId: string): Promise<void> {
    const release = await this.acquireLock(teamId);
    try {
      const state = await this.load(teamId);
      state.currentReviewTaskId = null;
      await this.save(teamId, state);
    } finally {
      release();
    }
  }

  /**
   * Check if a review is currently in progress for a team.
   * Used for idempotency — avoid spawning multiple concurrent reviews.
   */
  async isReviewInProgress(teamId: string): Promise<boolean> {
    const state = await this.load(teamId);
    return state.currentReviewTaskId !== null;
  }

  /**
   * Get the file path for a team's state file.
   */
  private getStatePath(teamId: string): string {
    return join(this.stateDir, `${teamId}.json`);
  }

  /**
   * Get default state for a team.
   */
  private getDefaultState(teamId: string): MurmurState {
    return {
      teamId,
      lastReviewAt: null,
      completionsSinceLastReview: 0,
      failuresSinceLastReview: 0,
      currentReviewTaskId: null,
      lastTriggeredBy: null,
    };
  }

  /**
   * Ensure state directory exists.
   */
  private async ensureStateDir(): Promise<void> {
    try {
      await mkdir(this.stateDir, { recursive: true });
    } catch (error) {
      // Ignore EEXIST errors
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
}
