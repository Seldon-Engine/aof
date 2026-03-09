/**
 * Subscription Schema & Store Tests
 *
 * Tests Zod schema validation for TaskSubscription/SubscriptionsFile
 * and CRUD operations for SubscriptionStore.
 */

import { describe, it, expect } from "vitest";
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
