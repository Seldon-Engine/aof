/**
 * Zod-validated config registry singleton.
 *
 * Single source of truth for all AOF environment variable configuration.
 * Lazy-initialized on first getConfig() call, cached, and deeply frozen.
 * Use resetConfig() in tests for isolation.
 *
 * @module config/registry
 */

import { z, type ZodIssue } from "zod";
import { normalizePath } from "./paths.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const AofConfigSchema = z.object({
  core: z
    .object({
      dataDir: z.string().default("~/.aof"),
      logLevel: z
        .enum(["debug", "info", "warn", "error", "silent"])
        .default("info"),
      vaultRoot: z.string().optional(),
    })
    .default({}),
  dispatch: z
    .object({
      defaultLeaseTtlMs: z.coerce.number().positive().default(600_000),
      spawnTimeoutMs: z.coerce.number().positive().default(120_000),
      maxConcurrency: z.coerce.number().int().positive().default(3),
      maxDispatchesPerPoll: z.coerce.number().int().positive().default(10),
    })
    .default({}),
  daemon: z
    .object({
      pollIntervalMs: z.coerce.number().positive().default(30_000),
      socketPath: z.string().optional(),
    })
    .default({}),
  openclaw: z
    .object({
      gatewayUrl: z.string().default("http://localhost:3000"),
      gatewayToken: z.string().optional(),
      stateDir: z.string().default("~/.openclaw"),
      configPath: z.string().optional(),
    })
    .default({}),
  integrations: z
    .object({
      openaiApiKey: z.string().optional(),
    })
    .default({}),
});

export type AofConfig = z.infer<typeof AofConfigSchema>;

// ---------------------------------------------------------------------------
// ConfigError
// ---------------------------------------------------------------------------

export class ConfigError extends Error {
  public readonly issues: ZodIssue[];

  constructor(issues: ZodIssue[]) {
    const lines = issues.map(
      (i) => `  - ${i.path.join(".")}: ${i.message}`,
    );
    super(`Invalid AOF configuration:\n${lines.join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Known env vars (for unknown-var detection)
// ---------------------------------------------------------------------------

const KNOWN_AOF_VARS = new Set([
  "AOF_DATA_DIR",
  "AOF_ROOT",
  "AOF_LOG_LEVEL",
  "AOF_DEFAULT_LEASE_TTL_MS",
  "AOF_SPAWN_TIMEOUT_MS",
  "AOF_MAX_CONCURRENCY",
  "AOF_MAX_DISPATCHES_PER_POLL",
  "AOF_DAEMON_POLL_INTERVAL_MS",
  "AOF_DAEMON_SOCKET",
  "AOF_VAULT_ROOT",
  "AOF_CALLBACK_DEPTH",
]);

// ---------------------------------------------------------------------------
// Env-to-schema mapping
// ---------------------------------------------------------------------------

/** Strip undefined values so Zod defaults apply. */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function readEnvInput(): Record<string, unknown> {
  const env = process.env;
  return {
    core: stripUndefined({
      dataDir: env["AOF_DATA_DIR"] ?? env["AOF_ROOT"],
      logLevel: env["AOF_LOG_LEVEL"],
      vaultRoot: env["AOF_VAULT_ROOT"] ?? env["OPENCLAW_VAULT_ROOT"],
    }),
    dispatch: stripUndefined({
      defaultLeaseTtlMs: env["AOF_DEFAULT_LEASE_TTL_MS"],
      spawnTimeoutMs: env["AOF_SPAWN_TIMEOUT_MS"],
      maxConcurrency: env["AOF_MAX_CONCURRENCY"],
      maxDispatchesPerPoll: env["AOF_MAX_DISPATCHES_PER_POLL"],
    }),
    daemon: stripUndefined({
      pollIntervalMs: env["AOF_DAEMON_POLL_INTERVAL_MS"],
      socketPath: env["AOF_DAEMON_SOCKET"],
    }),
    openclaw: stripUndefined({
      gatewayUrl: env["OPENCLAW_GATEWAY_URL"],
      gatewayToken: env["OPENCLAW_GATEWAY_TOKEN"],
      stateDir: env["OPENCLAW_STATE_DIR"],
      configPath: env["OPENCLAW_CONFIG"],
    }),
    integrations: stripUndefined({
      openaiApiKey: env["OPENAI_API_KEY"],
    }),
  };
}

// ---------------------------------------------------------------------------
// Deep freeze
// ---------------------------------------------------------------------------

function deepFreeze<T extends object>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Levenshtein distance (simple inline)
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

function findClosest(key: string, known: Set<string>): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const k of known) {
    const d = levenshtein(key, k);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  // Only suggest if reasonably close (within half the key length)
  return bestDist <= Math.ceil(key.length / 2) ? best : undefined;
}

function warnUnknownVars(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("AOF_") && !KNOWN_AOF_VARS.has(key)) {
      const closest = findClosest(key, KNOWN_AOF_VARS);
      console.warn(
        `Unknown env var ${key}${closest ? ` -- did you mean ${closest}?` : ""}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Deep merge utility (for resetConfig overrides)
// ---------------------------------------------------------------------------

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let cached: Readonly<AofConfig> | null = null;

/**
 * Get the validated, frozen AOF configuration singleton.
 *
 * On first call, reads process.env, validates via Zod, deep-freezes,
 * and caches. Subsequent calls return the cached instance.
 *
 * @throws {ConfigError} if env vars fail Zod validation
 */
export function getConfig(): Readonly<AofConfig> {
  if (cached) return cached;

  const input = readEnvInput();
  const result = AofConfigSchema.safeParse(input);

  if (!result.success) {
    throw new ConfigError(result.error.issues);
  }

  // Resolve ~ in path fields
  const config = result.data;
  config.core.dataDir = normalizePath(config.core.dataDir);
  if (config.core.vaultRoot) {
    config.core.vaultRoot = normalizePath(config.core.vaultRoot);
  }
  config.openclaw.stateDir = normalizePath(config.openclaw.stateDir);

  cached = deepFreeze(config) as Readonly<AofConfig>;
  warnUnknownVars();
  return cached;
}

/**
 * Reset the config cache.
 *
 * Without arguments: clears cache so next getConfig() re-reads env.
 * With overrides: creates a new config from defaults deep-merged with
 * overrides (does NOT read process.env). For test isolation.
 */
export function resetConfig(
  overrides?: Partial<{
    [K in keyof AofConfig]: Partial<AofConfig[K]>;
  }>,
): void {
  cached = null;

  if (overrides) {
    // Parse defaults (empty input = all defaults)
    const defaults = AofConfigSchema.parse({});
    // Resolve ~ in default paths
    defaults.core.dataDir = normalizePath(defaults.core.dataDir);
    defaults.openclaw.stateDir = normalizePath(defaults.openclaw.stateDir);

    const merged = deepMerge(
      defaults as unknown as Record<string, unknown>,
      overrides as unknown as Record<string, unknown>,
    ) as AofConfig;
    cached = deepFreeze(merged) as Readonly<AofConfig>;
  }
}
