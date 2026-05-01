/**
 * Notification policy rule schema + default rule set.
 *
 * Rules are evaluated first-match-wins. The default set covers all major
 * event types defined in schemas/event.ts.
 */

export type Severity = "info" | "warn" | "critical";
export type Audience = "agent" | "team-lead" | "operator";

/**
 * A single notification routing rule.
 *
 * `match.eventType` supports exact match or "*" wildcard prefix (e.g. "murmur.*").
 * `match.payload` is an optional map of payload field → expected value (exact equality).
 */
export interface NotificationRule {
  match: {
    /** Exact event type or glob ending in ".*" (e.g., "murmur.*"). */
    eventType: string;
    /** Optional payload field matchers — all must match (AND). */
    payload?: Record<string, unknown>;
  };
  severity: Severity;
  audience: Audience[];
  /** Default channel (can be overridden via org chart). */
  channel: string;
  /** Handlebars-lite template: {field.path} substitution into BaseEvent. */
  template: string;
  /** Dedupe window override in ms. 0 = always send. Default: global 5-min window. */
  dedupeWindowMs?: number;
  /** If true, bypasses deduplication entirely (used for critical unsuppressable events). */
  neverSuppress?: boolean;
}

/**
 * Default rule set. Evaluated first-match-wins.
 *
 * Rules with payload matchers must be listed BEFORE their generic eventType counterparts
 * so the more specific rule wins.
 */
export const DEFAULT_RULES: NotificationRule[] = [
  // ── Task lifecycle (specific transitions first) ──────────────────────────
  {
    match: { eventType: "task.transitioned", payload: { to: "review" } },
    severity: "warn",
    audience: ["team-lead", "operator"],
    channel: "#aof-review",
    template: "👀 {taskId} ready for review (by {actor})",
    dedupeWindowMs: 0, // Always send — review needs immediate attention
  },
  {
    match: { eventType: "task.transitioned", payload: { to: "blocked" } },
    severity: "warn",
    audience: ["team-lead", "operator"],
    channel: "#aof-alerts",
    template: "🚧 {taskId} blocked: {payload.reason}",
  },
  {
    match: { eventType: "task.transitioned", payload: { to: "done" } },
    severity: "info",
    audience: ["agent", "team-lead"],
    channel: "#aof-dispatch",
    template: "✅ {actor} completed {taskId}",
  },
  {
    match: { eventType: "task.transitioned", payload: { to: "in-progress" } },
    severity: "info",
    audience: ["agent"],
    channel: "#aof-dispatch",
    template: "▶️ {actor} started {taskId}",
  },
  {
    match: { eventType: "task.transitioned" },
    severity: "info",
    audience: ["agent"],
    channel: "#aof-dispatch",
    template: "🔄 {taskId}: {payload.from} → {payload.to}",
  },

  // ── Task lifecycle (generic) ─────────────────────────────────────────────
  {
    match: { eventType: "task.created" },
    severity: "info",
    audience: ["agent"],
    channel: "#aof-dispatch",
    template: "📬 Task {taskId} created: {payload.title}",
  },
  {
    match: { eventType: "task.blocked" },
    severity: "warn",
    audience: ["team-lead", "operator"],
    channel: "#aof-alerts",
    template: "🚧 {taskId} blocked: {payload.reason}",
  },
  {
    match: { eventType: "task.deadletter" },
    severity: "critical",
    audience: ["operator"],
    channel: "#aof-alerts",
    template: "🪦 Task {taskId} moved to dead letter: {payload.reason}",
    neverSuppress: true,
  },
  {
    match: { eventType: "task.abandoned" },
    severity: "critical",
    audience: ["operator"],
    channel: "#aof-alerts",
    template: "💀 Task {taskId} may be abandoned (check run.json)",
    neverSuppress: true,
  },
  {
    match: { eventType: "task.resurrected" },
    severity: "info",
    audience: ["team-lead"],
    channel: "#aof-dispatch",
    template: "🔁 Task {taskId} resurrected",
  },
  {
    match: { eventType: "task.dep.added" },
    severity: "info",
    audience: ["agent"],
    channel: "#aof-dispatch",
    template: "🔗 Dependency added to {taskId}: {payload.depId}",
  },
  {
    match: { eventType: "task.dep.removed" },
    severity: "info",
    audience: ["agent"],
    channel: "#aof-dispatch",
    template: "✂️ Dependency removed from {taskId}: {payload.depId}",
  },

  // ── Dependency cascade ───────────────────────────────────────────────────
  {
    match: { eventType: "dependency.cascaded", payload: { action: "promote" } },
    severity: "info",
    audience: ["operator"],
    channel: "#aof-dispatch",
    template: "🔗 Cascade: {payload.count} task(s) promoted after {payload.trigger} completed",
    dedupeWindowMs: 30_000,
  },
  {
    match: { eventType: "dependency.cascaded", payload: { action: "block" } },
    severity: "warn",
    audience: ["team-lead", "operator"],
    channel: "#aof-alerts",
    template: "🚧 Cascade block: {payload.count} task(s) blocked — upstream {payload.trigger} is blocked",
    dedupeWindowMs: 0,
  },

  // ── Lease management ─────────────────────────────────────────────────────
  {
    match: { eventType: "lease.expired" },
    severity: "warn",
    audience: ["team-lead"],
    channel: "#aof-alerts",
    template: "⏰ Lease expired on {taskId} (agent: {actor})",
  },

  // ── SLA ──────────────────────────────────────────────────────────────────
  {
    match: { eventType: "sla.violation" },
    severity: "warn",
    audience: ["team-lead"],
    channel: "#aof-alerts",
    template: "⚠️ SLA violation: {taskId} in-progress {payload.durationHrs}h (limit: {payload.limitHrs}h)",
    dedupeWindowMs: 900_000, // 15 min — matches SlaChecker rate limiter
  },

  // ── Gate events ──────────────────────────────────────────────────────────
  {
    match: { eventType: "gate_timeout" },
    severity: "warn",
    audience: ["team-lead"],
    channel: "#aof-alerts",
    template: "⏱️ Gate timeout: {taskId} ({payload.gate})",
  },
  {
    match: { eventType: "gate_timeout_escalation" },
    severity: "critical",
    audience: ["operator"],
    channel: "#aof-critical",
    template: "🔴 Gate escalation: {taskId} escalated after {payload.elapsed}h",
    neverSuppress: true,
  },

  // ── System events ────────────────────────────────────────────────────────
  {
    match: { eventType: "system.drift-detected" },
    severity: "warn",
    audience: ["operator"],
    channel: "#aof-alerts",
    template: "⚠️ Org chart drift: {payload.summary}",
  },
  {
    match: { eventType: "system.config-changed" },
    severity: "info",
    audience: ["operator"],
    channel: "#aof-alerts",
    template: "🔧 Config changed: {payload.key}",
  },
  {
    match: { eventType: "system.shutdown" },
    severity: "critical",
    audience: ["operator"],
    channel: "#aof-critical",
    template: "🔴 AOF system shutting down",
    neverSuppress: true,
  },
  {
    match: { eventType: "system.recovery" },
    severity: "warn",
    audience: ["operator"],
    channel: "#aof-alerts",
    template: "🟢 Scheduler recovered",
  },
  {
    match: { eventType: "system.startup" },
    severity: "info",
    audience: ["operator"],
    channel: "#aof-alerts",
    template: "🟢 AOF system started",
  },

  // ── Scheduler ────────────────────────────────────────────────────────────
  {
    match: { eventType: "scheduler_alert" },
    severity: "warn",
    audience: ["operator"],
    channel: "#aof-alerts",
    template: "🔔 Scheduler alert: {payload.reason}",
  },

  // ── Murmur events ────────────────────────────────────────────────────────
  {
    match: { eventType: "murmur.review.dispatched" },
    severity: "info",
    audience: ["team-lead"],
    channel: "#aof-dispatch",
    template: "🔍 Murmur review dispatched: {payload.taskTitle}",
  },
  {
    match: { eventType: "murmur.review.dispatch_failed" },
    severity: "warn",
    audience: ["operator"],
    channel: "#aof-alerts",
    template: "⚠️ Murmur dispatch failed: {payload.error}",
  },
  {
    match: { eventType: "murmur.review.dispatch_error" },
    severity: "warn",
    audience: ["operator"],
    channel: "#aof-alerts",
    template: "⚠️ Murmur dispatch error: {payload.error}",
  },
  {
    match: { eventType: "murmur.evaluation.error" },
    severity: "warn",
    audience: ["operator"],
    channel: "#aof-alerts",
    template: "⚠️ Murmur evaluation error: {payload.error}",
  },
  {
    match: { eventType: "murmur.evaluation.failed" },
    severity: "warn",
    audience: ["operator"],
    channel: "#aof-alerts",
    template: "⚠️ Murmur evaluation failed: {payload.error}",
  },
];

/**
 * Returns true if the given eventType matches a rule's match.eventType.
 * Supports exact match or glob ending with ".*".
 */
export function matchesEventType(pattern: string, eventType: string): boolean {
  if (pattern === eventType) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return eventType.startsWith(`${prefix}.`);
  }
  return false;
}
