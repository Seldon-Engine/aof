import { describe, it, expect, vi } from "vitest";
import { registerAofPlugin } from "../adapter.js";
import type { OpenClawApi } from "../types.js";

vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() }),
}));

describe("OpenClaw adapter", () => {
  it("registers services, tools, http routes, and events", () => {
    const services: Array<{ id: string }> = [];
    const tools: Array<{ name: string }> = [];
    const routes: Array<{ path: string }> = [];
    const events: Record<string, (...args: unknown[]) => void> = {};

    const api: OpenClawApi = {
      registerService: (def) => services.push({ id: def.id }),
      registerTool: (def) => tools.push({ name: def.name }),
      registerHttpRoute: (def) => routes.push({ path: def.path }),
      on: (event, handler) => {
        events[event] = handler;
      },
    };

    const service = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      getStatus: vi.fn(() => ({ running: false })),
      handleSessionEnd: vi.fn(),
      handleAgentEnd: vi.fn(),
      handleMessageReceived: vi.fn(),
    };

    registerAofPlugin(api, {
      dataDir: "/tmp/aof",
      service,
    });

    // Service
    expect(services).toHaveLength(1);
    expect(services[0]!.id).toBe("aof-scheduler");

    // Tools: shared registry tools + adapter-specific tools
    expect(tools.map(t => t.name)).toEqual([
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

    // HTTP routes
    expect(routes.map(r => r.path)).toEqual([
      "/aof/metrics",
      "/aof/status",
    ]);

    // Event hooks
    expect(events["session_end"]).toBeDefined();
    expect(events["before_compaction"]).toBeDefined();
    expect(events["agent_end"]).toBeDefined();
    expect(events["message_received"]).toBeDefined();

    events["session_end"]?.();
    events["agent_end"]?.({ agent: "swe-backend" });
    events["message_received"]?.({ from: "swe-backend" });

    expect(service.handleSessionEnd).toHaveBeenCalled();
    expect(service.handleAgentEnd).toHaveBeenCalled();
    expect(service.handleMessageReceived).toHaveBeenCalled();
  });
});
