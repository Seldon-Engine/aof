/**
 * OpenClawExecutor — spawns agent sessions using OpenClaw's sessions API.
 * 
 * Primary dispatch: HTTP fetch to gateway REST API
 * Fallback: api.spawnAgent() if available
 */

import type { DispatchExecutor, TaskContext, ExecutorResult } from "../dispatch/executor.js";
import type { OpenClawApi, OpenClawExecutorOptions } from "./types.js";

export class OpenClawExecutor implements DispatchExecutor {
  private readonly gatewayUrl?: string;
  private readonly gatewayToken?: string;

  constructor(
    private readonly api: OpenClawApi,
    opts: OpenClawExecutorOptions = {}
  ) {
    // Priority: constructor opts > env vars > api.config
    this.gatewayUrl = opts.gatewayUrl 
      || process.env.OPENCLAW_GATEWAY_URL
      || this.deriveGatewayUrl();
    
    this.gatewayToken = opts.gatewayToken
      || process.env.OPENCLAW_GATEWAY_TOKEN
      || this.api.config?.gateway?.auth?.token;
  }

  async spawn(context: TaskContext, opts?: { timeoutMs?: number }): Promise<ExecutorResult> {
    console.info(`[AOF] [BUG-001] OpenClawExecutor.spawn() ENTERED for task ${context.taskId}`);
    console.info(`[AOF] [BUG-001]   Agent: ${context.agent}`);
    console.info(`[AOF] [BUG-001]   TaskPath: ${context.taskPath}`);

    // Try HTTP dispatch first
    if (this.gatewayUrl && this.gatewayToken) {
      try {
        console.info(`[AOF] Attempting HTTP dispatch to ${this.gatewayUrl}`);
        const result = await this.httpDispatch(context, opts);
        console.info(`[AOF] HTTP dispatch successful: ${JSON.stringify(result)}`);
        return result;
      } catch (err) {
        const error = err as Error;
        console.warn(`[AOF] HTTP dispatch failed: ${error.message}`);
        
        // Fallback to spawnAgent if available
        if (this.api.spawnAgent) {
          console.info(`[AOF] Falling back to api.spawnAgent`);
          return this.spawnAgentFallback(context, opts);
        }
        
        // No fallback available
        return {
          success: false,
          error: `HTTP dispatch failed: ${error.message}`,
        };
      }
    }

    // No HTTP config, try spawnAgent fallback
    if (this.api.spawnAgent) {
      console.info(`[AOF] No HTTP config, using api.spawnAgent`);
      return this.spawnAgentFallback(context, opts);
    }

    // No dispatch method available
    console.error(`[AOF] [BUG-DISPATCH-001] No gateway configuration and spawnAgent not available`);
    return {
      success: false,
      error: "No gateway configuration available and spawnAgent API not present",
    };
  }

  private async httpDispatch(context: TaskContext, opts?: { timeoutMs?: number }): Promise<ExecutorResult> {
    const taskInstruction = this.formatTaskInstruction(context);
    
    const payload = {
      tool: "sessions_spawn",
      args: {
        agentId: context.agent,
        task: taskInstruction,
        ...(context.thinking && { thinking: context.thinking }),
      },
      sessionKey: "agent:main:main",
    };

    const signal = AbortSignal.timeout(60000);
    
    const response = await fetch(`${this.gatewayUrl}/tools/invoke`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.gatewayToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const sessionId = this.extractSessionId(data);

    if (!sessionId) {
      throw new Error("No sessionId in response");
    }

    return {
      success: true,
      sessionId,
    };
  }

  private extractSessionId(data: any): string | undefined {
    // Try top-level sessionId
    if (data.sessionId) return data.sessionId;

    // Try result.sessionId
    if (data.result?.sessionId) return data.result.sessionId;

    // Try result.details child session identifiers
    if (data.result?.details?.childSessionKey) return data.result.details.childSessionKey;
    if (data.result?.details?.runId) return data.result.details.runId;

    // Try data.sessionId
    if (data.data?.sessionId) return data.data.sessionId;

    // Try result.content[0].text (nested JSON)
    if (data.result?.content?.[0]?.text) {
      try {
        const parsed = JSON.parse(data.result.content[0].text);
        if (parsed.childSessionKey) return parsed.childSessionKey;
        if (parsed.runId) return parsed.runId;
        if (parsed.sessionId) return parsed.sessionId;
      } catch {
        // Not JSON, ignore
      }
    }

    return undefined;
  }

  private async spawnAgentFallback(context: TaskContext, opts?: { timeoutMs?: number }): Promise<ExecutorResult> {
    if (!this.api.spawnAgent) {
      console.error(`[AOF] [BUG-DISPATCH-001] OpenClaw API spawnAgent is NOT available`);
      console.error(`[AOF] [BUG-DISPATCH-001]   This indicates an old OpenClaw version or plugin API mismatch`);
      console.error(`[AOF] [BUG-DISPATCH-001]   REMEDIATION:`);
      console.error(`[AOF] [BUG-DISPATCH-001]     1. Update OpenClaw to latest version (npm install -g openclaw@latest)`);
      console.error(`[AOF] [BUG-DISPATCH-001]     2. Verify AOF plugin is compatible with installed OpenClaw version`);
      console.error(`[AOF] [BUG-DISPATCH-001]     3. Check gateway logs for API surface warnings`);
      console.error(`[AOF] [BUG-DISPATCH-001]   Task ${context.taskId} will be moved to blocked until fixed`);
      
      return {
        success: false,
        error: "spawnAgent not available - update OpenClaw or check plugin compatibility (see gateway log for remediation steps)",
      };
    }

    console.info(`[AOF] [BUG-001] api.spawnAgent is available, proceeding with spawn`);

    try {
      const taskInstruction = this.formatTaskInstruction(context);

      const request = {
        agentId: context.agent,
        task: taskInstruction,
        context: {
          taskId: context.taskId,
          taskPath: context.taskPath,
          priority: context.priority,
          routing: context.routing,
          projectId: context.projectId,
          projectRoot: context.projectRoot,
          taskRelpath: context.taskRelpath,
        },
        timeoutMs: opts?.timeoutMs,
      };

      console.info(`[AOF] [BUG-001] Calling api.spawnAgent with request: ${JSON.stringify(request)}`);

      const response = await this.api.spawnAgent(request);

      console.info(`[AOF] [BUG-001] api.spawnAgent returned: ${JSON.stringify(response)}`);

      if (response.success) {
        return {
          success: true,
          sessionId: response.sessionId,
        };
      } else {
        return {
          success: false,
          error: response.error ?? "Unknown spawn failure",
        };
      }
    } catch (err) {
      const error = err as Error;
      const errorMsg = error.message;
      const errorStack = error.stack ?? "No stack trace available";

      console.error(`[AOF] [BUG-003] Exception in OpenClawExecutor.spawn():`);
      console.error(`[AOF] [BUG-003]   Task: ${context.taskId}`);
      console.error(`[AOF] [BUG-003]   Agent: ${context.agent}`);
      console.error(`[AOF] [BUG-003]   Error: ${errorMsg}`);
      console.error(`[AOF] [BUG-003]   Stack: ${errorStack}`);

      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  private formatTaskInstruction(context: TaskContext): string {
    let instruction = `Execute the task: ${context.taskId}

Task file: ${context.taskPath}`;

    if (context.projectId) {
      instruction += `\nProject: ${context.projectId}`;
    }
    if (context.projectRoot) {
      instruction += `\nProject root: ${context.projectRoot}`;
    }
    if (context.taskRelpath) {
      instruction += `\nTask path (relative): ${context.taskRelpath}`;
    }

    instruction += `\n\nPriority: ${context.priority}
Routing: ${JSON.stringify(context.routing)}

Read the task file for full details and acceptance criteria.`;

    return instruction;
  }

  private deriveGatewayUrl(): string | undefined {
    const port = this.api.config?.gateway?.port;
    if (port) {
      return `http://127.0.0.1:${port}`;
    }
    return undefined;
  }
}
