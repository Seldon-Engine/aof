/**
 * Task mutation operations — extracted from task-store for modularity.
 * 
 * These are standalone functions that can be called by the store.
 * They accept store methods as parameters to avoid circular dependencies.
 */

import { rename, unlink, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { Task, TaskStatus } from "../schemas/task.js";
import { isValidTransition } from "../schemas/task.js";
import { contentHash, serializeTask } from "./task-parser.js";

export interface UpdatePatch {
  title?: string;
  description?: string;
  priority?: string;
  routing?: {
    role?: string;
    team?: string;
    agent?: string;
    tags?: string[];
  };
}

/**
 * Update task fields (title, description, priority, routing).
 * Standalone function extracted from FilesystemTaskStore.update().
 */
export async function updateTask(
  id: string,
  patch: UpdatePatch,
  getTask: (id: string) => Promise<Task | null | undefined>,
  getTaskPath: (id: string, status: TaskStatus) => string,
  logger?: {
    log(event: string, actor: string, data: { taskId: string; payload: unknown }): Promise<void>;
  },
): Promise<Task> {
  const task = await getTask(id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }

  // Reject updates to terminal states
  const terminalStates: TaskStatus[] = ["done"];
  if (terminalStates.includes(task.frontmatter.status)) {
    throw new Error(
      `Cannot update task ${id}: task is in terminal state '${task.frontmatter.status}'`,
    );
  }

  // Track what changed for event payload
  const changes: Record<string, unknown> = {};

  // Apply patches
  if (patch.title !== undefined) {
    changes.title = { from: task.frontmatter.title, to: patch.title };
    task.frontmatter.title = patch.title;
  }

  if (patch.description !== undefined) {
    changes.description = { from: task.body, to: patch.description };
    task.body = patch.description;
    task.frontmatter.contentHash = contentHash(patch.description);
  }

  if (patch.priority !== undefined) {
    changes.priority = { from: task.frontmatter.priority, to: patch.priority };
    task.frontmatter.priority = patch.priority as typeof task.frontmatter.priority;
  }

  if (patch.routing !== undefined) {
    const oldRouting = { ...task.frontmatter.routing };
    
    if (patch.routing.role !== undefined) {
      task.frontmatter.routing.role = patch.routing.role;
    }
    if (patch.routing.team !== undefined) {
      task.frontmatter.routing.team = patch.routing.team;
    }
    if (patch.routing.agent !== undefined) {
      task.frontmatter.routing.agent = patch.routing.agent;
    }
    if (patch.routing.tags !== undefined) {
      task.frontmatter.routing.tags = patch.routing.tags;
    }

    changes.routing = { from: oldRouting, to: task.frontmatter.routing };
  }

  // Update timestamp
  task.frontmatter.updatedAt = new Date().toISOString();

  // Persist changes
  const filePath = task.path ?? getTaskPath(id, task.frontmatter.status);
  await writeFileAtomic(filePath, serializeTask(task));

  // Emit task.updated event
  if (logger && Object.keys(changes).length > 0) {
    await logger.log("task.updated", "system", {
      taskId: id,
      payload: { changes },
    });
  }

  return task;
}

export interface TransitionOpts {
  reason?: string;
  agent?: string;
  /**
   * Phase 46 / Bug 1A — see `ITaskStore.transition` opts.metadataPatch.
   * Fields merged into `task.frontmatter.metadata` BEFORE the new-location
   * `writeFileAtomic`, so the metadata stamp and the file move happen
   * inside the same per-task TaskLocks critical section.
   */
  metadataPatch?: Record<string, unknown>;
}

export type { TaskStoreHooks } from "./interfaces.js";
import type { TaskStoreHooks } from "./interfaces.js";

export interface TaskLogger {
  logTransition(
    taskId: string,
    fromStatus: TaskStatus,
    toStatus: TaskStatus,
    actor: string,
    reason?: string,
  ): Promise<void>;
  log(event: string, actor: string, data: { taskId: string; payload: unknown }): Promise<void>;
}

/**
 * Transition task to a new status.
 * Standalone function extracted from FilesystemTaskStore.transition().
 */
export async function transitionTask(
  id: string,
  newStatus: TaskStatus,
  opts: TransitionOpts | undefined,
  getTask: (id: string) => Promise<Task | null | undefined>,
  getTaskPath: (id: string, status: TaskStatus) => string,
  getTaskDir: (id: string, status: TaskStatus) => string,
  logger?: TaskLogger,
  hooks?: TaskStoreHooks,
): Promise<Task> {
  const task = await getTask(id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }

  const currentStatus = task.frontmatter.status;

  // Idempotent: if already in target state, return early (no-op)
  if (currentStatus === newStatus) {
    return task;
  }

  if (!isValidTransition(currentStatus, newStatus)) {
    throw new Error(
      `Invalid transition: ${currentStatus} → ${newStatus} for task ${id}`,
    );
  }

  const now = new Date().toISOString();
  task.frontmatter.status = newStatus;
  task.frontmatter.updatedAt = now;
  task.frontmatter.lastTransitionAt = now;

  // Phase 46 / Bug 1A: apply caller-supplied metadata patch atomically
  // with the rename. Used by failure-tracker.transitionToDeadletter to
  // stamp deadletter cause fields (deadletterReason, deadletterLastError,
  // deadletterErrorClass, deadletterAt, deadletterFailureCount) inside
  // the same per-task-mutex critical section as the file move, so the
  // pre-Phase-46 partial-state window between save() and transition()
  // becomes structurally impossible. Patch is applied BEFORE the
  // writeFileAtomic call below so the new-location file lands with the
  // patched frontmatter on first write. The idempotent early-return at
  // line 151 deliberately skips the patch — failure-tracker only calls
  // transition for non-no-op transitions, so this is fine.
  if (opts?.metadataPatch) {
    task.frontmatter.metadata = {
      ...task.frontmatter.metadata,
      ...opts.metadataPatch,
    };
  }

  // Clear lease on terminal states and when returning to ready
  if (newStatus === "done" || newStatus === "ready" || newStatus === "backlog") {
    task.frontmatter.lease = undefined;
  }

  const oldPath = task.path ?? getTaskPath(id, currentStatus);
  const newPath = getTaskPath(id, newStatus);

  if (oldPath !== newPath) {
    // Failure-safe transition:
    //   1. Ensure target status directory exists.
    //   2. Write the new-location file FIRST (atomic) — new location becomes
    //      source of truth before we touch the old location.
    //   3. Move the companion directory (best-effort — a missing companion
    //      dir is fine; any other failure aborts and rolls back the .md write).
    //   4. Remove the old .md. If this fails, we're in a duplicate-file state
    //      rather than a split-state, which a startup reconciliation sweep
    //      can detect (both files with matching frontmatter.status) and
    //      resolve idempotently.
    //
    // Prior implementation wrote to the OLD path then renamed. If anything
    // (including a concurrent writer from a zombie pre-thin-bridge plugin
    // process) interfered between the rename of the .md and the rename of
    // the companion dir, the .md could end up at the OLD location with
    // frontmatter pointing at the NEW status — a permanent split-state that
    // the scheduler couldn't reconcile. Writing new-first inverts that risk.
    await mkdir(dirname(newPath), { recursive: true });

    await writeFileAtomic(newPath, serializeTask(task));

    const oldDir = getTaskDir(id, currentStatus);
    const newDir = getTaskDir(id, newStatus);
    try {
      await rename(oldDir, newDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // Companion dir exists but couldn't move — roll back the .md write
        // to avoid stranding content at two locations. ENOENT is fine
        // (some tasks have no companion directory).
        await unlink(newPath).catch(() => {
          // best-effort rollback; if this also fails the next startup
          // reconciliation will clean up
        });
        throw err;
      }
    }

    // Cross-process safety: verify the new file actually landed before we
    // delete the old one. If verification fails, leave the old file in place
    // so nothing is lost.
    try {
      await stat(newPath);
      await unlink(oldPath).catch((err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw err;
        // Old file already gone (e.g. another writer beat us to it) — fine.
      });
    } catch {
      // New file verification failed — unusual but non-destructive to bail.
    }
  } else {
    // Same location, just update content atomically
    await writeFileAtomic(newPath, serializeTask(task));
  }

  task.path = newPath;
  
  // Emit transition event
  if (logger) {
    await logger.logTransition(id, currentStatus, newStatus, opts?.agent ?? "system", opts?.reason);
  }
  
  // Emit task.assigned event if transitioning to in-progress with an agent
  if (newStatus === "in-progress" && opts?.agent) {
    if (logger) {
      await logger.log("task.assigned", opts.agent, {
        taskId: id,
        payload: { agent: opts.agent },
      });
    }
  }
  
  if (hooks?.afterTransition) {
    await hooks.afterTransition(task, currentStatus);
  }
  
  return task;
}
