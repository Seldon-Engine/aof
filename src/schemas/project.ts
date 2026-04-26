/**
 * Project manifest schema for project.yaml per Projects v0 spec.
 *
 * Each project lives under `<vaultRoot>/Projects/<projectId>/project.yaml`
 * and provides metadata for dispatcher, memory routing, and governance.
 */

import { z } from "zod";
import { WorkflowDefinition } from "./workflow-dag.js";

// ---------------------------------------------------------------------------
/** @deprecated Legacy gate workflow types, kept for backward compat of persisted data */
// ---------------------------------------------------------------------------

/** Gate definition — a checkpoint in the workflow. */
export const Gate = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  canReject: z.boolean().default(false),
  when: z.string().optional(),
  description: z.string().optional(),
  requireHuman: z.boolean().optional(),
  timeout: z.string().optional(),
  escalateTo: z.string().optional(),
});
export type Gate = z.infer<typeof Gate>;

/** Rejection strategy — how far to loop back on rejection. */
export const RejectionStrategy = z.enum(["origin"]);
export type RejectionStrategy = z.infer<typeof RejectionStrategy>;

/** Workflow configuration — defines multi-stage task progression. */
export const WorkflowConfig = z.object({
  name: z.string().min(1),
  rejectionStrategy: RejectionStrategy.default("origin"),
  gates: z.array(Gate).min(1),
  outcomes: z.record(z.string(), z.string()).optional(),
});
export type WorkflowConfig = z.infer<typeof WorkflowConfig>;

/** Validate workflow configuration for internal consistency. */
export function validateWorkflow(workflow: WorkflowConfig): string[] {
  const errors: string[] = [];
  if (workflow.gates.length > 0 && workflow.gates[0]?.canReject) {
    errors.push("First gate cannot have canReject=true (no previous gate to return to)");
  }
  const gateIds = new Set<string>();
  for (const gate of workflow.gates) {
    if (gateIds.has(gate.id)) {
      errors.push(`Duplicate gate ID: ${gate.id}`);
    }
    gateIds.add(gate.id);
  }
  const durationRegex = /^\d+[mh]$/;
  for (const gate of workflow.gates) {
    if (gate.timeout && !durationRegex.test(gate.timeout)) {
      errors.push(`Invalid timeout format for gate ${gate.id}: ${gate.timeout} (expected: "1h", "30m", etc.)`);
    }
  }
  for (const gate of workflow.gates) {
    if (gate.escalateTo !== undefined && gate.escalateTo.trim().length === 0) {
      errors.push(`Gate ${gate.id} has empty escalateTo role`);
    }
  }
  return errors;
}

/** Valid project ID: [a-z0-9][a-z0-9-]{1,63} or special _inbox */
export const PROJECT_ID_REGEX = /^(_inbox|[a-z0-9][a-z0-9-]{1,63})$/;

/** Template name key: lowercase alphanumeric with hyphens, must start with [a-z0-9]. */
export const TemplateNameKey = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, {
  message: "Template name must be lowercase alphanumeric with hyphens",
});

/** Project status. */
export const ProjectStatus = z.enum(["active", "paused", "archived"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/** Project type. */
export const ProjectType = z.enum([
  "swe",
  "ops",
  "research",
  "admin",
  "personal",
  "other",
]);
export type ProjectType = z.infer<typeof ProjectType>;

/** Project owner metadata. */
export const ProjectOwner = z.object({
  /** Team ID from org-chart. */
  team: z.string(),
  /** Lead agent or human ID. */
  lead: z.string(),
});
export type ProjectOwner = z.infer<typeof ProjectOwner>;

/** Routing config for project tasks. */
export const ProjectRouting = z.object({
  intake: z
    .object({
      default: z.string().default("Tasks/Backlog"),
    })
    .default({}),
  mailboxes: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
});
export type ProjectRouting = z.infer<typeof ProjectRouting>;

/** Memory indexing tier defaults. */
export const ProjectMemoryTiers = z.object({
  bronze: z.enum(["cold", "warm"]).default("cold"),
  silver: z.enum(["cold", "warm"]).default("warm"),
  gold: z.enum(["cold", "warm"]).default("warm"),
});
export type ProjectMemoryTiers = z.infer<typeof ProjectMemoryTiers>;

/** Memory indexing config. */
export const ProjectMemory = z.object({
  tiers: ProjectMemoryTiers.default({}),
  allowIndex: z
    .object({
      warmPaths: z.array(z.string()).default(["Artifacts/Silver", "Artifacts/Gold"]),
    })
    .default({}),
  denyIndex: z
    .array(z.string())
    .default(["Cold", "Artifacts/Bronze", "State", "Tasks"]),
});
export type ProjectMemory = z.infer<typeof ProjectMemory>;

/** External links for project. */
export const ProjectLinks = z.object({
  repo: z.string().optional(),
  dashboards: z.array(z.string()).default([]),
  docs: z.array(z.string()).default([]),
});
export type ProjectLinks = z.infer<typeof ProjectLinks>;

/** SLA configuration for project tasks. */
export const ProjectSLA = z.object({
  /** Default max in-progress duration for normal tasks (ms). */
  defaultMaxInProgressMs: z.number().int().positive().optional(),
  /** Default max in-progress duration for research tasks (ms). */
  researchMaxInProgressMs: z.number().int().positive().optional(),
  /** Violation policy (Phase 1: only 'alert' is supported). */
  onViolation: z.enum(["alert", "block", "deadletter"]).default("alert"),
  /** Alerting configuration. */
  alerting: z.object({
    /** Alert channel (slack, discord, email). */
    channel: z.string().optional(),
    /** Webhook URL for alerts. */
    webhook: z.string().optional(),
    /** Rate limit for alerts (minutes between alerts per task). */
    rateLimitMinutes: z.number().int().positive().default(15),
  }).optional(),
});
export type ProjectSLA = z.infer<typeof ProjectSLA>;

/** Project manifest (project.yaml). */
export const ProjectManifest = z.object({
  /** Project ID: must match directory name and follow [a-z0-9][a-z0-9-]{1,63} or be _inbox. */
  id: z.string().regex(PROJECT_ID_REGEX, {
    message: "Project ID must match [a-z0-9][a-z0-9-]{1,63} or be _inbox",
  }),
  /** Human-readable project title. */
  title: z.string(),
  /** Project status. */
  status: ProjectStatus.default("active"),
  /** Project type. */
  type: ProjectType,
  /** Owner metadata. */
  owner: ProjectOwner,
  /** Optional parent project ID for hierarchical projects. */
  parentId: z.string().optional(),
  /** Routing config. */
  routing: ProjectRouting.default({}),
  /** Memory config. */
  memory: ProjectMemory.default({}),
  /** External links. */
  links: ProjectLinks.default({}),
  /** SLA configuration (time limits and violation handling). */
  sla: ProjectSLA.optional(),
  /** Workflow configuration (multi-stage task progression). */
  workflow: WorkflowConfig.optional(),
  /** Named workflow templates -- static WorkflowDefinition snapshots reusable across tasks. */
  workflowTemplates: z.record(TemplateNameKey, WorkflowDefinition).optional(),
  /** Default workflow template name (references a key in workflowTemplates). */
  defaultWorkflow: z.string().optional(),
});
export type ProjectManifest = z.infer<typeof ProjectManifest>;
