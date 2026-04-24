/**
 * OpenClaw chat-message delivery — plugin-owned subscription delivery kind.
 *
 * Registers as an EventLogger callback and fires on actionable task
 * transitions ({blocked, review, done, cancelled, deadletter}). For each
 * matching active subscription with `delivery.kind === "openclaw-chat"`,
 * sends a message to the captured session/channel via the OpenClaw
 * message tool. Per-status dedupe is persisted on the subscription.
 *
 * This module owns OpenClaw idioms (sessionKey, sessionId, replyTarget,
 * channel, threadId) so AOF core stays session-agnostic.
 */

import { join } from "node:path";
import { createLogger } from "../logging/index.js";
import { readRunResult } from "../recovery/run-artifacts.js";
import { resolveDeliveryKind, type TaskSubscription } from "../schemas/subscription.js";
import type { TaskStatus } from "../schemas/task.js";
import { SubscriptionStore } from "../store/subscription-store.js";
import type { BaseEvent } from "../schemas/event.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { MatrixMessageTool } from "./matrix-notifier.js";
import { OPENCLAW_CHAT_DELIVERY_KIND } from "./subscription-delivery.js";
import type { OpenClawChatDeliveryType } from "./subscription-delivery.js";

const log = createLogger("openclaw-chat-delivery");
// Phase 44 D-44-OBSERVABILITY: dedicated channel for structured wake-up.*
// events so operators (and 999.4 fan-out) can grep lifecycle transitions
// independently of the existing free-form log lines above.
const wakeLog = createLogger("wake-up-delivery");

export { OPENCLAW_CHAT_DELIVERY_KIND } from "./subscription-delivery.js";

const TRIGGER_STATUSES = new Set(["blocked", "review", "done", "cancelled", "deadletter"]);
const TERMINAL_STATUSES = new Set(["done", "cancelled", "deadletter"]);
const NOTES_TRUNCATION_LIMIT = 240;
const ELLIPSIS = "...";

export interface OpenClawChatDeliveryOptions {
  resolveStoreForTask: (taskId: string) => Promise<ITaskStore | undefined>;
  messageTool: MatrixMessageTool;
}

export class OpenClawChatDeliveryNotifier {
  constructor(private readonly opts: OpenClawChatDeliveryOptions) {}

  async handleEvent(event: BaseEvent): Promise<void> {
    if (event.type !== "task.transitioned" || !event.taskId) return;
    const to = typeof event.payload.to === "string" ? event.payload.to : undefined;
    if (!to || !TRIGGER_STATUSES.has(to)) return;

    const store = await this.opts.resolveStoreForTask(event.taskId);
    if (!store) return;

    const task = await store.get(event.taskId);
    if (!task) return;

    const subscriptionStore = this.createSubscriptionStore(store);
    const active = await subscriptionStore.list(event.taskId, { status: "active" });
    const chatSubs = active.filter(
      (s) => resolveDeliveryKind(s) === OPENCLAW_CHAT_DELIVERY_KIND
        && !s.notifiedStatuses.includes(to),
    );
    if (chatSubs.length === 0) return;

    const runResult = await readRunResult(store, event.taskId).catch(() => undefined);

    for (const sub of chatSubs) {
      await this.deliverOne({
        sub,
        subscriptionStore,
        task,
        toStatus: to,
        actor: event.actor,
        reason: typeof event.payload.reason === "string" ? event.payload.reason : undefined,
        runResult,
        source: "event",
      }).catch((err) => {
        log.error({ err, taskId: event.taskId, subscriptionId: sub.id }, "chat delivery failed");
      });
    }
  }

  private async deliverOne(args: {
    sub: TaskSubscription;
    subscriptionStore: SubscriptionStore;
    task: Awaited<ReturnType<ITaskStore["get"]>>;
    toStatus: string;
    actor: string;
    reason?: string;
    runResult: Awaited<ReturnType<typeof readRunResult>> | undefined;
    /**
     * Phase 44 D-44-OBSERVABILITY: "event" for the realtime handleEvent path,
     * "recovery" for the boot-time replayUnnotifiedTerminals pass. Controls
     * which wake-up.* event name fires on the attempt (recovery-replay vs
     * attempted).
     */
    source: "event" | "recovery";
  }): Promise<void> {
    const { sub, subscriptionStore, task, toStatus, actor, reason, runResult, source } = args;
    if (!task) return;

    const delivery = sub.delivery as OpenClawChatDeliveryType | undefined;
    if (!delivery) return;
    const target = delivery.target ?? delivery.sessionKey ?? delivery.sessionId;
    if (!target) {
      // Phase 44 D-44-OBSERVABILITY: active chat subscription on a trigger
      // status but with no route at all — nothing to send, but operators
      // need to see it.
      wakeLog.debug(
        {
          subscriptionId: sub.id,
          taskId: task.frontmatter.id,
          toStatus,
          source,
          sessionKey: delivery.sessionKey,
          dispatcherAgentId: delivery.dispatcherAgentId,
        },
        "wake-up.skipped-no-route",
      );
      return;
    }

    const message = renderMessage({ task, toStatus, actor, reason, runResult });

    wakeLog.info(
      {
        subscriptionId: sub.id,
        taskId: task.frontmatter.id,
        toStatus,
        source,
        sessionKey: delivery.sessionKey,
        dispatcherAgentId: delivery.dispatcherAgentId,
      },
      source === "recovery" ? "wake-up.recovery-replay" : "wake-up.attempted",
    );

    const attemptedAt = new Date().toISOString();
    try {
      await this.opts.messageTool.send(target, message, {
        subscriptionId: sub.id,
        taskId: task.frontmatter.id,
        toStatus,
        delivery: sub.delivery as Record<string, unknown> | undefined,
      });
      await subscriptionStore.appendAttempt(task.frontmatter.id, sub.id, {
        attemptedAt,
        success: true,
        toStatus,
      });
      await subscriptionStore.markStatusNotified(task.frontmatter.id, sub.id, toStatus);
      if (TERMINAL_STATUSES.has(toStatus)) {
        await subscriptionStore.update(task.frontmatter.id, sub.id, {
          status: "delivered",
          deliveredAt: new Date().toISOString(),
        });
      }
      wakeLog.info(
        {
          subscriptionId: sub.id,
          taskId: task.frontmatter.id,
          toStatus,
          source,
          sessionKey: delivery.sessionKey,
          dispatcherAgentId: delivery.dispatcherAgentId,
        },
        "wake-up.delivered",
      );
    } catch (err) {
      const failureMessage = err instanceof Error ? err.message : String(err);
      const originalKind =
        err && typeof err === "object" && "kind" in err && typeof (err as { kind: unknown }).kind === "string"
          ? ((err as { kind: string }).kind)
          : undefined;

      // Phase 44 D-44-AGENT-CALLBACK-FALLBACK: when the plugin-side
      // sendChatDelivery throws NoPlatformError (kind="no-platform") because
      // the delivery sessionKey is a subagent (4-part) key or otherwise
      // unparseable AND no explicit channel was set, rewrite the attempt's
      // error.kind to "agent-callback-fallback" so the audit trail captures
      // the fallback decision. The subscription stays active (NOT "delivered")
      // — the real wake-up is observably lost today; a future phase will
      // invoke an agent-callback send on this path.
      const isNoPlatform = originalKind === "no-platform";
      const kind = isNoPlatform ? "agent-callback-fallback" : originalKind;
      const attemptMessage = isNoPlatform
        ? `agent-callback fallback (wake-up observably lost): ${failureMessage}`
        : failureMessage;

      await subscriptionStore.appendAttempt(task.frontmatter.id, sub.id, {
        attemptedAt,
        success: false,
        toStatus,
        error: {
          ...(kind !== undefined ? { kind } : {}),
          message: attemptMessage,
        },
      });

      // Phase 44 D-44-OBSERVABILITY: structured telemetry event per failure
      // shape. `kind` here is the ORIGINAL error kind from the thrown Error
      // (timeout / no-platform / undefined), NOT the delivery kind.
      const telemetryEvent =
        originalKind === "timeout"
          ? "wake-up.timed-out"
          : isNoPlatform
            ? "wake-up.fallback"
            : "wake-up.failed";
      wakeLog.warn(
        {
          subscriptionId: sub.id,
          taskId: task.frontmatter.id,
          toStatus,
          source,
          kind: originalKind,
          message: failureMessage,
          sessionKey: delivery.sessionKey,
          dispatcherAgentId: delivery.dispatcherAgentId,
        },
        telemetryEvent,
      );

      if (isNoPlatform) {
        log.warn(
          { err, target, taskId: task.frontmatter.id, subscriptionId: sub.id },
          "wake-up fell back to agent-callback (no platform for delivery sessionKey)",
        );
      } else {
        log.error({ err, target, taskId: task.frontmatter.id }, "messageTool.send failed");
      }
    }
  }

  /**
   * Phase 44 D-44-RECOVERY: boot-time replay of unnotified terminal subscriptions.
   *
   * Fires wake-ups for active subscriptions whose task is already in a terminal
   * status AND whose `notifiedStatuses` ledger does NOT yet record that terminal
   * status. Guards against daemon crashes between `transition()` and plugin ACK
   * where the event-logger callback fired but the ACK never landed (so the
   * subscription was never marked delivered and no wake-up reached the agent).
   *
   * Safe to call multiple times — each call observes the same `notifiedStatuses`
   * ledger, so the second call short-circuits via the existing `.includes(toStatus)`
   * filter. Mirrors the shape of `retryPendingDeliveries` in
   * `src/dispatch/callback-delivery.ts` (same terminal-status gate + active-sub
   * filter), specialized to the openclaw-chat kind and the notifiedStatuses
   * dedupe ledger.
   */
  async replayUnnotifiedTerminals(store: ITaskStore): Promise<void> {
    const subscriptionStore = this.createSubscriptionStore(store);
    let replayed = 0;

    // Iterate per terminal status — task-store.list(filters) takes a single
    // status at a time (STATUS_DIRS scan otherwise returns every task).
    for (const terminalStatus of TERMINAL_STATUSES) {
      let tasks: Awaited<ReturnType<ITaskStore["list"]>>;
      try {
        // `terminalStatus` is narrowed from a `Set<string>` — cast to the
        // TaskStatus union the store.list filter expects.
        tasks = await store.list({ status: terminalStatus as TaskStatus });
      } catch (err) {
        log.warn({ err, terminalStatus }, "replayUnnotifiedTerminals: store.list failed (skipping status)");
        continue;
      }

      for (const task of tasks) {
        const toStatus = task.frontmatter.status;
        // Defense-in-depth: list(status) should only return tasks of that
        // status, but drift between frontmatter and directory has surfaced
        // before (6fbcb18 partial-rename hardening).
        if (!TERMINAL_STATUSES.has(toStatus)) continue;

        let active: TaskSubscription[];
        try {
          active = await subscriptionStore.list(task.frontmatter.id, { status: "active" });
        } catch (err) {
          log.warn(
            { err, taskId: task.frontmatter.id },
            "replayUnnotifiedTerminals: subscriptionStore.list failed (skipping task)",
          );
          continue;
        }

        const candidates = active.filter(
          (s) =>
            resolveDeliveryKind(s) === OPENCLAW_CHAT_DELIVERY_KIND
            && !s.notifiedStatuses.includes(toStatus),
        );
        if (candidates.length === 0) continue;

        const runResult = await readRunResult(store, task.frontmatter.id).catch(() => undefined);

        for (const sub of candidates) {
          try {
            await this.deliverOne({
              sub,
              subscriptionStore,
              task,
              toStatus,
              // Recovery path has no originating transition event — use a
              // synthetic actor so downstream log/message rendering has a
              // recognizable provenance marker.
              actor: "system:recovery",
              reason: undefined,
              runResult,
              source: "recovery",
            });
            replayed += 1;
          } catch (err) {
            log.error(
              { err, taskId: task.frontmatter.id, subscriptionId: sub.id },
              "replayUnnotifiedTerminals: deliverOne failed",
            );
          }
        }
      }
    }

    wakeLog.info({ replayed }, "wake-up.recovery-pass-complete");
  }

  private createSubscriptionStore(store: ITaskStore): SubscriptionStore {
    const tasksDir = store.tasksDir;
    return new SubscriptionStore(async (taskId) => {
      const t = await store.get(taskId);
      if (!t) throw new Error(`Task not found: ${taskId}`);
      return join(tasksDir, t.frontmatter.status, taskId);
    });
  }
}

function renderMessage(args: {
  task: NonNullable<Awaited<ReturnType<ITaskStore["get"]>>>;
  toStatus: string;
  actor: string;
  reason?: string;
  runResult: Awaited<ReturnType<typeof readRunResult>> | undefined;
}): string {
  const { task, toStatus, actor, reason, runResult } = args;
  const lines: string[] = [
    `${renderStatusLead(toStatus)}: ${task.frontmatter.id} ${task.frontmatter.title}`,
    `Agent: ${actor}`,
  ];

  if (runResult?.outcome) lines.push(`Outcome: ${runResult.outcome}`);
  if (runResult?.summaryRef) lines.push(`Summary: ${runResult.summaryRef}`);

  if (runResult?.blockers?.length) {
    lines.push(`Blockers: ${runResult.blockers.join("; ")}`);
  } else if (reason && reason.trim().length > 0) {
    lines.push(`Reason: ${reason.trim()}`);
  }

  if (runResult?.notes) {
    lines.push(`Notes: ${truncate(runResult.notes, NOTES_TRUNCATION_LIMIT)}`);
  }

  return lines.join("\n");
}

function renderStatusLead(status: string): string {
  switch (status) {
    case "done":
      return "Task complete";
    case "cancelled":
      return "Task cancelled";
    case "deadletter":
      return "Task dead-lettered";
    case "review":
      return "Task ready for review";
    case "blocked":
      return "Task blocked";
    default:
      return "Task update";
  }
}

function truncate(value: string, limit: number): string {
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  if (limit <= ELLIPSIS.length) return ELLIPSIS.slice(0, limit);
  return `${value.slice(0, limit - ELLIPSIS.length)}${ELLIPSIS}`;
}
