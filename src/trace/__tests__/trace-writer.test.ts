/**
 * Trace writer tests -- verifies captureTrace() orchestration.
 *
 * Mocks: filesystem, write-file-atomic, parseSession, detectNoop, EventLogger.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { join } from "node:path";

// --- Mocks ---

// Mock node:fs/promises
vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  mkdir: vi.fn(),
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// Mock write-file-atomic
vi.mock("write-file-atomic", () => ({
  default: vi.fn(),
}));

// Mock session-parser
vi.mock("../session-parser.js", () => ({
  parseSession: vi.fn(),
}));

// Mock noop-detector
vi.mock("../noop-detector.js", () => ({
  detectNoop: vi.fn(),
}));

import { readdir, mkdir, access } from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";
import { parseSession } from "../session-parser.js";
import { detectNoop } from "../noop-detector.js";
import { captureTrace, type CaptureTraceOptions } from "../trace-writer.js";
import { TraceSchema } from "../../schemas/trace.js";
import { createMockStore, createMockLogger } from "../../testing/index.js";

// Typed mocks
const mockReaddir = readdir as unknown as Mock;
const mockMkdir = mkdir as unknown as Mock;
const mockAccess = access as unknown as Mock;
const mockWriteFileAtomic = writeFileAtomic as unknown as Mock;
const mockParseSession = parseSession as unknown as Mock;
const mockDetectNoop = detectNoop as unknown as Mock;

/** Default parsed session (successful, one tool call). */
function defaultParsedSession() {
  return {
    toolCalls: [{ name: "Write", input: '{"file_path":"/tmp/test.txt"}' }],
    toolCallCount: 1,
    model: "claude-sonnet-4-20250514",
    provider: "anthropic",
    thinkingLevel: "low",
    reasoning: undefined,
    unknownEntries: 0,
    parseErrors: 0,
    totalEntriesParsed: 5,
  };
}

/** Build default options for captureTrace. */
function defaultOpts(overrides?: Partial<CaptureTraceOptions>): CaptureTraceOptions {
  return {
    taskId: "task-001",
    sessionId: "sess-abc-123",
    agentId: "agent:coder",
    durationMs: 5000,
    store: createMockStore() as any,
    logger: createMockLogger() as any,
    debug: false,
    ...overrides,
  };
}

describe("captureTrace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no existing trace files
    mockReaddir.mockResolvedValue([]);
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFileAtomic.mockResolvedValue(undefined);
    mockAccess.mockResolvedValue(undefined);
    mockParseSession.mockResolvedValue(defaultParsedSession());
    mockDetectNoop.mockReturnValue({ noopDetected: false });
  });

  it("writes trace-1.json on first attempt", async () => {
    const opts = defaultOpts();
    const result = await captureTrace(opts);

    expect(result.success).toBe(true);
    expect(result.noopDetected).toBe(false);
    expect(result.tracePath).toMatch(/trace-1\.json$/);

    // Verify write was called
    expect(mockWriteFileAtomic).toHaveBeenCalledTimes(1);
    const writtenPath = mockWriteFileAtomic.mock.calls[0][0] as string;
    expect(writtenPath).toContain("trace-1.json");

    // Verify written JSON matches TraceSchema
    const writtenJson = JSON.parse(mockWriteFileAtomic.mock.calls[0][1] as string);
    const parsed = TraceSchema.safeParse(writtenJson);
    expect(parsed.success).toBe(true);
    expect(writtenJson.version).toBe(1);
    expect(writtenJson.taskId).toBe("task-001");
    expect(writtenJson.sessionId).toBe("sess-abc-123");
    expect(writtenJson.attemptNumber).toBe(1);
    expect(writtenJson.toolCallCount).toBe(1);
    expect(writtenJson.noopDetected).toBe(false);
    expect(writtenJson.meta.mode).toBe("summary");
  });

  it("writes trace-2.json when trace-1.json already exists", async () => {
    // Simulate existing trace-1.json
    mockReaddir.mockResolvedValue(["trace-1.json", "run.json"]);

    const opts = defaultOpts();
    const result = await captureTrace(opts);

    expect(result.success).toBe(true);
    expect(result.tracePath).toMatch(/trace-2\.json$/);
    const writtenPath = mockWriteFileAtomic.mock.calls[0][0] as string;
    expect(writtenPath).toContain("trace-2.json");
  });

  it("writes trace-3.json when trace-1.json and trace-2.json exist", async () => {
    mockReaddir.mockResolvedValue(["trace-1.json", "trace-2.json"]);

    const opts = defaultOpts();
    const result = await captureTrace(opts);

    expect(result.success).toBe(true);
    expect(result.tracePath).toMatch(/trace-3\.json$/);
  });

  it("returns success with noopDetected when zero tool calls", async () => {
    mockParseSession.mockResolvedValue({
      ...defaultParsedSession(),
      toolCalls: [],
      toolCallCount: 0,
    });
    mockDetectNoop.mockReturnValue({ noopDetected: true });

    const opts = defaultOpts();
    const result = await captureTrace(opts);

    expect(result.success).toBe(true);
    expect(result.noopDetected).toBe(true);
  });

  it("returns success:false when session file missing (does not throw)", async () => {
    // parseSession returns empty on missing file, but we detect via access check
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    mockParseSession.mockResolvedValue({
      ...defaultParsedSession(),
      toolCalls: [],
      toolCallCount: 0,
      totalEntriesParsed: 0,
    });
    mockDetectNoop.mockReturnValue({ noopDetected: false, skipped: true });

    const opts = defaultOpts();
    const result = await captureTrace(opts);

    // Session missing → still returns (doesn't throw), but success is false
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("passes debug flag through to parseSession", async () => {
    const opts = defaultOpts({ debug: true });
    await captureTrace(opts);

    expect(mockParseSession).toHaveBeenCalledWith(
      expect.any(String),
      { debug: true },
    );
  });

  it("sets meta.mode to debug when debug is true", async () => {
    const opts = defaultOpts({ debug: true });
    await captureTrace(opts);

    const writtenJson = JSON.parse(mockWriteFileAtomic.mock.calls[0][1] as string);
    expect(writtenJson.meta.mode).toBe("debug");
  });

  it("validates written JSON against TraceSchema", async () => {
    const opts = defaultOpts();
    await captureTrace(opts);

    const writtenJson = JSON.parse(mockWriteFileAtomic.mock.calls[0][1] as string);
    const result = TraceSchema.safeParse(writtenJson);
    expect(result.success).toBe(true);
  });

  describe("1MB cap", () => {
    it("truncates tool outputs when debug trace exceeds 1MB", async () => {
      // Create a large parsed session that will exceed 1MB
      const bigOutput = "x".repeat(600_000);
      mockParseSession.mockResolvedValue({
        ...defaultParsedSession(),
        toolCalls: [
          { name: "Read", input: '{"file":"a.ts"}', output: bigOutput, toolCallId: "tc1" },
          { name: "Read", input: '{"file":"b.ts"}', output: bigOutput, toolCallId: "tc2" },
        ],
        toolCallCount: 2,
      });

      const opts = defaultOpts({ debug: true });
      const result = await captureTrace(opts);

      expect(result.success).toBe(true);
      const writtenJson = JSON.parse(mockWriteFileAtomic.mock.calls[0][1] as string);
      expect(writtenJson.meta.truncated).toBe(true);
      // At least one output should be truncated to empty string
      const hasEmptyOutput = writtenJson.toolCalls.some((tc: any) => tc.output === "");
      expect(hasEmptyOutput).toBe(true);
    });
  });

  describe("event emission", () => {
    it("emits trace.captured on success", async () => {
      const logger = createMockLogger();
      const opts = defaultOpts({ logger: logger as any });
      await captureTrace(opts);

      expect(logger.log).toHaveBeenCalledWith(
        "trace.captured",
        expect.any(String),
        expect.objectContaining({
          taskId: "task-001",
          payload: expect.objectContaining({
            attemptNumber: 1,
            toolCallCount: 1,
          }),
        }),
      );
    });

    it("emits trace.capture_failed on failure", async () => {
      // Force parseSession to throw
      mockAccess.mockRejectedValue(new Error("ENOENT"));
      const logger = createMockLogger();
      const opts = defaultOpts({ logger: logger as any });
      const result = await captureTrace(opts);

      expect(result.success).toBe(false);
      expect(logger.log).toHaveBeenCalledWith(
        "trace.capture_failed",
        expect.any(String),
        expect.objectContaining({
          taskId: "task-001",
        }),
      );
    });

    it("emits completion.noop_detected when noopDetected is true", async () => {
      mockParseSession.mockResolvedValue({
        ...defaultParsedSession(),
        toolCalls: [],
        toolCallCount: 0,
      });
      mockDetectNoop.mockReturnValue({ noopDetected: true });

      const logger = createMockLogger();
      const opts = defaultOpts({ logger: logger as any });
      await captureTrace(opts);

      expect(logger.log).toHaveBeenCalledWith(
        "completion.noop_detected",
        expect.any(String),
        expect.objectContaining({
          taskId: "task-001",
          payload: expect.objectContaining({
            sessionId: "sess-abc-123",
            toolCallCount: 0,
          }),
        }),
      );
    });

    it("still returns success even if event logging fails", async () => {
      const logger = createMockLogger();
      logger.log.mockRejectedValue(new Error("logging broken"));

      const opts = defaultOpts({ logger: logger as any });
      const result = await captureTrace(opts);

      // The write should still succeed
      expect(result.success).toBe(true);
    });
  });

  it("strips agent: prefix from agentId for session path", async () => {
    const opts = defaultOpts({ agentId: "agent:coder" });
    await captureTrace(opts);

    const sessionPath = mockParseSession.mock.calls[0][0] as string;
    expect(sessionPath).toContain("/coder/");
    expect(sessionPath).not.toContain("agent:");
  });

  it("creates task directory with mkdir recursive", async () => {
    const opts = defaultOpts();
    await captureTrace(opts);

    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining("state/runs/task-001"),
      { recursive: true },
    );
  });
});
