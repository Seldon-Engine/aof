import { existsSync } from "node:fs";
import type { ProtocolEnvelope as ProtocolEnvelopeType } from "../schemas/protocol.js";
import type { StatusUpdatePayload } from "../schemas/protocol.js";
import type { HandoffRequestPayload, HandoffAckPayload } from "../schemas/protocol.js";
import type { Task } from "../schemas/task.js";
import type { TaskStatus } from "../schemas/task.js";
import type { ITaskStore } from "../store/interfaces.js";
import { serializeTask } from "../store/task-store.js";
import type { NotificationService } from "../events/notifier.js";
import { readRunResult, writeRunResult, completeRunArtifact } from "../recovery/run-artifacts.js";
import type { RunResult } from "../schemas/run-result.js";
import { writeHandoffArtifacts } from "../delegation/index.js";
import writeFileAtomic from "write-file-atomic";
import type { TaskLockManager } from "./task-lock.js";
import { InMemoryTaskLockManager } from "./task-lock.js";
import { parseProtocolMessage, type ProtocolLogger } from "./parsers.js";
import { buildStatusReason, shouldAppendWorkLog, buildWorkLogEntry, appendSection } from "./formatters.js";
import {
  resolveAuthorizedAgent,
  checkAuthorization,
  applyCompletionOutcome,
  transitionTask,
  logTransition,
  notifyTransition,
} from "./router-helpers.js";

// Re-export for backward compatibility
export { parseProtocolMessage } from "./parsers.js";
export type { ProtocolLogger } from "./parsers.js";

export interface ProtocolRouterDependencies {
  store: ITaskStore;
  logger?: ProtocolLogger;
  notifier?: NotificationService;
  lockManager?: TaskLockManager;
  projectStoreResolver?: (projectId: string) => ITaskStore | undefined;
}

export class ProtocolRouter {
  private readonly handlers: Record<
    string,
    (envelope: ProtocolEnvelopeType, store: ITaskStore) => Promise<void> | void
  >;
  private readonly logger?: ProtocolLogger;
  private readonly store: ITaskStore;
  private readonly notifier?: NotificationService;
  private readonly lockManager: TaskLockManager;
  private readonly projectStoreResolver?: (projectId: string) => ITaskStore | undefined;

  constructor(deps: ProtocolRouterDependencies) {
    this.logger = deps.logger;
    this.store = deps.store;
    this.notifier = deps.notifier;
    this.lockManager = deps.lockManager ?? new InMemoryTaskLockManager();
    this.projectStoreResolver = deps.projectStoreResolver;
    this.handlers = {
      "completion.report": (envelope, store) =>
        this.lockManager.withLock(envelope.taskId, () => this.handleCompletionReport(envelope, store)),
      "status.update": (envelope, store) =>
        this.lockManager.withLock(envelope.taskId, () => this.handleStatusUpdate(envelope, store)),
      "handoff.request": (envelope, store) =>
        this.lockManager.withLock(envelope.taskId, () => this.handleHandoffRequest(envelope, store)),
      "handoff.accepted": (envelope, store) =>
        this.lockManager.withLock(envelope.taskId, () => this.handleHandoffAck(envelope, store)),
      "handoff.rejected": (envelope, store) =>
        this.lockManager.withLock(envelope.taskId, () => this.handleHandoffAck(envelope, store)),
    };
  }

  async route(envelope: ProtocolEnvelopeType): Promise<void> {
    const handler = this.handlers[envelope.type];
    if (!handler) {
      await this.logger?.log("protocol.message.unknown", "system", {
        taskId: envelope.taskId,
        payload: { type: envelope.type },
      });
      return;
    }

    // Validate project and resolve store
    const store = this.resolveProjectStore(envelope.projectId);
    if (!store) {
      await this.logger?.log("protocol.message.rejected", "system", {
        taskId: envelope.taskId,
        payload: {
          reason: "invalid_project_id",
          projectId: envelope.projectId,
        },
      });
      return;
    }

    // Validate task exists in the project
    const task = await store.get(envelope.taskId);
    if (!task) {
      await this.logger?.log("protocol.message.rejected", "system", {
        taskId: envelope.taskId,
        payload: {
          reason: "task_not_found",
          projectId: envelope.projectId,
        },
      });
      return;
    }

    await handler(envelope, store);
  }

  private resolveProjectStore(projectId: string): ITaskStore | undefined {
    if (this.projectStoreResolver) {
      return this.projectStoreResolver(projectId);
    }
    // Fallback for legacy single-store mode
    return this.store;
  }

  async handleCompletionReport(
    envelope: ProtocolEnvelopeType,
    store: ITaskStore,
  ): Promise<void> {
    await this.logger?.log("protocol.message.received", envelope.fromAgent, {
      taskId: envelope.taskId,
      payload: { type: envelope.type },
    });

    if (envelope.type !== "completion.report") return;

    const task = await store.get(envelope.taskId);
    if (!task) {
      await this.logger?.log("protocol.message.rejected", "system", {
        taskId: envelope.taskId,
        payload: { reason: "task_not_found" },
      });
      return;
    }

    // Authorization check: only assigned agent can send completion reports
    if (!(await checkAuthorization(envelope.fromAgent, envelope.taskId, task, this.logger))) {
      return;
    }

    // Warn if referenced summary file does not exist
    if (!existsSync(envelope.payload.summaryRef)) {
      await this.logger?.log("protocol.message.warning", "system", {
        taskId: envelope.taskId,
        payload: { reason: "summary_file_not_found", summaryRef: envelope.payload.summaryRef },
      });
    }

    const runResult: RunResult = {
      taskId: envelope.taskId,
      agentId: envelope.fromAgent,
      completedAt: envelope.sentAt,
      outcome: envelope.payload.outcome,
      summaryRef: envelope.payload.summaryRef,
      handoffRef: "outputs/handoff.md",
      deliverables: envelope.payload.deliverables,
      tests: envelope.payload.tests,
      blockers: envelope.payload.blockers,
      notes: envelope.payload.notes,
    };

    await writeRunResult(store, envelope.taskId, runResult);

    await applyCompletionOutcome(
      task,
      {
        actor: envelope.fromAgent,
        outcome: envelope.payload.outcome,
        notes: envelope.payload.notes,
        blockers: envelope.payload.blockers,
      },
      store,
      this.logger,
      this.notifier,
    );

    await completeRunArtifact(store, envelope.taskId);

    await this.logger?.log("task.completed", envelope.fromAgent, {
      taskId: envelope.taskId,
      payload: { outcome: envelope.payload.outcome },
    });
  }

  async handleStatusUpdate(
    envelope: ProtocolEnvelopeType,
    store: ITaskStore,
  ): Promise<void> {
    await this.logger?.log("protocol.message.received", envelope.fromAgent, {
      taskId: envelope.taskId,
      payload: { type: envelope.type },
    });

    if (envelope.type !== "status.update") return;

    const task = await store.get(envelope.taskId);
    if (!task) {
      await this.logger?.log("protocol.message.rejected", "system", {
        taskId: envelope.taskId,
        payload: { reason: "task_not_found" },
      });
      return;
    }

    const actor = envelope.payload.agentId ?? envelope.fromAgent;
    const reason = buildStatusReason(envelope.payload);

    let updatedTask = task;
    let transitioned = false;

    if (envelope.payload.status) {
      const targetStatus = envelope.payload.status;
      if (updatedTask.frontmatter.status !== targetStatus) {
        const nextTask = await transitionTask(
          updatedTask,
          targetStatus,
          actor,
          reason,
          store,
        );
        transitioned = nextTask.frontmatter.status !== updatedTask.frontmatter.status;
        updatedTask = nextTask;
      }
    }

    if (!transitioned && shouldAppendWorkLog(envelope.payload)) {
      updatedTask = await this.appendWorkLog(updatedTask, envelope.payload, store);
    }

    if (transitioned) {
      await logTransition(
        updatedTask.frontmatter.id,
        task.frontmatter.status,
        updatedTask.frontmatter.status,
        actor,
        reason,
        this.logger,
      );
      await notifyTransition(
        updatedTask.frontmatter.id,
        task.frontmatter.status,
        updatedTask.frontmatter.status,
        actor,
        reason,
        this.notifier,
      );
    }
  }

  async handleSessionEnd(): Promise<void> {
    const inProgress = await this.store.list({ status: "in-progress" });
    for (const task of inProgress) {
      const runResult = await readRunResult(this.store, task.frontmatter.id);
      if (!runResult) continue;
      await applyCompletionOutcome(
        task,
        {
          actor: runResult.agentId,
          outcome: runResult.outcome,
          notes: runResult.notes,
          blockers: runResult.blockers,
        },
        this.store,
        this.logger,
        this.notifier,
      );
      await completeRunArtifact(this.store, task.frontmatter.id);
    }
  }

  async handleHandoffRequest(
    envelope: ProtocolEnvelopeType,
    store: ITaskStore,
  ): Promise<void> {
    await this.logger?.log("protocol.message.received", envelope.fromAgent, {
      taskId: envelope.taskId,
      payload: { type: envelope.type },
    });

    if (envelope.type !== "handoff.request") return;

    const payload = envelope.payload as HandoffRequestPayload;

    // Verify taskId matches
    if (payload.taskId !== envelope.taskId) {
      await this.logger?.log("protocol.message.rejected", "system", {
        taskId: envelope.taskId,
        payload: { reason: "taskId_mismatch" },
      });
      return;
    }

    // Load child task
    const childTask = await store.get(envelope.taskId);
    if (!childTask) {
      await this.logger?.log("protocol.message.rejected", "system", {
        taskId: envelope.taskId,
        payload: { reason: "task_not_found" },
      });
      await this.logger?.log("delegation.rejected", envelope.fromAgent, {
        taskId: envelope.taskId,
        payload: { reason: "task_not_found" },
      });
      return;
    }

    // Authorization check: only assigned agent can send handoff requests
    if (!(await checkAuthorization(envelope.fromAgent, envelope.taskId, childTask, this.logger))) {
      return;
    }

    // Load parent task
    const parentTask = await store.get(payload.parentTaskId);
    if (!parentTask) {
      await this.logger?.log("delegation.rejected", envelope.fromAgent, {
        taskId: envelope.taskId,
        payload: { reason: "parent_not_found" },
      });
      return;
    }

    // Check delegation depth
    const parentDepth =
      typeof parentTask.frontmatter.metadata?.delegationDepth === "number"
        ? parentTask.frontmatter.metadata.delegationDepth
        : 0;

    if (parentDepth + 1 > 1) {
      await this.logger?.log("delegation.rejected", envelope.fromAgent, {
        taskId: envelope.taskId,
        payload: { reason: "nested_delegation" },
      });
      return;
    }

    // Update child metadata with delegation depth
    childTask.frontmatter.metadata = {
      ...childTask.frontmatter.metadata,
      delegationDepth: parentDepth + 1,
    };
    // Route child to receiving agent so handoff.ack authorization passes
    childTask.frontmatter.routing = {
      ...childTask.frontmatter.routing,
      agent: payload.toAgent,
    };
    childTask.frontmatter.updatedAt = new Date().toISOString();

    // Write updated task
    const taskPath =
      childTask.path ??
      `${store.tasksDir}/${childTask.frontmatter.status}/${childTask.frontmatter.id}.md`;
    childTask.path = taskPath;
    await writeFileAtomic(taskPath, serializeTask(childTask));

    // Write handoff artifacts
    await writeHandoffArtifacts(store, childTask, payload);

    await this.logger?.log("delegation.requested", envelope.fromAgent, {
      taskId: envelope.taskId,
      payload: {
        parentTaskId: payload.parentTaskId,
        toAgent: payload.toAgent,
      },
    });
  }

  async handleHandoffAck(
    envelope: ProtocolEnvelopeType,
    store: ITaskStore,
  ): Promise<void> {
    await this.logger?.log("protocol.message.received", envelope.fromAgent, {
      taskId: envelope.taskId,
      payload: { type: envelope.type },
    });

    if (envelope.type !== "handoff.accepted" && envelope.type !== "handoff.rejected") return;

    const payload = envelope.payload as HandoffAckPayload;

    // Load child task
    const childTask = await store.get(envelope.taskId);
    if (!childTask) {
      await this.logger?.log("protocol.message.rejected", "system", {
        taskId: envelope.taskId,
        payload: { reason: "task_not_found" },
      });
      return;
    }

    // Authorization check: only assigned agent can send handoff acks
    if (!(await checkAuthorization(envelope.fromAgent, envelope.taskId, childTask, this.logger))) {
      return;
    }

    if (envelope.type === "handoff.accepted") {
      await this.logger?.log("delegation.accepted", envelope.fromAgent, {
        taskId: envelope.taskId,
      });
    } else {
      // handoff.rejected
      const reason = payload.reason ?? "handoff_rejected";
      await transitionTask(childTask, "blocked", envelope.fromAgent, reason, store);
      await logTransition(
        childTask.frontmatter.id,
        childTask.frontmatter.status,
        "blocked",
        envelope.fromAgent,
        reason,
        this.logger,
      );
      await notifyTransition(
        childTask.frontmatter.id,
        childTask.frontmatter.status,
        "blocked",
        envelope.fromAgent,
        reason,
        this.notifier,
      );
      await this.logger?.log("delegation.rejected", envelope.fromAgent, {
        taskId: envelope.taskId,
        payload: { reason },
      });
    }
  }

  private async appendWorkLog(
    task: Task,
    payload: StatusUpdatePayload,
    store: ITaskStore,
  ): Promise<Task> {
    const entry = buildWorkLogEntry(payload);
    if (!entry) return task;
    const body = appendSection(task.body, "Work Log", [entry]);
    return store.updateBody(task.frontmatter.id, body);
  }
}

