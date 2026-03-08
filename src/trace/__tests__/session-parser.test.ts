import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { parseSession } from "../session-parser.js";
import { TraceSchema, ToolCallTrace } from "../../schemas/trace.js";

const fixturesDir = join(__dirname, "../../../tests/fixtures");

describe("TraceSchema", () => {
  it("validates a well-formed trace object", () => {
    const trace = {
      version: 1,
      taskId: "task-001",
      sessionId: "sess-abc-123",
      attemptNumber: 1,
      capturedAt: "2026-03-07T10:00:00Z",
      session: {
        sessionFilePath: "/tmp/session.jsonl",
        durationMs: 5000,
        model: "google/gemini-3.1-pro",
        provider: "openrouter",
        thinkingLevel: "low",
      },
      toolCalls: [
        { name: "Write", input: '{"file_path":"/tmp/test.txt"}' },
      ],
      toolCallCount: 1,
      noopDetected: false,
      meta: {
        mode: "summary" as const,
        unknownEntries: 0,
        parseErrors: 0,
        truncated: false,
        totalEntriesParsed: 6,
      },
    };

    const result = TraceSchema.safeParse(trace);
    expect(result.success).toBe(true);
  });

  it("rejects trace with invalid version", () => {
    const trace = {
      version: 2,
      taskId: "task-001",
      sessionId: "sess-abc-123",
      attemptNumber: 1,
      capturedAt: "2026-03-07T10:00:00Z",
      session: { sessionFilePath: "/tmp/session.jsonl", durationMs: 5000 },
      toolCalls: [],
      toolCallCount: 0,
      noopDetected: false,
      meta: { mode: "summary", unknownEntries: 0, parseErrors: 0, truncated: false, totalEntriesParsed: 0 },
    };

    const result = TraceSchema.safeParse(trace);
    expect(result.success).toBe(false);
  });

  it("validates trace with debug mode and reasoning", () => {
    const trace = {
      version: 1,
      taskId: "task-002",
      sessionId: "sess-debug-456",
      attemptNumber: 1,
      capturedAt: "2026-03-07T11:00:00Z",
      session: { sessionFilePath: "/tmp/session.jsonl", durationMs: 3000 },
      toolCalls: [{ name: "Read", input: '{"file_path":"/tmp/file.ts"}', output: "file contents" }],
      toolCallCount: 1,
      reasoning: ["I should read the file first."],
      noopDetected: false,
      meta: { mode: "debug" as const, unknownEntries: 0, parseErrors: 0, truncated: false, totalEntriesParsed: 4 },
    };

    const result = TraceSchema.safeParse(trace);
    expect(result.success).toBe(true);
  });
});

describe("parseSession", () => {
  it("extracts tool calls with truncated input in summary mode", async () => {
    const filePath = join(fixturesDir, "session-basic.jsonl");
    const result = await parseSession(filePath, { debug: false });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("Write");
    expect(result.toolCalls[0].input.length).toBeLessThanOrEqual(200);
    expect(result.toolCalls[0].toolCallId).toBe("tc01");
    expect(result.toolCallCount).toBe(1);
  });

  it("extracts model, provider, and thinkingLevel from session", async () => {
    const filePath = join(fixturesDir, "session-basic.jsonl");
    const result = await parseSession(filePath, { debug: false });

    expect(result.model).toBe("google/gemini-3.1-pro");
    expect(result.provider).toBe("openrouter");
    expect(result.thinkingLevel).toBe("low");
  });

  it("excludes reasoning in summary mode", async () => {
    const filePath = join(fixturesDir, "session-basic.jsonl");
    const result = await parseSession(filePath, { debug: false });

    expect(result.reasoning).toBeUndefined();
  });

  it("includes full input and reasoning in debug mode", async () => {
    const filePath = join(fixturesDir, "session-debug.jsonl");
    const result = await parseSession(filePath, { debug: true });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("Read");
    // Debug mode: full input preserved (>200 chars)
    expect(result.toolCalls[0].input.length).toBeGreaterThan(200);
    // Debug mode: reasoning collected
    expect(result.reasoning).toBeDefined();
    expect(result.reasoning!.length).toBeGreaterThan(0);
    expect(result.reasoning![0]).toContain("complex task");
  });

  it("includes tool output in debug mode", async () => {
    const filePath = join(fixturesDir, "session-debug.jsonl");
    const result = await parseSession(filePath, { debug: true });

    expect(result.toolCalls[0].output).toBeDefined();
    expect(result.toolCalls[0].output).toContain("AuthModule");
  });

  it("excludes tool output in summary mode", async () => {
    const filePath = join(fixturesDir, "session-basic.jsonl");
    const result = await parseSession(filePath, { debug: false });

    expect(result.toolCalls[0].output).toBeUndefined();
  });

  it("handles both toolCall and tool_use content types", async () => {
    // session-basic uses toolCall, session-debug uses tool_use
    const basicResult = await parseSession(join(fixturesDir, "session-basic.jsonl"), { debug: false });
    const debugResult = await parseSession(join(fixturesDir, "session-debug.jsonl"), { debug: false });

    expect(basicResult.toolCalls).toHaveLength(1);
    expect(debugResult.toolCalls).toHaveLength(1);
  });

  it("handles malformed JSONL lines without throwing", async () => {
    // Create a temporary fixture with malformed lines
    const { writeFile, unlink } = await import("node:fs/promises");
    const tmpPath = join(fixturesDir, "session-malformed-temp.jsonl");
    const content = [
      '{"type":"session","version":3,"id":"sess-mal","timestamp":"2026-03-07T10:00:00Z","cwd":"/tmp"}',
      "this is not valid json",
      '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-03-07T10:00:01Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc1","name":"Bash","arguments":{"command":"ls"}}]}}',
    ].join("\n");

    await writeFile(tmpPath, content);
    try {
      const result = await parseSession(tmpPath, { debug: false });
      expect(result.parseErrors).toBe(1);
      expect(result.toolCalls).toHaveLength(1);
    } finally {
      await unlink(tmpPath);
    }
  });

  it("counts unknown entry types", async () => {
    const { writeFile, unlink } = await import("node:fs/promises");
    const tmpPath = join(fixturesDir, "session-unknown-temp.jsonl");
    const content = [
      '{"type":"session","version":3,"id":"sess-unk","timestamp":"2026-03-07T10:00:00Z","cwd":"/tmp"}',
      '{"type":"some_future_type","id":"ft1","data":{}}',
      '{"type":"another_new_type","id":"ft2","data":{}}',
    ].join("\n");

    await writeFile(tmpPath, content);
    try {
      const result = await parseSession(tmpPath, { debug: false });
      expect(result.unknownEntries).toBe(2);
    } finally {
      await unlink(tmpPath);
    }
  });

  it("returns empty result for missing file without throwing", async () => {
    const result = await parseSession("/nonexistent/path/session.jsonl", { debug: false });

    expect(result.toolCalls).toHaveLength(0);
    expect(result.toolCallCount).toBe(0);
    expect(result.parseErrors).toBe(0);
    expect(result.totalEntriesParsed).toBe(0);
  });

  it("truncates tool input to 200 chars in summary mode", async () => {
    const filePath = join(fixturesDir, "session-debug.jsonl");
    const result = await parseSession(filePath, { debug: false });

    // session-debug has a tool input >200 chars
    expect(result.toolCalls[0].input.length).toBeLessThanOrEqual(200);
  });

  it("tracks totalEntriesParsed correctly", async () => {
    const filePath = join(fixturesDir, "session-basic.jsonl");
    const result = await parseSession(filePath, { debug: false });

    // session-basic.jsonl has 6 lines
    expect(result.totalEntriesParsed).toBe(6);
  });

  it("matches toolResult to tool call by toolCallId in debug mode", async () => {
    const filePath = join(fixturesDir, "session-basic.jsonl");
    const result = await parseSession(filePath, { debug: true });

    expect(result.toolCalls[0].toolCallId).toBe("tc01");
    expect(result.toolCalls[0].output).toBe("File written successfully.");
  });
});
