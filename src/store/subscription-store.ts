/**
 * SubscriptionStore — CRUD operations for task notification subscriptions.
 *
 * Subscriptions are persisted as co-located `subscriptions.json` files
 * in task directories. All writes use write-file-atomic for crash safety.
 */

import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import writeFileAtomic from "write-file-atomic";
import {
  SubscriptionsFile,
  type SubscriptionDelivery,
  type SubscriptionGranularity,
  type SubscriptionStatus,
  type TaskSubscription,
} from "../schemas/subscription.js";

const SUBSCRIPTIONS_FILENAME = "subscriptions.json";

export class SubscriptionStore {
  private taskDirResolver: (taskId: string) => Promise<string>;

  constructor(taskDirResolver: (taskId: string) => Promise<string>) {
    this.taskDirResolver = taskDirResolver;
  }

  /**
   * Create a new subscription for a task.
   * Creates the task directory if it does not exist.
   */
  async create(
    taskId: string,
    subscriberId: string,
    granularity: SubscriptionGranularity,
    delivery?: SubscriptionDelivery,
  ): Promise<TaskSubscription> {
    const taskDir = await this.taskDirResolver(taskId);
    await mkdir(taskDir, { recursive: true });

    const filePath = join(taskDir, SUBSCRIPTIONS_FILENAME);
    const data = await this.readSubscriptionsFile(filePath);

    const now = new Date().toISOString();
    const subscription: TaskSubscription = {
      id: randomUUID(),
      subscriberId,
      granularity,
      status: "active",
      createdAt: now,
      updatedAt: now,
      deliveryAttempts: 0,
      notifiedStatuses: [],
      attempts: [],
      ...(delivery ? { delivery } : {}),
    };

    data.subscriptions.push(subscription);
    await this.writeSubscriptionsFile(filePath, data);

    return subscription;
  }

  /**
   * Get a subscription by ID.
   * Returns undefined if not found or if subscriptions.json does not exist.
   */
  async get(
    taskId: string,
    subscriptionId: string,
  ): Promise<TaskSubscription | undefined> {
    const taskDir = await this.taskDirResolver(taskId);
    const filePath = join(taskDir, SUBSCRIPTIONS_FILENAME);
    const data = await this.readSubscriptionsFile(filePath);
    return data.subscriptions.find((s) => s.id === subscriptionId);
  }

  /**
   * List subscriptions for a task, with optional status filter.
   * Returns empty array if subscriptions.json does not exist.
   */
  async list(
    taskId: string,
    opts?: { status?: SubscriptionStatus },
  ): Promise<TaskSubscription[]> {
    const taskDir = await this.taskDirResolver(taskId);
    const filePath = join(taskDir, SUBSCRIPTIONS_FILENAME);
    const data = await this.readSubscriptionsFile(filePath);

    if (opts?.status) {
      return data.subscriptions.filter((s) => s.status === opts.status);
    }
    return data.subscriptions;
  }

  /**
   * Update a subscription's delivery-related fields atomically.
   * Throws if subscription not found.
   */
  async update(
    taskId: string,
    subscriptionId: string,
    fields: Partial<
      Pick<
        TaskSubscription,
        "status" | "deliveredAt" | "failureReason" | "deliveryAttempts" | "lastAttemptAt" | "lastDeliveredAt" | "notifiedStatuses"
      >
    >,
  ): Promise<TaskSubscription> {
    const taskDir = await this.taskDirResolver(taskId);
    const filePath = join(taskDir, SUBSCRIPTIONS_FILENAME);
    const data = await this.readSubscriptionsFile(filePath);

    const index = data.subscriptions.findIndex((s) => s.id === subscriptionId);
    if (index === -1) {
      throw new Error(
        `Subscription ${subscriptionId} not found for task ${taskId}`,
      );
    }

    const now = new Date().toISOString();
    const updated: TaskSubscription = {
      ...data.subscriptions[index]!,
      ...fields,
      updatedAt: now,
    };
    data.subscriptions[index] = updated;

    await this.writeSubscriptionsFile(filePath, data);
    return updated;
  }

  /**
   * Cancel a subscription by setting its status to "cancelled".
   * Throws if the subscription is not found.
   */
  async cancel(
    taskId: string,
    subscriptionId: string,
  ): Promise<TaskSubscription> {
    const taskDir = await this.taskDirResolver(taskId);
    const filePath = join(taskDir, SUBSCRIPTIONS_FILENAME);
    const data = await this.readSubscriptionsFile(filePath);

    const index = data.subscriptions.findIndex((s) => s.id === subscriptionId);
    if (index === -1) {
      throw new Error(
        `Subscription ${subscriptionId} not found for task ${taskId}`,
      );
    }

    const now = new Date().toISOString();
    const updated: TaskSubscription = {
      ...data.subscriptions[index]!,
      status: "cancelled" as const,
      updatedAt: now,
    };
    data.subscriptions[index] = updated;

    await this.writeSubscriptionsFile(filePath, data);
    return updated;
  }

  /**
   * Append a status to `notifiedStatuses` for dedupe bookkeeping.
   * No-op if the status is already present. Returns the updated subscription.
   */
  async markStatusNotified(
    taskId: string,
    subscriptionId: string,
    status: string,
  ): Promise<TaskSubscription | undefined> {
    const taskDir = await this.taskDirResolver(taskId);
    const filePath = join(taskDir, SUBSCRIPTIONS_FILENAME);
    const data = await this.readSubscriptionsFile(filePath);

    const index = data.subscriptions.findIndex((s) => s.id === subscriptionId);
    if (index === -1) return undefined;

    const existing = data.subscriptions[index]!;
    if (existing.notifiedStatuses.includes(status)) return existing;

    const updated: TaskSubscription = {
      ...existing,
      notifiedStatuses: [...existing.notifiedStatuses, status],
      updatedAt: new Date().toISOString(),
    };
    data.subscriptions[index] = updated;

    await this.writeSubscriptionsFile(filePath, data);
    return updated;
  }

  /**
   * Append an entry to the subscription's `attempts` audit trail and refresh
   * the aggregate top-level fields (`deliveryAttempts`, `lastAttemptAt`, and
   * `failureReason` — cleared on success, set on failure).
   *
   * Does NOT set `status` or `deliveredAt` — the caller decides lifecycle
   * transitions based on delivery kind (e.g. chat-delivery flips to
   * `delivered` only on terminal transitions; all-granularity subscriptions
   * stay `active` even after successful deliveries).
   */
  async appendAttempt(
    taskId: string,
    subscriptionId: string,
    attempt: import("../schemas/subscription.js").TaskSubscriptionAttempt,
  ): Promise<TaskSubscription | undefined> {
    const taskDir = await this.taskDirResolver(taskId);
    const filePath = join(taskDir, SUBSCRIPTIONS_FILENAME);
    const data = await this.readSubscriptionsFile(filePath);

    const index = data.subscriptions.findIndex((s) => s.id === subscriptionId);
    if (index === -1) return undefined;

    const existing = data.subscriptions[index]!;
    const attempts = [...existing.attempts, attempt];
    const now = new Date().toISOString();

    const updated: TaskSubscription = {
      ...existing,
      attempts,
      deliveryAttempts: attempts.length,
      lastAttemptAt: attempt.attemptedAt,
      // Clear the stale failureReason on success; set it on failure so
      // old readers that don't consume `attempts` still see the current
      // failure at the top level.
      ...(attempt.success
        ? { failureReason: undefined }
        : { failureReason: attempt.error?.message ?? "delivery failed" }),
      updatedAt: now,
    };
    data.subscriptions[index] = updated;

    await this.writeSubscriptionsFile(filePath, data);
    return updated;
  }

  /**
   * Read and parse subscriptions.json, returning empty file on ENOENT.
   */
  private async readSubscriptionsFile(
    filePath: string,
  ): Promise<SubscriptionsFile> {
    try {
      const content = await readFile(filePath, "utf-8");
      return SubscriptionsFile.parse(JSON.parse(content));
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return { version: 1, subscriptions: [] };
      }
      throw err;
    }
  }

  /**
   * Write subscriptions data atomically.
   */
  private async writeSubscriptionsFile(
    filePath: string,
    data: SubscriptionsFile,
  ): Promise<void> {
    await writeFileAtomic(filePath, JSON.stringify(data, null, 2));
  }
}
