import type { GatewayHandler } from "../gateway/handlers.js";

// --- Real OpenClaw Plugin API types (matched against plugin-sdk runtime types) ---

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
}

/**
 * Service context passed to registered plugin services on start/stop.
 *
 * Mirrors the canonical `OpenClawPluginServiceContext` from
 * `~/Projects/openclaw/src/plugins/types.ts:1850-1856`. AOF doesn't
 * import openclaw's types directly (peer-dependency only), so we mirror
 * the shape here. Only the fields AOF actually consumes are typed
 * narrowly; everything else stays as `unknown` to avoid drift if
 * upstream extends the surface.
 */
export interface OpenClawPluginServiceContext {
  config: Record<string, unknown>;
  workspaceDir?: string;
  stateDir: string;
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug?(msg: string): void;
  };
}

/**
 * Background plugin service registered via `api.registerService(...)`.
 *
 * Lifecycle (verified against `~/Projects/openclaw/src/plugins/services.ts`):
 *   - `start(ctx)` is invoked exactly once per process during gateway
 *     startup (`startPluginServices` in
 *     `~/Projects/openclaw/src/gateway/server-startup.ts`). Worker
 *     processes (per-session agent runners) never call
 *     `startPluginServices`, so service.start does NOT fire there.
 *   - `stop(ctx)` is invoked on gateway shutdown via the handle returned
 *     from `startPluginServices`, in reverse registration order.
 *
 * Mirrors `OpenClawPluginService` at
 * `~/Projects/openclaw/src/plugins/types.ts:1858-1863`.
 */
export interface OpenClawServiceDefinition {
  id: string;
  start: (ctx: OpenClawPluginServiceContext) => Promise<void> | void;
  stop?: (ctx: OpenClawPluginServiceContext) => Promise<void> | void;
}

export interface OpenClawToolDefinition {
  name: string;
  description?: string;
  parameters?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
}

export interface OpenClawToolOpts {
  name?: string;
  names?: string[];
  optional?: boolean;
}

export interface OpenClawHttpRouteDefinition {
  path: string;
  handler: GatewayHandler;
  /**
   * Required auth descriptor (OpenClaw >= 2026.4.11). The gateway's loader
   * rejects registrations where `auth` is neither "gateway" nor "plugin":
   *   - "gateway": protected by gateway token auth (requests need a valid
   *     gateway token — appropriate for loopback-only admin/observability
   *     surfaces that should not be reachable without the local token).
   *   - "plugin": the plugin's handler is responsible for its own auth.
   * Canonical validator lives in the openclaw CLI at dist/loader-*.js —
   * this mirror exists so TypeScript callers can't omit the field.
   */
  auth: "gateway" | "plugin";
}

/**
 * Subset of the openclaw `api.runtime.agent` surface we consume.
 * Canonical definition lives in openclaw's
 * plugin-sdk/src/plugins/runtime/types-core.ts (PluginRuntimeCore.agent).
 */
export interface OpenClawAgentRuntime {
  runEmbeddedPiAgent?: (params: Record<string, unknown>) => Promise<{
    meta: {
      durationMs: number;
      aborted?: boolean;
      error?: { kind: string; message: string };
    };
  }>;
  resolveAgentWorkspaceDir?: (cfg: Record<string, unknown>, agentId?: string) => string;
  resolveAgentDir?: (cfg: Record<string, unknown>, agentId?: string) => string;
  resolveAgentTimeoutMs?: (cfg: Record<string, unknown>, agentId?: string) => number;
  ensureAgentWorkspace?: (params?: { dir?: string; ensureBootstrapFiles?: boolean }) => Promise<{ dir: string } | void>;
  session?: {
    resolveSessionFilePath?: (sessionId: string) => string;
  };
}

export interface OpenClawRuntime {
  agent?: OpenClawAgentRuntime;
}

// --- API Interface ---

export interface OpenClawApi {
  config?: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  runtime?: OpenClawRuntime;
  logger?: { info(msg: string): void; warn?(msg: string): void; error(msg: string): void; debug?(msg: string): void };
  log?(level: string, msg: string): void;
  registerService(def: OpenClawServiceDefinition): void;
  registerTool(tool: OpenClawToolDefinition, opts?: OpenClawToolOpts): void;
  registerGatewayMethod?(method: string, handler: GatewayHandler): void;
  registerHttpRoute?(def: OpenClawHttpRouteDefinition): void;
  registerCli?(registrar: (...args: unknown[]) => void, opts?: { commands: string[] }): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}
