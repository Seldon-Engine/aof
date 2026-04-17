/**
 * OpenClawAdapter — spawns agent sessions via api.runtime.agent.runEmbeddedPiAgent().
 *
 * Runs agents directly in the gateway process. This is the same function the
 * gateway itself uses internally to execute every agent run. No HTTP, no JSON-RPC,
 * no gateway-request scope required — it is safe to call from a background
 * poller. Requires OpenClaw ≥ 2026.2 (api.runtime.agent surface).
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/index.js";
import type { GatewayAdapter, TaskContext, SpawnResult, SessionStatus, AgentRunOutcome } from "../dispatch/executor.js";
import type { OpenClawApi, OpenClawAgentRuntime } from "./types.js";
import type { ITaskStore } from "../store/interfaces.js";
import { readHeartbeat, markRunArtifactExpired } from "../recovery/run-artifacts.js";

const log = createLogger("openclaw");

/** Subset of runEmbeddedPiAgent's result shape that we consume. */
interface EmbeddedPiRunResult {
  meta: {
    durationMs: number;
    aborted?: boolean;
    error?: { kind: string; message: string };
  };
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export class OpenClawAdapter implements GatewayAdapter {
  private sessionToTask = new Map<string, string>();

  constructor(
    private readonly api: OpenClawApi,
    private readonly store?: ITaskStore,
  ) {
    log.info("OpenClawAdapter initialized (embedded agent mode)");
  }

  async spawnSession(
    context: TaskContext,
    opts?: {
      timeoutMs?: number;
      correlationId?: string;
      onRunComplete?: (outcome: AgentRunOutcome) => void | Promise<void>;
    },
  ): Promise<SpawnResult> {
    log.info({ taskId: context.taskId, agent: context.agent }, "spawnSession");

    const config = this.api.config as Record<string, unknown> | undefined;
    if (!config) {
      return { success: false, error: "No OpenClaw config available on api.config" };
    }

    const runtimeAgent = this.api.runtime?.agent;
    if (!hasEmbeddedRuntime(runtimeAgent)) {
      return {
        success: false,
        error:
          "OpenClaw runtime.agent.runEmbeddedPiAgent is not available. " +
          "AOF requires OpenClaw ≥ 2026.2.",
      };
    }

    const agentId = this.normalizeAgentId(context.agent);
    const sessionId = randomUUID();
    const sessionKey = `agent:${agentId}:subagent:${sessionId}`;
    // Caller-supplied timeout is authoritative. Callers are responsible for
    // passing the real execution budget (per-task timeoutMs from aof_dispatch
    // or an appropriate default). DEFAULT_TIMEOUT_MS only applies when the
    // caller omits opts.timeoutMs.
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const prompt = this.formatTaskInstruction(context);

    try {
      const workspaceDirRaw = runtimeAgent.resolveAgentWorkspaceDir(config, agentId);
      const ensured = await runtimeAgent.ensureAgentWorkspace({ dir: workspaceDirRaw });
      const workspaceDir = ensured?.dir ?? workspaceDirRaw;
      const agentDir = runtimeAgent.resolveAgentDir(config, agentId);
      const sessionFile = runtimeAgent.session?.resolveSessionFilePath?.(sessionId)
        ?? `${agentDir}/sessions/${sessionId}.jsonl`;

      log.info({ agentId, sessionId }, "launching embedded agent (fire-and-forget)");

      // Fire-and-forget: the scheduler's spawnTimeoutMs is for dispatch handshake,
      // not for agent execution. The agent calls aof_task_complete when done;
      // the scheduler's lease expiry handles the failure case.
      void this.runAgentBackground({
        runEmbeddedPiAgent: runtimeAgent.runEmbeddedPiAgent,
        sessionId,
        sessionKey,
        sessionFile,
        workspaceDir,
        agentDir,
        config,
        prompt,
        agentId,
        timeoutMs,
        runId: sessionId,
        taskId: context.taskId,
        thinking: context.thinking,
        onRunComplete: opts?.onRunComplete,
      });

      this.sessionToTask.set(sessionId, context.taskId);
      return { success: true, sessionId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, taskId: context.taskId }, "embedded agent setup failed");
      return {
        success: false,
        error: message,
        platformLimit: this.parsePlatformLimitError(message),
      };
    }
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    const taskId = this.sessionToTask.get(sessionId);
    if (!taskId || !this.store) {
      return { sessionId, alive: false };
    }

    const heartbeat = await readHeartbeat(this.store, taskId);
    if (!heartbeat) {
      return { sessionId, alive: false };
    }

    const expiresAt = heartbeat.expiresAt ? new Date(heartbeat.expiresAt).getTime() : 0;
    return {
      sessionId,
      alive: expiresAt > Date.now(),
      lastHeartbeatAt: heartbeat.lastHeartbeat,
    };
  }

  async forceCompleteSession(sessionId: string): Promise<void> {
    const taskId = this.sessionToTask.get(sessionId);
    if (!taskId) return;

    if (this.store) {
      await markRunArtifactExpired(this.store, taskId, "force_completed");
    }
    this.sessionToTask.delete(sessionId);
    log.info({ sessionId, taskId }, "force-completed session");
  }

  /** Run the embedded agent in the background, invoking onRunComplete when done. */
  private async runAgentBackground(params: {
    runEmbeddedPiAgent: (p: Record<string, unknown>) => Promise<EmbeddedPiRunResult>;
    sessionId: string;
    sessionKey: string;
    sessionFile: string;
    workspaceDir: string;
    agentDir: string;
    config: Record<string, unknown>;
    prompt: string;
    agentId: string;
    timeoutMs: number;
    runId: string;
    taskId: string;
    thinking?: string;
    onRunComplete?: (outcome: AgentRunOutcome) => void | Promise<void>;
  }): Promise<void> {
    const startMs = Date.now();
    let outcome: AgentRunOutcome;

    try {
      const agentPromise = params.runEmbeddedPiAgent({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        config: params.config,
        prompt: params.prompt,
        agentId: params.agentId,
        timeoutMs: params.timeoutMs,
        runId: params.runId,
        lane: "aof",
        senderIsOwner: true,
        ...(params.thinking && { thinkLevel: params.thinking }),
      });

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(
            `Agent run timed out after ${params.timeoutMs}ms (taskId=${params.taskId}, agentId=${params.agentId})`,
          )),
          params.timeoutMs,
        );
        if (typeof timer === "object" && "unref" in timer) timer.unref();
      });

      const result = await Promise.race([agentPromise, timeoutPromise]);

      if (result.meta.error) {
        log.warn(
          { taskId: params.taskId, errorKind: result.meta.error.kind, errorMessage: result.meta.error.message },
          "agent run completed with error",
        );
      } else if (result.meta.aborted) {
        log.warn({ taskId: params.taskId }, "agent run was aborted");
      } else {
        log.info(
          { taskId: params.taskId, durationMs: result.meta.durationMs },
          "agent run completed",
        );
      }

      outcome = {
        taskId: params.taskId,
        sessionId: params.sessionId,
        success: !result.meta.error && !result.meta.aborted,
        aborted: result.meta.aborted ?? false,
        error: result.meta.error,
        durationMs: result.meta.durationMs,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, taskId: params.taskId }, "background agent run failed");
      outcome = {
        taskId: params.taskId,
        sessionId: params.sessionId,
        success: false,
        aborted: false,
        error: { kind: "exception", message },
        durationMs: Date.now() - startMs,
      };
    }

    if (params.onRunComplete) {
      try {
        await params.onRunComplete(outcome);
      } catch (cbErr) {
        log.error({ err: cbErr, taskId: params.taskId }, "onRunComplete callback failed");
      }
    }
  }

  private normalizeAgentId(agent: string): string {
    // Strip "agent:" prefix if present (e.g. "agent:swe-backend:main" -> "swe-backend")
    if (agent.startsWith("agent:")) {
      const parts = agent.split(":");
      return parts[1] ?? agent;
    }
    return agent;
  }

  private formatTaskInstruction(context: TaskContext): string {
    let instruction = `Execute the task: ${context.taskId}\n\nTask file: ${context.taskPath}`;

    if (context.projectId) instruction += `\nProject: ${context.projectId}`;
    if (context.projectRoot) instruction += `\nProject root: ${context.projectRoot}`;
    if (context.taskRelpath) instruction += `\nTask path (relative): ${context.taskRelpath}`;

    instruction += `\n\nPriority: ${context.priority}\nRouting: ${JSON.stringify(context.routing)}\n\nRead the task file for full details and acceptance criteria.\n\n**CRITICAL:** Before starting work, verify that the \`aof_task_complete\` tool is available to you. If it is NOT available, STOP IMMEDIATELY and output: "ERROR: aof_task_complete tool not available in this session." Do not attempt to complete the task without the tool — your work will be lost.\n\n**COMPLETION REQUIREMENT:** You MUST call \`aof_task_complete\` with taskId="${context.taskId}" when finished. If you exit without calling this tool, the task will be marked as FAILED and retried by another agent. Include a brief summary of actions taken and artifacts produced.`;

    return instruction;
  }

  private parsePlatformLimitError(error: string): number | undefined {
    const match = error.match(/max active children for this session \((\d+)\/(\d+)\)/);
    if (match?.[2]) return parseInt(match[2], 10);
    return undefined;
  }
}

type EmbeddedRuntime = OpenClawAgentRuntime & Required<Pick<
  OpenClawAgentRuntime,
  "runEmbeddedPiAgent" | "resolveAgentWorkspaceDir" | "resolveAgentDir" | "ensureAgentWorkspace"
>>;

function hasEmbeddedRuntime(runtime: OpenClawAgentRuntime | undefined): runtime is EmbeddedRuntime {
  return Boolean(
    runtime?.runEmbeddedPiAgent
      && runtime.resolveAgentWorkspaceDir
      && runtime.resolveAgentDir
      && runtime.ensureAgentWorkspace,
  );
}

/** @deprecated Use OpenClawAdapter instead. */
export const OpenClawExecutor = OpenClawAdapter;
