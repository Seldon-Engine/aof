/**
 * StandaloneAdapter — GatewayAdapter for standalone daemon mode.
 *
 * Dispatches tasks to an OpenClaw gateway over HTTP when the daemon
 * runs outside of the OpenClaw process (e.g. after shell installer setup).
 */

import type {
  GatewayAdapter,
  TaskContext,
  SpawnResult,
  SessionStatus,
  AgentRunOutcome,
} from "../dispatch/executor.js";
import { getConfig } from "../config/registry.js";
import { createLogger } from "../logging/index.js";

const log = createLogger("daemon");

export interface StandaloneAdapterOptions {
  gatewayUrl?: string;
  gatewayToken?: string;
}

export class StandaloneAdapter implements GatewayAdapter {
  private readonly gatewayUrl: string;
  private readonly gatewayToken: string | undefined;
  private gatewayVerified = false;

  constructor(opts: StandaloneAdapterOptions = {}) {
    const cfg = getConfig();
    this.gatewayUrl =
      opts.gatewayUrl ??
      cfg.openclaw.gatewayUrl;
    this.gatewayToken =
      opts.gatewayToken ?? cfg.openclaw.gatewayToken;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.gatewayToken) {
      h["Authorization"] = `Bearer ${this.gatewayToken}`;
    }
    return h;
  }

  private async verifyGateway(): Promise<void> {
    if (this.gatewayVerified) return;

    try {
      const res = await fetch(`${this.gatewayUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        log.error(
          { gatewayUrl: this.gatewayUrl, statusCode: res.status },
          "gateway health check failed",
        );
      }
      this.gatewayVerified = true;
    } catch (err) {
      log.error(
        { err, gatewayUrl: this.gatewayUrl },
        "cannot reach gateway — ensure the OpenClaw gateway is running",
      );
      // Mark verified to avoid spamming on every call
      this.gatewayVerified = true;
    }
  }

  async spawnSession(
    context: TaskContext,
    opts?: {
      timeoutMs?: number;
      correlationId?: string;
      onRunComplete?: (outcome: AgentRunOutcome) => void | Promise<void>;
    },
  ): Promise<SpawnResult> {
    await this.verifyGateway();

    try {
      const res = await fetch(`${this.gatewayUrl}/v1/sessions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          taskId: context.taskId,
          taskPath: context.taskPath,
          agent: context.agent,
          priority: context.priority,
          routing: context.routing,
          projectId: context.projectId,
          projectRoot: context.projectRoot,
          timeoutMs: opts?.timeoutMs,
          correlationId: opts?.correlationId,
        }),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? 30000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          success: false,
          error: `Gateway returned HTTP ${res.status}: ${body}`,
        };
      }

      const data = (await res.json()) as { sessionId?: string };
      const sessionId = data.sessionId ?? `standalone-${Date.now()}`;

      // Fire onRunComplete asynchronously if provided — poll for completion
      if (opts?.onRunComplete) {
        this.pollForCompletion(sessionId, context.taskId, opts.onRunComplete).catch(
          (err) =>
            log.error(
              { err, sessionId },
              "completion poll error",
            ),
        );
      }

      return { success: true, sessionId };
    } catch (err) {
      return {
        success: false,
        error: `Failed to spawn session: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    try {
      const res = await fetch(
        `${this.gatewayUrl}/v1/sessions/${encodeURIComponent(sessionId)}`,
        {
          method: "GET",
          headers: this.headers(),
          signal: AbortSignal.timeout(10000),
        },
      );

      if (!res.ok) {
        return { sessionId, alive: false };
      }

      const data = (await res.json()) as {
        alive?: boolean;
        lastHeartbeatAt?: string;
        completedAt?: string;
      };
      return {
        sessionId,
        alive: data.alive ?? false,
        lastHeartbeatAt: data.lastHeartbeatAt,
        completedAt: data.completedAt,
      };
    } catch (err) {
      log.warn({ err, sessionId }, "failed to get session status");
      return { sessionId, alive: false };
    }
  }

  async forceCompleteSession(sessionId: string): Promise<void> {
    try {
      await fetch(
        `${this.gatewayUrl}/v1/sessions/${encodeURIComponent(sessionId)}/force-complete`,
        {
          method: "POST",
          headers: this.headers(),
          signal: AbortSignal.timeout(10000),
        },
      );
    } catch (err) {
      log.warn({ err, sessionId }, "failed to force-complete session");
    }
  }

  private async pollForCompletion(
    sessionId: string,
    taskId: string,
    onRunComplete: (outcome: AgentRunOutcome) => void | Promise<void>,
  ): Promise<void> {
    const startMs = Date.now();
    const maxPollMs = 30 * 60 * 1000; // 30 minutes
    let intervalMs = 2000;

    while (Date.now() - startMs < maxPollMs) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      intervalMs = Math.min(intervalMs * 1.5, 15000);

      const status = await this.getSessionStatus(sessionId);
      if (!status.alive || status.completedAt) {
        await onRunComplete({
          taskId,
          sessionId,
          success: !!status.completedAt,
          aborted: false,
          durationMs: Date.now() - startMs,
        });
        return;
      }
    }

    // Timed out waiting
    await onRunComplete({
      taskId,
      sessionId,
      success: false,
      aborted: true,
      error: { kind: "timeout", message: "Completion poll timed out after 30 minutes" },
      durationMs: Date.now() - startMs,
    });
  }
}
