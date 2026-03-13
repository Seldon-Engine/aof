/**
 * Pino-based structured logging factory.
 *
 * Creates child loggers with a bound `component` field.
 * Writes JSON to stderr. Log level controlled by AOF_LOG_LEVEL
 * via the config registry.
 *
 * @module logging
 */

import pino, { type Logger, type DestinationStream } from "pino";
import { getConfig } from "../config/registry.js";

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let root: Logger | null = null;
let dest: DestinationStream | null = null;

function getRootLogger(): Logger {
  if (root) return root;

  const { core } = getConfig();
  dest = pino.destination({ fd: 2, sync: false });
  root = pino(
    {
      level: core.logLevel,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    dest,
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
 * Reset logger singleton -- for test isolation (mirrors resetConfig()).
 *
 * Flushes any buffered logs before clearing the singleton so that
 * async writes are not lost.
 */
export function resetLogger(): void {
  if (dest && "flushSync" in dest && typeof dest.flushSync === "function") {
    (dest as { flushSync: () => void }).flushSync();
  }
  root = null;
  dest = null;
}

export type { Logger } from "pino";
