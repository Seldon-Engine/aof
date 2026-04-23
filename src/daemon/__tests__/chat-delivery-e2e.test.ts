/**
 * E2E test for chat-delivery — exercises every layer from EventLogger
 * callback through real HTTP long-poll over a real Unix socket, then back
 * via real POST /v1/deliveries/{id}/result.
 *
 * Only difference vs. production: OpenClaw's `api.runtime.channel.telegram`
 * surface is a stub that captures calls. Everything else is the real code.
 *
 * What this proves that the integration test doesn't:
 *   - `DaemonIpcClient.waitForChatDelivery()` and the long-poll route wire up
 *     correctly over a real Unix-socket HTTP server (keepalive timing,
 *     JSON round-trip, Zod parse on both ends).
 *   - `POST /v1/deliveries/{id}/result` actually resolves the daemon-side
 *     awaiter — the notifier's subscription update runs on a real event loop
 *     tick after a real network round-trip, not a same-tick Promise callback.
 *   - `sendChatDelivery` correctly parses the Telegram sessionKey and routes
 *     to the stub `sendMessageTelegram` with the right `messageThreadId`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../store/task-store.js";
import { EventLogger } from "../../events/logger.js";
import { SubscriptionStore } from "../../store/subscription-store.js";
import { ChatDeliveryQueue } from "../../ipc/chat-delivery-queue.js";
import { attachIpcRoutes } from "../../ipc/server-attach.js";
import { DaemonIpcClient } from "../../openclaw/daemon-ipc-client.js";
import { OpenClawChatDeliveryNotifier, OPENCLAW_CHAT_DELIVERY_KIND } from "../../openclaw/openclaw-chat-delivery.js";
import { sendChatDelivery } from "../../openclaw/chat-message-sender.js";
import { createLogger } from "../../logging/index.js";
import type { IpcDeps } from "../../ipc/types.js";
import type { OpenClawApi } from "../../openclaw/types.js";

const log = createLogger("chat-delivery-e2e-test");

describe("chat-delivery E2E (real socket, real long-poll, real Zod)", () => {
  let tmpDir: string;
  let socketPath: string;
  let server: Server;
  let store: FilesystemTaskStore;
  let logger: EventLogger;
  let queue: ChatDeliveryQueue;
  let subStore: SubscriptionStore;
  let client: DaemonIpcClient;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-chat-delivery-e2e-"));
    socketPath = join(tmpDir, "daemon.sock");

    store = new FilesystemTaskStore(tmpDir, { projectId: null });
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
    queue = new ChatDeliveryQueue();

    subStore = new SubscriptionStore(async (taskId) => {
      const t = await store.get(taskId);
      if (!t) throw new Error(`task not found: ${taskId}`);
      return join(store.tasksDir, t.frontmatter.status, taskId);
    });

    // Wire notifier → queue (same bridge as startAofDaemon).
    const queueBackedMessageTool = {
      async send(
        target: string,
        message: string,
        ctx?: { subscriptionId: string; taskId: string; toStatus: string; delivery?: Record<string, unknown> },
      ): Promise<void> {
        const baseDelivery = (ctx?.delivery ?? {}) as Record<string, unknown>;
        const delivery: Record<string, unknown> = { ...baseDelivery, kind: "openclaw-chat" };
        const hasUsableRoute =
          (typeof baseDelivery.target === "string" && baseDelivery.target.length > 0)
          || (typeof baseDelivery.sessionKey === "string" && baseDelivery.sessionKey.length > 0);
        if (!hasUsableRoute) delivery.target = target;
        const { done } = queue.enqueueAndAwait({
          subscriptionId: ctx?.subscriptionId ?? "unknown",
          taskId: ctx?.taskId ?? "unknown",
          toStatus: ctx?.toStatus ?? "unknown",
          message,
          delivery: delivery as { kind: string } & Record<string, unknown>,
        });
        return done;
      },
    };
    const notifier = new OpenClawChatDeliveryNotifier({
      resolveStoreForTask: async (taskId) => ((await store.get(taskId)) ? store : undefined),
      messageTool: queueBackedMessageTool,
    });
    logger.addOnEvent((event) => notifier.handleEvent(event));

    // Build minimal IpcDeps — only the chat-delivery surface matters here.
    const deps: IpcDeps = {
      toolRegistry: {} as IpcDeps["toolRegistry"],
      resolveStore: async () => store,
      logger,
      service: {} as IpcDeps["service"],
      log,
      chatDeliveryQueue: queue,
      deliverChatResult: (id, result) => queue.deliverResult(id, result),
    };

    // Real HTTP server on a real Unix socket.
    server = createServer();
    attachIpcRoutes(server, deps);
    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(socketPath, resolve);
    });

    client = new DaemonIpcClient(socketPath);
  });

  afterEach(async () => {
    queue.reset();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("full round-trip: transition → long-poll → send via api.runtime → ACK → subscription delivered", async () => {
    const sessionKey = "agent:swe-architect:telegram:group:-1003844680528:topic:6";
    const task = await store.create({
      title: "E2E diagnostic",
      body: "verify chat-delivery pipeline",
      routing: { agent: "swe-pm" },
      createdBy: "test",
    });
    // Walk the status machine to "done" like a real task would.
    await store.transition(task.frontmatter.id, "ready", { agent: "swe-pm" });
    await store.transition(task.frontmatter.id, "in-progress", { agent: "swe-pm" });
    await store.transition(task.frontmatter.id, "review", { agent: "swe-pm" });
    await store.transition(task.frontmatter.id, "done", { agent: "swe-pm" });
    const sub = await subStore.create(task.frontmatter.id, "notify:openclaw-chat", "completion", {
      kind: OPENCLAW_CHAT_DELIVERY_KIND,
      sessionKey,
      sessionId: "session-e2e-1",
    });

    // Stub the unified outbound-adapter API — loadAdapter(platform) returns an
    // adapter with sendText. Captures the sendText params.
    const sendText = vi.fn(async (params: { to: string; text: string; threadId?: string | number }) => ({
      messageId: "tg-msg-1",
      chatId: params.to,
    }));
    const loadAdapter = vi.fn(async (id: string) =>
      id === "telegram" ? { sendText } : undefined,
    );
    const stubApi = {
      runtime: { channel: { outbound: { loadAdapter } } },
      on: () => {},
      registerService: () => {},
      registerTool: () => {},
    } as unknown as OpenClawApi;

    // Kick the plugin-side loop: long-poll for a delivery in parallel with
    // firing the transition event on the daemon side. This proves the long-
    // poll wakes on `enqueue` and returns a real ChatDeliveryRequest over HTTP.
    const pluginLoop = (async () => {
      const req = await client.waitForChatDelivery(5_000);
      expect(req).toBeDefined();
      // Send via the real sendChatDelivery against the stub api.runtime.
      await sendChatDelivery(stubApi, req!);
      await client.postChatDeliveryResult(req!.id, { success: true });
    })();

    // Fire the transition — notifier enqueues, daemon-side promise hangs
    // until the plugin ACKs.
    const transitionPromise = logger.logTransition(
      task.frontmatter.id,
      "review",
      "done",
      "swe-pm",
      "task_complete",
    );

    await pluginLoop;
    await transitionPromise;

    // loadAdapter("telegram") invoked, then sendText called with chatId +
    // topic threadId parsed from the sessionKey.
    expect(loadAdapter).toHaveBeenCalledWith("telegram");
    expect(sendText).toHaveBeenCalledTimes(1);
    const sendParams = sendText.mock.calls[0]![0];
    expect(sendParams.to).toBe("-1003844680528");
    expect(sendParams.text).toContain("Task complete");
    expect(sendParams.threadId).toBe("6");

    // Subscription should be marked delivered on disk.
    const reloaded = await subStore.get(task.frontmatter.id, sub.id);
    expect(reloaded?.status).toBe("delivered");
    expect(reloaded?.deliveredAt).toBeTruthy();
    expect(reloaded?.notifiedStatuses).toContain("done");
  }, 15_000);

  it("failure ACK: plugin POSTs success=false, subscription records deliveryAttempts + failureReason", async () => {
    const task = await store.create({
      title: "E2E failure path",
      body: "verify failure recording",
      routing: { agent: "swe-pm" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready", { agent: "swe-pm" });
    await store.transition(task.frontmatter.id, "in-progress", { agent: "swe-pm" });
    await store.transition(task.frontmatter.id, "review", { agent: "swe-pm" });
    await store.transition(task.frontmatter.id, "done", { agent: "swe-pm" });
    const sub = await subStore.create(task.frontmatter.id, "notify:openclaw-chat", "completion", {
      kind: OPENCLAW_CHAT_DELIVERY_KIND,
      target: "telegram:-42",
      channel: "telegram",
    });

    const pluginLoop = (async () => {
      const req = await client.waitForChatDelivery(5_000);
      expect(req).toBeDefined();
      await client.postChatDeliveryResult(req!.id, {
        success: false,
        error: { kind: "send-failed", message: "gateway 403" },
      });
    })();

    const transitionPromise = logger.logTransition(
      task.frontmatter.id,
      "review",
      "done",
      "swe-pm",
      "task_complete",
    );

    await pluginLoop;
    await transitionPromise;

    const reloaded = await subStore.get(task.frontmatter.id, sub.id);
    expect(reloaded?.deliveryAttempts).toBeGreaterThanOrEqual(1);
    expect(reloaded?.failureReason).toContain("gateway 403");
    expect(reloaded?.status).not.toBe("delivered");
  }, 15_000);
});
