import { describe, it, expect } from "vitest";
import {
  formatTraceSummary,
  formatTraceDebug,
  formatTraceJson,
  formatDuration,
  type HopInfo,
} from "../trace-formatter.js";
import type { TraceSchema } from "../../schemas/trace.js";

/** Helper to create a valid trace fixture. */
function makeTrace(
  attemptNumber: number,
  overrides?: Partial<TraceSchema>,
): TraceSchema {
  return {
    version: 1,
    taskId: "task-001",
    sessionId: `sess-${attemptNumber}`,
    attemptNumber,
    capturedAt: "2026-03-07T10:00:00Z",
    session: {
      sessionFilePath: `/tmp/session-${attemptNumber}.jsonl`,
      durationMs: 5000 * attemptNumber,
      model: "google/gemini-3.1-pro",
      provider: "openrouter",
    },
    toolCalls: [
      { name: "Read", input: '{"file_path":"/tmp/a.txt"}' },
      { name: "Read", input: '{"file_path":"/tmp/b.txt"}' },
      { name: "Write", input: '{"file_path":"/tmp/c.txt"}' },
    ],
    toolCallCount: 3,
    noopDetected: false,
    meta: {
      mode: "summary" as const,
      unknownEntries: 0,
      parseErrors: 0,
      truncated: false,
      totalEntriesParsed: 10,
    },
    ...overrides,
  };
}

describe("formatDuration", () => {
  it("formats 0ms as 0s", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("formats 5000ms as 5s", () => {
    expect(formatDuration(5000)).toBe("5s");
  });

  it("formats 65000ms as 1m 5s", () => {
    expect(formatDuration(65000)).toBe("1m 5s");
  });

  it("formats 3661000ms as 61m 1s", () => {
    expect(formatDuration(3661000)).toBe("61m 1s");
  });
});

describe("formatTraceSummary", () => {
  it("returns 'No traces found.' for empty array", () => {
    expect(formatTraceSummary("task-001", [])).toBe("No traces found.");
  });

  it("shows task ID header", () => {
    const output = formatTraceSummary("task-001", [makeTrace(1)]);
    expect(output).toContain("task-001");
  });

  it("shows model, provider, duration, tool call count, no-op flag, mode", () => {
    const output = formatTraceSummary("task-001", [makeTrace(1)]);
    expect(output).toContain("google/gemini-3.1-pro");
    expect(output).toContain("openrouter");
    expect(output).toContain("5s");
    expect(output).toContain("3"); // tool call count
    expect(output).toMatch(/[Nn]o.?[Oo]p.*[Nn]o/i); // no-op: no
    expect(output).toContain("summary"); // mode
  });

  it("shows tool usage breakdown", () => {
    const output = formatTraceSummary("task-001", [makeTrace(1)]);
    expect(output).toMatch(/Read\s+x2/);
    expect(output).toMatch(/Write\s+x1/);
  });

  it("shows per-attempt sections for multiple traces", () => {
    const output = formatTraceSummary("task-001", [
      makeTrace(1),
      makeTrace(2),
    ]);
    expect(output).toContain("Attempt 1");
    expect(output).toContain("Attempt 2");
  });

  it("shows no-op as yes when detected", () => {
    const trace = makeTrace(1, { noopDetected: true });
    const output = formatTraceSummary("task-001", [trace]);
    expect(output).toMatch(/[Nn]o.?[Oo]p.*[Yy]es/i);
  });
});

describe("formatTraceDebug", () => {
  it("returns 'No traces found.' for empty array", () => {
    expect(formatTraceDebug("task-001", [])).toBe("No traces found.");
  });

  it("includes everything from summary", () => {
    const output = formatTraceDebug("task-001", [makeTrace(1)]);
    expect(output).toContain("google/gemini-3.1-pro");
    expect(output).toContain("5s");
    expect(output).toMatch(/Read\s+x2/);
  });

  it("shows tool call details with input and output", () => {
    const trace = makeTrace(1, {
      toolCalls: [
        {
          name: "Read",
          input: '{"file_path":"/tmp/a.txt"}',
          output: "file contents here",
        },
      ],
      toolCallCount: 1,
    });
    const output = formatTraceDebug("task-001", [trace]);
    expect(output).toContain("Read");
    expect(output).toContain('{"file_path":"/tmp/a.txt"}');
    expect(output).toContain("file contents here");
  });

  it("shows '(not captured)' when tool output is missing", () => {
    const trace = makeTrace(1, {
      toolCalls: [{ name: "Read", input: '{"file_path":"/tmp/a.txt"}' }],
      toolCallCount: 1,
    });
    const output = formatTraceDebug("task-001", [trace]);
    expect(output).toContain("(not captured)");
  });

  it("shows reasoning text when present", () => {
    const trace = makeTrace(1, {
      reasoning: ["I need to read the file first.", "Now I will write output."],
    });
    const output = formatTraceDebug("task-001", [trace]);
    expect(output).toContain("I need to read the file first.");
    expect(output).toContain("Now I will write output.");
  });

  it("appends summary-mode note when meta.mode is summary", () => {
    const trace = makeTrace(1); // meta.mode defaults to "summary"
    const output = formatTraceDebug("task-001", [trace]);
    expect(output).toContain(
      "Trace captured in summary mode. Re-run task with debug=true for full details.",
    );
  });

  it("does not append summary-mode note when meta.mode is debug", () => {
    const trace = makeTrace(1, {
      meta: {
        mode: "debug" as const,
        unknownEntries: 0,
        parseErrors: 0,
        truncated: false,
        totalEntriesParsed: 10,
      },
    });
    const output = formatTraceDebug("task-001", [trace]);
    expect(output).not.toContain("Re-run task with debug=true");
  });
});

describe("formatTraceJson", () => {
  it("returns valid JSON for single trace", () => {
    const trace = makeTrace(1);
    const output = formatTraceJson([trace]);
    const parsed = JSON.parse(output);
    expect(parsed.taskId).toBe("task-001");
    expect(parsed.attemptNumber).toBe(1);
  });

  it("returns array JSON for multiple traces", () => {
    const traces = [makeTrace(1), makeTrace(2)];
    const output = formatTraceJson(traces);
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  it("is pretty-printed with 2-space indent", () => {
    const output = formatTraceJson([makeTrace(1)]);
    // Pretty-printed JSON has newlines and indentation
    expect(output).toContain("\n");
    expect(output).toContain('  "version"');
  });

  it("returns no decorative text, only valid JSON", () => {
    const output = formatTraceJson([makeTrace(1)]);
    // Should be parseable without errors
    expect(() => JSON.parse(output)).not.toThrow();
    // First char should be { or [
    expect(output.trimStart()[0]).toMatch(/[{[]/);
  });
});

describe("DAG hop grouping", () => {
  const traces = [makeTrace(1), makeTrace(2), makeTrace(3)];
  const hopMap: HopInfo[] = [
    { hopId: "hop-plan", role: "planner", traceIndices: [0] },
    { hopId: "hop-exec", role: "executor", traceIndices: [1, 2] },
  ];

  it("groups traces under hop headers in summary mode", () => {
    const output = formatTraceSummary("task-001", traces, hopMap);
    expect(output).toContain("Hop: hop-plan (role: planner)");
    expect(output).toContain("Hop: hop-exec (role: executor)");
  });

  it("groups traces under hop headers in debug mode", () => {
    const output = formatTraceDebug("task-001", traces, hopMap);
    expect(output).toContain("Hop: hop-plan (role: planner)");
    expect(output).toContain("Hop: hop-exec (role: executor)");
  });

  it("displays flat list when hopMap not provided", () => {
    const output = formatTraceSummary("task-001", traces);
    expect(output).not.toContain("Hop:");
    expect(output).toContain("Attempt 1");
    expect(output).toContain("Attempt 2");
    expect(output).toContain("Attempt 3");
  });
});
