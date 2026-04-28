/**
 * OpenClawAdapter — spawns agent sessions via api.runtime.agent.runEmbeddedPiAgent().
 *
 * Runs agents directly in the gateway process. This is the same function the
 * gateway itself uses internally to execute every agent run. No HTTP, no JSON-RPC,
 * no gateway-request scope required — it is safe to call from a background
 * poller. Requires OpenClaw ≥ 2026.2 (api.runtime.agent surface).
 *
 * Phase 43 refactor: `runAgentFromSpawnRequest` is factored out as a
 * standalone async entry point so the new spawn-poller can drive agent runs
 * from a `SpawnRequest` envelope without constructing an `OpenClawAdapter`
 * (which requires an `ITaskStore` the thin plugin no longer holds).
 * `OpenClawAdapter` remains the standalone/legacy entry point and delegates
 * to the same inner runner.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/index.js";
import type { GatewayAdapter, TaskContext, SpawnResult, SessionStatus, AgentRunOutcome } from "../dispatch/executor.js";
import type { OpenClawApi, OpenClawAgentRuntime } from "./types.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { SpawnRequest, SpawnResultPost } from "../ipc/schemas.js";
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

    const prepared = prepareEmbeddedRun(this.api, {
      taskId: context.taskId,
      agent: context.agent,
      prompt: formatTaskInstruction(context),
      thinking: context.thinking,
      timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (!prepared.ok) {
      return { success: false, error: prepared.error };
    }

    try {
      const ready = await withSetupTimeout(
        prepared.setup(),
        DEFAULT_SETUP_TIMEOUT_MS,
        context.taskId,
        context.agent,
      );

      log.info({ agentId: ready.agentId, sessionId: ready.sessionId }, "launching embedded agent (fire-and-forget)");

      // Fire-and-forget: the scheduler's spawnTimeoutMs is for dispatch handshake,
      // not for agent execution. The agent calls aof_task_complete when done;
      // the scheduler's lease expiry handles the failure case.
      void runAgentBackground(ready, opts?.onRunComplete);

      this.sessionToTask.set(ready.sessionId, context.taskId);
      return { success: true, sessionId: ready.sessionId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, taskId: context.taskId }, "embedded agent setup failed");
      return {
        success: false,
        error: message,
        platformLimit: parsePlatformLimitError(message),
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
}

// ---------------------------------------------------------------------------
// Phase 43 — SpawnRequest entry point
// ---------------------------------------------------------------------------

/**
 * Execute a `SpawnRequest` received from the daemon long-poll and return a
 * `SpawnResultPost` suitable for POSTing to `/v1/spawns/:id/result`.
 *
 * Unlike `OpenClawAdapter.spawnSession` (fire-and-forget), this function
 * awaits the full agent run. The spawn-poller calls it per received
 * `SpawnRequest`, without holding up the long-poll loop (the call itself is
 * kicked off with `void` by the poller, and the poller reconnects
 * immediately).
 *
 * Requires `api.runtime.agent.runEmbeddedPiAgent` (OpenClaw ≥ 2026.2).
 */
export async function runAgentFromSpawnRequest(
  api: OpenClawApi,
  sr: SpawnRequest,
): Promise<SpawnResultPost> {
  const startMs = Date.now();

  // Reconstruct a TaskContext-equivalent prompt from the SpawnRequest.
  // Mirrors the shape of `TaskContext` for `formatTaskInstruction`.
  const pseudoContext: TaskContext = {
    taskId: sr.taskId,
    taskPath: sr.taskPath,
    agent: sr.agent,
    priority: sr.priority,
    routing: sr.routing,
    projectId: sr.projectId,
    projectRoot: sr.projectRoot,
    taskRelpath: sr.taskRelpath,
    thinking: sr.thinking as TaskContext["thinking"],
  };

  const prepared = prepareEmbeddedRun(api, {
    taskId: sr.taskId,
    agent: sr.agent,
    prompt: formatTaskInstruction(pseudoContext),
    thinking: sr.thinking,
    timeoutMs: sr.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!prepared.ok) {
    return {
      sessionId: "unknown",
      success: false,
      aborted: false,
      error: { kind: "setup_error", message: prepared.error },
      durationMs: Date.now() - startMs,
    };
  }

  let ready: EmbeddedRunReady;
  try {
    ready = await withSetupTimeout(
      prepared.setup(),
      DEFAULT_SETUP_TIMEOUT_MS,
      sr.taskId,
      sr.agent,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, taskId: sr.taskId }, "embedded agent setup failed (spawn-poller path)");
    return {
      sessionId: "unknown",
      success: false,
      aborted: false,
      error: { kind: "setup_error", message },
      durationMs: Date.now() - startMs,
    };
  }

  const outcome = await executeEmbeddedRun(ready);
  return {
    sessionId: outcome.sessionId,
    success: outcome.success,
    aborted: outcome.aborted,
    error: outcome.error,
    durationMs: outcome.durationMs,
  };
}

// ---------------------------------------------------------------------------
// Shared internal helpers
// ---------------------------------------------------------------------------

type EmbeddedRuntime = OpenClawAgentRuntime & Required<Pick<
  OpenClawAgentRuntime,
  "runEmbeddedPiAgent" | "resolveAgentWorkspaceDir" | "resolveAgentDir" | "ensureAgentWorkspace"
>>;

interface EmbeddedRunSetupInput {
  taskId: string;
  agent: string;
  prompt: string;
  thinking?: string;
  timeoutMs: number;
}

interface EmbeddedRunReady {
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
  provider?: string;
  model?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
}

type PrepareResult =
  | { ok: false; error: string }
  | { ok: true; setup: () => Promise<EmbeddedRunReady> };

/**
 * Validate that the api exposes the embedded runtime and return a
 * deferred setup closure. Validation is synchronous so early failure
 * modes (missing config, missing runtime) can short-circuit without
 * invoking the filesystem-touching helpers.
 */
function prepareEmbeddedRun(api: OpenClawApi, input: EmbeddedRunSetupInput): PrepareResult {
  const config = api.config as Record<string, unknown> | undefined;
  if (!config) {
    return { ok: false, error: "No OpenClaw config available on api.config" };
  }

  const runtimeAgent = api.runtime?.agent;
  if (!hasEmbeddedRuntime(runtimeAgent)) {
    return {
      ok: false,
      error:
        "OpenClaw runtime.agent.runEmbeddedPiAgent is not available. " +
        "AOF requires OpenClaw ≥ 2026.2.",
    };
  }

  const agentId = normalizeAgentId(input.agent);
  const sessionId = randomUUID();
  const sessionKey = `agent:${agentId}:subagent:${sessionId}`;

  return {
    ok: true,
    setup: async () => {
      const workspaceDirRaw = runtimeAgent.resolveAgentWorkspaceDir(config, agentId);
      const ensured = await runtimeAgent.ensureAgentWorkspace({ dir: workspaceDirRaw });
      const workspaceDir = ensured?.dir ?? workspaceDirRaw;
      const agentDir = runtimeAgent.resolveAgentDir(config, agentId);
      const sessionFile = runtimeAgent.session?.resolveSessionFilePath?.(sessionId)
        ?? `${agentDir}/sessions/${sessionId}.jsonl`;

      const modelRef = resolveConfiguredModelRef(config, agentId);

      // Derive the explicit auth profile id from the agent's configured
      // provider. OpenClaw's profile-resolution path
      // (`~/Projects/openclaw/src/agents/pi-embedded-runner/run.ts`,
      // `preferredProfileId = params.authProfileId?.trim()`) consumes
      // this as a hint when source is "auto", and as a hard requirement
      // when source is "user". We pass "auto" so OpenClaw can still
      // fall back to the next eligible profile in
      // `resolveAuthProfileOrder` if `<provider>:default` is somehow
      // unavailable (lock file held, keychain prompt blocked, etc.) —
      // but the resolution starts from a known-good preferred profile
      // instead of OpenClaw guessing the default. Passing nothing
      // produced the original "No credentials found for openai:default"
      // ghost class because OpenClaw's silent fallback can pick a
      // profile that doesn't exist in the AOF-spawned agent's scope.
      // See .planning/debug/2026-04-28-aof-dispatch-ghosting-and-worker-hygiene.md
      // (Workstream 3) for the full investigation.
      const authProfileId = modelRef.provider
        ? `${modelRef.provider}:default`
        : undefined;

      return {
        runEmbeddedPiAgent: runtimeAgent.runEmbeddedPiAgent,
        sessionId,
        sessionKey,
        sessionFile,
        workspaceDir,
        agentDir,
        config,
        prompt: input.prompt,
        agentId,
        timeoutMs: input.timeoutMs,
        runId: sessionId,
        taskId: input.taskId,
        thinking: input.thinking,
        ...modelRef,
        ...(authProfileId && {
          authProfileId,
          authProfileIdSource: "auto" as const,
        }),
      };
    },
  };
}

/**
 * Default ceiling on `prepared.setup()` — wraps the IPC + filesystem
 * helpers (resolveAgentWorkspaceDir, ensureAgentWorkspace,
 * resolveAgentDir, resolveSessionFilePath) in a hard timeout so a
 * silently-hung helper can't ghost a dispatch indefinitely.
 *
 * Setup is just config lookups + a workspace mkdir; 30 s is generous.
 * Without this watchdog, a wedged OpenClaw runtime (e.g. mid-reload
 * race, blocked keychain prompt, fs deadlock) produces the exact
 * symptom captured in
 * `.planning/debug/2026-04-28-aof-dispatch-ghosting-and-worker-hygiene.md`
 * — `dispatch.matched` fires, `spawn-poller` logs "spawn received",
 * then total silence until the 1-4 hour task timeout finally fires.
 */
const DEFAULT_SETUP_TIMEOUT_MS = 30_000;

/** Race a promise against a setup-timeout window. */
async function withSetupTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  taskId: string,
  agentId: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `setup timed out after ${timeoutMs}ms (taskId=${taskId}, agentId=${agentId})`,
          ),
        ),
      timeoutMs,
    );
    if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Fire-and-forget wrapper that funnels completion through `onRunComplete`. */
async function runAgentBackground(
  ready: EmbeddedRunReady,
  onRunComplete?: (outcome: AgentRunOutcome) => void | Promise<void>,
): Promise<void> {
  const outcome = await executeEmbeddedRun(ready);
  if (onRunComplete) {
    try {
      await onRunComplete(outcome);
    } catch (cbErr) {
      log.error({ err: cbErr, taskId: ready.taskId }, "onRunComplete callback failed");
    }
  }
}

/**
 * Execute the prepared embedded run synchronously (awaits completion) and
 * return an `AgentRunOutcome`. Both `OpenClawAdapter.spawnSession` and
 * `runAgentFromSpawnRequest` funnel through here so the error handling,
 * timeout behavior, and outcome shape are identical on both paths.
 */
async function executeEmbeddedRun(ready: EmbeddedRunReady): Promise<AgentRunOutcome> {
  const startMs = Date.now();

  try {
    const agentPromise = ready.runEmbeddedPiAgent({
      sessionId: ready.sessionId,
      sessionKey: ready.sessionKey,
      sessionFile: ready.sessionFile,
      workspaceDir: ready.workspaceDir,
      agentDir: ready.agentDir,
      config: ready.config,
      prompt: ready.prompt,
      agentId: ready.agentId,
      timeoutMs: ready.timeoutMs,
      runId: ready.runId,
      lane: "aof",
      senderIsOwner: true,
      ...(ready.provider && { provider: ready.provider }),
      ...(ready.model && { model: ready.model }),
      ...(ready.authProfileId && { authProfileId: ready.authProfileId }),
      ...(ready.authProfileIdSource && { authProfileIdSource: ready.authProfileIdSource }),
      ...(ready.thinking && { thinkLevel: ready.thinking }),
    });

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(
          `Agent run timed out after ${ready.timeoutMs}ms (taskId=${ready.taskId}, agentId=${ready.agentId})`,
        )),
        ready.timeoutMs,
      );
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    });

    const result = await Promise.race([agentPromise, timeoutPromise]);

    if (result.meta.error) {
      log.warn(
        { taskId: ready.taskId, errorKind: result.meta.error.kind, errorMessage: result.meta.error.message },
        "agent run completed with error",
      );
    } else if (result.meta.aborted) {
      log.warn({ taskId: ready.taskId }, "agent run was aborted");
    } else {
      log.info(
        { taskId: ready.taskId, durationMs: result.meta.durationMs },
        "agent run completed",
      );
    }

    return {
      taskId: ready.taskId,
      sessionId: ready.sessionId,
      success: !result.meta.error && !result.meta.aborted,
      aborted: result.meta.aborted ?? false,
      error: result.meta.error,
      durationMs: result.meta.durationMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, taskId: ready.taskId }, "background agent run failed");
    return {
      taskId: ready.taskId,
      sessionId: ready.sessionId,
      success: false,
      aborted: false,
      error: { kind: "exception", message },
      durationMs: Date.now() - startMs,
    };
  }
}

function normalizeAgentId(agent: string): string {
  // Strip "agent:" prefix if present (e.g. "agent:swe-backend:main" -> "swe-backend")
  if (agent.startsWith("agent:")) {
    const parts = agent.split(":");
    return parts[1] ?? agent;
  }
  return agent;
}

interface ModelRef {
  provider?: string;
  model?: string;
}

function resolveConfiguredModelRef(config: Record<string, unknown>, agentId: string): ModelRef {
  const modelRef = readAgentModelRef(config, agentId);
  if (!modelRef) return {};

  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash >= modelRef.length - 1) {
    return { model: modelRef };
  }

  return {
    provider: modelRef.slice(0, slash),
    model: modelRef.slice(slash + 1),
  };
}

function readAgentModelRef(config: Record<string, unknown>, agentId: string): string | undefined {
  const agents = config.agents;
  if (!agents || typeof agents !== "object") return undefined;

  const list = (agents as { list?: unknown }).list;
  if (!Array.isArray(list)) return undefined;

  const entry = list.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    return (candidate as { id?: unknown }).id === agentId;
  });
  if (!entry || typeof entry !== "object") return undefined;

  const model = (entry as { model?: unknown }).model;
  if (typeof model === "string") {
    const trimmed = model.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (model && typeof model === "object") {
    const primary = (model as { primary?: unknown }).primary;
    if (typeof primary === "string") {
      const trimmed = primary.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
  }

  return undefined;
}

function formatTaskInstruction(context: TaskContext): string {
  let instruction = `Execute the task: ${context.taskId}\n\nTask file: ${context.taskPath}`;

  if (context.projectId) instruction += `\nProject: ${context.projectId}`;
  if (context.projectRoot) instruction += `\nProject root: ${context.projectRoot}`;
  if (context.taskRelpath) instruction += `\nTask path (relative): ${context.taskRelpath}`;

  instruction += `\n\nPriority: ${context.priority}\nRouting: ${JSON.stringify(context.routing)}\n\nRead the task file for full details and acceptance criteria.\n\n**CRITICAL:** Before starting work, verify that the \`aof_task_complete\` tool is available to you. If it is NOT available, STOP IMMEDIATELY and output: "ERROR: aof_task_complete tool not available in this session." Do not attempt to complete the task without the tool — your work will be lost.\n\n**COMPLETION REQUIREMENT:** You MUST call \`aof_task_complete\` with taskId="${context.taskId}" when finished. If you exit without calling this tool, the task will be marked as FAILED and retried by another agent. Include a brief summary of actions taken and artifacts produced.`;

  return instruction;
}

function parsePlatformLimitError(error: string): number | undefined {
  const match = error.match(/max active children for this session \((\d+)\/(\d+)\)/);
  if (match?.[2]) return parseInt(match[2], 10);
  return undefined;
}

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
