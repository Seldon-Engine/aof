/**
 * Phase 44 — Dispatcher wake-up E2E (RED, env-gated).
 *
 * Locks the behavioral contract that when an `aof_dispatch` call captures a
 * Telegram-shaped OpenClaw session route, the completion of the dispatched
 * child task sends a wake-up message back to the dispatching agent's
 * session. The subscription persisted on the task MUST carry both the
 * enriched `dispatcherAgentId` / `pluginId` identity fields and the
 * originating `sessionKey` — those are the Phase 44 schema-promotion
 * contract (Plan 03) and capture-enrichment contract (Plan 04).
 *
 * Today this test FAILS because:
 *   1. `mergeDispatchNotificationRecipient` does not yet populate
 *      `dispatcherAgentId` / `pluginId` on the delivery payload
 *      (Plans 03 + 04 land these).
 *   2. Depending on the tool-invocation-context TTL window, a >60min gap
 *      between capture and dispatch drops the route (Plan 05 bumps TTL).
 *
 * Wave 2 / Wave 3 lands these. Flipping the three final assertions from
 * RED to GREEN is the "done" signal for the end-to-end wake-up feature.
 *
 * Env gate: `AOF_INTEGRATION=1` — excluded from the default `npm test`
 * sweep per `vitest.config.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../src/store/task-store.js";
import { EventLogger } from "../../src/events/logger.js";
import { SubscriptionStore } from "../../src/store/subscription-store.js";
import { ChatDeliveryQueue } from "../../src/ipc/chat-delivery-queue.js";
import { attachIpcRoutes } from "../../src/ipc/server-attach.js";
import { DaemonIpcClient } from "../../src/openclaw/daemon-ipc-client.js";
import {
  OpenClawChatDeliveryNotifier,
  OPENCLAW_CHAT_DELIVERY_KIND,
} from "../../src/openclaw/openclaw-chat-delivery.js";
import { OpenClawToolInvocationContextStore } from "../../src/openclaw/tool-invocation-context.js";
import { mergeDispatchNotificationRecipient } from "../../src/openclaw/dispatch-notification.js";
import { createLogger } from "../../src/logging/index.js";
import type { IpcDeps } from "../../src/ipc/types.js";

const log = createLogger("wake-up-dispatcher-test");

const SHOULD_RUN = process.env.AOF_INTEGRATION === "1";

describe.skipIf(!SHOULD_RUN)(
  "Phase 44 — dispatcher wake-up end-to-end (D-44-GOAL, D-44-AUTOREGISTER)",
  () => {
    let tmpDir: string;
    let socketPath: string;
    let server: Server;
    let store: FilesystemTaskStore;
    let logger: EventLogger;
    let queue: ChatDeliveryQueue;
    let subscriptionStore: SubscriptionStore;
    let client: DaemonIpcClient;
    let mockSendText: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "aof-wake-up-dispatcher-"));
      socketPath = join(tmpDir, "daemon.sock");

      store = new FilesystemTaskStore(tmpDir, { projectId: null });
      await store.init();
      const eventsDir = join(tmpDir, "events");
      await mkdir(eventsDir, { recursive: true });
      logger = new EventLogger(eventsDir);
      queue = new ChatDeliveryQueue();

      subscriptionStore = new SubscriptionStore(async (taskId) => {
        const t = await store.get(taskId);
        if (!t) throw new Error(`task not found: ${taskId}`);
        return join(store.tasksDir, t.frontmatter.status, taskId);
      });

      mockSendText = vi.fn(async () => undefined);

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

    it(
      "RED: dispatcher wake-up reaches captured Telegram-shaped route end-to-end (dispatcherAgentId=main, pluginId=openclaw, to=42)",
      async () => {
        // 1. Simulate capture of an `aof_dispatch` invocation coming from a
        //    Telegram group chat. Phase-44-enriched fields (dispatcherAgentId,
        //    capturedAt, pluginId) MUST flow onto the delivery payload so the
        //    recovery pass and the subagent-fallback path can see them later.
        const invocationStore = new OpenClawToolInvocationContextStore();
        invocationStore.captureToolCall({
          name: "aof_dispatch",
          toolCallId: "tc-wake-up",
          sessionKey: "agent:main:telegram:group:42",
          replyTarget: "42",
          channel: "telegram",
          agentId: "main",
        });

        const merged = mergeDispatchNotificationRecipient(
          { notifyOnCompletion: true },
          "tc-wake-up",
          invocationStore,
        ) as { notifyOnCompletion: Record<string, unknown> };

        // store.create signature (src/store/task-store.ts:201) generates the
        // TASK-NNN id; we cannot pre-specify. `initialStatus: "ready"` skips
        // backlog so the transition chain is shorter.
        const task = await store.create({
          title: "wake-up probe",
          createdBy: "test:wake-up-dispatcher",
          initialStatus: "ready",
        });

        // Walk the status machine all the way to `done` BEFORE creating the
        // subscription or wiring the notifier. This mirrors the
        // chat-delivery-e2e harness: we use a single synthetic
        // `logger.logTransition(..., "review", "done", ...)` call below to
        // fire the notifier callback against an already-terminal task. That
        // avoids subscription-file race conditions when the task directory
        // is renamed across status dirs.
        await store.transition(task.frontmatter.id, "in-progress", { agent: "main" });
        await store.transition(task.frontmatter.id, "review", { agent: "main" });
        await store.transition(task.frontmatter.id, "done", { agent: "main" });

        const sub = await subscriptionStore.create(
          task.frontmatter.id,
          "notify:openclaw-chat",
          "completion",
          merged.notifyOnCompletion as { kind: string },
        );

        // Queue-backed shim mirroring src/daemon/daemon.ts:147-191. The
        // notifier calls `messageTool.send(target, message, ctx)` which
        // enqueues onto `queue`; plugin loop below drains.
        const queueBackedMessageTool = {
          async send(
            target: string,
            message: string,
            ctx?: {
              subscriptionId: string;
              taskId: string;
              toStatus: string;
              delivery?: Record<string, unknown>;
            },
          ): Promise<void> {
            const baseDelivery = (ctx?.delivery ?? {}) as Record<string, unknown>;
            const delivery: Record<string, unknown> = {
              ...baseDelivery,
              kind: OPENCLAW_CHAT_DELIVERY_KIND,
            };
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

        const chatNotifier = new OpenClawChatDeliveryNotifier({
          resolveStoreForTask: async () => store,
          messageTool: queueBackedMessageTool,
        });
        logger.addOnEvent((event) => chatNotifier.handleEvent(event));

        // Plugin-side shim: wait on the long-poll, parse the Telegram-shaped
        // sessionKey, invoke mockSendText with {to, text}. Stands in for the
        // real gateway → outbound-adapter hop.
        const pluginLoop = (async () => {
          const req = await client.waitForChatDelivery(5_000);
          if (!req) return;
          const sk = req.delivery.sessionKey ?? "";
          // sessionKey shape: agent:<agentId>:<platform>:<chatType>:<chatId>
          const parts = sk.split(":");
          const chatId = parts.length >= 5 ? parts[4]! : req.delivery.target ?? "";
          await mockSendText({ to: chatId, text: req.message });
          await client.postChatDeliveryResult(req.id, { success: true });
        })();

        // Fire the terminal transition event — task is already in `done`, so
        // the notifier sees it in a terminal state and proceeds to mark the
        // subscription delivered. The daemon-side promise hangs until the
        // plugin ACKs via postChatDeliveryResult.
        const transitionPromise = logger.logTransition(
          task.frontmatter.id,
          "review",
          "done",
          "main",
          "task_complete",
        );

        await pluginLoop;
        await transitionPromise;

        // --- Assertions: anchor the Phase 44 schema contract ---
        expect(mockSendText).toHaveBeenCalledTimes(1);
        const callArg = mockSendText.mock.calls[0]![0] as { to: string; text: string };
        expect(callArg.to).toBe("42");
        expect(callArg.text).toContain(task.frontmatter.id);

        const final = await subscriptionStore.get(task.frontmatter.id, sub.id);
        expect(final?.status).toBe("delivered");
        expect(final?.notifiedStatuses).toContain("done");
        // RED anchors — Plan 03 (schema) + Plan 04 (capture enrichment):
        expect((final?.delivery as Record<string, unknown>).dispatcherAgentId).toBe("main");
        expect((final?.delivery as Record<string, unknown>).pluginId).toBe("openclaw");
        expect(final?.attempts.some((a) => a.success === true)).toBe(true);
      },
      15_000,
    );
  },
);
