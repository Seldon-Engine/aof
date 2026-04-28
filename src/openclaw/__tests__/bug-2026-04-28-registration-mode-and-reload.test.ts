/**
 * BUG-2026-04-28 (Workstream 2.5 step #2 + #3):
 *
 * Step #2 — registration-mode guard. OpenClaw's plugin registry
 * (`~/Projects/openclaw/src/plugins/registry.ts`) only attaches
 * registration handlers (`registerTool`, `registerHook`,
 * `registerService`, `registerHttpRoute`, …) when
 * `params.registrationMode === "full"`. In `setup-only` /
 * `setup-runtime` / `cli-metadata` modes, those keys are absent
 * from the api object. AOF's pre-fix `register()` called them
 * unconditionally, so any non-full load (setup wizard, CLI
 * metadata extraction, shared-token rotation) would throw
 * `TypeError: api.registerTool is not a function`.
 *
 * Fix: `registerAofPlugin` early-returns in non-full modes after
 * computing the daemon socket path, with no other side effects.
 *
 * Step #3 — `reload` policy declaration. The plugin export now
 * carries a `reload` block (`~/Projects/openclaw/src/plugins/types.ts`
 * `OpenClawPluginReloadRegistration`) telling OpenClaw which
 * config-key prefixes need a gateway restart vs. hot-reload vs.
 * no-op. Without it, OpenClaw warns about an empty reload
 * registration and falls back to the most conservative behavior.
 *
 * This test covers both — the integration is in `src/plugin.ts`
 * (reload declaration) and `src/openclaw/adapter.ts`
 * (registrationMode guard).
 */

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
    warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(),
  }),
}));

import { registerAofPlugin } from "../adapter.js";
import { stopSpawnPoller, isSpawnPollerStarted } from "../spawn-poller.js";
import { stopChatDeliveryPoller, isChatDeliveryPollerStarted } from "../chat-delivery-poller.js";
import { resetDaemonIpcClient } from "../daemon-ipc-client.js";
import aofPlugin from "../../plugin.js";
import type { OpenClawApi, OpenClawServiceDefinition, PluginRegistrationMode } from "../types.js";
import type { DaemonIpcClient } from "../daemon-ipc-client.js";
import type { InvokeToolResponse } from "../../ipc/schemas.js";

function makeMockClient(): DaemonIpcClient {
  return {
    invokeTool: vi.fn(
      async (_env: unknown): Promise<InvokeToolResponse> => ({ result: { ok: true } }),
    ),
    waitForSpawn: vi.fn(() => new Promise<undefined>(() => {})),
    waitForChatDelivery: vi.fn(() => new Promise<undefined>(() => {})),
    postSpawnResult: vi.fn(async () => undefined),
    postChatDeliveryResult: vi.fn(async () => undefined),
    postSessionEnd: vi.fn(async () => undefined),
    postAgentEnd: vi.fn(async () => undefined),
    postBeforeCompaction: vi.fn(async () => undefined),
    postMessageReceived: vi.fn(async () => undefined),
    selfCheck: vi.fn(async () => true),
    socketPath: "/tmp/fake.sock",
  } as unknown as DaemonIpcClient;
}

describe("BUG-2026-04-28 step #2 — registration-mode guard", () => {
  afterEach(() => {
    stopSpawnPoller();
    stopChatDeliveryPoller();
    resetDaemonIpcClient();
  });

  it.each<PluginRegistrationMode>(["setup-only", "setup-runtime", "cli-metadata"])(
    "registerAofPlugin no-ops when registrationMode is %s",
    (mode) => {
      const services: OpenClawServiceDefinition[] = [];
      const tools: Array<{ name: string }> = [];
      const routes: Array<{ path: string }> = [];
      const events: string[] = [];

      // Deliberately omit non-handler methods that OpenClaw strips in
      // non-full modes. The api object below mimics what
      // `~/Projects/openclaw/src/plugins/registry.ts` actually passes
      // in those modes — only the always-on shape is here. If the
      // guard works, no method on `api` is invoked except the logger.
      const api: OpenClawApi = {
        registrationMode: mode,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        // Methods below would throw if called; they're TypeError-trap
        // sentinels. Only present so the OpenClawApi shape compiles.
        registerService: ((def: OpenClawServiceDefinition) => services.push(def)) as OpenClawApi["registerService"],
        registerTool: ((tool: { name: string }) => tools.push(tool)) as unknown as OpenClawApi["registerTool"],
        registerHttpRoute: ((def: { path: string }) => routes.push(def)) as unknown as OpenClawApi["registerHttpRoute"],
        on: ((name: string) => events.push(name)) as unknown as OpenClawApi["on"],
      };

      const result = registerAofPlugin(api, {
        dataDir: "/tmp/aof",
        daemonIpcClient: makeMockClient(),
      });

      // Computed but not used — daemonSocketPath is a pure function
      // of dataDir, so we still return it for callers that need to
      // know where the socket would live.
      expect(result.mode).toBe("thin-bridge");
      expect(result.daemonSocketPath).toMatch(/daemon\.sock$/);

      // No side effects.
      expect(services).toEqual([]);
      expect(tools).toEqual([]);
      expect(routes).toEqual([]);
      expect(events).toEqual([]);
      expect(isSpawnPollerStarted()).toBe(false);
      expect(isChatDeliveryPollerStarted()).toBe(false);
      expect(api.logger?.info).toHaveBeenCalledWith(
        expect.stringContaining(`registrationMode=${mode}`),
      );
    },
  );

  it("registerAofPlugin runs full side effects when registrationMode is 'full'", () => {
    const services: OpenClawServiceDefinition[] = [];
    const tools: Array<{ name: string }> = [];

    const api: OpenClawApi = {
      registrationMode: "full",
      registerService: (def) => services.push(def),
      registerTool: ((tool: { name: string }) => tools.push(tool)) as unknown as OpenClawApi["registerTool"],
      registerHttpRoute: vi.fn(),
      on: vi.fn(),
    };

    registerAofPlugin(api, {
      dataDir: "/tmp/aof",
      daemonIpcClient: makeMockClient(),
    });

    // Pollers registered as services (Workstream 2.5 step #1).
    expect(services.map((s) => s.id).sort()).toEqual([
      "aof-chat-delivery-poller",
      "aof-spawn-poller",
    ]);
    // Tools registered.
    expect(tools.length).toBeGreaterThan(0);
  });

  it("registerAofPlugin treats undefined registrationMode as 'full' (backward compat)", () => {
    const services: OpenClawServiceDefinition[] = [];

    const api: OpenClawApi = {
      // registrationMode intentionally absent — pre-2026-04-28 OpenClaw
      // versions don't set it; AOF must keep working.
      registerService: (def) => services.push(def),
      registerTool: vi.fn(),
      registerHttpRoute: vi.fn(),
      on: vi.fn(),
    };

    registerAofPlugin(api, {
      dataDir: "/tmp/aof",
      daemonIpcClient: makeMockClient(),
    });

    expect(services.map((s) => s.id).sort()).toEqual([
      "aof-chat-delivery-poller",
      "aof-spawn-poller",
    ]);
  });
});

describe("BUG-2026-04-28 step #3 — reload policy declaration", () => {
  it("plugin export declares restart-only reload policy for the AOF config subtree", () => {
    // Cast through unknown — the local plugin export shape isn't typed
    // as OpenClawPluginDefinition (we don't pull in the openclaw dep
    // for types). Read the field directly.
    const reload = (aofPlugin as unknown as {
      reload?: {
        restartPrefixes?: string[];
        hotPrefixes?: string[];
        noopPrefixes?: string[];
      };
    }).reload;

    expect(reload).toBeDefined();
    expect(reload?.restartPrefixes).toContain("plugins.entries.aof.config");
    expect(reload?.hotPrefixes).toEqual([]);
    expect(reload?.noopPrefixes).toEqual([]);
  });
});
