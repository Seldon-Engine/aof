import { mkdtemp, readFile } from "node:fs/promises";
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

  it("creates an openclaw-chat subscription from auto-captured session on aof_dispatch", async () => {
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
      brief: "Persist recipient as subscription",
      actor: "main",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.notificationSubscriptionId).toBeDefined();

    const task = await store.get(payload.taskId);
    expect(task).toBeDefined();
    // Delivery never leaks into task frontmatter metadata.
    expect(task?.frontmatter.metadata.notificationRecipient).toBeUndefined();

    // Subscription is co-located with the task.
    const subsPath = join(tmpDir, "tasks", task!.frontmatter.status, task!.frontmatter.id, "subscriptions.json");
    const subsFile = JSON.parse(await readFile(subsPath, "utf-8"));
    expect(subsFile.subscriptions).toHaveLength(1);
    expect(subsFile.subscriptions[0]).toMatchObject({
      granularity: "completion",
      delivery: {
        kind: "openclaw-chat",
        sessionKey: "agent:main:telegram:group:42",
        target: "telegram:-10042",
        channel: "telegram",
      },
    });
  });

  it("auto-captures sessionKey from hook ctx (real openclaw (event, ctx) signature)", async () => {
    // Regression: openclaw fires hooks as (event, ctx); session identifiers live
    // on ctx. Previously the adapter ignored ctx, so sessionKey was never captured
    // and aof_dispatch created no subscription. See: task 008, 2026-04-14.
    const tools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<any> }> = [];
    const events: Record<string, (...args: unknown[]) => void> = {};
    const tmpDir = await mkdtemp(join(tmpdir(), "aof-openclaw-adapter-ctx-"));
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
      messageTool: { send: vi.fn(async () => undefined) },
    });

    // Real openclaw call shape: event carries toolName/params/toolCallId,
    // ctx carries sessionKey/sessionId/agentId.
    events["message_received"]?.(
      { from: "user", content: "hi" },
      {
        sessionKey: "agent:main:telegram:group:42",
        channelId: "telegram",
      },
    );
    events["before_tool_call"]?.(
      { toolName: "aof_dispatch", params: {}, toolCallId: "ctx-call-1" },
      {
        toolName: "aof_dispatch",
        sessionKey: "agent:main:telegram:group:42",
        agentId: "main",
      },
    );

    const dispatchTool = tools.find((tool) => tool.name === "aof_dispatch");
    const result = await dispatchTool!.execute("ctx-call-1", {
      title: "Ctx task",
      brief: "Verify notification subscription is created from ctx-captured session",
      actor: "main",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.notificationSubscriptionId).toBeDefined();

    const task = await store.get(payload.taskId);
    const subsPath = join(tmpDir, "tasks", task!.frontmatter.status, task!.frontmatter.id, "subscriptions.json");
    const subsFile = JSON.parse(await readFile(subsPath, "utf-8"));
    expect(subsFile.subscriptions).toHaveLength(1);
    expect(subsFile.subscriptions[0].delivery).toMatchObject({
      kind: "openclaw-chat",
      sessionKey: "agent:main:telegram:group:42",
    });
  });

  it("respects an explicit notifyOnCompletion target over auto-capture (cron/CLI path)", async () => {
    const tools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<any> }> = [];
    const tmpDir = await mkdtemp(join(tmpdir(), "aof-openclaw-adapter-explicit-"));
    const store = new FilesystemTaskStore(tmpDir);
    const logger = new EventLogger(join(tmpDir, "events"));
    await store.init();

    const api: OpenClawApi = {
      registerService: vi.fn(),
      registerTool: (def) => tools.push(def as any),
      registerHttpRoute: vi.fn(),
      on: vi.fn(),
    };

    registerAofPlugin(api, {
      dataDir: tmpDir,
      store,
      logger,
      messageTool: { send: vi.fn(async () => undefined) },
    });

    const dispatchTool = tools.find((tool) => tool.name === "aof_dispatch");
    const result = await dispatchTool!.execute("cron-call-1", {
      title: "Cron task",
      brief: "Explicit chat target — no session in scope",
      actor: "cron",
      notifyOnCompletion: {
        kind: "openclaw-chat",
        target: "telegram:-98765",
      },
    });
    const payload = JSON.parse(result.content[0].text);
    const task = await store.get(payload.taskId);
    const subsPath = join(tmpDir, "tasks", task!.frontmatter.status, task!.frontmatter.id, "subscriptions.json");
    const subsFile = JSON.parse(await readFile(subsPath, "utf-8"));

    expect(subsFile.subscriptions[0].delivery).toMatchObject({
      kind: "openclaw-chat",
      target: "telegram:-98765",
    });
  });

  it("sanitizes an explicit notifyOnCompletion kind before persisting delivery", async () => {
    const tools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<any> }> = [];
    const tmpDir = await mkdtemp(join(tmpdir(), "aof-openclaw-adapter-invalid-kind-"));
    const store = new FilesystemTaskStore(tmpDir);
    const logger = new EventLogger(join(tmpDir, "events"));
    await store.init();

    const api: OpenClawApi = {
      registerService: vi.fn(),
      registerTool: (def) => tools.push(def as any),
      registerHttpRoute: vi.fn(),
      on: vi.fn(),
    };

    registerAofPlugin(api, {
      dataDir: tmpDir,
      store,
      logger,
      messageTool: { send: vi.fn(async () => undefined) },
    });

    const dispatchTool = tools.find((tool) => tool.name === "aof_dispatch");
    const result = await dispatchTool!.execute("cron-call-invalid-kind", {
      title: "Cron task with invalid kind",
      brief: "Adapter should fall back to openclaw-chat",
      actor: "cron",
      notifyOnCompletion: {
        kind: 42,
        target: "telegram:-12345",
      },
    });
    const payload = JSON.parse(result.content[0].text);
    const task = await store.get(payload.taskId);
    const subsPath = join(tmpDir, "tasks", task!.frontmatter.status, task!.frontmatter.id, "subscriptions.json");
    const subsFile = JSON.parse(await readFile(subsPath, "utf-8"));

    expect(subsFile.subscriptions[0].delivery).toMatchObject({
      kind: "openclaw-chat",
      target: "telegram:-12345",
    });
  });

  it("honours notifyOnCompletion: false to disable chat-delivery subscription", async () => {
    const tools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<any> }> = [];
    const events: Record<string, (...args: unknown[]) => void> = {};
    const tmpDir = await mkdtemp(join(tmpdir(), "aof-openclaw-adapter-optout-"));
    const store = new FilesystemTaskStore(tmpDir);
    const logger = new EventLogger(join(tmpDir, "events"));
    await store.init();

    const api: OpenClawApi = {
      registerService: vi.fn(),
      registerTool: (def) => tools.push(def as any),
      registerHttpRoute: vi.fn(),
      on: (event, handler) => { events[event] = handler; },
    };

    registerAofPlugin(api, {
      dataDir: tmpDir,
      store,
      logger,
      messageTool: { send: vi.fn(async () => undefined) },
    });

    events["message_received"]?.({ sessionKey: "s", target: "t", channel: "c" });
    events["before_tool_call"]?.({ name: "aof_dispatch", id: "tc-optout", sessionKey: "s" });

    const dispatchTool = tools.find((tool) => tool.name === "aof_dispatch");
    const result = await dispatchTool!.execute("tc-optout", {
      title: "Opted-out task",
      brief: "Should not produce any subscription",
      actor: "main",
      notifyOnCompletion: false,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.notificationSubscriptionId).toBeUndefined();
  });

  it("registers policy-engine and chat-delivery callbacks in plugin mode", async () => {
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

    // engine + chat delivery = 2
    expect(addOnEventSpy).toHaveBeenCalledTimes(2);
  });

  it("registers only the policy-engine callback when no messageTool is provided", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "aof-openclaw-callbacks-nochat-"));
    const logger = new EventLogger(join(tmpDir, "events"));
    const addOnEventSpy = vi.spyOn(logger, "addOnEvent");

    const api: OpenClawApi = {
      registerService: vi.fn(),
      registerTool: vi.fn(),
      registerHttpRoute: vi.fn(),
      on: vi.fn(),
    };

    registerAofPlugin(api, { dataDir: tmpDir, logger });

    expect(addOnEventSpy).toHaveBeenCalledTimes(1);
  });
});
