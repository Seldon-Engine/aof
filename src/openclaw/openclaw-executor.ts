/**
 * OpenClawAdapter — spawns agent sessions via in-process runEmbeddedPiAgent().
 *
 * Runs agents directly inside the gateway process, bypassing HTTP dispatch,
 * WebSocket auth, and device pairing entirely. This is the same code path
 * the gateway itself uses for all agent execution.
 *
 * The extensionAPI module is loaded lazily on first spawn from the gateway's
 * dist directory.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { getConfig } from "../config/registry.js";
import { createLogger } from "../logging/index.js";
import type { GatewayAdapter, TaskContext, SpawnResult, SessionStatus, AgentRunOutcome } from "../dispatch/executor.js";
import type { OpenClawApi, OpenClawAgentRuntime, OpenClawSubagentRuntime } from "./types.js";
import type { ITaskStore } from "../store/interfaces.js";
import { readHeartbeat, markRunArtifactExpired } from "../recovery/run-artifacts.js";

const log = createLogger("openclaw");

/** Minimal shape of the functions we need from extensionAPI.js */
interface ExtensionApi {
  runEmbeddedPiAgent: (params: Record<string, unknown>) => Promise<EmbeddedPiRunResult>;
  resolveAgentWorkspaceDir: (cfg: Record<string, unknown>, agentId: string) => string;
  resolveAgentDir: (cfg: Record<string, unknown>, agentId: string) => string;
  ensureAgentWorkspace: (params: { dir: string }) => Promise<{ dir: string }>;
  resolveSessionFilePath: (sessionId: string) => string;
  resolveAgentEffectiveModelPrimary?: (cfg: Record<string, unknown>, agentId: string) => string | undefined;
}

/** Subset of the result type we actually use */
interface EmbeddedPiRunResult {
  payloads?: Array<{
    text?: string;
    isError?: boolean;
  }>;
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
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const SUBAGENT_SUCCESS_STATUSES = new Set(["completed", "succeeded", "done"]);
const SUBAGENT_FAILURE_STATUSES = new Set(["failed", "error"]);
const SUBAGENT_ABORTED_STATUSES = new Set(["aborted", "cancelled"]);
const SUBAGENT_RUNNING_STATUSES = new Set(["running", "in_progress", "queued", "pending"]);

export class OpenClawAdapter implements GatewayAdapter {
  private extensionApi: ExtensionApi | undefined;
  private extensionApiLoadPromise: Promise<ExtensionApi> | undefined;
  private sessionToTask = new Map<string, string>();
  private sessionToRun = new Map<string, { runId: string; sessionKey: string }>();

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
      return {
        success: false,
        error: "No OpenClaw config available on api.config",
      };
    }

    const agentId = this.normalizeAgentId(context.agent);
    const sessionId = randomUUID();
    const sessionKey = `agent:${agentId}:subagent:${sessionId}`;
    const runId = sessionId;
    // The scheduler's spawnTimeoutMs (default 30s) was designed for fast HTTP
    // dispatch. For embedded agents, we need the full execution budget.
    // Use the larger of the caller's timeout and our minimum.
    const timeoutMs = Math.max(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const prompt = this.formatTaskInstruction(context);

    const subagentRuntime = this.api.runtime?.subagent;
    if (subagentRuntime?.run) {
      return this.spawnViaSubagentRuntime({
        subagentRuntime,
        agentId,
        sessionId,
        sessionKey,
        prompt,
        timeoutMs,
        taskId: context.taskId,
        thinking: context.thinking,
        onRunComplete: opts?.onRunComplete,
      });
    }

    const runtimeAgent = this.api.runtime?.agent;
    if (this.hasEmbeddedRuntime(runtimeAgent)) {
      return this.spawnViaRuntimeAgent({
        runtimeAgent,
        config,
        agentId,
        sessionId,
        sessionKey,
        prompt,
        timeoutMs,
        runId,
        taskId: context.taskId,
        thinking: context.thinking,
        onRunComplete: opts?.onRunComplete,
      });
    }

    let ext: ExtensionApi;
    try {
      ext = await this.loadExtensionApi();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, "failed to load extensionAPI");
      return {
        success: false,
        error: `Failed to load gateway extensionAPI: ${message}`,
      };
    }

    try {
      // Resolve paths synchronously so failures are reported to the scheduler
      const workspaceDirRaw = ext.resolveAgentWorkspaceDir(config, agentId);
      const { dir: workspaceDir } = await ext.ensureAgentWorkspace({ dir: workspaceDirRaw });
      const agentDir = ext.resolveAgentDir(config, agentId);
      const sessionFile = ext.resolveSessionFilePath(sessionId);

      log.info({ agentId, sessionId }, "launching embedded agent (fire-and-forget)");

      // Fire-and-forget: launch the agent in the background so the scheduler
      // isn't blocked by the spawnTimeoutMs (designed for fast HTTP dispatch).
      // The agent calls aof_task_complete when done; the scheduler's lease
      // expiry handles the failure case.
      const modelOverride = ext.resolveAgentEffectiveModelPrimary?.(config, agentId);

      void this.runAgentBackground(ext, {
        ...(modelOverride && { model: modelOverride }),
        sessionId,
        sessionKey,
        sessionFile,
        workspaceDir,
        agentDir,
        config,
        prompt,
        agentId,
        timeoutMs,
        runId,
        taskId: context.taskId,
        thinking: context.thinking,
        onRunComplete: opts?.onRunComplete,
      });

      // Track sessionId -> taskId mapping for getSessionStatus / forceCompleteSession
      this.sessionToTask.set(sessionId, context.taskId);

      return {
        success: true,
        sessionId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, "embedded agent setup failed");

      const platformLimit = this.parsePlatformLimitError(message);

      return {
        success: false,
        error: message,
        platformLimit,
      };
    }
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    const taskId = this.sessionToTask.get(sessionId);
    if (!taskId) {
      return { sessionId, alive: false };
    }

    const runState = this.sessionToRun.get(sessionId);
    if (runState && this.api.runtime?.subagent?.waitForRun) {
      try {
        const result = await this.api.runtime.subagent.waitForRun({ runId: runState.runId, timeoutMs: 1 });
        const status = result.status?.toLowerCase();
        if (status && SUBAGENT_SUCCESS_STATUSES.has(status)) {
          return { sessionId, alive: false };
        }
        if (status && (SUBAGENT_FAILURE_STATUSES.has(status) || SUBAGENT_ABORTED_STATUSES.has(status))) {
          return { sessionId, alive: false };
        }
        if (!status || SUBAGENT_RUNNING_STATUSES.has(status)) {
          return { sessionId, alive: true };
        }
        return { sessionId, alive: true };
      } catch {
        // Non-blocking status probe; fall back to heartbeat/status file behavior.
      }
    }

    if (!this.store) {
      // No store available — cannot check heartbeat
      return { sessionId, alive: false };
    }

    const heartbeat = await readHeartbeat(this.store, taskId);
    if (!heartbeat) {
      return { sessionId, alive: false };
    }

    const expiresAt = heartbeat.expiresAt
      ? new Date(heartbeat.expiresAt).getTime()
      : 0;

    return {
      sessionId,
      alive: expiresAt > Date.now(),
      lastHeartbeatAt: heartbeat.lastHeartbeat,
    };
  }

  async forceCompleteSession(sessionId: string): Promise<void> {
    const taskId = this.sessionToTask.get(sessionId);
    if (!taskId) {
      return;
    }

    if (this.store) {
      await markRunArtifactExpired(this.store, taskId, "force_completed");
    }

    const runState = this.sessionToRun.get(sessionId);
    if (runState && this.api.runtime?.subagent?.deleteSession) {
      try {
        await this.api.runtime.subagent.deleteSession({ sessionKey: runState.sessionKey });
      } catch (err) {
        log.warn({ err, sessionId, sessionKey: runState.sessionKey }, "failed to delete subagent session");
      }
    }

    this.sessionToTask.delete(sessionId);
    this.sessionToRun.delete(sessionId);
    log.info({ sessionId, taskId }, "force-completed session");
  }

  /** Run the embedded agent in the background, logging results when done. */
  private async runAgentBackground(
    ext: ExtensionApi,
    params: {
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
    },
  ): Promise<void> {
    const startMs = Date.now();
    let outcome: AgentRunOutcome;

    try {
      // Race agent execution against a hard timeout
      const agentPromise = ext.runEmbeddedPiAgent({
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
        alsoAllow: [
          "aof_task_complete", "aof_task_update", "aof_task_block",
          "aof_status_report",
        ],
        ...(params.thinking && { thinkLevel: params.thinking }),
      });

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Agent run timed out after ${params.timeoutMs}ms`)),
          params.timeoutMs,
        );
        // Don't block process exit
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

    // Invoke the completion callback (dispatcher's fallback handler)
    if (params.onRunComplete) {
      try {
        await params.onRunComplete(outcome);
      } catch (cbErr) {
        log.error({ err: cbErr, taskId: params.taskId }, "onRunComplete callback failed");
      }
    }
  }

  private async spawnViaSubagentRuntime(params: {
    subagentRuntime: OpenClawSubagentRuntime;
    agentId: string;
    sessionId: string;
    sessionKey: string;
    prompt: string;
    timeoutMs: number;
    taskId: string;
    thinking?: string;
    onRunComplete?: (outcome: AgentRunOutcome) => void | Promise<void>;
  }): Promise<SpawnResult> {
    try {
      const result = await params.subagentRuntime!.run({
        sessionKey: params.sessionKey,
        message: params.prompt,
        agentId: params.agentId,
        timeoutMs: params.timeoutMs,
        deliver: false,
        ...(params.thinking && { thinking: params.thinking }),
      });

      this.sessionToTask.set(params.sessionId, params.taskId);
      this.sessionToRun.set(params.sessionId, {
        runId: result.runId,
        sessionKey: result.childSessionKey ?? result.sessionKey ?? params.sessionKey,
      });

      if (params.subagentRuntime.waitForRun) {
        void this.watchSubagentRun({
          sessionId: params.sessionId,
          taskId: params.taskId,
          runId: result.runId,
          waitForRun: params.subagentRuntime.waitForRun.bind(params.subagentRuntime),
          timeoutMs: params.timeoutMs,
          onRunComplete: params.onRunComplete,
        });
      }

      log.info({ taskId: params.taskId, agentId: params.agentId, runId: result.runId, sessionKey: params.sessionKey }, "launched runtime subagent");

      return {
        success: true,
        sessionId: params.sessionId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, taskId: params.taskId }, "runtime subagent spawn failed");
      return {
        success: false,
        error: message,
        platformLimit: this.parsePlatformLimitError(message),
      };
    }
  }

  private async spawnViaRuntimeAgent(params: {
    runtimeAgent: OpenClawAgentRuntime;
    config: Record<string, unknown>;
    agentId: string;
    sessionId: string;
    sessionKey: string;
    prompt: string;
    timeoutMs: number;
    runId: string;
    taskId: string;
    thinking?: string;
    onRunComplete?: (outcome: AgentRunOutcome) => void | Promise<void>;
  }): Promise<SpawnResult> {
    try {
      const workspaceDirRaw = params.runtimeAgent!.resolveAgentWorkspaceDir!(params.config, params.agentId);
      const ensured = await params.runtimeAgent!.ensureAgentWorkspace!(params.config, params.agentId);
      const workspaceDir = typeof ensured === "object" && ensured && "dir" in ensured && typeof ensured.dir === "string"
        ? ensured.dir
        : workspaceDirRaw;
      const agentDir = params.runtimeAgent!.resolveAgentDir!(params.config, params.agentId);
      const sessionFile = params.runtimeAgent!.session?.resolveSessionFilePath?.(params.config, params.sessionId)
        ?? join(agentDir, "sessions", `${params.sessionId}.jsonl`);

      log.info({ agentId: params.agentId, sessionId: params.sessionId }, "launching runtime embedded agent (fire-and-forget)");

      void this.runRuntimeAgentBackground({
        runEmbeddedPiAgent: params.runtimeAgent!.runEmbeddedPiAgent!,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile,
        workspaceDir,
        agentDir,
        config: params.config,
        prompt: params.prompt,
        agentId: params.agentId,
        timeoutMs: params.timeoutMs,
        runId: params.runId,
        taskId: params.taskId,
        thinking: params.thinking,
        onRunComplete: params.onRunComplete,
      });

      this.sessionToTask.set(params.sessionId, params.taskId);

      return {
        success: true,
        sessionId: params.sessionId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, "runtime embedded agent setup failed");
      return {
        success: false,
        error: message,
        platformLimit: this.parsePlatformLimitError(message),
      };
    }
  }

  private async runRuntimeAgentBackground(params: {
    runEmbeddedPiAgent: (params: Record<string, unknown>) => Promise<EmbeddedPiRunResult>;
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
    return this.runAgentBackground(
      {
        runEmbeddedPiAgent: params.runEmbeddedPiAgent,
      } as ExtensionApi,
      params,
    );
  }

  private async watchSubagentRun(params: {
    sessionId: string;
    taskId: string;
    runId: string;
    waitForRun: (params: { runId: string; timeoutMs?: number }) => Promise<{ status?: string; error?: { kind?: string; message?: string } }>;
    timeoutMs: number;
    onRunComplete?: (outcome: AgentRunOutcome) => void | Promise<void>;
  }): Promise<void> {
    const startMs = Date.now();
    let outcome: AgentRunOutcome;

    try {
      const result = await params.waitForRun({ runId: params.runId, timeoutMs: params.timeoutMs });
      const status = result.status?.toLowerCase();
      const succeeded = Boolean(status && SUBAGENT_SUCCESS_STATUSES.has(status));
      const aborted = Boolean(status && SUBAGENT_ABORTED_STATUSES.has(status));
      const failed = Boolean(status && SUBAGENT_FAILURE_STATUSES.has(status));
      const running = !status || SUBAGENT_RUNNING_STATUSES.has(status);
      outcome = {
        taskId: params.taskId,
        sessionId: params.sessionId,
        success: succeeded && !result.error,
        aborted,
        error: result.error
          ? { kind: result.error.kind ?? "subagent", message: result.error.message ?? "Subagent run failed" }
          : failed
            ? { kind: "subagent", message: `Subagent run ended with status ${result.status}` }
            : running
              ? { kind: "subagent", message: `Subagent run did not reach a terminal status (${result.status ?? "unknown"})` }
              : !succeeded && !aborted
                ? { kind: "subagent", message: `Subagent run ended with unexpected status ${result.status ?? "unknown"}` }
          : undefined,
        durationMs: Date.now() - startMs,
      };
      if (outcome.error) {
        log.error({ taskId: params.taskId, runId: params.runId, error: outcome.error }, "subagent run completed with error");
      } else if (outcome.aborted) {
        log.warn({ taskId: params.taskId, runId: params.runId }, "subagent run was aborted");
      } else {
        log.info({ taskId: params.taskId, runId: params.runId, durationMs: outcome.durationMs }, "subagent run completed");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome = {
        taskId: params.taskId,
        sessionId: params.sessionId,
        success: false,
        aborted: false,
        error: { kind: "subagent_wait", message },
        durationMs: Date.now() - startMs,
      };
      log.error({ err, taskId: params.taskId, runId: params.runId }, "subagent waitForRun failed");
    }

    if (params.onRunComplete) {
      try {
        await params.onRunComplete(outcome);
      } catch (cbErr) {
        log.error({ err: cbErr, taskId: params.taskId }, "onRunComplete callback failed");
      }
    }
  }

  private hasEmbeddedRuntime(runtimeAgent: OpenClawAgentRuntime | undefined): runtimeAgent is OpenClawAgentRuntime {
    return Boolean(
      runtimeAgent?.runEmbeddedPiAgent
        && runtimeAgent.resolveAgentWorkspaceDir
        && runtimeAgent.resolveAgentDir
        && runtimeAgent.ensureAgentWorkspace,
    );
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

    if (context.projectId) {
      instruction += `\nProject: ${context.projectId}`;
    }
    if (context.projectRoot) {
      instruction += `\nProject root: ${context.projectRoot}`;
    }
    if (context.taskRelpath) {
      instruction += `\nTask path (relative): ${context.taskRelpath}`;
    }

    instruction += `\n\nPriority: ${context.priority}\nRouting: ${JSON.stringify(context.routing)}\n\nRead the task file for full details and acceptance criteria.\n\n**CRITICAL:** Before starting work, verify that the \`aof_task_complete\` tool is available to you. If it is NOT available, STOP IMMEDIATELY and output: "ERROR: aof_task_complete tool not available in this session." Do not attempt to complete the task without the tool — your work will be lost.\n\n**COMPLETION REQUIREMENT:** You MUST call \`aof_task_complete\` with taskId="${context.taskId}" when finished. If you exit without calling this tool, the task will be marked as FAILED and retried by another agent. Include a brief summary of actions taken and artifacts produced.`;

    return instruction;
  }

  /**
   * Lazily load the gateway's extensionAPI module.
   * Cached after first successful load.
   */
  private async loadExtensionApi(): Promise<ExtensionApi> {
    if (this.extensionApi) return this.extensionApi;

    // Deduplicate concurrent loads
    if (this.extensionApiLoadPromise) return this.extensionApiLoadPromise;

    this.extensionApiLoadPromise = this.doLoadExtensionApi();
    try {
      this.extensionApi = await this.extensionApiLoadPromise;
      return this.extensionApi;
    } finally {
      this.extensionApiLoadPromise = undefined;
    }
  }

  private async doLoadExtensionApi(): Promise<ExtensionApi> {
    const distDir = this.resolveGatewayDistDir();
    const extensionApiPath = join(distDir, "extensionAPI.js");
    const url = new URL(`file://${extensionApiPath}`).href;

    // The bundled extensionAPI and its dependency graph resolve config/paths
    // relative to CWD. The gateway process CWD is typically "/", which causes
    // module initialization failures. Temporarily switch to the workspace
    // package root so relative lookups succeed.
    const packageDir = join(distDir, "..");
    const prevCwd = process.cwd();
    process.chdir(packageDir);

    let mod: Record<string, unknown>;
    try {
      mod = await import(url);
    } finally {
      process.chdir(prevCwd);
    }

    // Validate required exports
    const required = [
      "runEmbeddedPiAgent",
      "resolveAgentWorkspaceDir",
      "resolveAgentDir",
      "ensureAgentWorkspace",
      "resolveSessionFilePath",
    ] as const;

    for (const name of required) {
      if (typeof mod[name] !== "function") {
        throw new Error(`extensionAPI.js missing export: ${name}`);
      }
    }

    log.info({ path: extensionApiPath }, "loaded extensionAPI");
    return mod as unknown as ExtensionApi;
  }

  /**
   * Resolve the gateway dist directory.
   * Order: OPENCLAW_STATE_DIR env > ~/.openclaw
   */
  private resolveGatewayDistDir(): string {
    const stateDir = getConfig().openclaw.stateDir;
    return join(stateDir, "workspace", "package", "dist");
  }

  private parsePlatformLimitError(error: string): number | undefined {
    const match = error.match(/max active children for this session \((\d+)\/(\d+)\)/);
    if (match?.[2]) {
      return parseInt(match[2], 10);
    }
    return undefined;
  }
}

/** @deprecated Use OpenClawAdapter instead. */
export const OpenClawExecutor = OpenClawAdapter;
