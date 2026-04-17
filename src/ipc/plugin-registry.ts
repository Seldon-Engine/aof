/**
 * Implicit plugin-attach registry (D-11).
 *
 * A plugin is "registered" purely by virtue of having an active long-poll
 * against `GET /v1/spawns/wait`. There is no separate handshake; `register()`
 * is called from the long-poll route handler immediately after the connection
 * is accepted, and `res.on("close")` auto-releases the handle when the plugin
 * drops (Pitfall 2 — single cleanup path avoids listener + map leaks).
 *
 * `hasActivePlugin(pluginId?)` is consulted by the `SelectingAdapter` at
 * dispatch time to decide between the `PluginBridgeAdapter` and the
 * `StandaloneAdapter` (plugin-bridge vs standalone mode).
 *
 * D-13: `pluginId` defaults to `"openclaw"` — the only plugin shipped this
 * phase. The parameter is reserved for multi-plugin fan-out in a future phase.
 *
 * @module ipc/plugin-registry
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "../logging/index.js";

const log = createLogger("plugin-registry");

export interface PluginHandle {
  pluginId: string;
  connectedAt: number;
  release(): void;
}

export class PluginRegistry {
  private active = new Map<string, PluginHandle>();

  /**
   * Register a newly-attached plugin long-poll. Returns a handle whose
   * `release()` removes the entry. `res.on("close")` is wired automatically
   * so the registration clears on connection drop without a second cleanup
   * path (Pitfall 2).
   *
   * Types use `EventEmitter` unions rather than strict `IncomingMessage`/
   * `ServerResponse` so unit tests can supply plain EventEmitter stand-ins.
   */
  register(
    req: IncomingMessage | NodeJS.EventEmitter,
    res: ServerResponse | NodeJS.EventEmitter,
    pluginId: string = "openclaw",
  ): PluginHandle {
    const handleId = `${pluginId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const handle: PluginHandle = {
      pluginId,
      connectedAt: Date.now(),
      release: () => {
        if (this.active.has(handleId)) {
          this.active.delete(handleId);
          log.info({ pluginId }, "plugin detached");
        }
      },
    };
    this.active.set(handleId, handle);
    log.info({ pluginId }, "plugin attached");
    res.on("close", () => handle.release());
    return handle;
  }

  /** True iff at least one plugin with `pluginId` is currently attached. */
  hasActivePlugin(pluginId: string = "openclaw"): boolean {
    for (const h of this.active.values()) {
      if (h.pluginId === pluginId) return true;
    }
    return false;
  }

  /** Total number of currently-attached plugin handles (across all ids). */
  activeCount(): number {
    return this.active.size;
  }

  /** Test helper — clear every registration without firing release callbacks. */
  reset(): void {
    this.active.clear();
  }
}
