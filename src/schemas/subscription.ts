/**
 * Subscription schema — data model for task notification subscriptions.
 *
 * Subscriptions are stored as co-located `subscriptions.json` files
 * alongside task files in task directories.
 */

import { z } from "zod";

/** Granularity of subscription notifications. */
export const SubscriptionGranularity = z.enum([
  "completion",   // Notify only on task completion
  "all",          // Notify on every status change
]).describe("Notification granularity: completion-only or all status changes");
export type SubscriptionGranularity = z.infer<typeof SubscriptionGranularity>;

/** Lifecycle status of a subscription. */
export const SubscriptionStatus = z.enum([
  "active",       // Subscription is live and will trigger notifications
  "delivered",    // Notification was successfully delivered
  "failed",       // Notification delivery failed
  "cancelled",    // Subscription was cancelled by user or system
]).describe("Current lifecycle status of the subscription");
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

/** A single task subscription. */
export const TaskSubscription = z.object({
  id: z.string().uuid().describe("Unique subscription identifier (UUID v4)"),
  subscriberId: z.string().min(1).describe("Agent or system that created this subscription"),
  granularity: SubscriptionGranularity.describe("When to send notifications"),
  status: SubscriptionStatus.default("active").describe("Current subscription status"),
  createdAt: z.string().datetime().describe("ISO-8601 creation timestamp"),
  updatedAt: z.string().datetime().describe("ISO-8601 last update timestamp"),
  deliveredAt: z.string().datetime().optional().describe("ISO-8601 delivery timestamp (set on successful delivery)"),
  failureReason: z.string().optional().describe("Reason for delivery failure (set when status is 'failed')"),
  deliveryAttempts: z.number().int().min(0).default(0).describe("Number of delivery attempts made"),
  lastAttemptAt: z.string().datetime().optional().describe("ISO-8601 timestamp of last delivery attempt"),
  lastDeliveredAt: z.string().datetime().optional().describe("ISO-8601 cursor for all-granularity delivery — tracks last delivered transition timestamp"),
});
export type TaskSubscription = z.infer<typeof TaskSubscription>;

/** Container for persisted subscriptions file (subscriptions.json). */
export const SubscriptionsFile = z.object({
  version: z.literal(1).describe("Schema version for migration support"),
  subscriptions: z.array(TaskSubscription).default([]).describe("Array of task subscriptions"),
});
export type SubscriptionsFile = z.infer<typeof SubscriptionsFile>;
