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

  /**
   * Config-reload policy. Tells OpenClaw which AOF config-key prefixes
   * mean what when the gateway sees a config change (handled by
   * `~/Projects/openclaw/src/gateway/config-reload-plan.ts` —
   * `pluginReloadRules` aggregates each plugin's `restartPrefixes` /
   * `hotPrefixes` / `noopPrefixes` into the gateway's reload decision
   * tree). Without a `reload` block, OpenClaw warns
   * (`~/Projects/openclaw/src/plugins/registry.ts` empty-prefixes
   * branch) and falls back to the conservative default: any change
   * triggers a full restart.
   *
   * Every AOF plugin-config key is consumed at register time and
   * forwarded to the daemon over IPC. Nothing is re-read at runtime,
   * so changes only take effect after a gateway restart — meaning
   * `restartPrefixes` is the correct kind for the entire AOF config
   * subtree. The legacy path AOF uses to read its own config is
   * `plugins.entries.aof.config` (see `resolvePluginConfig` in this
   * file), so that's the prefix we declare. Hot/noop prefixes are
   * intentionally empty — there is no key AOF can hot-apply today.
   */
  reload: {
    restartPrefixes: ["plugins.entries.aof.config"],
    hotPrefixes: [],
    noopPrefixes: [],
  },

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
