/**
 * Task store — filesystem-backed CRUD for tasks.
 *
 * Tasks are Markdown files with YAML frontmatter.
 * The canonical layout uses status subdirectories:
 *   tasks/<status>/TASK-<id>.md
 *
 * Moving a file between directories = atomic status transition.
 * This is the single source of truth. Views are derived.
 */

import { readFile, writeFile, readdir, mkdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { customAlphabet } from "nanoid";
import { createLogger } from "../logging/index.js";
import { TaskFrontmatter, Task, isValidTransition } from "../schemas/task.js";

// Visually-unambiguous alphabet (drops 0/O, 1/I/l) — 56 chars × 8 positions ≈ 46 bits.
// At 1M IDs/day, P(collision within a day) ≈ 7×10⁻⁹.
// Format: TASK-YYYY-MM-DD-XXXXXXXX. Date prefix preserved for human triage and grep.
const generateTaskSuffix = customAlphabet("23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz", 8);

const storeLog = createLogger("store");
import type { TaskStatus } from "../schemas/task.js";
import type { ITaskStore, TaskStoreHooks } from "./interfaces.js";
import { parseTaskFile, serializeTask, extractTaskSections, contentHash } from "./task-parser.js";
import { validateDAG, initializeWorkflowState } from "../schemas/workflow-dag.js";
import type { WorkflowDefinition, TaskWorkflow } from "../schemas/workflow-dag.js";
import { hasCycle, addDependency, removeDependency } from "./task-deps.js";
import { lintTasks } from "./task-validation.js";
import { getTaskInputs as getInputs, getTaskOutputs as getOutputs, writeTaskOutput as writeOutput } from "./task-file-ops.js";
import { blockTask, unblockTask, cancelTask } from "./task-lifecycle.js";
import { updateTask, type UpdatePatch, transitionTask, type TransitionOpts } from "./task-mutations.js";
import { TaskLocks } from "./task-lock.js";
const FRONTMATTER_FENCE = "---";

/** All valid status directories per BRD. */
const STATUS_DIRS: readonly TaskStatus[] = [
  "backlog",
  "ready",
  "in-progress",
  "blocked",
  "review",
  "done",
  "cancelled",
  "deadletter",
] as const;

export type { TaskStoreHooks } from "./interfaces.js";

export interface TaskStoreOptions {
  hooks?: TaskStoreHooks;
  logger?: import("../events/logger.js").EventLogger;
  /**
   * Project identifier for this store. Pass `null` (or omit) to
   * declare this as an unscoped base store — tasks created here will
   * NOT receive a `project:` frontmatter field and `loadProjectManifest`
   * will skip the same-root branch (BUG-044).
   */
  projectId?: string | null;
}

// Re-export parser functions for public API
export { parseTaskFile, serializeTask, extractTaskSections, contentHash };

/** Task filename from ID. */
function taskFilename(id: string): string {
  return `${id}.md`;
}

/** Format a date for TASK-YYYY-MM-DD-NNN IDs. */
function formatTaskDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Filesystem-backed task store with status subdirectories.
 *
 * Layout: projectRoot/tasks/<status>/<id>.md
 * Moving a file between status dirs = atomic state transition.
 */
export class FilesystemTaskStore implements ITaskStore {
  readonly projectRoot: string;
  /**
   * Project ID for the tasks stored here, or `null` when this is the
   * unscoped base store (daemon data dir, no project manifest).
   *
   * BUG-044: the previous default `basename(projectRoot)` produced
   * `"data"` for `~/.aof/data/` and leaked that as `project: data` into
   * every task's frontmatter, driving task-dispatcher to probe for a
   * non-existent `~/.aof/data/project.yaml`. Callers that want a
   * project-scoped store MUST pass `opts.projectId` explicitly
   * (`createProjectStore` already does); callers that want an unscoped
   * store should omit it (the 3 call sites are `daemon/daemon.ts`,
   * `service/aof-service.ts`, `mcp/shared.ts`).
   */
  readonly projectId: string | null;
  readonly tasksDir: string;
  private readonly hooks?: TaskStoreHooks;
  private readonly logger?: import("../events/logger.js").EventLogger;
  /**
   * Per-task mutex for status-changing filesystem operations.
   * See src/store/task-lock.ts for the rationale: the "duplicate task
   * ID detected" race when two async code paths concurrently transition
   * the same task. Serializing them lets the second contender re-read
   * fresh state and make the correct follow-up call.
   */
  private readonly locks = new TaskLocks();

  constructor(projectRoot: string, opts: TaskStoreOptions = {}) {
    this.projectRoot = resolve(projectRoot);
    // BUG-044: no basename() fallback. If the caller doesn't pass a
    // projectId, this is the unscoped base store — `null` signals
    // "don't stamp anything into task frontmatter, don't load a
    // manifest at our root". `opts.projectId === ""` is also treated
    // as unscoped (defensive — an empty string was never a valid
    // project id per the manifest schema).
    this.projectId = opts.projectId && opts.projectId.length > 0 ? opts.projectId : null;
    this.tasksDir = resolve(this.projectRoot, "tasks");
    this.hooks = opts.hooks;
    this.logger = opts.logger;
  }

  /**
   * Compute the next TASK-YYYY-MM-DD-XXXXXXXX identifier.
   *
   * The 8-char nanoid suffix replaces the prior per-store 3-digit counter,
   * which collided across project-scoped stores (each store enumerated only
   * its own status dirs, so two stores both minted -001 on the same day).
   * Date prefix preserved for grep/triage affordance.
   */
  private nextTaskId(now: Date): string {
    return `TASK-${formatTaskDate(now)}-${generateTaskSuffix()}`;
  }

  /** Ensure all status directories exist, then reconcile any on-disk drift. */
  async init(): Promise<void> {
    for (const status of STATUS_DIRS) {
      await mkdir(join(this.tasksDir, status), { recursive: true });
    }
    await this.reconcileDrift();
  }

  /**
   * Phase 46 / Bug 1A (reconciliation half): heal on-disk drift between
   * frontmatter.status and directory location. Filesystem is the source
   * of truth for location; frontmatter is the source of truth for WHICH
   * status the task should have. When they disagree — e.g. because a
   * pre-Phase-46 partial transition crashed between `save()` and
   * `transition()`, or because an external process moved a file — this
   * pass rewrites the on-disk layout to match frontmatter.
   *
   * Reuses `this.lint()` → `lintTasks()` which already detects and
   * reports "Status mismatch:" issues via the same directory walk.
   * Runs ONCE per init() (not per poll) per CONTEXT.md: "It's a
   * self-heal pass for past drift, not a continuous correction loop."
   *
   * PATTERNS.md Pitfall 4: we do NOT call `this.get(id)` inside the
   * loop — get() has its own mtime-wins self-heal that deletes files
   * mid-walk. lintTasks uses parseTaskFile directly on each enumerated
   * path, so `issues` is a safe snapshot.
   *
   * Companion directory is moved alongside the .md on a best-effort
   * basis. ENOENT (no companion dir) is fine; any other rename failure
   * is logged and we keep going — the .md move already succeeded and
   * is the critical half.
   *
   * Threat T-46-02-01 (path traversal via crafted frontmatter.status):
   * mitigated by the `STATUS_DIRS.includes(targetStatus)` check before
   * computing newPath. STATUS_DIRS is a hardcoded `readonly` array;
   * any value not in it triggers the warn-log branch and leaves the
   * file in place.
   */
  private async reconcileDrift(): Promise<void> {
    const issues = await this.lint();
    for (const { task, issue } of issues) {
      if (!issue.startsWith("Status mismatch:")) continue;

      const targetStatus = task.frontmatter.status;
      if (!STATUS_DIRS.includes(targetStatus)) {
        storeLog.warn(
          { taskId: task.frontmatter.id, status: targetStatus, op: "reconcile" },
          "frontmatter status not in known dirs — leaving file in place",
        );
        continue;
      }

      const oldPath = task.path;
      if (!oldPath) {
        storeLog.warn(
          { taskId: task.frontmatter.id, op: "reconcile" },
          "task has no path — cannot reconcile",
        );
        continue;
      }

      // Phase 46 / threat T-46-02-05: derive currentStatus from the
      // `issue` string returned by lintTasks. This regex is brittle —
      // if `task-validation.ts` ever changes the "Status mismatch:"
      // string format, this parse silently degrades to undefined and
      // companion-dir rename is skipped (the .md still moves correctly,
      // so no data loss; just an orphaned companion dir until the next
      // restart when reconciliation runs again on a now-already-moved
      // file with no drift). A more robust alternative is to parse the
      // current status from `oldPath` itself (split on `/tasks/` and
      // read the next segment) — switch to that if the issue-string
      // format changes.
      const match = issue.match(/but file in '(\w[\w-]*)\/'/);
      const currentStatus =
        match && STATUS_DIRS.includes(match[1] as TaskStatus)
          ? (match[1] as TaskStatus)
          : undefined;

      const newPath = this.taskPath(task.frontmatter.id, targetStatus);
      try {
        await mkdir(join(this.tasksDir, targetStatus), { recursive: true });
        await rename(oldPath, newPath);

        // Best-effort companion dir rename. ENOENT is fine — most
        // tasks created via failure-tracker / older paths don't have
        // companion dirs at all.
        if (currentStatus) {
          const oldDir = this.taskDir(task.frontmatter.id, currentStatus);
          const newDir = this.taskDir(task.frontmatter.id, targetStatus);
          try {
            await rename(oldDir, newDir);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") {
              storeLog.warn(
                { taskId: task.frontmatter.id, err, op: "reconcile" },
                "companion directory rename failed (non-fatal, .md already moved)",
              );
            }
          }
        }

        storeLog.info(
          {
            taskId: task.frontmatter.id,
            from: oldPath,
            to: newPath,
            op: "reconcile",
          },
          "reconciled task file to match frontmatter status",
        );
      } catch (err) {
        storeLog.error(
          {
            taskId: task.frontmatter.id,
            err,
            oldPath,
            newPath,
            op: "reconcile",
          },
          "failed to reconcile task file",
        );
        // Do not throw — one bad file should not block the rest of init().
      }
    }
  }

  /** Get the directory path for a status. */
  private statusDir(status: TaskStatus): string {
    return join(this.tasksDir, status);
  }

  /** Get the full file path for a task. */
  private taskPath(id: string, status: TaskStatus): string {
    return join(this.statusDir(status), taskFilename(id));
  }

  /** Get the companion directory path for task artifacts. */
  private taskDir(id: string, status: TaskStatus): string {
    return join(this.statusDir(status), id);
  }

  /** Ensure companion directories exist for a task. */
  private async ensureTaskDirs(id: string, status: TaskStatus): Promise<void> {
    const baseDir = this.taskDir(id, status);
    await mkdir(join(baseDir, "inputs"), { recursive: true });
    await mkdir(join(baseDir, "work"), { recursive: true });
    await mkdir(join(baseDir, "outputs"), { recursive: true });
    await mkdir(join(baseDir, "subtasks"), { recursive: true });
  }

  private async readTaskAtPath(filePath: string): Promise<Task | undefined> {
    try {
      const raw = await readFile(filePath, "utf-8");
      return parseTaskFile(raw, filePath);
    } catch (err) {
      try {
        await stat(filePath);
        const errorMessage = (err as Error).message;
        storeLog.error({ filePath, error: errorMessage }, "parse error in task file");
        if (this.logger) {
          await this.logger.logValidationFailed(basename(filePath), errorMessage);
        }
      } catch {
        // File doesn't exist.
      }

      return undefined;
    }
  }

  /** Create a new task. Returns the created Task. */
  /** Create a new task. Returns the created Task. */
  async create(opts: {
    title: string;
    body?: string;
    priority?: string;
    routing?: { role?: string; team?: string; agent?: string; tags?: string[] };
    sla?: { maxInProgressMs?: number; onViolation?: "alert" | "block" | "deadletter" };
    metadata?: Record<string, unknown>;
    createdBy: string;
    parentId?: string;
    dependsOn?: string[];
    workflow?: { definition: WorkflowDefinition; templateName?: string };
    contextTier?: "seed" | "full";
    callbackDepth?: number;
    /**
     * Initial lifecycle status for the new task. Defaults to `"backlog"` to
     * preserve the long-standing creation semantics. `aofDispatch` overrides
     * this to `"ready"` so the task file materializes directly in
     * `tasks/ready/` instead of being written in `backlog/` and then renamed
     * — closing BUG-006's concurrent-write-vs-read race where a parallel
     * `aof_status_report` could observe the brief window when the file was
     * in neither status directory.
     */
    initialStatus?: TaskStatus;
  }): Promise<Task> {
    const body = opts.body ?? "";
    const status: TaskStatus = opts.initialStatus ?? "backlog";

    // --- Workflow handling: auto-validate and auto-initialize ---
    let resolvedWorkflow: TaskWorkflow | undefined;
    if (opts.workflow?.definition) {
      const dagErrors = validateDAG(opts.workflow.definition);
      if (dagErrors.length > 0) {
        throw new Error(`Workflow DAG invalid: ${dagErrors.join(", ")}`);
      }
      const state = initializeWorkflowState(opts.workflow.definition);
      resolvedWorkflow = {
        definition: opts.workflow.definition,
        state,
        ...(opts.workflow.templateName ? { templateName: opts.workflow.templateName } : {}),
      };
    }

    await mkdir(this.statusDir(status), { recursive: true });

    for (let attempt = 0; attempt < 1000; attempt++) {
      const now = new Date();
      const nowIso = now.toISOString();
      const id = this.nextTaskId(now);
      const frontmatter = TaskFrontmatter.parse({
        schemaVersion: 1,
        id,
        // BUG-044: only stamp `project` when the store is project-scoped.
        // Unscoped base stores (projectId === null) must leave this
        // field absent so task-dispatcher doesn't attempt a manifest
        // lookup for a project that doesn't exist.
        ...(this.projectId ? { project: this.projectId } : {}),
        title: opts.title,
        status,
        priority: opts.priority ?? "normal",
        routing: {
          role: opts.routing?.role,
          team: opts.routing?.team,
          agent: opts.routing?.agent,
          tags: opts.routing?.tags ?? [],
        },
        sla: opts.sla,
        createdAt: nowIso,
        updatedAt: nowIso,
        lastTransitionAt: nowIso,
        createdBy: opts.createdBy,
        parentId: opts.parentId,
        dependsOn: opts.dependsOn ?? [],
        metadata: opts.metadata ?? {},
        contextTier: opts.contextTier,
        ...(opts.callbackDepth !== undefined ? { callbackDepth: opts.callbackDepth } : {}),
        contentHash: contentHash(body),
        ...(resolvedWorkflow ? { workflow: resolvedWorkflow } : {}),
      });

      const task: Task = { frontmatter, body };
      const filePath = this.taskPath(id, status);

      try {
        await writeFile(filePath, serializeTask(task), { encoding: "utf-8", flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          continue;
        }
        throw error;
      }

      await this.ensureTaskDirs(id, status);
      task.path = filePath;

      return task;
    }

    throw new Error("Failed to allocate a unique task ID after 1000 attempts");
  }

  /**
   * Find a task by ID across all status directories.
   *
   * If the same id surfaces in more than one status directory (a state
   * that v1.14.8's per-task mutex prevents intra-process, but that
   * pre-fix installs, multi-process hosts, and external sync can still
   * produce), self-heal: keep the most-recently-written copy as
   * canonical and remove the stales. The previous behavior was to throw
   * forever, which jammed the dispatch chain in an infinite retry loop.
   * The `mtime`-wins heuristic reflects that the last completed
   * transition always writes after any phantom siblings.
   */
  async get(id: string): Promise<Task | undefined> {
    const matches: Array<{ task: Task; filePath: string; mtimeMs: number }> = [];

    for (const status of STATUS_DIRS) {
      const filePath = this.taskPath(id, status);
      const task = await this.readTaskAtPath(filePath);
      if (task) {
        const st = await stat(filePath).catch(() => undefined);
        matches.push({ task, filePath, mtimeMs: st?.mtimeMs ?? 0 });
      }
    }

    if (matches.length <= 1) return matches[0]?.task;

    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const winner = matches[0]!;
    const stale = matches.slice(1);
    const statuses = matches.map(m => m.task.frontmatter.status).join(", ");
    storeLog.error(
      {
        taskId: id,
        statuses,
        winner: winner.task.frontmatter.status,
        discarded: stale.map(s => s.task.frontmatter.status),
      },
      "duplicate task ID detected — self-healing by removing stale copies (most-recent mtime wins)",
    );
    for (const s of stale) {
      await rm(s.filePath, { force: true }).catch((err) => {
        storeLog.warn({ taskId: id, filePath: s.filePath, err }, "duplicate removal failed");
      });
    }
    return winner.task;
  }

  /** Find a task by ID prefix (for CLI convenience). */
  async getByPrefix(prefix: string): Promise<Task | undefined> {
    const matches: Task[] = [];

    for (const status of STATUS_DIRS) {
      const dir = this.statusDir(status);
      try {
        const entries = await readdir(dir);
        for (const entry of entries) {
          if (!entry.startsWith(prefix) || !entry.endsWith(".md")) continue;

          const task = await this.readTaskAtPath(join(dir, entry));
          if (task) {
            matches.push(task);
          }
        }
      } catch {
        // Directory might not exist
      }
    }

    if (matches.length > 1) {
      const ids = matches.map(task => task.frontmatter.id).join(", ");
      throw new Error(`Ambiguous task prefix: ${prefix} matches multiple tasks (${ids})`);
    }

    return matches[0];
  }

  /** List all tasks, optionally filtered. */
  async list(filters?: {
    status?: TaskStatus;
    agent?: string;
    team?: string;
  }): Promise<Task[]> {
    const tasks: Task[] = [];
    const statusesToScan = filters?.status ? [filters.status] : STATUS_DIRS;

    for (const status of statusesToScan) {
      const dir = this.statusDir(status);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue; // Directory doesn't exist
      }

      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const filePath = join(dir, entry);

        try {
          const s = await stat(filePath);
          if (!s.isFile()) continue;

          const raw = await readFile(filePath, "utf-8");
          const task = parseTaskFile(raw, filePath);

          // Apply filters
          if (filters?.agent && task.frontmatter.lease?.agent !== filters.agent) continue;
          if (filters?.team && task.frontmatter.routing.team !== filters.team) continue;

          tasks.push(task);
        } catch (err) {
          // Skip malformed files but log the error explicitly
          const errorMessage = (err as Error).message;
          storeLog.error({ filePath, error: errorMessage }, "parse error in task file");
          
          // Emit validation.failed event
          if (this.logger) {
            await this.logger.logValidationFailed(basename(filePath), errorMessage);
          }
        }
      }
    }

    return tasks;
  }

  /**
   * Count tasks by status.
   * Returns a map of status -> count.
   */
  async countByStatus(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    for (const status of STATUS_DIRS) {
      const dir = this.statusDir(status);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        counts[status] = 0;
        continue;
      }

      const taskFiles = entries.filter((entry) => entry.endsWith(".md"));
      counts[status] = taskFiles.length;
    }

    return counts;
  }

  /**
   * Transition a task to a new status.
   * This is the core operation: atomic rename between status directories.
   *
   * Guarded by a per-task mutex: concurrent transitions serialize so
   * the late contender re-reads fresh state and either no-ops (already
   * in target), throws `Invalid transition`, or performs a valid
   * follow-up transition. Without the lock, two racing transitions
   * leave the same task file in two status directories at once
   * (see task-lock.ts for the write+rename race detail).
   */
  async transition(
    id: string,
    newStatus: TaskStatus,
    opts?: TransitionOpts,
  ): Promise<Task> {
    return this.locks.run(id, () => transitionTask(
      id,
      newStatus,
      opts,
      this.get.bind(this),
      this.taskPath.bind(this),
      this.taskDir.bind(this),
      this.logger as any,
      this.hooks,
    ));
  }

  /**
   * Cancel a task.
   * Transitions to "cancelled" status, clears any active lease,
   * stores cancellation reason in metadata, and emits task.cancelled event.
   *
   * Shares the per-task mutex with transition(): cancelling while a
   * transition is in-flight would otherwise produce the same
   * duplicate-file race.
   */
  async cancel(id: string, reason?: string): Promise<Task> {
    return this.locks.run(id, () => cancelTask(
      id,
      reason,
      this.get.bind(this),
      this.taskPath.bind(this),
      this.taskDir.bind(this),
      this.logger,
      this.hooks,
    ));
  }

  /**
   * Update task body content (recalculates content hash).
   *
   * Guarded by the per-task mutex so body writes can't lose updates when
   * interleaved with addDep/removeDep/transition/cancel on the same task.
   */
  async updateBody(id: string, body: string): Promise<Task> {
    return this.locks.run(id, async () => {
      const task = await this.get(id);
      if (!task) throw new Error(`Task not found: ${id}`);

      task.body = body;
      task.frontmatter.contentHash = contentHash(body);
      task.frontmatter.updatedAt = new Date().toISOString();

      const filePath = task.path ?? this.taskPath(id, task.frontmatter.status);
      await writeFileAtomic(filePath, serializeTask(task));

      return task;
    });
  }

  /**
   * Update task metadata fields.
   *
   * Guarded by the per-task mutex so metadata patches don't lose updates
   * when racing against dep/body/status mutations on the same task.
   */
  async update(id: string, patch: UpdatePatch): Promise<Task> {
    return this.locks.run(id, () => updateTask(
      id,
      patch,
      this.get.bind(this),
      this.taskPath.bind(this),
      this.logger as any,
    ));
  }

  /** Delete a task file (use sparingly — prefer cancel status). */
  async delete(id: string): Promise<boolean> {
    const task = await this.get(id);
    if (!task) return false;

    const filePath = task.path ?? this.taskPath(id, task.frontmatter.status);
    try {
      await rm(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Scan for tasks with consistency issues.
   * Returns tasks where frontmatter status doesn't match directory.
   */
  async lint(): Promise<Array<{ task: Task; issue: string }>> {
    return lintTasks(this.tasksDir, this.statusDir.bind(this), this.logger);
  }

  /**
   * List all files in the task's inputs/ directory.
   * Returns empty array if task or directory doesn't exist.
   */
  async getTaskInputs(id: string): Promise<string[]> {
    return getInputs(id, this.get.bind(this), this.taskDir.bind(this));
  }

  /**
   * List all files in the task's outputs/ directory.
   * Returns empty array if task or directory doesn't exist.
   */
  async getTaskOutputs(id: string): Promise<string[]> {
    return getOutputs(id, this.get.bind(this), this.taskDir.bind(this));
  }

  /**
   * Write a file to the task's outputs/ directory.
   * Creates the outputs directory if it doesn't exist.
   */
  async writeTaskOutput(id: string, filename: string, content: string): Promise<void> {
    return writeOutput(id, filename, content, this.get.bind(this), this.taskDir.bind(this));
  }

  /**
   * Check if adding a dependency would create a cycle.
   * Returns true if blockerId (or any of its transitive dependencies) depends on taskId.
   * Uses DFS to detect cycles in the dependency graph.
   */
  private async hasCycle(taskId: string, blockerId: string): Promise<boolean> {
    return hasCycle(taskId, blockerId, this.get.bind(this));
  }

  /**
   * Add a dependency to a task.
   * Makes taskId depend on blockerId (taskId cannot start until blockerId is done).
   *
   * Guarded by the per-task mutex: addDep is a read-modify-write on the
   * frontmatter.dependsOn array, and concurrent unlocked calls lose updates
   * (both read the same baseline, each pushes its blocker, last write wins).
   * The lock shares a key with transition()/cancel(), so a concurrent
   * transition and dependency mutation also serialize correctly.
   */
  async addDep(taskId: string, blockerId: string): Promise<Task> {
    return this.locks.run(taskId, () => addDependency(
      taskId,
      blockerId,
      this.get.bind(this),
      this.taskPath.bind(this),
      this.logger,
    ));
  }

  /**
   * Remove a dependency from a task.
   *
   * Same rationale as addDep: read-modify-write on dependsOn must be serialized
   * with any other mutation on the same task to prevent lost updates.
   */
  async removeDep(taskId: string, blockerId: string): Promise<Task> {
    return this.locks.run(taskId, () => removeDependency(
      taskId,
      blockerId,
      this.get.bind(this),
      this.taskPath.bind(this),
      this.logger,
    ));
  }

  /**
   * Block a task with a reason.
   * Transitions task to blocked state and stores the block reason.
   * Can only block tasks from non-terminal states.
   */
  async block(id: string, reason: string): Promise<Task> {
    return blockTask(
      id,
      reason,
      this.get.bind(this),
      this.transition.bind(this),
      this.taskPath.bind(this),
      this.logger,
    );
  }

  /**
   * Unblock a task.
   * Transitions task from blocked to ready and clears the block reason.
   * Can only unblock tasks currently in blocked state.
   */
  async unblock(id: string): Promise<Task> {
    return unblockTask(
      id,
      this.get.bind(this),
      this.transition.bind(this),
      this.taskPath.bind(this),
      this.logger,
    );
  }

  /**
   * Persist a modified task to its canonical path.
   * Uses task.path if set, otherwise computes from status directory.
   */
  async save(task: Task): Promise<void> {
    const filePath = task.path ?? this.taskPath(task.frontmatter.id, task.frontmatter.status);
    await writeFileAtomic(filePath, serializeTask(task));
  }

  /**
   * Persist a task to an explicit path (for session copies, metadata files).
   */
  async saveToPath(task: Task, path: string): Promise<void> {
    await writeFileAtomic(path, serializeTask(task));
  }
}
