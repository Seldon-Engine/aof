import type { GatewayHandler } from "../gateway/handlers.js";

// --- Real OpenClaw Plugin API types (matched against extensionAPI.js) ---

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
}

export interface OpenClawServiceDefinition {
  id: string;               // OpenClaw calls service.id.trim()
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
  status?: () => unknown;
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
}

export interface OpenClawSubagentRunResult {
  runId: string;
  childSessionKey?: string;
  sessionKey?: string;
}

export interface OpenClawSubagentWaitResult {
  status?: string;
  error?: { kind?: string; message?: string };
}

export interface OpenClawSubagentRuntime {
  run(params: Record<string, unknown>): Promise<OpenClawSubagentRunResult>;
  waitForRun?(params: { runId: string; timeoutMs?: number }): Promise<OpenClawSubagentWaitResult>;
  deleteSession?(params: { sessionKey: string }): Promise<void>;
  getSessionMessages?(params: { sessionKey: string; limit?: number }): Promise<{ messages: unknown[] }>;
}

export interface OpenClawAgentRuntime {
  runEmbeddedPiAgent?: (params: Record<string, unknown>) => Promise<{
    meta: {
      durationMs: number;
      agentMeta?: {
        sessionId: string;
        provider: string;
        model: string;
      };
      aborted?: boolean;
      error?: {
        kind: string;
        message: string;
      };
    };
  }>;
  resolveAgentWorkspaceDir?: (cfg: Record<string, unknown>, agentId?: string) => string;
  resolveAgentDir?: (cfg: Record<string, unknown>, agentId?: string) => string;
  resolveAgentTimeoutMs?: (cfg: Record<string, unknown>, agentId?: string) => number;
  ensureAgentWorkspace?: (
    cfgOrParams: Record<string, unknown> | { dir: string },
    agentId?: string,
  ) => Promise<{ dir?: string } | void>;
  session?: {
    resolveSessionFilePath?: (cfg: Record<string, unknown>, sessionId: string) => string;
  };
}

export interface OpenClawRuntime {
  agent?: OpenClawAgentRuntime;
  subagent?: OpenClawSubagentRuntime;
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
