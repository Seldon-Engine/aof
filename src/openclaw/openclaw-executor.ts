/**
 * Embedded-agent runner for OpenClaw plugin-bridge mode.
 *
 * `runAgentFromSpawnRequest` is the sole production entry point: the
 * spawn-poller drains `SpawnRequest` envelopes from the daemon long-poll
 * and calls this function inside the gateway process. It awaits the full
 * agent run and returns a `SpawnResultPost` for the poller to ACK.
 *
 * Inner helpers (`prepareEmbeddedRun`, `executeEmbeddedRun`,
 * `withSetupTimeout`, model/auth-profile resolution) are exported only for
 * unit tests and the spawn-poller.
 *
 * Requires `api.runtime.agent.runEmbeddedPiAgent` (OpenClaw ≥ 2026.2).
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/index.js";
import type { TaskContext } from "../dispatch/executor.js";
import type { OpenClawApi, OpenClawAgentRuntime } from "./types.js";
import type { SpawnRequest, SpawnResultPost } from "../ipc/schemas.js";

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

/**
 * Default ceiling on `prepared.setup()` — wraps the IPC + filesystem helpers
 * (resolveAgentWorkspaceDir, ensureAgentWorkspace, resolveAgentDir,
 * resolveSessionFilePath) in a hard timeout so a silently-hung helper can't
 * ghost a dispatch indefinitely. Setup is just config lookups + a workspace
 * mkdir; 30 s is generous.
 */
const DEFAULT_SETUP_TIMEOUT_MS = 30_000;

/**
 * Execute a `SpawnRequest` received from the daemon long-poll and return a
 * `SpawnResultPost` suitable for POSTing to `/v1/spawns/:id/result`.
 *
 * Awaits the full agent run. The spawn-poller calls this per received
 * `SpawnRequest` without holding up the long-poll loop (the call itself is
 * kicked off with `void` by the poller).
 */
export async function runAgentFromSpawnRequest(
  api: OpenClawApi,
  sr: SpawnRequest,
): Promise<SpawnResultPost> {
  const startMs = Date.now();

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
    log.error({ err, taskId: sr.taskId }, "embedded agent setup failed");
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
// Shared internal helpers (exported for unit tests)
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

interface EmbeddedRunOutcome {
  taskId: string;
  sessionId: string;
  success: boolean;
  aborted: boolean;
  error?: { kind: string; message: string };
  durationMs: number;
}

type PrepareResult =
  | { ok: false; error: string }
  | { ok: true; setup: () => Promise<EmbeddedRunReady> };

/**
 * Validate that the api exposes the embedded runtime and return a deferred
 * setup closure. Validation is synchronous so early failure modes (missing
 * config, missing runtime) short-circuit before invoking the
 * filesystem-touching helpers.
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

      // Pin authProfileId to `<provider>:default` with source "auto" so OpenClaw's
      // profile resolver starts from a known-good preferred profile and falls back
      // through `resolveAuthProfileOrder` if needed. Passing nothing surfaces as
      // "No credentials found for profile <provider>:default" because OpenClaw's
      // silent fallback can pick a profile outside the AOF-spawned agent's scope.
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

/**
 * Execute the prepared embedded run synchronously (awaits completion) and
 * return an outcome. Wraps the agent invocation in a hard timeout so a hung
 * runtime never holds the spawn-poller indefinitely.
 */
async function executeEmbeddedRun(ready: EmbeddedRunReady): Promise<EmbeddedRunOutcome> {
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
    log.error({ err, taskId: ready.taskId }, "embedded agent run failed");
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

function hasEmbeddedRuntime(runtime: OpenClawAgentRuntime | undefined): runtime is EmbeddedRuntime {
  return Boolean(
    runtime?.runEmbeddedPiAgent
      && runtime.resolveAgentWorkspaceDir
      && runtime.resolveAgentDir
      && runtime.ensureAgentWorkspace,
  );
}
