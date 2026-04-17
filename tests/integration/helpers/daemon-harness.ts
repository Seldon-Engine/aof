/**
 * Phase 43 — Integration test daemon harness.
 *
 * Spins up a real `startAofDaemon` in-process against a sandboxed $HOME / tmp
 * socket so integration tests can POST to the daemon's Unix socket without
 * polluting the developer's live ~/.aof install.
 *
 * Usage:
 *   const daemon = await startTestDaemon();
 *   // ... exercise daemon.socketPath via plugin-ipc-client helpers ...
 *   await daemon.stop();
 *
 * Notes:
 *   - Sandbox is an mkdtempSync dir — entire thing is rmSync'd on stop().
 *   - `dryRun: true` is the default so the scheduler polls without attempting
 *     to dispatch real sessions; tests that want dispatch semantics override
 *     via opts.dryRun=false.
 *   - Health server is enabled by default (needed by later-wave IPC routes
 *     which extend the same server).
 *
 * This helper is intentionally standalone — it only depends on the existing
 * `src/daemon/daemon.ts` surface. Wave 1+ additions to `src/ipc/*` are
 * consumed by the tests themselves, never by this harness.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { startAofDaemon, type AOFDaemonOptions } from "../../../src/daemon/daemon.js";
import type { AOFService } from "../../../src/service/aof-service.js";

export interface TestDaemon {
  /** Absolute path to the daemon's Unix domain socket. */
  socketPath: string;
  /** Data directory under the sandbox fakeHome. Contains events/, state/, tasks/. */
  dataDir: string;
  /** Fake $HOME root (sandbox/home). */
  fakeHome: string;
  /** Absolute path to the mkdtempSync sandbox root (stop() rms this entirely). */
  sandbox: string;
  /** The running AOFService instance. */
  service: AOFService;
  /** The Unix-socket health/IPC HTTP server (if enableHealthServer). */
  healthServer?: Server;
  /** Tear down the daemon and rm the sandbox. Idempotent. */
  stop(): Promise<void>;
}

export type StartTestDaemonOptions = Partial<
  Omit<AOFDaemonOptions, "dataDir" | "socketPath">
> & {
  /** Override socketPath (default: `${dataDir}/daemon.sock`). */
  socketPath?: string;
  /** Override dataDir (default: `${sandbox}/home/.aof-data`). */
  dataDir?: string;
};

/**
 * Start an AOFService daemon in-process against a fresh sandbox. Returns a
 * `TestDaemon` handle with a `stop()` method that tears everything down.
 *
 * Default behavior:
 *   - `dryRun: true` — scheduler polls without attempting real dispatch.
 *   - `enableHealthServer: true` — Unix socket listener is up before return.
 *   - `pollIntervalMs: 500` — fast polling so tests don't wait 30s per tick.
 */
export async function startTestDaemon(
  overrides: StartTestDaemonOptions = {},
): Promise<TestDaemon> {
  const sandbox = mkdtempSync(join(tmpdir(), "aof-43-harness-"));
  const fakeHome = join(sandbox, "home");
  const dataDir = overrides.dataDir ?? join(fakeHome, ".aof-data");
  mkdirSync(dataDir, { recursive: true });

  const socketPath = overrides.socketPath ?? join(dataDir, "daemon.sock");

  const { dataDir: _dd, socketPath: _sp, ...rest } = overrides;
  void _dd;
  void _sp;

  const ctx = await startAofDaemon({
    dataDir,
    socketPath,
    enableHealthServer: true,
    dryRun: true,
    pollIntervalMs: 500,
    ...rest,
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      await ctx.service.stop();
    } catch {
      // best-effort — test is tearing down anyway
    }
    if (ctx.healthServer) {
      await new Promise<void>((resolve) => {
        ctx.healthServer!.close(() => resolve());
      });
    }
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // best-effort — tmpdir may be partially gone
    }
  };

  return {
    socketPath,
    dataDir,
    fakeHome,
    sandbox,
    service: ctx.service,
    healthServer: ctx.healthServer,
    stop,
  };
}

/**
 * Convenience wrapper — equivalent to `daemon.stop()`. Exported so tests that
 * prefer a functional style don't need to destructure the handle.
 */
export async function stopTestDaemon(daemon: TestDaemon): Promise<void> {
  await daemon.stop();
}
