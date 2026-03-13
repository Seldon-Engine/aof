import { join } from "node:path";
import { createLogger } from "../logging/index.js";
import { FilesystemTaskStore } from "../store/task-store.js";

const log = createLogger("openclaw");
import type { ITaskStore } from "../store/interfaces.js";
import { EventLogger } from "../events/logger.js";
import { AOFMetrics } from "../metrics/exporter.js";
import { AOFService } from "../service/aof-service.js";
import { NotificationPolicyEngine, DEFAULT_RULES } from "../events/notification-policy/index.js";
import { ConsoleNotifier } from "../adapters/console-notifier.js";
import { MatrixNotifier } from "./matrix-notifier.js";
import { OpenClawAdapter } from "./openclaw-executor.js";
import { MockAdapter } from "../dispatch/executor.js";
import type { GatewayAdapter } from "../dispatch/executor.js";
import { loadOrgChart } from "../org/loader.js";
import { PermissionAwareTaskStore } from "../permissions/task-permissions.js";
import type { OrgChart } from "../schemas/org-chart.js";
import type { OpenClawApi } from "./types.js";
import { createMetricsHandler, createStatusHandler } from "../gateway/handlers.js";
import { toolRegistry } from "../tools/tool-registry.js";
import { withPermissions } from "./permissions.js";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface AOFPluginOptions {
  dataDir: string;
  pollIntervalMs?: number;
  defaultLeaseTtlMs?: number;
  dryRun?: boolean;
  maxConcurrentDispatches?: number;
  store?: ITaskStore;
  logger?: EventLogger;
  metrics?: AOFMetrics;
  service?: AOFService;
  messageTool?: {
    send(target: string, message: string): Promise<void>;
  };
  orgChartPath?: string;
  /** Map of project ID -> task store for multi-project resolution */
  projectStores?: Map<string, ITaskStore>;
}

const SERVICE_NAME = "aof-scheduler";

/**
 * Resolve the appropriate GatewayAdapter based on configuration.
 */
function resolveAdapter(api: OpenClawApi, store: ITaskStore): GatewayAdapter {
  const config = api.config as Record<string, unknown> | undefined;
  const adapterType = (config?.executor as Record<string, unknown>)?.adapter;

  if (adapterType === "mock") {
    return new MockAdapter();
  }

  return new OpenClawAdapter(api, store);
}

export function registerAofPlugin(api: OpenClawApi, opts: AOFPluginOptions): AOFService {
  const store = opts.store ?? new FilesystemTaskStore(opts.dataDir);
  const logger = opts.logger ?? new EventLogger(join(opts.dataDir, "events"));
  const metrics = opts.metrics ?? new AOFMetrics();

  // Load org chart for permission enforcement
  let orgChartPromise: Promise<OrgChart | undefined> | undefined;
  if (opts.orgChartPath) {
    orgChartPromise = loadOrgChart(opts.orgChartPath)
      .then(result => {
        if (result.success && result.chart) return result.chart;
        log.warn({ errors: result.errors }, "failed to load org chart for permission enforcement");
        return undefined;
      })
      .catch(err => {
        log.warn({ err }, "failed to load org chart");
        return undefined;
      });
  }

  /**
   * Resolve the correct project-scoped store for a given project ID.
   */
  const resolveProjectStore = (projectId?: string): ITaskStore => {
    if (projectId && opts.projectStores?.has(projectId)) {
      return opts.projectStores.get(projectId)!;
    }
    return store;
  };

  /**
   * Get a permission-aware store for the given actor.
   */
  const getStoreForActor = async (actor?: string, baseStore?: ITaskStore): Promise<ITaskStore> => {
    const effectiveStore = baseStore ?? store;
    if (!orgChartPromise || !actor || actor === "unknown") {
      return effectiveStore;
    }
    const orgChart = await orgChartPromise;
    if (!orgChart) return effectiveStore;
    return new PermissionAwareTaskStore(effectiveStore, orgChart, actor);
  };

  // Build notification adapter
  const notifAdapter = opts.messageTool
    ? new MatrixNotifier(opts.messageTool)
    : new ConsoleNotifier();
  const engine = new NotificationPolicyEngine(notifAdapter, DEFAULT_RULES);

  // Create executor for agent dispatch
  const executor = opts.dryRun === false
    ? resolveAdapter(api, store)
    : undefined;

  const service = opts.service
    ?? new AOFService(
      { store, logger, metrics, engine, executor },
      {
        dataDir: opts.dataDir,
        dryRun: opts.dryRun ?? false,
        pollIntervalMs: opts.pollIntervalMs,
        defaultLeaseTtlMs: opts.defaultLeaseTtlMs,
        maxConcurrentDispatches: opts.maxConcurrentDispatches,
      },
    );

  // --- Service ---
  api.registerService({
    id: SERVICE_NAME,
    start: () => service.start(),
    stop: () => service.stop(),
    status: () => service.getStatus(),
  });

  // --- Event hooks ---
  api.on("session_end", () => { void service.handleSessionEnd(); });
  api.on("before_compaction", () => { void service.handleSessionEnd(); });
  api.on("agent_end", (event) => { void service.handleAgentEnd(event); });
  api.on("message_received", (event) => { void service.handleMessageReceived(event); });

  // --- Tools: shared registry loop (eliminates copy-pasted execute blocks) ---
  for (const [name, def] of Object.entries(toolRegistry)) {
    api.registerTool({
      name,
      description: def.description,
      parameters: zodToJsonSchema(def.schema) as { type: string; properties?: Record<string, unknown>; required?: string[] },
      execute: withPermissions(def.handler, resolveProjectStore, getStoreForActor, logger),
    });
  }

  // --- Adapter-specific tools (not in shared registry) ---

  api.registerTool({
    name: "aof_project_create",
    description: "Create a new project with standard directory structure and manifest.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Project ID (lowercase, hyphens, underscores)" },
        title: { type: "string", description: "Human-readable project title" },
        type: { type: "string", enum: ["swe", "ops", "research", "admin", "personal", "other"], description: "Project type" },
        participants: { type: "array", items: { type: "string" }, description: "Initial participant agent IDs" },
      },
      required: ["id"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const { createProject } = await import("../projects/create.js");
      const result = await createProject(params.id as string, {
        vaultRoot: opts.dataDir,
        title: params.title as string | undefined,
        type: params.type as "swe" | "ops" | "research" | "admin" | "personal" | "other" | undefined,
        participants: params.participants as string[] | undefined,
        template: true,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  });

  api.registerTool({
    name: "aof_project_list",
    description: "List all projects on this AOF instance.",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async (_id: string, _params: Record<string, unknown>) => {
      const { discoverProjects } = await import("../projects/index.js");
      const projects = await discoverProjects(opts.dataDir);
      return { content: [{ type: "text" as const, text: JSON.stringify({ projects: projects.map(p => ({ id: p.id, path: p.path, error: p.error })) }, null, 2) }] };
    },
  });

  api.registerTool({
    name: "aof_project_add_participant",
    description: "Add an agent to a project's participant list.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project ID" },
        agent: { type: "string", description: "Agent ID to add as participant" },
      },
      required: ["project", "agent"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const { resolveProject } = await import("../projects/index.js");
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { parse } = await import("yaml");
      const { writeProjectManifest } = await import("../projects/manifest.js");

      const resolution = await resolveProject(params.project as string, opts.dataDir);
      const manifestPath = join(resolution.projectRoot, "project.yaml");
      const content = await readFile(manifestPath, "utf-8");
      const manifest = parse(content);

      if (!manifest.participants) manifest.participants = [];
      if (manifest.participants.includes(params.agent)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: "Agent already a participant", participants: manifest.participants }, null, 2) }] };
      }

      manifest.participants.push(params.agent as string);
      await writeProjectManifest(resolution.projectRoot, manifest);

      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, participants: manifest.participants }, null, 2) }] };
    },
  });

  // --- HTTP routes ---
  if (typeof api.registerHttpRoute === "function") {
    api.registerHttpRoute({ path: "/aof/metrics", handler: createMetricsHandler({ store, metrics, service }) });
    api.registerHttpRoute({ path: "/aof/status", handler: createStatusHandler(service) });
  }

  return service;
}
