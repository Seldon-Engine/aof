import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTraceFiles } from "../trace-reader.js";
import type { TraceSchema } from "../../schemas/trace.js";

/** Helper to create a valid trace object for a given attempt number. */
function makeTrace(attemptNumber: number, overrides?: Partial<TraceSchema>): TraceSchema {
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
      { name: "Read", input: '{"file_path":"/tmp/test.txt"}' },
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
    ...overrides,
  };
}

describe("readTraceFiles", () => {
  let taskDir: string;

  beforeEach(async () => {
    taskDir = await mkdtemp(join(tmpdir(), "trace-reader-test-"));
  });

  afterEach(async () => {
    await rm(taskDir, { recursive: true, force: true });
  });

  it("returns TraceSchema[] sorted by attemptNumber when trace-N.json files exist", async () => {
    // Write trace-2 before trace-1 to test sorting
    await writeFile(join(taskDir, "trace-2.json"), JSON.stringify(makeTrace(2)));
    await writeFile(join(taskDir, "trace-1.json"), JSON.stringify(makeTrace(1)));

    const result = await readTraceFiles(taskDir);

    expect(result).toHaveLength(2);
    expect(result[0].attemptNumber).toBe(1);
    expect(result[1].attemptNumber).toBe(2);
  });

  it("returns empty array when directory does not exist", async () => {
    const result = await readTraceFiles("/tmp/nonexistent-dir-xyz-12345");
    expect(result).toEqual([]);
  });

  it("returns empty array when directory has no trace-*.json files", async () => {
    await writeFile(join(taskDir, "run.json"), "{}");
    await writeFile(join(taskDir, "run_result.json"), "{}");

    const result = await readTraceFiles(taskDir);
    expect(result).toEqual([]);
  });

  it("skips corrupted/malformed trace files silently", async () => {
    await writeFile(join(taskDir, "trace-1.json"), JSON.stringify(makeTrace(1)));
    await writeFile(join(taskDir, "trace-2.json"), "not valid json at all{{{");
    await writeFile(join(taskDir, "trace-3.json"), JSON.stringify(makeTrace(3)));

    const result = await readTraceFiles(taskDir);

    expect(result).toHaveLength(2);
    expect(result[0].attemptNumber).toBe(1);
    expect(result[1].attemptNumber).toBe(3);
  });

  it("filters to only trace-N.json pattern", async () => {
    await writeFile(join(taskDir, "trace-1.json"), JSON.stringify(makeTrace(1)));
    await writeFile(join(taskDir, "run.json"), "{}");
    await writeFile(join(taskDir, "run_result.json"), "{}");
    await writeFile(join(taskDir, "trace-summary.json"), "{}");
    await writeFile(join(taskDir, "trace-.json"), "{}");
    await writeFile(join(taskDir, "trace-abc.json"), "{}");

    const result = await readTraceFiles(taskDir);

    expect(result).toHaveLength(1);
    expect(result[0].attemptNumber).toBe(1);
  });

  it("sorts numerically, not lexicographically (trace-2 before trace-10)", async () => {
    await writeFile(join(taskDir, "trace-10.json"), JSON.stringify(makeTrace(10)));
    await writeFile(join(taskDir, "trace-2.json"), JSON.stringify(makeTrace(2)));
    await writeFile(join(taskDir, "trace-1.json"), JSON.stringify(makeTrace(1)));

    const result = await readTraceFiles(taskDir);

    expect(result).toHaveLength(3);
    expect(result[0].attemptNumber).toBe(1);
    expect(result[1].attemptNumber).toBe(2);
    expect(result[2].attemptNumber).toBe(10);
  });

  it("skips files that fail schema validation", async () => {
    await writeFile(join(taskDir, "trace-1.json"), JSON.stringify(makeTrace(1)));
    // Valid JSON but invalid schema (version: 999)
    await writeFile(join(taskDir, "trace-2.json"), JSON.stringify({ version: 999, taskId: "x" }));

    const result = await readTraceFiles(taskDir);

    expect(result).toHaveLength(1);
    expect(result[0].attemptNumber).toBe(1);
  });
});
