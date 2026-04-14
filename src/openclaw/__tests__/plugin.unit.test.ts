import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import plugin from "../../plugin.js";
import * as adapter from "../adapter.js";
import type { OpenClawApi } from "../types.js";

vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() }),
}));

type Registry = {
  serviceIds: string[];
  toolNames: string[];
  toolOptionals: boolean[];
  httpRoutes: string[];
  events: string[];
};

const createStrictApi = (overrides: Partial<OpenClawApi> = {}) => {
  const registry: Registry = {
    serviceIds: [],
    toolNames: [],
    toolOptionals: [],
    httpRoutes: [],
    events: [],
  };

  const api: OpenClawApi = {
    registerService: (service) => {
      const id = service.id.trim();
      registry.serviceIds.push(id);
    },
    registerTool: (tool, opts) => {
      const names = opts?.names ?? (opts?.name ? [opts.name] : []);
      if (typeof tool !== "function") names.push(tool.name);
      const normalized = names.map((name) => name.trim()).filter(Boolean);
      registry.toolNames.push(...normalized);
      registry.toolOptionals.push(opts?.optional === true);
    },
    registerHttpRoute: (params) => {
      const trimmed = params.path.trim();
      if (!trimmed) return;
      const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
      registry.httpRoutes.push(normalized);
    },
    on: (event) => {
      registry.events.push(event);
    },
    ...overrides,
  };

  return { api, registry };
};

const DEFAULT_DATA_DIR = join(homedir(), ".aof", "data");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AOF OpenClaw plugin entrypoint", () => {
  it("registers with strict OpenClaw API behavior and forwards config", () => {
    const spy = vi.spyOn(adapter, "registerAofPlugin");
    const { api, registry } = createStrictApi({
      pluginConfig: {
        dataDir: "/tmp/aof",
        pollIntervalMs: 15_000,
        defaultLeaseTtlMs: 123_000,
        dryRun: false,
      },
    });

    plugin.register(api);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      dataDir: "/tmp/aof",
      pollIntervalMs: 15_000,
      defaultLeaseTtlMs: 123_000,
      dryRun: false,
    });

    expect(registry.serviceIds).toEqual(["aof-scheduler"]);
    expect(registry.toolNames).toEqual([
      // From shared toolRegistry loop
      "aof_dispatch",
      "aof_task_update",
      "aof_task_complete",
      "aof_status_report",
      "aof_task_edit",
      "aof_task_cancel",
      "aof_task_dep_add",
      "aof_task_dep_remove",
      "aof_task_block",
      "aof_task_unblock",
      "aof_context_load",
      "aof_task_subscribe",
      "aof_task_unsubscribe",
      // Adapter-specific tools
      "aof_project_create",
      "aof_project_list",
      "aof_project_add_participant",
    ]);
    expect(registry.toolOptionals).toEqual([false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false]);
    expect(registry.httpRoutes).toEqual(["/aof/metrics", "/aof/status"]);
    expect(registry.events).toEqual(
      expect.arrayContaining([
        "session_end",
        "before_compaction",
        "agent_end",
        "message_received",
        "message_sent",
        "before_tool_call",
        "after_tool_call",
      ]),
    );
  });

  it("defaults config when missing", () => {
    const spy = vi.spyOn(adapter, "registerAofPlugin");
    const { api } = createStrictApi();

    plugin.register(api);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      dataDir: DEFAULT_DATA_DIR,
      pollIntervalMs: 30_000,
      defaultLeaseTtlMs: 300_000,
      dryRun: false,
    });
  });

  it("falls back to defaults when dataDir is blank", () => {
    const spy = vi.spyOn(adapter, "registerAofPlugin");
    const { api } = createStrictApi({
      pluginConfig: {
        dataDir: "   ",
      },
    });

    plugin.register(api);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      dataDir: DEFAULT_DATA_DIR,
    });
  });

  it("expands tilde in dataDir", () => {
    const spy = vi.spyOn(adapter, "registerAofPlugin");
    const { api } = createStrictApi({
      pluginConfig: {
        dataDir: "~/.aof/data",
      },
    });

    plugin.register(api);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      dataDir: DEFAULT_DATA_DIR,
    });
  });

  it("forwards dryRun from plugin config", () => {
    const spy = vi.spyOn(adapter, "registerAofPlugin");
    const { api } = createStrictApi({
      pluginConfig: {
        dataDir: "/tmp/aof",
        dryRun: false,
      },
    });

    plugin.register(api);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      dataDir: "/tmp/aof",
      dryRun: false,
    });
  });
});
