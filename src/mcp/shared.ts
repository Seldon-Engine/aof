import { join } from "node:path";
import type { Task, TaskStatus, TaskPriority } from "../schemas/task.js";
import { FilesystemTaskStore } from "../store/task-store.js";
import type { ITaskStore } from "../store/interfaces.js";
import { EventLogger } from "../events/logger.js";
import type { GatewayAdapter } from "../dispatch/executor.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ProjectManifest } from "../schemas/project.js";
import { SubscriptionStore } from "../store/subscription-store.js";

export interface AofMcpOptions {
  dataDir: string;
  store?: ITaskStore;
  logger?: EventLogger;
  executor?: GatewayAdapter;
  orgChartPath?: string;
  /** Project ID (for project-scoped operations, defaults to _inbox). */
  projectId?: string;
  /** Vault root (for project-scoped operations). */
  vaultRoot?: string;
}

export interface AofMcpContext {
  dataDir: string;
  /** Vault root for project-level operations (create, list, add participant). */
  vaultRoot: string;
  store: ITaskStore;
  logger: EventLogger;
  executor?: GatewayAdapter;
  orgChartPath: string;
  /** Project manifest for template resolution (loaded when projectId is provided). */
  projectConfig?: ProjectManifest;
  /** Subscription store for task notification subscriptions. */
  subscriptionStore: SubscriptionStore;
}

export async function createAofMcpContext(options: AofMcpOptions): Promise<AofMcpContext> {
  let store: ITaskStore;
  let dataDir: string;
  let logger: EventLogger;
  let orgChartPath: string;
  let projectConfig: ProjectManifest | undefined;

  // If projectId is provided, use project-scoped store
  if (options.projectId || options.vaultRoot) {
    const { createProjectStore } = await import("../cli/project-utils.js");
    const projectId = options.projectId ?? "_inbox";
    const vaultRoot = options.vaultRoot ?? options.dataDir;
    const resolution = await createProjectStore({ projectId, vaultRoot, logger: options.logger });

    store = options.store ?? resolution.store;
    dataDir = resolution.projectRoot;
    logger = options.logger ?? new EventLogger(join(dataDir, "events"));
    orgChartPath = options.orgChartPath ?? join(resolution.vaultRoot, "org", "org-chart.yaml");

    // Load project manifest for workflow template resolution
    try {
      const { readFile } = await import("node:fs/promises");
      const { parse: parseYaml } = await import("yaml");
      const { ProjectManifest: ProjectManifestSchema } = await import("../schemas/project.js");
      const manifestPath = join(dataDir, "project.yaml");
      const raw = await readFile(manifestPath, "utf-8");
      const parsed = parseYaml(raw) as unknown;
      projectConfig = ProjectManifestSchema.parse(parsed);
    } catch {
      // No manifest or parse error -- projectConfig stays undefined
    }
  } else {
    // Legacy behavior: use dataDir directly
    store = options.store ?? new FilesystemTaskStore(options.dataDir);
    dataDir = options.dataDir;
    logger = options.logger ?? new EventLogger(join(dataDir, "events"));
    orgChartPath = options.orgChartPath ?? join(dataDir, "org", "org-chart.yaml");
  }

  const vaultRoot = options.vaultRoot ?? options.dataDir;

  // Build taskDirResolver for SubscriptionStore
  const tasksDir = (store as FilesystemTaskStore).tasksDir ?? join(dataDir, "tasks");
  const taskDirResolver = async (taskId: string): Promise<string> => {
    const task = await store.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return join(tasksDir, task.frontmatter.status, taskId);
  };
  const subscriptionStore = new SubscriptionStore(taskDirResolver);

  return {
    dataDir,
    vaultRoot,
    store,
    logger,
    executor: options.executor,
    orgChartPath,
    projectConfig,
    subscriptionStore,
  };
}

export async function resolveTask(store: ITaskStore, taskId: string): Promise<Task> {
  const task = await store.get(taskId);
  if (task) return task;
  const byPrefix = await store.getByPrefix(taskId);
  if (byPrefix) return byPrefix;
  throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
}

export function resolveAssignedAgent(task: Task): string | undefined {
  if (task.frontmatter.lease?.agent) return task.frontmatter.lease.agent;
  if (task.frontmatter.routing.agent) return task.frontmatter.routing.agent;
  const assignee = task.frontmatter.metadata?.assignee;
  return typeof assignee === "string" ? assignee : undefined;
}

const STATUS_DIRS: TaskStatus[] = [
  "backlog",
  "ready",
  "in-progress",
  "blocked",
  "review",
  "done",
];

export function parseTaskPath(filePath: string): { taskId: string; status: TaskStatus } | null {
  const normalized = filePath.split("\\").join("/");
  const match = normalized.match(/\/tasks\/([^/]+)\/([^/]+)\.md$/);
  if (!match) return null;
  const status = match[1] as TaskStatus;
  if (!STATUS_DIRS.includes(status)) return null;
  return { status, taskId: match[2] ?? "" };
}

const PRIORITY_MAP: Record<string, TaskPriority> = {
  low: "low",
  medium: "normal",
  normal: "normal",
  high: "high",
  critical: "critical",
};

export function normalizePriority(value?: string): TaskPriority {
  if (!value) return "normal";
  const key = value.toLowerCase();
  return PRIORITY_MAP[key] ?? "normal";
}

export function appendSection(body: string, title: string, lines: string[]): string {
  if (lines.length === 0) return body;
  const section = [`## ${title}`, ...lines].join("\n");
  if (!body.trim()) return section;
  return `${body.trim()}\n\n${section}`;
}

export function formatTimestamp(): string {
  return new Date().toISOString();
}
