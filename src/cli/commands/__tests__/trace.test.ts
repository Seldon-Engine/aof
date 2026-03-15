/**
 * Tests for trace CLI command.
 *
 * Covers:
 * - registerTraceCommand registers "trace" command with correct options
 * - Task not found prints error to stderr, sets exitCode=1
 * - No traces found prints informative error to stderr
 * - Default mode calls formatTraceSummary
 * - --debug calls formatTraceDebug
 * - --json calls formatTraceJson and outputs to stdout
 * - --json errors go to stderr only
 * - DAG hop correlation via buildHopMap
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { createMockStore } from "../../../testing/index.js";

// Mock dependencies before importing the module under test
vi.mock("../../project-utils.js", () => ({
  createProjectStore: vi.fn(),
}));

vi.mock("../../../trace/trace-reader.js", () => ({
  readTraceFiles: vi.fn(),
}));

vi.mock("../../../trace/trace-formatter.js", () => ({
  formatTraceSummary: vi.fn(),
  formatTraceDebug: vi.fn(),
  formatTraceJson: vi.fn(),
}));

import { registerTraceCommand, buildHopMap } from "../trace.js";
import { createProjectStore } from "../../project-utils.js";
import { readTraceFiles } from "../../../trace/trace-reader.js";
import {
  formatTraceSummary,
  formatTraceDebug,
  formatTraceJson,
} from "../../../trace/trace-formatter.js";
import type { TraceSchema } from "../../../schemas/trace.js";
import type { TaskWorkflow } from "../../../schemas/workflow-dag.js";

// Helper to create a minimal trace fixture
function makeTrace(overrides: Partial<TraceSchema> = {}): TraceSchema {
  return {
    version: 1,
    taskId: "TASK-2026-01-01-001",
    sessionId: "session-abc",
    attemptNumber: 1,
    capturedAt: "2026-01-01T00:00:00Z",
    session: {
      sessionFilePath: "/tmp/session.jsonl",
      durationMs: 5000,
      model: "claude-sonnet-4-20250514",
    },
    toolCalls: [{ name: "Read", input: "file.ts" }],
    toolCallCount: 1,
    noopDetected: false,
    meta: { mode: "summary" as const, totalEntriesParsed: 10, unknownEntries: 0, parseErrors: 0, truncated: false },
    ...overrides,
  };
}

describe("registerTraceCommand", () => {
  it("registers a trace command on the program", () => {
    const program = new Command();
    program.option("--root <path>", "AOF root", "/tmp/aof");
    registerTraceCommand(program);

    const traceCmd = program.commands.find((c) => c.name() === "trace");
    expect(traceCmd).toBeDefined();
    expect(traceCmd!.description()).toContain("trace");
  });
});

describe("trace command action", () => {
  let program: Command;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: number | undefined;

  beforeEach(() => {
    program = new Command();
    program.option("--root <path>", "AOF root", "/tmp/aof");
    program.exitOverride(); // Prevent actual exit
    registerTraceCommand(program);

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    originalExitCode = process.exitCode as number | undefined;
    process.exitCode = undefined;

    // Set mock return values fresh each test
    vi.mocked(formatTraceSummary).mockReturnValue("summary output");
    vi.mocked(formatTraceDebug).mockReturnValue("debug output");
    vi.mocked(formatTraceJson).mockReturnValue('{"json":"output"}');
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("prints error when task not found", async () => {
    const mockStore = createMockStore();
    mockStore.getByPrefix.mockResolvedValue(undefined);
    vi.mocked(createProjectStore).mockResolvedValue({
      store: mockStore,
      projectRoot: "/tmp/project",
      vaultRoot: "/tmp/aof",
    });

    await program.parseAsync(["node", "aof", "trace", "abc123"]);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Task not found: abc123"),
    );
    expect(process.exitCode).toBe(1);
  });

  it("prints error when no traces found", async () => {
    const mockStore = createMockStore();
    mockStore.getByPrefix.mockResolvedValue({
      frontmatter: { id: "TASK-2026-01-01-001" },
    } as any);
    vi.mocked(createProjectStore).mockResolvedValue({
      store: mockStore,
      projectRoot: "/tmp/project",
      vaultRoot: "/tmp/aof",
    });
    vi.mocked(readTraceFiles).mockResolvedValue([]);

    await program.parseAsync(["node", "aof", "trace", "TASK-2026"]);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("No traces found"),
    );
    expect(process.exitCode).toBe(1);
  });

  it("calls formatTraceSummary by default", async () => {
    const trace = makeTrace();
    const mockStore = createMockStore();
    mockStore.getByPrefix.mockResolvedValue({
      frontmatter: { id: "TASK-2026-01-01-001" },
    } as any);
    vi.mocked(createProjectStore).mockResolvedValue({
      store: mockStore,
      projectRoot: "/tmp/project",
      vaultRoot: "/tmp/aof",
    });
    vi.mocked(readTraceFiles).mockResolvedValue([trace]);

    await program.parseAsync(["node", "aof", "trace", "TASK-2026"]);

    expect(formatTraceSummary).toHaveBeenCalledWith(
      "TASK-2026-01-01-001",
      [trace],
      undefined,
    );
    expect(consoleLogSpy).toHaveBeenCalledWith("summary output");
  });

  it("calls formatTraceDebug with --debug flag", async () => {
    const trace = makeTrace();
    const mockStore = createMockStore();
    mockStore.getByPrefix.mockResolvedValue({
      frontmatter: { id: "TASK-2026-01-01-001" },
    } as any);
    vi.mocked(createProjectStore).mockResolvedValue({
      store: mockStore,
      projectRoot: "/tmp/project",
      vaultRoot: "/tmp/aof",
    });
    vi.mocked(readTraceFiles).mockResolvedValue([trace]);

    await program.parseAsync(["node", "aof", "trace", "TASK-2026", "--debug"]);

    expect(formatTraceDebug).toHaveBeenCalledWith(
      "TASK-2026-01-01-001",
      [trace],
      undefined,
    );
    expect(consoleLogSpy).toHaveBeenCalledWith("debug output");
  });

  it("calls formatTraceJson with --json flag", async () => {
    const trace = makeTrace();
    const mockStore = createMockStore();
    mockStore.getByPrefix.mockResolvedValue({
      frontmatter: { id: "TASK-2026-01-01-001" },
    } as any);
    vi.mocked(createProjectStore).mockResolvedValue({
      store: mockStore,
      projectRoot: "/tmp/project",
      vaultRoot: "/tmp/aof",
    });
    vi.mocked(readTraceFiles).mockResolvedValue([trace]);

    await program.parseAsync(["node", "aof", "trace", "TASK-2026", "--json"]);

    expect(formatTraceJson).toHaveBeenCalledWith([trace]);
    expect(consoleLogSpy).toHaveBeenCalledWith('{"json":"output"}');
  });

  it("sends errors to stderr in --json mode", async () => {
    const mockStore = createMockStore();
    mockStore.getByPrefix.mockResolvedValue(undefined);
    vi.mocked(createProjectStore).mockResolvedValue({
      store: mockStore,
      projectRoot: "/tmp/project",
      vaultRoot: "/tmp/aof",
    });

    await program.parseAsync(["node", "aof", "trace", "abc", "--json"]);

    expect(consoleErrorSpy).toHaveBeenCalled();
    // console.log should NOT have been called (no JSON output on error)
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("passes hopMap for workflow tasks", async () => {
    const trace1 = makeTrace({ sessionId: "corr-1", attemptNumber: 1 });
    const trace2 = makeTrace({ sessionId: "corr-2", attemptNumber: 2 });
    const workflow: TaskWorkflow = {
      definition: {
        name: "test-workflow",
        hops: [
          { id: "implement", role: "swe-backend", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
          { id: "review", role: "swe-qa", dependsOn: ["implement"], joinType: "all", autoAdvance: true, canReject: false },
        ],
      },
      state: {
        status: "complete",
        hops: {
          implement: { status: "complete", correlationId: "corr-1" },
          review: { status: "complete", correlationId: "corr-2" },
        },
      },
    };
    const mockStore = createMockStore();
    mockStore.getByPrefix.mockResolvedValue({
      frontmatter: { id: "TASK-2026-01-01-001", workflow },
    } as any);
    vi.mocked(createProjectStore).mockResolvedValue({
      store: mockStore,
      projectRoot: "/tmp/project",
      vaultRoot: "/tmp/aof",
    });
    vi.mocked(readTraceFiles).mockResolvedValue([trace1, trace2]);

    await program.parseAsync(["node", "aof", "trace", "TASK-2026"]);

    expect(formatTraceSummary).toHaveBeenCalledWith(
      "TASK-2026-01-01-001",
      [trace1, trace2],
      [
        { hopId: "implement", role: "swe-backend", traceIndices: [0] },
        { hopId: "review", role: "swe-qa", traceIndices: [1] },
      ],
    );
  });

  it("uses _inbox as default project", async () => {
    const mockStore = createMockStore();
    mockStore.getByPrefix.mockResolvedValue(undefined);
    vi.mocked(createProjectStore).mockResolvedValue({
      store: mockStore,
      projectRoot: "/tmp/project",
      vaultRoot: "/tmp/aof",
    });

    await program.parseAsync(["node", "aof", "trace", "abc"]);

    expect(createProjectStore).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "_inbox" }),
    );
  });
});

describe("buildHopMap", () => {
  it("maps traces to hops via correlationId", () => {
    const traces: TraceSchema[] = [
      makeTrace({ sessionId: "corr-A", attemptNumber: 1 }),
      makeTrace({ sessionId: "corr-B", attemptNumber: 2 }),
    ];
    const workflow: TaskWorkflow = {
      definition: {
        name: "wf",
        hops: [
          { id: "h1", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
          { id: "h2", role: "qa", dependsOn: ["h1"], joinType: "all", autoAdvance: true, canReject: false },
        ],
      },
      state: {
        status: "complete",
        hops: {
          h1: { status: "complete", correlationId: "corr-A" },
          h2: { status: "complete", correlationId: "corr-B" },
        },
      },
    };

    const result = buildHopMap(workflow, traces);
    expect(result).toEqual([
      { hopId: "h1", role: "dev", traceIndices: [0] },
      { hopId: "h2", role: "qa", traceIndices: [1] },
    ]);
  });

  it("falls back to sequential ordering when no correlationId", () => {
    const traces: TraceSchema[] = [
      makeTrace({ sessionId: "s1", attemptNumber: 1 }),
      makeTrace({ sessionId: "s2", attemptNumber: 2 }),
    ];
    const workflow: TaskWorkflow = {
      definition: {
        name: "wf",
        hops: [
          { id: "h1", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
          { id: "h2", role: "qa", dependsOn: ["h1"], joinType: "all", autoAdvance: true, canReject: false },
        ],
      },
      state: {
        status: "complete",
        hops: {
          h1: { status: "complete" },
          h2: { status: "complete" },
        },
      },
    };

    const result = buildHopMap(workflow, traces);
    expect(result).toEqual([
      { hopId: "h1", role: "dev", traceIndices: [0] },
      { hopId: "h2", role: "qa", traceIndices: [1] },
    ]);
  });

  it("handles more traces than hops (extras unassigned)", () => {
    const traces: TraceSchema[] = [
      makeTrace({ sessionId: "s1", attemptNumber: 1 }),
      makeTrace({ sessionId: "s2", attemptNumber: 2 }),
      makeTrace({ sessionId: "s3", attemptNumber: 3 }),
    ];
    const workflow: TaskWorkflow = {
      definition: {
        name: "wf",
        hops: [
          { id: "h1", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
        ],
      },
      state: {
        status: "complete",
        hops: {
          h1: { status: "complete", correlationId: "s1" },
        },
      },
    };

    const result = buildHopMap(workflow, traces);
    expect(result).toEqual([
      { hopId: "h1", role: "dev", traceIndices: [0] },
      { hopId: "unassigned", role: "unknown", traceIndices: [1, 2] },
    ]);
  });

  it("handles hops with no matching traces", () => {
    const traces: TraceSchema[] = [
      makeTrace({ sessionId: "s1", attemptNumber: 1 }),
    ];
    const workflow: TaskWorkflow = {
      definition: {
        name: "wf",
        hops: [
          { id: "h1", role: "dev", dependsOn: [], joinType: "all", autoAdvance: true, canReject: false },
          { id: "h2", role: "qa", dependsOn: ["h1"], joinType: "all", autoAdvance: true, canReject: false },
        ],
      },
      state: {
        status: "running",
        hops: {
          h1: { status: "complete", correlationId: "s1" },
          h2: { status: "pending" },
        },
      },
    };

    const result = buildHopMap(workflow, traces);
    expect(result).toEqual([
      { hopId: "h1", role: "dev", traceIndices: [0] },
      { hopId: "h2", role: "qa", traceIndices: [] },
    ]);
  });
});
