import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi } from "vitest";
import { FilesystemTaskStore } from "../../store/task-store.js";
import { SubscriptionStore } from "../../store/subscription-store.js";
import {
  OpenClawChatDeliveryNotifier,
  OPENCLAW_CHAT_DELIVERY_KIND,
} from "../openclaw-chat-delivery.js";
import type { BaseEvent } from "../../schemas/event.js";

vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() }),
}));

async function makeFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "aof-chat-delivery-"));
  const store = new FilesystemTaskStore(dataDir);
  await store.init();

  const task = await store.create({
    title: "Chat delivery test",
    body: "probe",
    priority: "normal",
    routing: { role: "tester" },
    createdBy: "test",
  });

  const tasksDir = store.tasksDir;
  const subStore = new SubscriptionStore(async (taskId) => {
    const t = await store.get(taskId);
    if (!t) throw new Error(`Task not found: ${taskId}`);
    return join(tasksDir, t.frontmatter.status, taskId);
  });

  return { dataDir, store, subStore, taskId: task.frontmatter.id };
}

function makeEvent(taskId: string, to: string): BaseEvent {
  return {
    eventId: 1,
    type: "task.transitioned",
    timestamp: new Date().toISOString(),
    actor: "agent:swe",
    taskId,
    payload: { from: "in-progress", to },
  };
}

describe("OpenClawChatDeliveryNotifier", () => {
  it("sends a chat message for matching chat-message subscriptions on actionable transitions", async () => {
    const { store, subStore, taskId } = await makeFixture();
    await subStore.create(taskId, "notify:openclaw-chat", "completion", {
      kind: OPENCLAW_CHAT_DELIVERY_KIND,
      target: "telegram:-42",
    });

    const send = vi.fn(async () => undefined);
    const notifier = new OpenClawChatDeliveryNotifier({
      resolveStoreForTask: async () => store,
      messageTool: { send },
    });

    await notifier.handleEvent(makeEvent(taskId, "review"));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("telegram:-42", expect.stringContaining("Task ready for review"));

    const subs = await subStore.list(taskId);
    expect(subs[0]!.notifiedStatuses).toContain("review");
    // Non-terminal status => subscription stays active.
    expect(subs[0]!.status).toBe("active");
  });

  it("dedupes per-status so two pings to the same status don't both fire", async () => {
    const { store, subStore, taskId } = await makeFixture();
    await subStore.create(taskId, "notify:openclaw-chat", "completion", {
      kind: OPENCLAW_CHAT_DELIVERY_KIND,
      target: "telegram:-42",
    });

    const send = vi.fn(async () => undefined);
    const notifier = new OpenClawChatDeliveryNotifier({
      resolveStoreForTask: async () => store,
      messageTool: { send },
    });

    await notifier.handleEvent(makeEvent(taskId, "blocked"));
    await notifier.handleEvent(makeEvent(taskId, "blocked"));

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("marks subscription delivered on terminal transition", async () => {
    const { store, subStore, taskId } = await makeFixture();
    await subStore.create(taskId, "notify:openclaw-chat", "completion", {
      kind: OPENCLAW_CHAT_DELIVERY_KIND,
      target: "telegram:-42",
    });

    const notifier = new OpenClawChatDeliveryNotifier({
      resolveStoreForTask: async () => store,
      messageTool: { send: vi.fn(async () => undefined) },
    });

    await notifier.handleEvent(makeEvent(taskId, "done"));

    const subs = await subStore.list(taskId);
    expect(subs[0]!.status).toBe("delivered");
    expect(subs[0]!.deliveredAt).toBeDefined();
  });

  it("skips subscriptions of other kinds (agent-callback is not its business)", async () => {
    const { store, subStore, taskId } = await makeFixture();
    // Agent-callback has no explicit delivery; resolveDeliveryKind returns "agent-callback" for it.
    await subStore.create(taskId, "agent:auditor", "completion");

    const send = vi.fn(async () => undefined);
    const notifier = new OpenClawChatDeliveryNotifier({
      resolveStoreForTask: async () => store,
      messageTool: { send },
    });

    await notifier.handleEvent(makeEvent(taskId, "done"));
    expect(send).not.toHaveBeenCalled();
  });

  it("falls back from target -> sessionKey -> sessionId when picking the send target", async () => {
    const { store, subStore, taskId } = await makeFixture();
    await subStore.create(taskId, "notify:openclaw-chat", "completion", {
      kind: OPENCLAW_CHAT_DELIVERY_KIND,
      sessionKey: "session:abc",
    });

    const send = vi.fn(async () => undefined);
    const notifier = new OpenClawChatDeliveryNotifier({
      resolveStoreForTask: async () => store,
      messageTool: { send },
    });

    await notifier.handleEvent(makeEvent(taskId, "done"));
    expect(send).toHaveBeenCalledWith("session:abc", expect.anything());
  });

  it("ignores non-actionable status transitions (e.g. ready)", async () => {
    const { store, subStore, taskId } = await makeFixture();
    await subStore.create(taskId, "notify:openclaw-chat", "completion", {
      kind: OPENCLAW_CHAT_DELIVERY_KIND,
      target: "telegram:-42",
    });

    const send = vi.fn(async () => undefined);
    const notifier = new OpenClawChatDeliveryNotifier({
      resolveStoreForTask: async () => store,
      messageTool: { send },
    });

    await notifier.handleEvent(makeEvent(taskId, "ready"));
    expect(send).not.toHaveBeenCalled();
  });

  it("records a delivery failure without throwing when messageTool.send rejects", async () => {
    const { store, subStore, taskId } = await makeFixture();
    await subStore.create(taskId, "notify:openclaw-chat", "completion", {
      kind: OPENCLAW_CHAT_DELIVERY_KIND,
      target: "telegram:-42",
    });

    const send = vi.fn(async () => { throw new Error("network down"); });
    const notifier = new OpenClawChatDeliveryNotifier({
      resolveStoreForTask: async () => store,
      messageTool: { send },
    });

    await expect(notifier.handleEvent(makeEvent(taskId, "done"))).resolves.toBeUndefined();

    const subs = await subStore.list(taskId);
    expect(subs[0]!.deliveryAttempts).toBe(1);
    expect(subs[0]!.failureReason).toContain("network down");
  });

  it("coexists with agent-callback subscriptions on the same task", async () => {
    const { dataDir, store, subStore, taskId } = await makeFixture();
    // Two subs on the same task: one agent-callback, one openclaw-chat.
    await subStore.create(taskId, "agent:auditor", "completion");
    await subStore.create(taskId, "notify:openclaw-chat", "completion", {
      kind: OPENCLAW_CHAT_DELIVERY_KIND,
      target: "telegram:-42",
    });

    const send = vi.fn(async () => undefined);
    const notifier = new OpenClawChatDeliveryNotifier({
      resolveStoreForTask: async () => store,
      messageTool: { send },
    });

    await notifier.handleEvent(makeEvent(taskId, "done"));

    expect(send).toHaveBeenCalledTimes(1);
    const subs = await subStore.list(taskId);
    const chatSub = subs.find((s) => s.delivery?.kind === OPENCLAW_CHAT_DELIVERY_KIND);
    const agentSub = subs.find((s) => !s.delivery);
    expect(chatSub!.status).toBe("delivered");
    expect(agentSub!.status).toBe("active"); // chat delivery leaves agent-callback sub untouched
    // Both subscriptions written to the same file, co-located with the task.
    const task = await store.get(taskId);
    const subsPath = join(dataDir, "tasks", task!.frontmatter.status, taskId, "subscriptions.json");
    const file = JSON.parse(await readFile(subsPath, "utf-8"));
    expect(file.subscriptions).toHaveLength(2);
  });
});
