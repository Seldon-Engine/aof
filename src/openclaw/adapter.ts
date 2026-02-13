import { join } from "node:path";
import { TaskStore } from "../store/task-store.js";
import { EventLogger } from "../events/logger.js";
import { AOFMetrics } from "../metrics/exporter.js";
import { AOFService } from "../service/aof-service.js";
import { NotificationService } from "../events/notifier.js";
import { MatrixNotifier } from "./matrix-notifier.js";
import { OpenClawExecutor } from "./openclaw-executor.js";
import { aofDispatch, aofStatusReport, aofTaskComplete, aofTaskUpdate } from "../tools/aof-tools.js";
import { createMetricsHandler, createStatusHandler } from "../gateway/handlers.js";
import type { OpenClawApi } from "./types.js";

export interface AOFPluginOptions {
  dataDir: string;
  pollIntervalMs?: number;
  defaultLeaseTtlMs?: number;
  dryRun?: boolean;
  gatewayUrl?: string;
  gatewayToken?: string;
  store?: TaskStore;
  logger?: EventLogger;
  metrics?: AOFMetrics;
  service?: AOFService;
  messageTool?: {
    send(target: string, message: string): Promise<void>;
  };
}

const SERVICE_NAME = "aof-scheduler";

export function registerAofPlugin(api: OpenClawApi, opts: AOFPluginOptions): AOFService {
  const store = opts.store ?? new TaskStore(opts.dataDir);
  const logger = opts.logger ?? new EventLogger(join(opts.dataDir, "events"));
  const metrics = opts.metrics ?? new AOFMetrics();

  // Wire up notification service if message tool provided
  let notifier: NotificationService | undefined;
  if (opts.messageTool) {
    const adapter = new MatrixNotifier(opts.messageTool);
    notifier = new NotificationService(adapter, { enabled: true });
  }

  // Create executor for agent dispatch (only when explicitly not in dry-run mode)
  const executor = opts.dryRun === false 
    ? new OpenClawExecutor(api, {
        gatewayUrl: opts.gatewayUrl,
        gatewayToken: opts.gatewayToken,
      })
    : undefined;

  const service = opts.service
    ?? new AOFService(
      { store, logger, metrics, notifier, executor },
      {
        dataDir: opts.dataDir,
        dryRun: opts.dryRun ?? true,
        pollIntervalMs: opts.pollIntervalMs,
        defaultLeaseTtlMs: opts.defaultLeaseTtlMs,
      },
    );

  // --- Service (OpenClaw expects `id`, not `name`) ---
  api.registerService({
    id: SERVICE_NAME,
    start: () => service.start(),
    stop: () => service.stop(),
    status: () => service.getStatus(),
  });

  // --- Event hooks ---
  api.on("session_end", () => {
    void service.handleSessionEnd();
  });
  api.on("before_compaction", () => {
    void service.handleSessionEnd();
  });
  api.on("agent_end", (event) => {
    void service.handleAgentEnd(event);
  });
  api.on("message_received", (event) => {
    void service.handleMessageReceived(event);
  });

  // --- Tools ---
  const wrapResult = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });

  api.registerTool({
    name: "aof_dispatch",
    description: "Create a new AOF task and assign to an agent or team. Returns taskId, status, and filePath.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title (required)" },
        brief: { type: "string", description: "Task description/brief (required)" },
        description: { type: "string", description: "Alias for brief" },
        agent: { type: "string", description: "Agent ID to assign task to" },
        team: { type: "string", description: "Team name for routing" },
        role: { type: "string", description: "Role name for routing" },
        priority: { 
          type: "string", 
          description: "Task priority (critical, high, normal, low)",
          enum: ["critical", "high", "normal", "low"]
        },
        dependsOn: { 
          type: "array", 
          items: { type: "string" },
          description: "Array of task IDs this task depends on"
        },
        parentId: { type: "string", description: "Parent task ID (for subtasks)" },
        metadata: { 
          type: "object", 
          description: "Additional metadata (tags, type, etc.)"
        },
        tags: { 
          type: "array", 
          items: { type: "string" },
          description: "Task tags"
        },
        actor: { type: "string", description: "Agent performing the action" },
      },
      required: ["title", "brief"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const result = await aofDispatch({ store, logger }, params as any);
      return wrapResult(result);
    },
  }, { optional: true });

  api.registerTool({
    name: "aof_task_update",
    description: "Update an AOF task's status/body/work log; use for progress notes, blockers, or outputs on the task card.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to update" },
        status: { type: "string", description: "New status (backlog, ready, in-progress, blocked, review, done)" },
        body: { type: "string", description: "New body content" },
        reason: { type: "string", description: "Reason for transition" },
        actor: { type: "string", description: "Agent performing the update" },
      },
      required: ["taskId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const result = await aofTaskUpdate({ store, logger }, params as any);
      return wrapResult(result);
    },
  }, { optional: true });

  api.registerTool({
    name: "aof_status_report",
    description: "Summarize AOF tasks by status/agent; use to check your queue or team workload without scanning task files.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Filter by agent ID" },
        status: { type: "string", description: "Filter by status" },
      },
      required: [],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const result = await aofStatusReport({ store, logger }, params as any);
      return wrapResult(result);
    },
  }, { optional: true });

  api.registerTool({
    name: "aof_task_complete",
    description: "Mark an AOF task done and append a completion summary (and outputs) to the task card.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to complete" },
        summary: { type: "string", description: "Completion summary" },
        actor: { type: "string", description: "Agent marking task complete" },
      },
      required: ["taskId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const result = await aofTaskComplete({ store, logger }, params as any);
      return wrapResult(result);
    },
  }, { optional: true });

  // --- HTTP routes (use registerHttpRoute for path-based endpoints) ---
  if (typeof api.registerHttpRoute === "function") {
    api.registerHttpRoute({
      path: "/aof/metrics",
      handler: createMetricsHandler({ store, metrics, service }),
    });
    api.registerHttpRoute({
      path: "/aof/status",
      handler: createStatusHandler(service),
    });
  }

  return service;
}
