/**
 * Spawn-poller — long-poll loop that drains `GET /v1/spawns/wait` on the
 * daemon socket and dispatches each received `SpawnRequest` to
 * `runAgentFromSpawnRequest` inside the OpenClaw gateway process.
 *
 * This module is the plugin-side half of the D-09 inversion: the daemon
 * enqueues spawn requests; the plugin pulls them over IPC and executes the
 * agent in-process via `api.runtime.agent.runEmbeddedPiAgent`. The daemon
 * never needs to open an inbound connection to the gateway (which OpenClaw's
 * plugin-sdk doesn't expose).
 *
 * Invariants:
 *   - `startSpawnPollerOnce` is idempotent — module-scope gate (`spawnPollerStarted`)
 *     survives OpenClaw's per-agent-session plugin reload cycle (Pitfall 3) and
 *     prevents double-start.
 *   - On HTTP 204 keepalive (server long-poll window expired) the loop
 *     reconnects immediately — no backoff.
 *   - On socket error the loop backs off exponentially (1s → 2s → 4s …,
 *     capped at 30s) without crashing, then resumes.
 *   - Spawn execution is fire-and-forget from the loop's perspective: the
 *     handler is kicked off with `void` and the loop reconnects for the next
 *     request right away. The handler's resolution feeds
 *     `client.postSpawnResult` asynchronously.
 *   - Handler throws are caught and synthesized into a `SpawnResultPost` with
 *     `{ success: false, error: { kind: "exception" } }` so the daemon lease
 *     can time out cleanly instead of hanging forever.
 *
 * @module openclaw/spawn-poller
 */

import { createLogger } from "../logging/index.js";
import type { DaemonIpcClient } from "./daemon-ipc-client.js";
import type { OpenClawApi } from "./types.js";
import { runAgentFromSpawnRequest } from "./openclaw-executor.js";

const log = createLogger("spawn-poller");

const WAIT_TIMEOUT_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Module-level idempotency gate. ESM module state is shared across OpenClaw's
 * per-session plugin reload cycle, so this flag guarantees at most one active
 * long-poll loop per plugin process.
 */
let spawnPollerStarted = false;

/**
 * Start the long-poll loop if it is not already running. Safe to call from
 * every `registerAofPlugin` invocation — second and subsequent calls are
 * a no-op.
 */
export function startSpawnPollerOnce(client: DaemonIpcClient, api: OpenClawApi): void {
  if (spawnPollerStarted) {
    log.debug("spawn poller already started — skip");
    return;
  }
  spawnPollerStarted = true;
  log.info({ socketPath: client.socketPath }, "spawn poller starting");

  void runLoop(client, api).catch((err) => {
    log.error({ err }, "spawn poller loop terminated unexpectedly");
    // Release the gate so a future register() call (e.g. on plugin reload)
    // can restart the loop instead of leaving the process in a half-dead
    // state.
    spawnPollerStarted = false;
  });
}

/**
 * Stop the running loop (test helper). The loop exits after its current
 * `waitForSpawn` resolves — callers that need immediate shutdown should
 * abandon the client alongside.
 */
export function stopSpawnPoller(): void {
  spawnPollerStarted = false;
}

/** Test helper — observe current gate state. */
export function isSpawnPollerStarted(): boolean {
  return spawnPollerStarted;
}

async function runLoop(client: DaemonIpcClient, api: OpenClawApi): Promise<void> {
  let backoffMs = INITIAL_BACKOFF_MS;

  while (spawnPollerStarted) {
    try {
      const sr = await client.waitForSpawn(WAIT_TIMEOUT_MS);
      if (!sr) {
        // 204 keepalive — reconnect immediately.
        backoffMs = INITIAL_BACKOFF_MS;
        continue;
      }

      log.info({ spawnId: sr.id, taskId: sr.taskId, agent: sr.agent }, "spawn received");

      // Fire-and-forget: do NOT block the loop on agent execution. The poller
      // posts the result when the handler settles.
      void runAgentFromSpawnRequest(api, sr)
        .then((result) =>
          client.postSpawnResult(sr.id, result).catch((err) =>
            log.error({ err, spawnId: sr.id }, "postSpawnResult failed"),
          ),
        )
        .catch((err) => {
          log.error({ err, spawnId: sr.id }, "spawn handler threw");
          void client
            .postSpawnResult(sr.id, {
              sessionId: "unknown",
              success: false,
              aborted: false,
              error: {
                kind: "exception",
                message: err instanceof Error ? err.message : String(err),
              },
              durationMs: 0,
            })
            .catch(() => {
              /* best-effort — daemon lease will eventually reclaim the slot */
            });
        });

      backoffMs = INITIAL_BACKOFF_MS;
    } catch (err) {
      log.warn({ err, backoffMs }, "spawn poll error, retrying after backoff");
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  log.info("spawn poller stopped");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
