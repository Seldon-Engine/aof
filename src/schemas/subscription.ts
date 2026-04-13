/**
 * Subscription schema — data model for task notification subscriptions.
 *
 * Subscriptions are stored as co-located `subscriptions.json` files
 * alongside task files in task directories.
 *
 * The `delivery` field is an opaque, kind-discriminated payload. Core AOF
 * ships a single built-in kind ("agent-callback") backed by `GatewayAdapter.
 * spawnSession`. Plugins (OpenClaw, MCP, etc.) register their own kinds
 * (e.g. "openclaw-chat") and handle delivery themselves. Core never
 * interprets plugin-owned payload fields.
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

/**
 * Delivery descriptor — opaque to core except for `kind`.
 * Plugins define additional fields under their own kind.
 */
export const SubscriptionDelivery = z.object({
  kind: z.string().min(1).describe("Delivery kind; core handles 'agent-callback', plugins register others"),
}).passthrough();
export type SubscriptionDelivery = z.infer<typeof SubscriptionDelivery>;

/** A single task subscription. */
export const TaskSubscription = z.object({
  id: z.string().uuid().describe("Unique subscription identifier (UUID v4)"),
  subscriberId: z.string().min(1).describe("Stable subscriber identity — used for dedup/listing; for agent-callback kind this is the agent ID"),
  granularity: SubscriptionGranularity.describe("When to send notifications"),
  delivery: SubscriptionDelivery.optional().describe("Delivery payload; absent means legacy agent-callback inferred from subscriberId"),
  status: SubscriptionStatus.default("active").describe("Current subscription status"),
  createdAt: z.string().datetime().describe("ISO-8601 creation timestamp"),
  updatedAt: z.string().datetime().describe("ISO-8601 last update timestamp"),
  deliveredAt: z.string().datetime().optional().describe("ISO-8601 delivery timestamp (set on successful delivery)"),
  failureReason: z.string().optional().describe("Reason for delivery failure (set when status is 'failed')"),
  deliveryAttempts: z.number().int().min(0).default(0).describe("Number of delivery attempts made"),
  lastAttemptAt: z.string().datetime().optional().describe("ISO-8601 timestamp of last delivery attempt"),
  lastDeliveredAt: z.string().datetime().optional().describe("ISO-8601 cursor for all-granularity delivery — tracks last delivered transition timestamp"),
  notifiedStatuses: z.array(z.string()).default([]).describe("Per-status dedupe ledger for kinds that fire on multiple non-terminal transitions"),
});
export type TaskSubscription = z.infer<typeof TaskSubscription>;

/** Container for persisted subscriptions file (subscriptions.json). */
export const SubscriptionsFile = z.object({
  version: z.literal(1).describe("Schema version for migration support"),
  subscriptions: z.array(TaskSubscription).default([]).describe("Array of task subscriptions"),
});
export type SubscriptionsFile = z.infer<typeof SubscriptionsFile>;

/**
 * Resolve the effective delivery kind for a subscription.
 * Legacy records without `delivery` are treated as agent-callback.
 */
export function resolveDeliveryKind(sub: TaskSubscription): string {
  return sub.delivery?.kind ?? "agent-callback";
}
