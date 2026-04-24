/**
 * Phase 44 — D-44-RECOVERY.
 *
 * Contract: after a daemon crash between task transition and plugin ACK,
 * the next notifier startup replays unnotified terminal transitions so the
 * wake-up is delivered exactly once. The recovery pass:
 *
 *   1. Lists tasks in a terminal status (done / cancelled / deadletter).
 *   2. For each, lists active openclaw-chat subscriptions whose
 *      `notifiedStatuses` does NOT yet contain the terminal status.
 *   3. Fires `messageTool.send` once per such subscription.
 *   4. Marks the subscription delivered on success.
 *
 * Mirrors the analog pattern in `src/dispatch/callback-delivery.ts`
 * (`retryPendingDeliveries`) — same shape, filtered on the chat-delivery
 * kind and the `notifiedStatuses` dedupe ledger (the persistent
 * no-double-fire contract per openclaw-chat-delivery.ts:62-65).
 *
 * These tests are RED today because `replayUnnotifiedTerminals` does not
 * exist yet on `OpenClawChatDeliveryNotifier` — Plan 08 lands it.
 *
 * This file is NOT env-gated: it unit-tests a specific method on a real
 * notifier against a real FilesystemTaskStore + SubscriptionStore with no
 * network or IPC. It runs under the default `npm test` sweep.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../store/task-store.js";
import { SubscriptionStore } from "../../store/subscription-store.js";
import {
  OpenClawChatDeliveryNotifier,
  OPENCLAW_CHAT_DELIVERY_KIND,
} from "../../openclaw/openclaw-chat-delivery.js";

vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }),
}));

describe("OpenClawChatDeliveryNotifier.replayUnnotifiedTerminals — Phase 44 D-44-RECOVERY", () => {
  let dir: string;
  let store: FilesystemTaskStore;
  let subStore: SubscriptionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "notifier-recovery-"));
    // FilesystemTaskStore ctor is (dataDir, opts?) — see src/store/task-store.ts.
    // `{ projectId: null }` mirrors the daemon's unscoped root store.
    store = new FilesystemTaskStore(dir, { projectId: null });
    await store.init();
    // SubscriptionStore takes a taskDirResolver callback
    // (src/store/subscription-store.ts:25); re-use the same shape as
    // OpenClawChatDeliveryNotifier.createSubscriptionStore.
    subStore = new SubscriptionStore(async (taskId) => {
      const t = await store.get(taskId);
      if (!t) throw new Error(`Task not found: ${taskId}`);
      return join(store.tasksDir, t.frontmatter.status, taskId);
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("replays wake-up when task is terminal and subscription was not yet notified", async () => {
    // store.create signature: opts = { title, createdBy, initialStatus?, ... }.
    // `initialStatus: "ready"` skips backlog; id is assigned by nextTaskId.
    const task = await store.create({
      title: "recovery probe — terminal, unnotified",
      createdBy: "test:recovery",
      initialStatus: "ready",
    });
    await store.transition(task.frontmatter.id, "in-progress", { agent: "main" });
    await store.transition(task.frontmatter.id, "review", { agent: "main" });
    await store.transition(task.frontmatter.id, "done", { agent: "main" });

    const sub = await subStore.create(
      task.frontmatter.id,
      "notify:openclaw-chat",
      "completion",
      {
        kind: OPENCLAW_CHAT_DELIVERY_KIND,
        sessionKey: "agent:main:telegram:group:42",
        target: "42",
      },
    );

    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const notifier = new OpenClawChatDeliveryNotifier({
      resolveStoreForTask: async () => store,
      messageTool: { send: sendSpy },
    });

    // Optional chain — today the method doesn't exist, so this is a no-op
    // and `sendSpy` won't be invoked. That's the RED state.
    await (notifier as unknown as {
      replayUnnotifiedTerminals?: (store: FilesystemTaskStore) => Promise<void>;
    }).replayUnnotifiedTerminals?.(store);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const final = await subStore.get(task.frontmatter.id, sub.id);
    expect(final?.status).toBe("delivered");
    expect(final?.notifiedStatuses).toContain("done");
  });

  it("does NOT replay when subscription already notified for the terminal status", async () => {
    const task = await store.create({
      title: "recovery probe — terminal, already notified",
      createdBy: "test:recovery",
      initialStatus: "ready",
    });
    await store.transition(task.frontmatter.id, "in-progress", { agent: "main" });
    await store.transition(task.frontmatter.id, "review", { agent: "main" });
    await store.transition(task.frontmatter.id, "done", { agent: "main" });
    const sub = await subStore.create(
      task.frontmatter.id,
      "notify:openclaw-chat",
      "completion",
      {
        kind: OPENCLAW_CHAT_DELIVERY_KIND,
        sessionKey: "agent:main:telegram:group:42",
        target: "42",
      },
    );
    // Simulate pre-crash "already delivered" state — the ledger already
    // records "done" as notified, so recovery must NOT fire again.
    await subStore.markStatusNotified(task.frontmatter.id, sub.id, "done");

    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const notifier = new OpenClawChatDeliveryNotifier({
      resolveStoreForTask: async () => store,
      messageTool: { send: sendSpy },
    });

    await (notifier as unknown as {
      replayUnnotifiedTerminals?: (store: FilesystemTaskStore) => Promise<void>;
    }).replayUnnotifiedTerminals?.(store);

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("does NOT replay when task is not in a terminal status", async () => {
    const task = await store.create({
      title: "recovery probe — non-terminal",
      createdBy: "test:recovery",
      initialStatus: "ready",
    });
    await store.transition(task.frontmatter.id, "in-progress", { agent: "main" });
    // Task is in-progress (non-terminal) — recovery must skip it even though
    // the subscription is active and unnotified.
    await subStore.create(
      task.frontmatter.id,
      "notify:openclaw-chat",
      "completion",
      {
        kind: OPENCLAW_CHAT_DELIVERY_KIND,
        sessionKey: "agent:main:telegram:group:42",
        target: "42",
      },
    );

    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const notifier = new OpenClawChatDeliveryNotifier({
      resolveStoreForTask: async () => store,
      messageTool: { send: sendSpy },
    });

    await (notifier as unknown as {
      replayUnnotifiedTerminals?: (store: FilesystemTaskStore) => Promise<void>;
    }).replayUnnotifiedTerminals?.(store);

    expect(sendSpy).not.toHaveBeenCalled();
  });
});
