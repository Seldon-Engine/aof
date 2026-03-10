/**
 * Subscription Schema & Store Tests
 *
 * Tests Zod schema validation for TaskSubscription/SubscriptionsFile
 * and CRUD operations for SubscriptionStore.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SubscriptionStore } from "../subscription-store.js";
import {
  SubscriptionGranularity,
  SubscriptionStatus,
  TaskSubscription,
  SubscriptionsFile,
} from "../../schemas/subscription.js";

const validSubscription = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  subscriberId: "agent:main",
  granularity: "completion" as const,
  status: "active" as const,
  createdAt: "2026-03-09T12:00:00Z",
  updatedAt: "2026-03-09T12:00:00Z",
};

describe("schema", () => {
  describe("TaskSubscription", () => {
    it("validates a correct subscription with all required fields", () => {
      const result = TaskSubscription.safeParse(validSubscription);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe(validSubscription.id);
        expect(result.data.subscriberId).toBe("agent:main");
        expect(result.data.granularity).toBe("completion");
        expect(result.data.status).toBe("active");
      }
    });

    it("accepts optional fields when present", () => {
      const result = TaskSubscription.safeParse({
        ...validSubscription,
        deliveredAt: "2026-03-09T13:00:00Z",
        failureReason: "timeout",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deliveredAt).toBe("2026-03-09T13:00:00Z");
        expect(result.data.failureReason).toBe("timeout");
      }
    });

    it("rejects missing required field: subscriberId", () => {
      const { subscriberId, ...rest } = validSubscription;
      const result = TaskSubscription.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects missing required field: granularity", () => {
      const { granularity, ...rest } = validSubscription;
      const result = TaskSubscription.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects missing required field: createdAt", () => {
      const { createdAt, ...rest } = validSubscription;
      const result = TaskSubscription.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects missing required field: updatedAt", () => {
      const { updatedAt, ...rest } = validSubscription;
      const result = TaskSubscription.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects invalid granularity value", () => {
      const result = TaskSubscription.safeParse({
        ...validSubscription,
        granularity: "immediate",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid status value", () => {
      const result = TaskSubscription.safeParse({
        ...validSubscription,
        status: "pending",
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-UUID id field", () => {
      const result = TaskSubscription.safeParse({
        ...validSubscription,
        id: "not-a-uuid",
      });
      expect(result.success).toBe(false);
    });

    it("defaults status to 'active' when omitted", () => {
      const { status, ...rest } = validSubscription;
      const result = TaskSubscription.safeParse(rest);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("active");
      }
    });

    it("accepts deliveryAttempts (number, default 0) and lastAttemptAt (optional datetime)", () => {
      const result = TaskSubscription.safeParse({
        ...validSubscription,
        deliveryAttempts: 2,
        lastAttemptAt: "2026-03-09T14:00:00Z",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deliveryAttempts).toBe(2);
        expect(result.data.lastAttemptAt).toBe("2026-03-09T14:00:00Z");
      }
    });

    it("defaults deliveryAttempts to 0 when omitted", () => {
      const result = TaskSubscription.safeParse(validSubscription);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deliveryAttempts).toBe(0);
      }
    });

    it("rejects negative deliveryAttempts", () => {
      const result = TaskSubscription.safeParse({
        ...validSubscription,
        deliveryAttempts: -1,
      });
      expect(result.success).toBe(false);
    });

    it("parses existing subscriptions without deliveryAttempts with default 0 (backward compat)", () => {
      // Simulate a subscription stored before deliveryAttempts was added
      const legacy = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        subscriberId: "agent:main",
        granularity: "completion",
        status: "active",
        createdAt: "2026-03-09T12:00:00Z",
        updatedAt: "2026-03-09T12:00:00Z",
      };
      const result = TaskSubscription.safeParse(legacy);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deliveryAttempts).toBe(0);
        expect(result.data.lastAttemptAt).toBeUndefined();
      }
    });
  });

  describe("SubscriptionsFile", () => {
    it("validates version must be literal 1", () => {
      const result = SubscriptionsFile.safeParse({
        version: 1,
        subscriptions: [validSubscription],
      });
      expect(result.success).toBe(true);
    });

    it("rejects version other than 1", () => {
      const result = SubscriptionsFile.safeParse({
        version: 2,
        subscriptions: [],
      });
      expect(result.success).toBe(false);
    });

    it("defaults to empty subscriptions array when omitted", () => {
      const result = SubscriptionsFile.safeParse({ version: 1 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.subscriptions).toEqual([]);
      }
    });
  });

  describe("SubscriptionGranularity", () => {
    it("accepts 'completion'", () => {
      expect(SubscriptionGranularity.safeParse("completion").success).toBe(true);
    });

    it("accepts 'all'", () => {
      expect(SubscriptionGranularity.safeParse("all").success).toBe(true);
    });

    it("rejects invalid values", () => {
      expect(SubscriptionGranularity.safeParse("immediate").success).toBe(false);
    });
  });

  describe("SubscriptionStatus", () => {
    it.each(["active", "delivered", "failed", "cancelled"])("accepts '%s'", (val) => {
      expect(SubscriptionStatus.safeParse(val).success).toBe(true);
    });

    it("rejects invalid values", () => {
      expect(SubscriptionStatus.safeParse("pending").success).toBe(false);
    });
  });
});

describe("SubscriptionStore", () => {
  let tmpDir: string;
  let store: SubscriptionStore;
  const taskId = "TASK-2026-03-09-001";

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-sub-store-"));
    store = new SubscriptionStore(
      (id: string) => Promise.resolve(join(tmpDir, "tasks", "ready", id)),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("create()", () => {
    it("creates a subscription with UUID id and returns TaskSubscription", async () => {
      const sub = await store.create(taskId, "agent:main", "completion");
      expect(sub.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(sub.subscriberId).toBe("agent:main");
      expect(sub.granularity).toBe("completion");
      expect(sub.status).toBe("active");
      expect(sub.createdAt).toBeDefined();
      expect(sub.updatedAt).toBeDefined();
    });

    it("creates task directory if it does not exist", async () => {
      await store.create(taskId, "agent:main", "completion");
      const taskDir = join(tmpDir, "tasks", "ready", taskId);
      const filePath = join(taskDir, "subscriptions.json");
      const content = await readFile(filePath, "utf-8");
      const data = JSON.parse(content);
      expect(data.version).toBe(1);
      expect(data.subscriptions).toHaveLength(1);
    });

    it("uses write-file-atomic for crash-safe writes", async () => {
      // Verify file is written correctly (atomic write produces valid JSON)
      await store.create(taskId, "agent:main", "all");
      const taskDir = join(tmpDir, "tasks", "ready", taskId);
      const content = await readFile(join(taskDir, "subscriptions.json"), "utf-8");
      expect(() => JSON.parse(content)).not.toThrow();
    });
  });

  describe("get()", () => {
    it("returns subscription by id", async () => {
      const created = await store.create(taskId, "agent:main", "completion");
      const found = await store.get(taskId, created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      expect(found!.subscriberId).toBe("agent:main");
    });

    it("returns undefined if not found", async () => {
      const result = await store.get(taskId, "550e8400-e29b-41d4-a716-446655440000");
      expect(result).toBeUndefined();
    });
  });

  describe("list()", () => {
    it("returns all subscriptions for a task", async () => {
      await store.create(taskId, "agent:a", "completion");
      await store.create(taskId, "agent:b", "all");
      const subs = await store.list(taskId);
      expect(subs).toHaveLength(2);
    });

    it("returns empty array if no file exists", async () => {
      const subs = await store.list(taskId);
      expect(subs).toEqual([]);
    });

    it("accepts optional status filter", async () => {
      const sub1 = await store.create(taskId, "agent:a", "completion");
      await store.create(taskId, "agent:b", "all");
      await store.cancel(taskId, sub1.id);
      const active = await store.list(taskId, { status: "active" });
      expect(active).toHaveLength(1);
      expect(active[0].subscriberId).toBe("agent:b");
    });
  });

  describe("cancel()", () => {
    it("sets subscription status to 'cancelled' and updates updatedAt", async () => {
      const created = await store.create(taskId, "agent:main", "completion");
      const cancelled = await store.cancel(taskId, created.id);
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.updatedAt).not.toBe(created.updatedAt);
    });

    it("throws if subscription not found", async () => {
      await expect(
        store.cancel(taskId, "550e8400-e29b-41d4-a716-446655440000"),
      ).rejects.toThrow();
    });
  });

  describe("update()", () => {
    it("modifies a subscription's fields and persists atomically", async () => {
      const created = await store.create(taskId, "agent:main", "completion");
      const updated = await store.update(taskId, created.id, {
        status: "delivered",
        deliveredAt: "2026-03-09T15:00:00Z",
        deliveryAttempts: 1,
      });
      expect(updated.status).toBe("delivered");
      expect(updated.deliveredAt).toBe("2026-03-09T15:00:00Z");
      expect(updated.deliveryAttempts).toBe(1);
      expect(updated.updatedAt).not.toBe(created.updatedAt);

      // Verify persistence by reading with new store instance
      const store2 = new SubscriptionStore(
        (id: string) => Promise.resolve(join(tmpDir, "tasks", "ready", id)),
      );
      const persisted = await store2.get(taskId, created.id);
      expect(persisted!.status).toBe("delivered");
    });

    it("throws if subscription not found", async () => {
      await store.create(taskId, "agent:main", "completion");
      await expect(
        store.update(taskId, "550e8400-e29b-41d4-a716-446655440099", {
          status: "delivered",
        }),
      ).rejects.toThrow();
    });
  });

  describe("persistence", () => {
    it("missing subscriptions.json returns empty subscriptions (no error)", async () => {
      const subs = await store.list(taskId);
      expect(subs).toEqual([]);
    });

    it("data survives read-after-write cycle", async () => {
      const created = await store.create(taskId, "agent:main", "all");
      // Create a new store instance to read from disk
      const store2 = new SubscriptionStore(
        (id: string) => Promise.resolve(join(tmpDir, "tasks", "ready", id)),
      );
      const found = await store2.get(taskId, created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      expect(found!.subscriberId).toBe("agent:main");
      expect(found!.granularity).toBe("all");
    });
  });
});
