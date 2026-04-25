/**
 * Pino-based structured logging factory.
 *
 * Creates child loggers with a bound `component` field.
 *
 * Phase 46 / Bug 1C: writes JSON to a rotated log file at
 * <dataDir>/logs/aof.log via pino-roll's worker-thread transport
 * (50 MB per file, 5 files retained, no gzip — 250 MB worst-case).
 *
 * Pre-Phase-46 the logger wrote to fd:2 (stderr), which launchd's
 * StandardErrorPath captured into daemon-stderr.log with no rotation.
 * After 6 days of churn that file was 172 MB / 970k lines and creating
 * visible fsync pressure. fd:2 is intentionally NOT a destination
 * here so launchd's stderr capture becomes a rare-event channel
 * (only Node-level uncaught crashes still write to it).
 *
 * Log level controlled by AOF_LOG_LEVEL via the config registry.
 *
 * @module logging
 */

import pino, { type Logger, type DestinationStream } from "pino";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { getConfig } from "../config/registry.js";
import { resolveDataDir } from "../config/paths.js";

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let root: Logger | null = null;
let dest: DestinationStream | null = null;

/**
 * TEST-ONLY transport override.
 *
 * Phase 46 / Bug 1C: existing logger.test.ts cases that exercise the
 * singleton's `getRootLogger` path would otherwise need to spawn the
 * pino-roll worker thread and synchronize against it, which is flaky
 * and leaks workers. Tests inject a synchronous PassThrough/sink
 * via this hook in beforeEach, and clear it in afterEach.
 *
 * Production code path (no override) wires pino-roll exactly as
 * specified above. The override is a TEST-ONLY escape hatch — option
 * (c) per Phase 46 revision: clean separation of production and test
 * concerns; no `sleep()` / `setTimeout()` synchronization in tests.
 */
let testTransportOverride: DestinationStream | null = null;

/**
 * TEST-ONLY: inject a synchronous transport so logger tests don't
 * spawn the pino-roll worker thread (Phase 46 / Bug 1C — see
 * src/logging/__tests__/logger.test.ts).
 *
 * Pass `null` to clear the override and restore production wiring.
 */
export function __setLoggerTransportForTests(
  stream: DestinationStream | null,
): void {
  testTransportOverride = stream;
}

function getRootLogger(): Logger {
  if (root) return root;

  const { core } = getConfig();

  // Phase 46 / Bug 1C: pino-roll worker-thread transport for bounded
  // log disk use in production. In vitest the worker-thread loader
  // can't resolve `pino-roll` from the worker context (and would leak
  // workers per file anyway), so default to a discard sink unless a
  // test has injected its own override via __setLoggerTransportForTests.
  let transport: DestinationStream;
  if (testTransportOverride) {
    transport = testTransportOverride;
  } else if (process.env["VITEST"] === "true") {
    const sink = new PassThrough();
    sink.resume();
    transport = sink;
  } else {
    const logsDir = join(resolveDataDir(), "logs");
    transport = pino.transport({
      target: "pino-roll",
      options: {
        file: join(logsDir, "aof.log"),
        size: "50m",
        limit: { count: 5 },
        mkdir: true,
      },
    });
  }
  dest = transport;

  root = pino(
    {
      level: core.logLevel,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport,
  );
  return root;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a child logger with the given component name bound.
 *
 * The root logger is lazily initialized on first call, reading
 * the log level from `getConfig().core.logLevel`.
 */
export function createLogger(component: string): Logger {
  return getRootLogger().child({ component });
}

/**
 * Reset logger singleton — for test isolation (mirrors resetConfig()).
 *
 * Flushes any buffered logs, then calls .end() on the worker-thread
 * transport so the worker is released. Without .end() the vitest
 * worker pool leaks threads (CLAUDE.md "Orphan vitest workers" hazard)
 * and `kill -9` becomes mandatory after every aborted run.
 */
export function resetLogger(): void {
  if (dest) {
    if ("flushSync" in dest && typeof dest.flushSync === "function") {
      (dest as { flushSync: () => void }).flushSync();
    }
    // Phase 46: pino-roll transport is worker-backed; .end() releases
    // the worker so the test suite doesn't leak threads.
    if (
      "end" in dest &&
      typeof (dest as { end: () => void }).end === "function"
    ) {
      (dest as { end: () => void }).end();
    }
  }
  root = null;
  dest = null;
}

export type { Logger } from "pino";
