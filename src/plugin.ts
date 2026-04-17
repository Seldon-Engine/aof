import { join } from "node:path";
import { homedir } from "node:os";
import { registerAofPlugin } from "./openclaw/adapter.js";
import type { OpenClawApi } from "./openclaw/types.js";
import { registerMemoryModule } from "./memory/index.js";

type AofPluginConfig = {
  dataDir?: string;
  pollIntervalMs?: number;
  defaultLeaseTtlMs?: number;
  dryRun?: boolean;
};

const DEFAULT_DATA_DIR = join(homedir(), ".aof", "data");
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_LEASE_TTL_MS = 300_000;
const DEFAULT_DRY_RUN = false;

const resolvePluginConfig = (api: OpenClawApi): AofPluginConfig => {
  const pluginConfig = api.pluginConfig as AofPluginConfig | undefined;
  if (pluginConfig && typeof pluginConfig === "object") return pluginConfig;

  const legacy = (api.config as Record<string, any> | undefined)?.plugins?.entries?.aof?.config;
  if (legacy && typeof legacy === "object") return legacy as AofPluginConfig;

  return {};
};

const expandHomeDir = (value: string): string => {
  return value.replace(/^~(?=$|[\\/])/, homedir());
};

const normalizeDataDir = (value: unknown): string => {
  if (typeof value !== "string") return DEFAULT_DATA_DIR;
  const trimmed = value.trim();
  if (trimmed.length === 0) return DEFAULT_DATA_DIR;
  return expandHomeDir(trimmed);
};

const normalizeNumber = (value: unknown, fallback: number): number => {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

const normalizeBoolean = (value: unknown, fallback: boolean): boolean => {
  return typeof value === "boolean" ? value : fallback;
};

const plugin = {
  id: "aof",
  name: "AOF — Agentic Ops Fabric",
  description: "Deterministic task orchestration for multi-agent systems",

  register(api: OpenClawApi): void {
    const config = resolvePluginConfig(api);
    const dataDir = normalizeDataDir(config.dataDir);
    const pollIntervalMs = normalizeNumber(config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    const defaultLeaseTtlMs = normalizeNumber(config.defaultLeaseTtlMs, DEFAULT_LEASE_TTL_MS);
    const dryRun = normalizeBoolean(config.dryRun, DEFAULT_DRY_RUN);

    try {
      // Thin-bridge registration (Phase 43, D-02) — returns
      // { mode, daemonSocketPath } rather than the legacy AOFService instance.
      // The daemon owns the scheduler now; there is no service to start here.
      const status = registerAofPlugin(api, {
        dataDir,
        pollIntervalMs,
        defaultLeaseTtlMs,
        dryRun,
      });

      registerMemoryModule(api);

      api.logger?.info?.(
        `[AOF] Plugin loaded (${status.mode}) — dataDir=${dataDir}, dryRun=${dryRun}, socket=${status.daemonSocketPath}`,
      );
    } catch (err) {
      const message = `[AOF] Plugin registration failed: ${String(err)}`;
      api.logger?.error?.(message);
    }
  },
};;

export default plugin;
