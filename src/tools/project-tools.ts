/**
 * AOF project tools — task creation and dispatch operations.
 */

import { z } from "zod";
import type { TaskStatus, TaskPriority } from "../schemas/task.js";
import { SubscriptionDelivery } from "../schemas/subscription.js";
import { compactResponse, type ToolResponseEnvelope } from "./envelope.js";
import type { ToolContext } from "./types.js";
import { createSubscriptionStore, validateSubscriberAgent } from "./subscription-tools.js";
import { loadProjectManifest } from "../projects/manifest.js";

/**
 * Zod schema for aof_dispatch input (shared between MCP and OpenClaw).
 */
/** 4 hours — upper bound on per-task agent run duration. */
export const MAX_DISPATCH_TIMEOUT_MS = 4 * 60 * 60 * 1000;

export const dispatchSchema = z.object({
  title: z.string().min(1),
  brief: z.string().min(1),
  description: z.string().optional(),
  agent: z.string().optional(),
  team: z.string().optional(),
  role: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "critical", "normal"]).optional(),
  dependsOn: z.array(z.string()).optional(),
  parentId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  actor: z.string().optional(),
  project: z.string().optional(),
  subscribe: z.enum(["completion", "all"]).optional(),
  // Plugin-driven completion notification. Boolean is a signal; plugins
  // (e.g. OpenClaw) may translate `true`/omitted into a concrete delivery
  // record via pre-handler transforms. An explicit object is used verbatim.
  notifyOnCompletion: z.union([z.boolean(), SubscriptionDelivery]).optional(),
  /**
   * Per-task hard cap on agent run duration in milliseconds. Research and
   * long-horizon tasks should opt in (research typically 30-60 min). Default
   * when omitted is the plugin-level spawnTimeoutMs (5 min floor).
   */
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_DISPATCH_TIMEOUT_MS)
    .optional(),
});

/**
 * Input parameters for creating and dispatching a new task.
 */
export interface AOFDispatchInput {
  /** Human-readable task title (required). */
  title: string;
  /** Short summary of what the task entails (required). */
  brief: string;
  /** Extended description; used as fallback for brief if brief is empty. */
  description?: string;
  /** Agent ID to route the task to. */
  agent?: string;
  /** Team ID for team-based routing. */
  team?: string;
  /** Role identifier for role-based routing. */
  role?: string;
  /** Task priority; defaults to "normal" if omitted or unrecognized. */
  priority?: TaskPriority | "normal";
  /** Task IDs that must complete before this task becomes dispatchable. */
  dependsOn?: string[];
  /** Parent task ID for subtask hierarchies. */
  parentId?: string;
  /** Arbitrary key-value metadata attached to the task frontmatter. */
  metadata?: Record<string, unknown>;
  /** Tags merged into metadata for categorization and filtering. */
  tags?: string[];
  /** Identity of the agent or user creating the task; defaults to "unknown". */
  actor?: string;
  /**
   * Project ID hint for the new task. When set, takes precedence over
   * `ctx.projectId` for project-owner defaulting (Phase 46 / Bug 2B).
   * Mirrors the `project` field on `dispatchSchema` — previously implicit
   * via the schema and forwarded by adapters, now explicit on the TS
   * interface so the handler can read it safely.
   */
  project?: string;
  /** Subscribe to task notifications at dispatch time. */
  subscribe?: "completion" | "all";
  /**
   * Plugin-driven completion notification. `false` disables; an object is
   * treated as a concrete delivery record and stored verbatim on the new
   * subscription. Plugins may rewrite `true`/omitted into an object via
   * their own pre-handler transforms before this reaches core.
   */
  notifyOnCompletion?: boolean | (Record<string, unknown> & { kind: string });
  /**
   * Per-task hard cap on agent run duration in milliseconds. Overrides the
   * plugin-level spawnTimeoutMs for this task. Bounded by MAX_DISPATCH_TIMEOUT_MS (4h).
   * When omitted, the plugin's scheduler config governs (5 min floor).
   */
  timeoutMs?: number;
}

/**
 * Result returned after a task is successfully created and dispatched.
 */
export interface AOFDispatchResult extends ToolResponseEnvelope {
  /** The generated unique task identifier (e.g. TASK-2026-02-17-001). */
  taskId: string;
  /** The task's current status after dispatch (typically "ready"). */
  status: TaskStatus;
  /** Filesystem path where the task markdown file resides. */
  filePath: string;
  /** Subscription ID if subscribe-at-dispatch was requested. */
  subscriptionId?: string;
  /** Plugin-driven completion-notification subscription ID, if one was created. */
  notificationSubscriptionId?: string;
}

function normalizePriority(priority?: string): TaskPriority {
  if (!priority) return "normal";
  const normalized = priority.toLowerCase();
  if (normalized === "critical" || normalized === "high" || normalized === "low") {
    return normalized as TaskPriority;
  }
  return "normal";
}

function normalizeCompletionDelivery(
  raw: Record<string, unknown>,
): Record<string, unknown> & { kind: string; subscriberId?: string } {
  const { kind: rawKind, subscriberId: rawSubscriberId, ...rest } = raw;
  const kind = typeof rawKind === "string" ? rawKind.trim() : "";
  if (kind.length === 0) {
    throw new Error("notifyOnCompletion.kind must be a non-empty string");
  }

  const subscriberId = typeof rawSubscriberId === "string" ? rawSubscriberId.trim() : "";
  return {
    ...rest,
    kind,
    ...(subscriberId.length > 0 ? { subscriberId } : {}),
  };
}

/**
 * Create a new task and immediately transition it to "ready" for dispatch.
 *
 * Validates required fields (title, brief), normalizes priority, persists
 * the task via the store, logs creation and transition events, and returns
 * a response envelope with the new task ID and file path.
 *
 * @param ctx - Tool context providing store and logger access
 * @param input - Task creation parameters (title, brief, routing, etc.)
 * @returns The created task's ID, status, and file path wrapped in a response envelope
 */
export async function aofDispatch(
  ctx: ToolContext,
  input: AOFDispatchInput,
): Promise<AOFDispatchResult> {
  const actor = input.actor ?? "unknown";

  // Validate required fields
  if (!input.title || input.title.trim().length === 0) {
    throw new Error("Task title is required");
  }

  const brief = input.brief || input.description || "";
  if (!brief || brief.trim().length === 0) {
    throw new Error("Task brief/description is required");
  }

  // Phase 46 / Bug 2B: routing-target validation + project-owner defaulting.
  //
  // A task with neither agent nor team nor role can never dispatch —
  // src/dispatch/task-dispatcher.ts:191-250 refuses tags-only routing
  // and the failure counter is NOT incremented for this path, so the
  // task sits in ready/ forever re-evaluated every poll. On 2026-04-25
  // this silently stranded 5 growth-lead tasks for 21 minutes before
  // the dispatching agent gave up.
  //
  // Reject at create-time so the caller gets a named error instead of
  // a silent sit-in-ready. Before rejecting, try to default from the
  // project owner — agents creating tasks in their own project's
  // namespace shouldn't have to repeat the routing every time.
  //
  // "system" is a sentinel used by the _inbox placeholder (and by any
  // project with no real human-meaningful owner set, e.g. the
  // event-calendar-2026 project from the 2026-04-24 incident). Per
  // CONTEXT.md addendum Q3, treat it case-insensitively as "no real
  // owner — do not default" so we don't swap one silent routing
  // failure for another.
  let agent = input.agent;
  let team = input.team;
  let role = input.role;

  if (!agent && !team && !role) {
    const projectId = input.project ?? ctx.projectId;
    if (projectId) {
      try {
        const manifest = await loadProjectManifest(ctx.store, projectId);
        const lead = manifest?.owner?.lead;
        const ownerTeam = manifest?.owner?.team;
        if (lead && lead.toLowerCase() !== "system") {
          agent = lead;
        } else if (ownerTeam && ownerTeam.toLowerCase() !== "system") {
          team = ownerTeam;
        }
      } catch {
        // Manifest load failure is non-fatal; fall through to rejection.
        // loadProjectManifest returns null on read/parse errors and logs
        // a warn itself, so we don't re-log here.
      }
    }
  }

  if (!agent && !team && !role) {
    throw new Error(
      "Task creation requires a routing target. " +
      "Provide one of: agent, team, role. Tags-only routing is not supported " +
      "(would never dispatch — see Phase 46 / Bug 2B).",
    );
  }

  // Validate dependsOn: every referenced task must exist in the store before
  // the new task is created. Silently accepting bogus IDs produced tasks in
  // a permanently-blocked dependency state that dep_remove couldn't clean up
  // (reported as BUG-004 sub-issue A).
  if (input.dependsOn && input.dependsOn.length > 0) {
    const missing: string[] = [];
    for (const blockerId of input.dependsOn) {
      const blocker = await ctx.store.get(blockerId);
      if (!blocker) missing.push(blockerId);
    }
    if (missing.length > 0) {
      throw new Error(
        `dependsOn references nonexistent task${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
      );
    }
  }

  const completionDelivery =
    input.notifyOnCompletion && typeof input.notifyOnCompletion === "object"
      ? normalizeCompletionDelivery(input.notifyOnCompletion as Record<string, unknown>)
      : undefined;

  // Normalize priority
  const priority = normalizePriority(input.priority);

  // Build metadata
  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
  if (input.tags) {
    metadata.tags = input.tags;
  }
  if (typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0) {
    metadata.timeoutMs = Math.min(Math.floor(input.timeoutMs), MAX_DISPATCH_TIMEOUT_MS);
  }

  // Create task directly in `ready/` to close BUG-006's concurrent-read
  // race. Passing through `backlog/` + a subsequent transition doubles the
  // window during which a concurrent aof_status_report's readdir can miss
  // the file (once for backlog/, once for ready/). Writing once, into the
  // final status directory, collapses the window to a single atomic rename.
  const readyTask = await ctx.store.create({
    title: input.title.trim(),
    body: brief.trim(),
    priority,
    // Phase 46 / Bug 2B: use the (possibly project-owner-defaulted) locals
    // instead of raw input, so the defaulted routing lands in the created
    // task's frontmatter.
    routing: { agent, team, role },
    dependsOn: input.dependsOn,
    parentId: input.parentId,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    createdBy: actor,
    initialStatus: "ready",
  });

  // Log task.created event — the task was born ready, so no separate
  // `task.transitioned` event is emitted. Downstream consumers of the
  // dispatch flow already handle the "born-ready" case because the
  // scheduler's auto-promote path only fires on tasks in `backlog/`;
  // dispatched tasks were never intended to be auto-promoted anyway.
  await ctx.logger.log("task.created", actor, {
    taskId: readyTask.frontmatter.id,
    payload: {
      title: readyTask.frontmatter.title,
      priority: readyTask.frontmatter.priority,
      routing: readyTask.frontmatter.routing,
    },
  });

  // Subscribe at dispatch time
  let subscriptionId: string | undefined;
  if (input.subscribe) {
    const subscriberId = input.actor ?? "unknown";
    await validateSubscriberAgent(ctx.orgChartPath, subscriberId);
    const subscriptionStore = createSubscriptionStore(ctx.store);
    const existing = await subscriptionStore.list(readyTask.frontmatter.id, { status: "active" });
    const duplicate = existing.find(s => s.subscriberId === subscriberId && s.granularity === input.subscribe);
    if (duplicate) {
      subscriptionId = duplicate.id;
    } else {
      const sub = await subscriptionStore.create(readyTask.frontmatter.id, subscriberId, input.subscribe!);
      subscriptionId = sub.id;
    }
  }

  // Plugin-driven completion notification. Core is idiom-agnostic: it only
  // understands that a delivery object with a `kind` becomes a subscription
  // whose payload is opaque to core and interpreted by the matching plugin
  // delivery handler.
  let notificationSubscriptionId: string | undefined;
  if (completionDelivery) {
    const deliverySubscriberId =
      completionDelivery.subscriberId ?? `notify:${completionDelivery.kind}`;
    const subscriptionStore = createSubscriptionStore(ctx.store);
    const sub = await subscriptionStore.create(
      readyTask.frontmatter.id,
      deliverySubscriberId,
      "completion",
      completionDelivery,
    );
    notificationSubscriptionId = sub.id;
  }

  // Build response envelope
  const summary = `Task ${readyTask.frontmatter.id} created and ready for assignment`;
  const envelope = compactResponse(summary, {
    taskId: readyTask.frontmatter.id,
    status: readyTask.frontmatter.status,
  });

  // Ensure filePath is always defined (construct if needed)
  const filePath = readyTask.path ?? `tasks/${readyTask.frontmatter.status}/${readyTask.frontmatter.id}.md`;

  return {
    ...envelope,
    taskId: readyTask.frontmatter.id,
    status: readyTask.frontmatter.status,
    filePath,
    ...(subscriptionId && { subscriptionId }),
    ...(notificationSubscriptionId && { notificationSubscriptionId }),
  };
}
