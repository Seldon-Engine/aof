# Phase 27: Trace CLI - Research

**Researched:** 2026-03-07
**Domain:** CLI command for trace presentation (reading + formatting existing trace-N.json files)
**Confidence:** HIGH

## Summary

Phase 27 is a pure presentation layer. Phase 26 already built the complete data pipeline: session-parser extracts tool calls from OpenClaw JSONL, trace-writer produces structured trace-N.json files in `state/runs/<taskId>/`, and the TraceSchema Zod type defines the shape. This phase reads those files and formats them for human and machine consumption.

The existing CLI uses Commander with a consistent registration pattern: each command module in `src/cli/commands/` exports a `registerXCommands(program)` function. All output uses `console.log()`/`console.error()` with no terminal color library. The `createProjectStore()` helper and `store.getByPrefix()` method handle project scoping and prefix-based task lookup respectively.

For DAG workflow tasks, the per-hop trace requirement (PRES-04) maps to correlating trace-N.json files with hop IDs. The HopState schema includes `correlationId` and `agent` fields, while the WorkflowDefinition has hop `id` and `role` fields. The trace file's `taskId` is the parent task; hop identification requires reading the task's `workflow.state.hops` map and matching by attempt number / correlationId.

**Primary recommendation:** Create a single `src/cli/commands/trace.ts` module with `registerTraceCommand(program)` that reads trace files from disk, formats them in three modes (summary, debug, JSON), and handles DAG hops by cross-referencing task workflow state.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Drop "token usage" from success criteria -- Phase 26 skipped extraction because the OpenClaw JSONL format is undocumented/unstable
- Success criteria #1 revised: shows tool calls made, outcome, duration, and model info (not token usage)
- Token usage can be a future enhancement if/when the session format stabilizes

### Claude's Discretion
- Human-readable output formatting (table vs indented list vs sections, color vs plain text)
- DAG hop presentation style (flat list, nested sections, etc.)
- Edge state handling (missing traces, truncated traces, failed captures)
- Whether to add a terminal color library or stay plain text
- Command registration pattern (top-level `aof trace` or subcommand under `aof task`)

### Deferred Ideas (OUT OF SCOPE)
- Token usage display -- requires stable session JSONL format documentation; revisit when OpenClaw stabilizes the format
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PRES-01 | `aof trace <task-id>` CLI command shows trace summary (tool calls, outcome, duration, model info) | TraceSchema has all fields: toolCalls, session.durationMs, session.model, noopDetected. Command reads trace-N.json from `state/runs/<taskId>/` |
| PRES-02 | `--debug` flag shows full tool calls and reasoning text | TraceSchema distinguishes summary/debug via `meta.mode`. Debug traces have full `toolCalls[].output` and `reasoning[]` array |
| PRES-03 | `--json` flag outputs structured trace data for programmatic consumption | Direct JSON.stringify of trace file contents; already valid JSON |
| PRES-04 | DAG workflow tasks show per-hop traces with hop identification | Cross-reference task's `workflow.state.hops` (keyed by hop ID) with trace files. HopState has `correlationId` and `agent`; trace has `attemptNumber` and `sessionId` |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| commander | (already installed) | CLI argument parsing, subcommand registration | Project standard -- all CLI commands use Commander |
| zod | (already installed) | Schema validation for trace data | Project standard -- TraceSchema already defined |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:fs/promises | built-in | Read trace-N.json files from disk | Reading trace files and listing directory contents |
| node:path | built-in | Path construction for state/runs/<taskId>/ | Resolving trace file locations |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Plain text output | chalk/kleur for colors | Project has zero color dependencies; stay plain text for consistency and pipe-friendliness |
| Top-level `aof trace` | `aof task trace` subcommand | Top-level is more discoverable for operators and matches success criteria wording verbatim |
| Table library (cli-table3) | Manual column formatting | Not worth a dependency for this use case; trace output is sequential sections, not tabular |

**Installation:**
```bash
# No new dependencies needed -- everything is already in the project
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── cli/
│   └── commands/
│       └── trace.ts          # registerTraceCommand() -- CLI glue
├── trace/
│   ├── trace-reader.ts       # readTraceFiles() -- reads trace-N.json from disk
│   ├── trace-formatter.ts    # formatTraceSummary(), formatTraceDebug() -- presentation logic
│   ├── session-parser.ts     # (existing) parseSession()
│   ├── trace-writer.ts       # (existing) captureTrace()
│   └── noop-detector.ts      # (existing) detectNoop()
└── schemas/
    └── trace.ts              # (existing) TraceSchema
```

### Pattern 1: Command Registration
**What:** Follow existing `registerXCommands(program)` pattern from `src/cli/commands/*.ts`
**When to use:** Always -- this is the project convention
**Example:**
```typescript
// src/cli/commands/trace.ts
import type { Command } from "commander";

export function registerTraceCommand(program: Command): void {
  program
    .command("trace <task-id>")
    .description("Show trace of agent activity for a task")
    .option("--debug", "Show full tool call details and reasoning text")
    .option("--json", "Output structured trace data as JSON")
    .option("--project <id>", "Project ID", "_inbox")
    .action(async (taskId: string, opts) => {
      // ... implementation
    });
}
```

### Pattern 2: Separation of Reading from Formatting
**What:** Keep file I/O (trace-reader) separate from presentation (trace-formatter)
**When to use:** Always -- enables testing formatters with fixture data without filesystem mocks
**Example:**
```typescript
// trace-reader.ts reads files, returns typed data
export async function readTraceFiles(taskDir: string): Promise<TraceSchema[]> { ... }

// trace-formatter.ts produces strings from typed data
export function formatTraceSummary(traces: TraceSchema[], hopMap?: HopInfo[]): string { ... }
```

### Pattern 3: Prefix-Based Task Lookup
**What:** Use `store.getByPrefix(taskId)` to allow short task IDs (e.g., `aof trace abc123` matching `abc123xx-...`)
**When to use:** Always -- existing CLI commands use this pattern (see views.ts runbook check)
**Example:**
```typescript
const task = await store.getByPrefix(taskId);
if (!task) {
  console.error(`Task not found: ${taskId}`);
  process.exitCode = 1;
  return;
}
```

### Pattern 4: DAG Hop Correlation
**What:** For workflow tasks, map trace files to hops using attempt ordering and workflow state
**When to use:** When task has `workflow` field in frontmatter
**Example:**
```typescript
// Build hop info from task's workflow definition + state
const workflow = task.frontmatter.workflow;
if (workflow) {
  const hopInfo = workflow.definition.hops.map(hop => ({
    hopId: hop.id,
    role: hop.role,
    status: workflow.state.hops[hop.id]?.status,
    agent: workflow.state.hops[hop.id]?.agent,
    correlationId: workflow.state.hops[hop.id]?.correlationId,
  }));
  // Match traces to hops via correlationId or sequential ordering
}
```

### Anti-Patterns to Avoid
- **Re-parsing session JSONL:** The trace command reads pre-built trace-N.json files. Never re-parse the raw OpenClaw JSONL -- that is Phase 26's job.
- **Mutating trace data:** This is a read-only command. Never write to trace files or task state.
- **Assuming single trace per task:** Tasks can have multiple retries, each producing trace-N.json. Always handle arrays of traces.
- **Coupling formatting to I/O:** Keep formatters pure functions that take typed data and return strings. This makes testing trivial.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Trace file reading | Custom JSON parsing with error handling | Zod's `TraceSchema.parse()` | Schema validation catches corrupted files; typed output |
| Task lookup by prefix | Manual directory scanning | `store.getByPrefix(taskId)` | Already implemented, handles edge cases |
| Duration formatting | Manual ms-to-string conversion | Simple helper (ms -> "Xs" or "Xm Ys") | Keep it simple but consistent; don't reach for a library |
| Project resolution | Manual path construction | `createProjectStore()` from `project-utils.ts` | Handles AOF_ROOT, project scoping, store creation |

**Key insight:** Phase 26 already did the hard work. This phase reads JSON files and formats strings. Keep it simple.

## Common Pitfalls

### Pitfall 1: Missing Trace Files
**What goes wrong:** Task exists but has no trace files (pre-Phase 26 tasks, or trace capture failed)
**Why it happens:** Traces are best-effort; `captureTrace()` can fail silently
**How to avoid:** Check for empty trace directory and provide a clear message: "No traces found for task X"
**Warning signs:** `readdir()` returns no `trace-*.json` files

### Pitfall 2: Summary vs Debug Mode Mismatch
**What goes wrong:** Operator uses `--debug` flag but trace was captured in summary mode (truncated inputs, no outputs/reasoning)
**Why it happens:** Trace capture mode is controlled by task's `metadata.debug` flag at capture time, not at display time
**How to avoid:** Check `trace.meta.mode` and inform user: "Trace was captured in summary mode. Re-run task with debug=true for full details."
**Warning signs:** `meta.mode === "summary"` when `--debug` flag is passed

### Pitfall 3: DAG Hop-to-Trace Correlation Gap
**What goes wrong:** Cannot reliably map trace-N.json to a specific hop because correlationId may not be set
**Why it happens:** HopState.correlationId is optional; older or non-DAG tasks won't have it
**How to avoid:** Use multiple signals: (1) correlationId match, (2) attempt number ordering, (3) agent match. Fall back to sequential display with attempt numbers when correlation fails.
**Warning signs:** `workflow.state.hops[hopId].correlationId` is undefined

### Pitfall 4: Large Debug Traces
**What goes wrong:** Printing a 1MB debug trace to terminal makes output unusable
**Why it happens:** Debug traces include full tool outputs which can be very large
**How to avoid:** In summary mode, show tool call names and truncated inputs. In debug mode, show full data but consider paginating or warning about size.
**Warning signs:** `meta.truncated === true` indicates the trace was already capped at 1MB

### Pitfall 5: JSON Output Must Be Machine-Parseable
**What goes wrong:** `--json` output includes human-readable decorations that break jq piping
**Why it happens:** Mixing console.log messages with JSON output
**How to avoid:** When `--json` is set, output ONLY valid JSON to stdout. Error messages go to stderr.
**Warning signs:** `echo '...' | jq .` fails on the output

## Code Examples

### Reading Trace Files from Disk
```typescript
// Source: trace-writer.ts pattern (state/runs/<taskId>/trace-N.json)
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { TraceSchema } from "../schemas/trace.js";

export async function readTraceFiles(taskDir: string): Promise<TraceSchema[]> {
  let entries: string[];
  try {
    entries = await readdir(taskDir);
  } catch {
    return []; // Directory doesn't exist
  }

  const traceFiles = entries
    .filter(f => /^trace-\d+\.json$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/trace-(\d+)/)?.[1] ?? "0");
      const numB = parseInt(b.match(/trace-(\d+)/)?.[1] ?? "0");
      return numA - numB;
    });

  const traces: TraceSchema[] = [];
  for (const file of traceFiles) {
    try {
      const raw = await readFile(join(taskDir, file), "utf-8");
      const parsed = TraceSchema.parse(JSON.parse(raw));
      traces.push(parsed);
    } catch {
      // Skip corrupted trace files
    }
  }
  return traces;
}
```

### Summary Output Format
```
Task: abc12345-6789-0abc-def0-123456789abc
Status: done

Attempt 1 (trace-1.json)
  Model: claude-sonnet-4-20250514 (anthropic)
  Duration: 45s
  Tool Calls: 12
  No-op: no
  Mode: summary

  Tools Used:
    Read        x5
    Write       x3
    Bash        x2
    Grep        x2

Attempt 2 (trace-2.json)
  Model: claude-sonnet-4-20250514 (anthropic)
  Duration: 1m 23s
  ...
```

### DAG Hop Output Format
```
Task: abc12345 (workflow: review-pipeline)
Status: done

Hop: implement (role: swe-backend) - complete
  Attempt 1 (trace-1.json)
    Model: claude-sonnet-4-20250514
    Duration: 2m 15s
    Tool Calls: 28
    Tools: Read x10, Write x8, Bash x6, Grep x4

Hop: review (role: swe-qa) - complete
  Attempt 2 (trace-2.json)
    Model: claude-sonnet-4-20250514
    Duration: 1m 05s
    Tool Calls: 15
    Tools: Read x12, Bash x3
```

### JSON Output (--json)
```typescript
// For --json: output raw trace data, one object per trace or array
// Single trace: the trace object
// Multiple traces: array of trace objects
// Errors go to stderr, valid JSON only to stdout
if (opts.json) {
  const output = traces.length === 1 ? traces[0] : traces;
  console.log(JSON.stringify(output, null, 2));
  return;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No trace visibility | trace-N.json files written per attempt | Phase 26 (2026-03-07) | Data is available but no CLI reader yet |
| Token usage in traces | Dropped from requirements | Phase 27 context discussion | Simplifies scope -- no undocumented format parsing |

**Deprecated/outdated:**
- Token usage extraction was originally in PRES-01 but explicitly dropped per user decision

## Open Questions

1. **Hop-to-trace correlation reliability**
   - What we know: HopState has optional `correlationId` and `agent` fields; traces have `attemptNumber` and `sessionId`
   - What's unclear: How reliably `correlationId` is populated in practice -- it depends on the dag-transition-handler setting it
   - Recommendation: Use correlationId when available, fall back to attempt-number sequential ordering, and display attempt number regardless so operators can cross-reference manually

2. **Multiple traces for same hop (retries within a hop)**
   - What we know: A hop can fail and be retried, producing multiple traces for the same hop
   - What's unclear: Whether attempt numbering is global (across all hops) or per-hop
   - Recommendation: Attempt numbering is global (trace-1.json, trace-2.json, etc. in the same task directory). Group by hop when possible, fall back to flat list.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (via `vitest.config.ts`) |
| Config file | `vitest.config.ts` |
| Quick run command | `npx vitest run src/trace/__tests__/ src/cli/commands/__tests__/ --reporter=verbose` |
| Full suite command | `npm test` (runs `./scripts/test-lock.sh run`) |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PRES-01 | Summary output shows tool calls, outcome, duration, model | unit | `npx vitest run src/trace/__tests__/trace-reader.test.ts src/trace/__tests__/trace-formatter.test.ts -x` | No -- Wave 0 |
| PRES-02 | Debug output shows full tool details and reasoning | unit | `npx vitest run src/trace/__tests__/trace-formatter.test.ts -x` | No -- Wave 0 |
| PRES-03 | JSON output is valid parseable JSON | unit | `npx vitest run src/trace/__tests__/trace-formatter.test.ts -x` | No -- Wave 0 |
| PRES-04 | DAG tasks show per-hop traces with hop IDs | unit | `npx vitest run src/trace/__tests__/trace-formatter.test.ts -x` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/trace/__tests__/ --reporter=verbose`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/trace/__tests__/trace-reader.test.ts` -- covers PRES-01 (reading trace files from disk)
- [ ] `src/trace/__tests__/trace-formatter.test.ts` -- covers PRES-01, PRES-02, PRES-03, PRES-04 (all formatting modes)
- [ ] `src/cli/commands/__tests__/trace.test.ts` -- covers CLI integration (command registration, option parsing, error handling)

## Sources

### Primary (HIGH confidence)
- `src/schemas/trace.ts` -- TraceSchema, ToolCallTrace, TraceMeta, TraceSession Zod schemas
- `src/trace/trace-writer.ts` -- captureTrace() shows file layout: `state/runs/<taskId>/trace-N.json`
- `src/trace/session-parser.ts` -- parseSession() shows what data is extracted
- `src/schemas/workflow-dag.ts` -- HopState (correlationId, agent), WorkflowDefinition (hop id, role)
- `src/cli/program.ts` -- command registration pattern, existing imports
- `src/cli/commands/task.ts`, `views.ts` -- registration conventions, `createProjectStore()` usage
- `src/cli/project-utils.ts` -- `createProjectStore()` helper API
- `src/recovery/run-artifacts.ts` -- `resolveTaskDir()` pattern for state/runs path resolution

### Secondary (MEDIUM confidence)
- Hop-to-trace correlation via correlationId -- confirmed in schema but runtime population not verified

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all patterns established in codebase
- Architecture: HIGH -- straightforward read-and-format with existing data layer
- Pitfalls: HIGH -- derived from actual schema analysis and codebase inspection

**Research date:** 2026-03-07
**Valid until:** 2026-04-07 (stable domain -- reading JSON files and formatting strings)
