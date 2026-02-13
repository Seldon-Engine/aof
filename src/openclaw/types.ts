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

export interface SpawnAgentRequest {
  agentId: string;
  task: string;
  context?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface SpawnAgentResponse {
  success: boolean;
  sessionId?: string;
  error?: string;
}

// --- HTTP Dispatch Types ---

export interface OpenClawGatewayConfig {
  url?: string;
  token?: string;
  port?: number;
  auth?: { token?: string };
}

export interface OpenClawExecutorOptions {
  gatewayUrl?: string;
  gatewayToken?: string;
}

// --- API Interface ---

export interface OpenClawApi {
  config?: {
    gateway?: OpenClawGatewayConfig;
    [key: string]: unknown;
  };
  pluginConfig?: Record<string, unknown>;
  logger?: { info(msg: string): void; warn?(msg: string): void; error(msg: string): void; debug?(msg: string): void };
  log?(level: string, msg: string): void;
  registerService(def: OpenClawServiceDefinition): void;
  registerTool(tool: OpenClawToolDefinition, opts?: OpenClawToolOpts): void;
  registerGatewayMethod?(method: string, handler: GatewayHandler): void;
  registerHttpRoute?(def: OpenClawHttpRouteDefinition): void;
  registerCli?(registrar: (...args: unknown[]) => void, opts?: { commands: string[] }): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  spawnAgent?(req: SpawnAgentRequest): Promise<SpawnAgentResponse>;
}
