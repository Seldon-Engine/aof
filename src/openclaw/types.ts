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

/**
 * Canonical lifecycle hook names exposed by OpenClaw.
 *
 * Mirrors `PluginHookName` from
 * `~/Projects/openclaw/src/plugins/hook-types.ts:56-85`. AOF only
 * subscribes to a subset (session_end, agent_end, before_compaction,
 * message_received, message_sent, before_tool_call, after_tool_call),
 * but the union is mirrored in full so typos against any of the other
 * 21 hook names are caught at compile time too.
 */
export type PluginHookName =
  | "before_model_resolve"
  | "before_prompt_build"
  | "before_agent_start"
  | "before_agent_reply"
  | "llm_input"
  | "llm_output"
  | "agent_end"
  | "before_compaction"
  | "after_compaction"
  | "before_reset"
  | "inbound_claim"
  | "message_received"
  | "message_sending"
  | "message_sent"
  | "before_tool_call"
  | "after_tool_call"
  | "tool_result_persist"
  | "before_message_write"
  | "session_start"
  | "session_end"
  | "subagent_spawning"
  | "subagent_delivery_target"
  | "subagent_spawned"
  | "subagent_ended"
  | "gateway_start"
  | "gateway_stop"
  | "before_dispatch"
  | "reply_dispatch"
  | "before_install";

/**
 * Plugin registration mode. Mirrors `PluginRegistrationMode` from
 * `~/Projects/openclaw/src/plugins/types.ts:1660` (around the
 * `registrationMode: PluginRegistrationMode` field on
 * `OpenClawPluginApi`).
 *
 * Only "full" actually wires the plugin; in the other modes
 * `~/Projects/openclaw/src/plugins/registry.ts` strips
 * `registerService`, `registerTool`, `registerHook`, etc. from the
 * api object entirely. AOF must therefore early-return when
 * `registrationMode !== "full"` to avoid TypeError'ing on undefined
 * methods.
 */
export type PluginRegistrationMode =
  | "full"
  | "setup-only"
  | "setup-runtime"
  | "cli-metadata";

/**
 * Lifecycle hook handler. The canonical type is
 * `PluginHookHandlerMap[K]` and varies per hook (each hook has its
 * own event/context payload shape). Mirroring the full handler map
 * is non-trivial — leaf types span ~10 source files. For now we
 * type the hook NAME union strictly and keep the handler args wide;
 * future tightening can mirror `PluginHookHandlerMap` per hook
 * subset that AOF actually needs.
 */
export type PluginHookHandler = (
  event: unknown,
  ctx: unknown,
) => void | Promise<void>;

export interface OpenClawApi {
  config?: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  /**
   * Plugin loading mode. Absent on older OpenClaw versions that
   * predate the registration-mode concept and on minimal test mocks
   * — treat `undefined` as "full" for backward compatibility.
   */
  registrationMode?: PluginRegistrationMode;
  runtime?: OpenClawRuntime;
  logger?: { info(msg: string): void; warn?(msg: string): void; error(msg: string): void; debug?(msg: string): void };
  log?(level: string, msg: string): void;
  registerService(def: OpenClawServiceDefinition): void;
  registerTool(tool: OpenClawToolDefinition, opts?: OpenClawToolOpts): void;
  registerGatewayMethod?(method: string, handler: GatewayHandler): void;
  registerHttpRoute?(def: OpenClawHttpRouteDefinition): void;
  registerCli?(registrar: (...args: unknown[]) => void, opts?: { commands: string[] }): void;
  /**
   * Register a typed lifecycle hook. The canonical signature
   * (`~/Projects/openclaw/src/plugins/types.ts:2059-2063`) constrains
   * `hookName` to `PluginHookName` and the handler to
   * `PluginHookHandlerMap[K]`. We constrain the name strictly here so
   * typos like `"sesion_end"` fail at compile time; the handler
   * payload stays wide (see `PluginHookHandler`).
   */
  on(
    hookName: PluginHookName,
    handler: PluginHookHandler,
    opts?: { priority?: number },
  ): void;
}
