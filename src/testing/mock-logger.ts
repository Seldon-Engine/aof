/**
 * Mock event logger factory for testing.
 *
 * Returns a typed mock of EventLogger with all public methods as vi.fn() stubs.
 * Since EventLogger is a class with private fields, we build the mock object
 * manually rather than trying to extend it.
 */

import { vi } from "vitest";
import type { EventLogger } from "../events/logger.js";

/** EventLogger mock with all public methods as vi.fn() stubs. */
export type MockEventLogger = {
  [K in keyof EventLogger]: EventLogger[K] extends (...args: infer A) => infer R
    ? ReturnType<typeof vi.fn<(...args: A) => R>>
    : EventLogger[K];
};

export function createMockLogger(): MockEventLogger {
  const logger = {
    lastEventAt: 0,

    log: vi.fn<() => Promise<any>>().mockResolvedValue({
      eventId: 0,
      type: "test",
      timestamp: new Date().toISOString(),
      actor: "test",
      payload: {},
    }),
    logTransition: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    logLease: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    logDispatch: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    logAction: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    logSystem: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    logSchedulerPoll: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    logContextBudget: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    logContextFootprint: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    logContextAlert: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    logValidationFailed: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    query: vi.fn<() => Promise<any[]>>().mockResolvedValue([]),
  } as unknown as MockEventLogger;

  return logger;
}
