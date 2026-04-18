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
import { createLogger } from "../logging/index.js";
import { TaskFrontmatter, Task, isValidTransition } from "../schemas/task.js";

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
  projectId?: string;
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

  /** Compute the next TASK-YYYY-MM-DD-NNN identifier. */
  private async nextTaskId(now: Date): Promise<string> {
    const date = formatTaskDate(now);
    const prefix = `TASK-${date}-`;
    let max = 0;

    for (const status of STATUS_DIRS) {
      const dir = this.statusDir(status);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.startsWith(prefix) || !entry.endsWith(".md")) continue;
        const suffix = entry.slice(prefix.length, prefix.length + 3);
        const value = parseInt(suffix, 10);
        if (!Number.isNaN(value)) {
          max = Math.max(max, value);
        }
      }
    }

    const next = String(max + 1).padStart(3, "0");
    return `${prefix}${next}`;
  }

  /** Ensure all status directories exist. */
  async init(): Promise<void> {
    for (const status of STATUS_DIRS) {
      await mkdir(join(this.tasksDir, status), { recursive: true });
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
  }): Promise<Task> {
    const body = opts.body ?? "";
    const status: TaskStatus = "backlog";

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
      const id = await this.nextTaskId(now);
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

  /** Update task body content (recalculates content hash). */
  async updateBody(id: string, body: string): Promise<Task> {
    const task = await this.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);

    task.body = body;
    task.frontmatter.contentHash = contentHash(body);
    task.frontmatter.updatedAt = new Date().toISOString();

    const filePath = task.path ?? this.taskPath(id, task.frontmatter.status);
    await writeFileAtomic(filePath, serializeTask(task));

    return task;
  }

  /** Update task metadata fields. */
  async update(id: string, patch: UpdatePatch): Promise<Task> {
    return updateTask(
      id,
      patch,
      this.get.bind(this),
      this.taskPath.bind(this),
      this.logger as any,
    );
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
   */
  async addDep(taskId: string, blockerId: string): Promise<Task> {
    return addDependency(
      taskId,
      blockerId,
      this.get.bind(this),
      this.taskPath.bind(this),
      this.logger,
    );
  }

  /**
   * Remove a dependency from a task.
   */
  async removeDep(taskId: string, blockerId: string): Promise<Task> {
    return removeDependency(
      taskId,
      blockerId,
      this.get.bind(this),
      this.taskPath.bind(this),
      this.logger,
    );
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
