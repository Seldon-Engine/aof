import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { detectNoop } from "../noop-detector.js";
import { parseSession } from "../session-parser.js";

const fixturesDir = join(__dirname, "../../../tests/fixtures");

describe("detectNoop", () => {
  it("returns noopDetected: true for zero tool calls", () => {
    const result = detectNoop({ toolCallCount: 0, sessionMissing: false });
    expect(result.noopDetected).toBe(true);
    expect(result.skipped).toBeUndefined();
  });

  it("returns noopDetected: false for one or more tool calls", () => {
    const result = detectNoop({ toolCallCount: 1, sessionMissing: false });
    expect(result.noopDetected).toBe(false);
    expect(result.skipped).toBeUndefined();
  });

  it("returns noopDetected: false for many tool calls", () => {
    const result = detectNoop({ toolCallCount: 15, sessionMissing: false });
    expect(result.noopDetected).toBe(false);
  });

  it("returns skipped: true when session is missing", () => {
    const result = detectNoop({ toolCallCount: 0, sessionMissing: true });
    expect(result.noopDetected).toBe(false);
    expect(result.skipped).toBe(true);
  });

  it("detects no-op from parsed noop session fixture", async () => {
    const parsed = await parseSession(join(fixturesDir, "session-noop.jsonl"), { debug: false });
    const result = detectNoop({ toolCallCount: parsed.toolCallCount, sessionMissing: false });
    expect(result.noopDetected).toBe(true);
  });

  it("does not flag session with tool calls", async () => {
    const parsed = await parseSession(join(fixturesDir, "session-basic.jsonl"), { debug: false });
    const result = detectNoop({ toolCallCount: parsed.toolCallCount, sessionMissing: false });
    expect(result.noopDetected).toBe(false);
  });
});
