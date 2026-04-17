import { existsSync } from "node:fs";
import { createLogger } from "../logging/index.js";
import type { ProtocolEnvelope as ProtocolEnvelopeType } from "../schemas/protocol.js";
import type { StatusUpdatePayload } from "../schemas/protocol.js";
import type { HandoffRequestPayload, HandoffAckPayload } from "../schemas/protocol.js";
import type { Task } from "../schemas/task.js";
import type { TaskStatus } from "../schemas/task.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { NotificationService } from "../events/notifier.js";
import { readRunResult, writeRunResult, completeRunArtifact } from "../recovery/run-artifacts.js";
import type { RunResult } from "../schemas/run-result.js";
import { writeHandoffArtifacts } from "../delegation/index.js";
import type { TaskLockManager } from "./task-lock.js";
import { InMemoryTaskLockManager } from "./task-lock.js";
import { parseProtocolMessage, type ProtocolLogger } from "./parsers.js";
import { buildStatusReason, shouldAppendWorkLog, buildWorkLogEntry, appendSection } from "./formatters.js";
import { cascadeOnCompletion } from "../dispatch/dep-cascader.js";
import { handleDAGHopCompletion, dispatchDAGHop } from "../dispatch/dag-transition-handler.js";
import {
  resolveAuthorizedAgent,
  checkAuthorization,
  applyCompletionOutcome,
  transitionTask,
  logTransition,
  notifyTransition,
} from "./router-helpers.js";
import { cascadeOnBlock, type CascadeLogger } from "../dispatch/dep-cascader.js";

// Re-export for backward compatibility
export { parseProtocolMessage } from "./parsers.js";
export type { ProtocolLogger } from "./parsers.js";

export interface ProtocolRouterDependencies {
  store: ITaskStore;
  logger?: ProtocolLogger;
  notifier?: NotificationService;
  lockManager?: TaskLockManager;
  projectStoreResolver?: (projectId: string) => ITaskStore | undefined;
  /**
   * When true, blocking a task via status.update cascades to direct dependents.
   * Mirrors SchedulerConfig.cascadeBlocks. Default: false.
   */
  cascadeBlocks?: boolean;
  /** Executor for dispatching DAG hops (optional — if absent, poll cycle handles dispatch). */
  executor?: import("../dispatch/executor.js").GatewayAdapter;
  /** Spawn timeout in ms for DAG hop dispatch (default 30s). */
  spawnTimeoutMs?: number;
}

const routerLog = createLogger("protocol");

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
  private readonly cascadeBlocks: boolean;
  private readonly executor?: import("../dispatch/executor.js").GatewayAdapter;
  private readonly spawnTimeoutMs: number;

  constructor(deps: ProtocolRouterDependencies) {
    this.logger = deps.logger;
    this.store = deps.store;
    this.notifier = deps.notifier;
    this.lockManager = deps.lockManager ?? new InMemoryTaskLockManager();
    this.projectStoreResolver = deps.projectStoreResolver;
    this.cascadeBlocks = deps.cascadeBlocks ?? false;
    this.executor = deps.executor;
    this.spawnTimeoutMs = deps.spawnTimeoutMs ?? 300_000;
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

    if (envelope.payload.outcome === "done" && this.logger) {
      try {
        await cascadeOnCompletion(envelope.taskId, store, this.logger);
      } catch (err) {
        routerLog.error({ err, taskId: envelope.taskId }, "cascadeOnCompletion failed");
      }
    }

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

    // Opt-in block cascade: when a task is blocked, propagate to direct dependents.
    if (transitioned && updatedTask.frontmatter.status === "blocked" && this.cascadeBlocks) {
      await cascadeOnBlock(
        updatedTask.frontmatter.id,
        store,
        this.logger as unknown as CascadeLogger,
      );
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

      if (task.frontmatter.workflow) {
        // DAG path — route to DAG transition handler
        try {
          await this.lockManager.withLock(task.frontmatter.id, async () => {
            // 1. Evaluate DAG hop completion
            const result = await handleDAGHopCompletion(
              this.store,
              this.logger as import("../events/logger.js").EventLogger,
              task,
              runResult,
            );

            // 2. Complete run artifact (same as gate path)
            await completeRunArtifact(this.store, task.frontmatter.id);

            // 3. Handle DAG completion
            if (result.dagComplete) {
              if (runResult.outcome === "done") {
                // DAG completed successfully — transition to review -> done
                await this.store.transition(task.frontmatter.id, "review", {
                  reason: "DAG workflow completed successfully",
                });
                // Cascade on completion
                if (this.logger) {
                  try {
                    await cascadeOnCompletion(task.frontmatter.id, this.store, this.logger as import("../events/logger.js").EventLogger);
                  } catch (err) {
                    routerLog.error({ err, taskId: task.frontmatter.id }, "cascadeOnCompletion failed");
                  }
                }
              } else {
                // DAG failed — transition to blocked
                await this.store.transition(task.frontmatter.id, "blocked", {
                  reason: "DAG workflow failed: all hops failed or skipped",
                });
              }
              return;
            }

            // 4. Handle review required (autoAdvance: false)
            if (result.reviewRequired) {
              await this.store.transition(task.frontmatter.id, "review", {
                reason: "DAG hop requires review before advancing",
              });
              return;
            }

            // 5. Dispatch first ready hop immediately
            if (result.readyHops.length > 0 && this.executor) {
              await dispatchDAGHop(
                this.store,
                this.logger as import("../events/logger.js").EventLogger,
                { spawnTimeoutMs: this.spawnTimeoutMs },
                this.executor,
                task,
                result.readyHops[0]!,
              );
            }
          });
        } catch (err) {
          // DAG errors must not crash the scheduler
          routerLog.error(
            { err, taskId: task.frontmatter.id },
            "DAG handleSessionEnd failed",
          );
        }
      } else {
        // Gate path (EXISTING, completely untouched)
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
        if (runResult.outcome === "done" && this.logger) {
          try {
            await cascadeOnCompletion(task.frontmatter.id, this.store, this.logger as import("../events/logger.js").EventLogger);
          } catch (err) {
            routerLog.error({ err, taskId: task.frontmatter.id }, "cascadeOnCompletion failed");
          }
        }
      }
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
    if (!childTask.path) {
      childTask.path = `${store.tasksDir}/${childTask.frontmatter.status}/${childTask.frontmatter.id}.md`;
    }
    await store.save(childTask);

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

