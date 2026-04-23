/**
 * Integration test for the full chat-delivery pipeline on the daemon side.
 *
 * Reproduces the bug the user surfaced: a task was created with a
 * `notifyOnCompletion: {kind: "openclaw-chat", sessionKey}` subscription,
 * transitioned to "done", and the subscription stayed stuck in
 * `status: "active"` with zero delivery attempts. Pre-fix, the
 * `OpenClawChatDeliveryNotifier` was defined but never wired anywhere.
 *
 * This test wires the notifier through the daemon-side `QueueBackedMessageTool`
 * bridge exactly like `startAofDaemon` does, then:
 *   1. Logs a task.transitioned event (simulates the scheduler).
 *   2. Asserts a ChatDeliveryRequest was enqueued with the correct
 *      subscriptionId + sessionKey (proving the capture half flows through).
 *   3. Simulates the plugin POSTing a success ACK.
 *   4. Asserts the subscription was marked `delivered`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { createTestHarness, type TestHarness } from "../../testing/harness.js";
import { ChatDeliveryQueue } from "../../ipc/chat-delivery-queue.js";
import { SubscriptionStore } from "../../store/subscription-store.js";
import { OpenClawChatDeliveryNotifier } from "../../openclaw/openclaw-chat-delivery.js";
import {
  OPENCLAW_CHAT_DELIVERY_KIND,
} from "../../openclaw/openclaw-chat-delivery.js";
import type { ChatDeliveryRequest } from "../../ipc/schemas.js";

describe("chat-delivery end-to-end (daemon side)", () => {
  let harness: TestHarness;
  let queue: ChatDeliveryQueue;
  let subStore: SubscriptionStore;

  beforeEach(async () => {
    harness = await createTestHarness("aof-chat-delivery-");
    queue = new ChatDeliveryQueue();

    // Wire the QueueBackedMessageTool → notifier → EventLogger chain exactly
    // like startAofDaemon does.
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
        const { done } = queue.enqueueAndAwait({
          subscriptionId: ctx?.subscriptionId ?? "unknown",
          taskId: ctx?.taskId ?? "unknown",
          toStatus: ctx?.toStatus ?? "unknown",
          message,
          delivery: {
            kind: "openclaw-chat",
            target,
            ...(ctx?.delivery ?? {}),
          },
        });
        return done;
      },
    };

    const notifier = new OpenClawChatDeliveryNotifier({
      resolveStoreForTask: async (taskId) => {
        const t = await harness.store.get(taskId);
        return t ? harness.store : undefined;
      },
      messageTool: queueBackedMessageTool,
    });

    harness.logger.addOnEvent((event) => notifier.handleEvent(event));

    subStore = new SubscriptionStore(async (taskId) => {
      const t = await harness.store.get(taskId);
      if (!t) throw new Error(`Task not found: ${taskId}`);
      return join(harness.store.tasksDir, t.frontmatter.status, taskId);
    });
  });

  afterEach(async () => {
    queue.reset();
    await harness.cleanup();
  });

  it("enqueues an openclaw-chat delivery on task.transitioned=done and marks it delivered after plugin ACK", async () => {
    // 1. Seed a task with an openclaw-chat subscription that mirrors the real
    //    bug repro: sessionKey captured from Telegram, no explicit target.
    const sessionKey = "agent:swe-architect:telegram:group:-1003844680528:topic:6";
    const task = await harness.store.create({
      title: "diagnostic",
      body: "test",
      routing: { agent: "swe-pm" },
      createdBy: "test",
    });
    await harness.store.transition(task.frontmatter.id, "ready", { agent: "swe-pm" });
    await harness.store.transition(task.frontmatter.id, "in-progress", { agent: "swe-pm" });
    await harness.store.transition(task.frontmatter.id, "review", { agent: "swe-pm" });
    await harness.store.transition(task.frontmatter.id, "done", { agent: "swe-pm" });

    const sub = await subStore.create(
      task.frontmatter.id,
      "notify:openclaw-chat",
      "completion",
      {
        kind: OPENCLAW_CHAT_DELIVERY_KIND,
        sessionKey,
        sessionId: "d4dd564a-a49e-4891-9423-423f008dae7c",
      },
    );

    // 2. Set up the enqueue listener BEFORE firing the event — the logger
    //    awaits the notifier callback, which awaits messageTool.send(), which
    //    awaits the plugin ACK. We need to observe the enqueue and ACK it
    //    before the transition promise can resolve.
    const enqueued = new Promise<ChatDeliveryRequest>((resolve) => {
      queue.once("enqueue", resolve);
    });

    // 3. Fire the transition event without awaiting — the notifier will hang
    //    waiting for the ACK we post below.
    const transitionPromise = harness.logger.logTransition(
      task.frontmatter.id,
      "review",
      "done",
      "swe-pm",
      "task_complete",
    );

    const req = await Promise.race([
      enqueued,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout waiting for enqueue")), 2_000),
      ),
    ]);

    // 4. Verify capture-half data survived onto the envelope.
    expect(req.subscriptionId).toBe(sub.id);
    expect(req.taskId).toBe(task.frontmatter.id);
    expect(req.toStatus).toBe("done");
    expect(req.delivery.sessionKey).toBe(sessionKey);
    expect(req.delivery.kind).toBe(OPENCLAW_CHAT_DELIVERY_KIND);
    expect(req.message).toContain("Task complete");

    // 5. Claim it the way the long-poll handler does, then ACK as the plugin would.
    expect(queue.tryClaim(req.id)).toBe(true);
    queue.deliverResult(req.id, { success: true });

    // The transition's logTransition() was awaiting the notifier chain —
    // let it settle now that the ACK has released messageTool.send().
    await transitionPromise;

    // 6. Subscription should now be marked delivered.
    const reloaded = await subStore.get(task.frontmatter.id, sub.id);
    expect(reloaded?.status).toBe("delivered");
    expect(reloaded?.deliveredAt).toBeTruthy();
    expect(reloaded?.notifiedStatuses).toContain("done");
  });

  it("records a delivery failure without throwing when plugin ACKs failure", async () => {
    const task = await harness.store.create({
      title: "failure path",
      body: "test",
      routing: { agent: "swe-pm" },
      createdBy: "test",
    });
    await harness.store.transition(task.frontmatter.id, "ready", { agent: "swe-pm" });
    await harness.store.transition(task.frontmatter.id, "in-progress", { agent: "swe-pm" });
    await harness.store.transition(task.frontmatter.id, "review", { agent: "swe-pm" });
    await harness.store.transition(task.frontmatter.id, "done", { agent: "swe-pm" });
    const sub = await subStore.create(
      task.frontmatter.id,
      "notify:openclaw-chat",
      "completion",
      {
        kind: OPENCLAW_CHAT_DELIVERY_KIND,
        target: "telegram:-100",
      },
    );

    const enqueued = new Promise<ChatDeliveryRequest>((resolve) => {
      queue.once("enqueue", resolve);
    });

    const transitionPromise = harness.logger.logTransition(
      task.frontmatter.id,
      "review",
      "done",
      "swe-pm",
      "task_complete",
    );

    const req = await enqueued;
    queue.tryClaim(req.id);
    queue.deliverResult(req.id, {
      success: false,
      error: { kind: "send-failed", message: "telegram 403" },
    });

    await transitionPromise;

    const reloaded = await subStore.get(task.frontmatter.id, sub.id);
    // Notifier's deliverOne catches the rejection and records a failure without throwing.
    expect(reloaded?.deliveryAttempts).toBeGreaterThanOrEqual(1);
    expect(reloaded?.failureReason).toContain("telegram 403");
    // Subscription is NOT marked delivered on failure.
    expect(reloaded?.status).not.toBe("delivered");
  });
});
