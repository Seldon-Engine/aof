/**
 * SelectingAdapter — routes spawn requests between the primary plugin-bridge
 * adapter and a fallback (typically `StandaloneAdapter`) based on whether a
 * plugin is currently attached (D-10).
 *
 * Modes:
 *   - `plugin-bridge`: plugin-mode install. If no plugin is attached we return
 *     the D-12 `"no-plugin-attached"` sentinel — the scheduler's hold-in-ready
 *     branch (landed in 43-05) keeps the task in `ready/` without incrementing
 *     retryCount, so tasks survive a brief plugin disconnect (gateway restart).
 *   - `standalone`: daemon-only install. Falls through to the fallback adapter
 *     when no plugin is attached. If a plugin IS attached in standalone mode
 *     (e.g. user installed a plugin post-hoc), the selector prefers the
 *     primary — plugin-attached-means-plugin-used is the least-surprising rule.
 *
 * `getSessionStatus` / `forceCompleteSession` route by current plugin
 * attachment. A spawn that landed on the primary but whose plugin has since
 * disconnected will report via the fallback; for this wave we accept that
 * behaviour and treat the refinement (per-session sticky routing) as a
 * Wave 3 concern.
 *
 * @module dispatch/selecting-adapter
 */

import { createLogger } from "../logging/index.js";
import type {
  GatewayAdapter,
  TaskContext,
  SpawnResult,
  SessionStatus,
} from "./executor.js";
import type { PluginRegistry } from "../ipc/plugin-registry.js";

const log = createLogger("selecting-adapter");

export interface SelectingAdapterOpts {
  primary: GatewayAdapter;
  fallback: GatewayAdapter;
  registry: PluginRegistry;
  mode: "plugin-bridge" | "standalone";
}

export class SelectingAdapter implements GatewayAdapter {
  constructor(private readonly opts: SelectingAdapterOpts) {}

  async spawnSession(
    context: TaskContext,
    spawnOpts?: Parameters<GatewayAdapter["spawnSession"]>[1],
  ): Promise<SpawnResult> {
    if (this.opts.registry.hasActivePlugin()) {
      return this.opts.primary.spawnSession(context, spawnOpts);
    }
    if (this.opts.mode === "standalone") {
      return this.opts.fallback.spawnSession(context, spawnOpts);
    }
    // plugin-bridge mode, no plugin attached — hold-in-ready sentinel (D-12).
    log.info(
      { taskId: context.taskId, op: "hold" },
      "holding task: no-plugin-attached",
    );
    return { success: false, error: "no-plugin-attached" };
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    if (this.opts.registry.hasActivePlugin()) {
      return this.opts.primary.getSessionStatus(sessionId);
    }
    if (this.opts.mode === "standalone") {
      return this.opts.fallback.getSessionStatus(sessionId);
    }
    return { sessionId, alive: false };
  }

  async forceCompleteSession(sessionId: string): Promise<void> {
    if (this.opts.registry.hasActivePlugin()) {
      return this.opts.primary.forceCompleteSession(sessionId);
    }
    if (this.opts.mode === "standalone") {
      return this.opts.fallback.forceCompleteSession(sessionId);
    }
    // plugin-bridge mode with no plugin — nothing to do; the spawn was never
    // dispatched.
  }
}
