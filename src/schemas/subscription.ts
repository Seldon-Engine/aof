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

/**
 * A single delivery attempt — either successful or failed. The full ordered
 * list lives in `TaskSubscription.attempts` for an audit trail; the
 * aggregate top-level fields (`deliveryAttempts` counter, `failureReason`
 * from the last attempt, `lastAttemptAt`, `deliveredAt`) are derived from
 * this list but persisted alongside for cheap reads.
 */
export const TaskSubscriptionAttempt = z.object({
  attemptedAt: z.string().datetime().describe("ISO-8601 timestamp when the attempt started"),
  success: z.boolean().describe("Whether the attempt delivered successfully"),
  toStatus: z.string().optional().describe("Status transition that triggered this attempt (e.g. 'done'); absent for non-transition-triggered deliveries"),
  error: z.object({
    kind: z.string().optional().describe("Machine-readable error class (e.g. 'send-failed', 'not-found')"),
    message: z.string().describe("Human-readable failure reason"),
  }).optional().describe("Failure details; absent when success is true"),
});
export type TaskSubscriptionAttempt = z.infer<typeof TaskSubscriptionAttempt>;

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
  failureReason: z.string().optional().describe("Reason for the MOST RECENT FAILED attempt (cleared on success). Full history lives in `attempts`."),
  deliveryAttempts: z.number().int().min(0).default(0).describe("Total number of delivery attempts made (equals `attempts.length`)"),
  lastAttemptAt: z.string().datetime().optional().describe("ISO-8601 timestamp of last delivery attempt"),
  lastDeliveredAt: z.string().datetime().optional().describe("ISO-8601 cursor for all-granularity delivery — tracks last delivered transition timestamp"),
  notifiedStatuses: z.array(z.string()).default([]).describe("Per-status dedupe ledger for kinds that fire on multiple non-terminal transitions"),
  attempts: z.array(TaskSubscriptionAttempt).default([]).describe("Ordered audit trail of every delivery attempt — success + failure — for post-mortem analysis and retry reasoning"),
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
