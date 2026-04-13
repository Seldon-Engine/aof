import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi } from "vitest";
import { registerAofPlugin } from "../adapter.js";
import type { OpenClawApi } from "../types.js";
import { FilesystemTaskStore } from "../../store/task-store.js";
import { EventLogger } from "../../events/logger.js";

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
    expect(events["message_sent"]).toBeDefined();
    expect(events["before_tool_call"]).toBeDefined();
    expect(events["after_tool_call"]).toBeDefined();

    events["session_end"]?.();
    events["agent_end"]?.({ agent: "swe-backend" });
    events["message_received"]?.({ from: "swe-backend" });

    expect(service.handleSessionEnd).toHaveBeenCalled();
    expect(service.handleAgentEnd).toHaveBeenCalled();
    expect(service.handleMessageReceived).toHaveBeenCalled();
  });

  it("persists the calling session as the notification recipient for aof_dispatch", async () => {
    const tools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<any> }> = [];
    const events: Record<string, (...args: unknown[]) => void> = {};
    const tmpDir = await mkdtemp(join(tmpdir(), "aof-openclaw-adapter-"));
    const store = new FilesystemTaskStore(tmpDir);
    const logger = new EventLogger(join(tmpDir, "events"));
    await store.init();

    const api: OpenClawApi = {
      registerService: vi.fn(),
      registerTool: (def) => tools.push(def as any),
      registerHttpRoute: vi.fn(),
      on: (event, handler) => {
        events[event] = handler;
      },
    };

    registerAofPlugin(api, {
      dataDir: tmpDir,
      store,
      logger,
      messageTool: {
        send: vi.fn(async () => undefined),
      },
    });

    events["message_received"]?.({
      sessionKey: "agent:main:telegram:group:42",
      target: "telegram:-10042",
      channel: "telegram",
    });
    events["before_tool_call"]?.({
      name: "aof_dispatch",
      id: "tool-call-1",
      sessionKey: "agent:main:telegram:group:42",
    });

    const dispatchTool = tools.find((tool) => tool.name === "aof_dispatch");
    expect(dispatchTool).toBeDefined();

    const result = await dispatchTool!.execute("tool-call-1", {
      title: "Test task",
      brief: "Persist recipient metadata",
      actor: "main",
    });
    const payload = JSON.parse(result.content[0].text);
    const task = await store.get(payload.taskId);

    expect(task?.frontmatter.metadata.notificationRecipient).toMatchObject({
      kind: "openclaw-session",
      sessionKey: "agent:main:telegram:group:42",
      replyTarget: "telegram:-10042",
      channel: "telegram",
    });
  });

  it("registers both policy-engine and recipient notifier callbacks in plugin mode", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "aof-openclaw-callbacks-"));
    const logger = new EventLogger(join(tmpDir, "events"));
    const addOnEventSpy = vi.spyOn(logger, "addOnEvent");

    const api: OpenClawApi = {
      registerService: vi.fn(),
      registerTool: vi.fn(),
      registerHttpRoute: vi.fn(),
      on: vi.fn(),
    };

    registerAofPlugin(api, {
      dataDir: tmpDir,
      logger,
      messageTool: {
        send: vi.fn(async () => undefined),
      },
    });

    expect(addOnEventSpy).toHaveBeenCalledTimes(2);
  });
});
