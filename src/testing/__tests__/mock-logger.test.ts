/**
 * Tests for createMockLogger factory.
 */

import { describe, it, expect, vi } from "vitest";
import { createMockLogger } from "../mock-logger.js";

describe("createMockLogger", () => {
  it("returns an object with all EventLogger public methods as vi.fn()", () => {
    const logger = createMockLogger();
    const methodNames = [
      "log", "logTransition", "logLease", "logDispatch", "logAction",
      "logSystem", "logSchedulerPoll", "logContextBudget", "logContextFootprint",
      "logContextAlert", "logValidationFailed", "query",
    ] as const;

    for (const name of methodNames) {
      expect(vi.isMockFunction(logger[name]), `${name} should be a mock function`).toBe(true);
    }
  });

  it("has lastEventAt as a number property defaulting to 0", () => {
    const logger = createMockLogger();
    expect(typeof logger.lastEventAt).toBe("number");
    expect(logger.lastEventAt).toBe(0);
  });

  it("methods are callable and return resolved promises", async () => {
    const logger = createMockLogger();
    // All methods should resolve without error
    await expect(logger.log("task.created" as any, "test")).resolves.not.toThrow();
    await expect(logger.logTransition("t1", "ready", "done", "test")).resolves.not.toThrow();
    await expect(logger.logLease("lease.acquired", "t1", "agent")).resolves.not.toThrow();
    await expect(logger.logDispatch("dispatch.matched", "test")).resolves.not.toThrow();
    await expect(logger.logAction("action.started", "test", "t1")).resolves.not.toThrow();
    await expect(logger.logSystem("system.startup" as any)).resolves.not.toThrow();
    await expect(logger.logSchedulerPoll()).resolves.not.toThrow();
    await expect(logger.logContextBudget("t1", "test", { totalChars: 0, estimatedTokens: 0, status: "ok" })).resolves.not.toThrow();
    await expect(logger.logContextFootprint("a1", { totalChars: 0, estimatedTokens: 0, breakdownCount: 0 })).resolves.not.toThrow();
    await expect(logger.logContextAlert("a1", { level: "warn", currentChars: 0, threshold: 100, message: "test" })).resolves.not.toThrow();
    await expect(logger.logValidationFailed("file.md", "errors")).resolves.not.toThrow();
    await expect(logger.query()).resolves.toEqual([]);
  });
});
