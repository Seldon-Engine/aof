# Phase 27: Trace CLI - Context

**Gathered:** 2026-03-07
**Status:** Ready for planning

<domain>
## Phase Boundary

CLI command (`aof trace <task-id>`) to inspect what any agent did on any task. Supports human-readable summary, debug detail, and JSON output modes. DAG workflow tasks show per-hop traces. Does NOT include token usage (dropped — format undocumented and unstable).

</domain>

<decisions>
## Implementation Decisions

### Token Usage
- Drop "token usage" from success criteria — Phase 26 skipped extraction because the OpenClaw JSONL format is undocumented/unstable
- Success criteria #1 revised: shows tool calls made, outcome, duration, and model info (not token usage)
- Token usage can be a future enhancement if/when the session format stabilizes

### Claude's Discretion
- Human-readable output formatting (table vs indented list vs sections, color vs plain text)
- DAG hop presentation style (flat list, nested sections, etc.)
- Edge state handling (missing traces, truncated traces, failed captures)
- Whether to add a terminal color library or stay plain text
- Command registration pattern (top-level `aof trace` or subcommand under `aof task`)

</decisions>

<specifics>
## Specific Ideas

- The core motivation is operational visibility: tasks failing silently still burn resources, operators need to see what agents actually did
- Phase 26 already built the data layer — this phase is purely about reading and presenting trace-N.json files

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/trace/session-parser.ts`: `parseSession()` — already extracts tool calls and metadata from session JSONL
- `src/trace/trace-writer.ts`: `captureTrace()` — writes trace-N.json files to `state/runs/<taskId>/`
- `src/schemas/trace.ts`: `TraceSchema` — Zod schema for validating and typing trace data
- `src/recovery/run-artifacts.ts`: `readRunResult()` — pattern for reading task artifact files
- `src/trace/noop-detector.ts`: `detectNoop()` — no-op detection data already in traces

### Established Patterns
- Commander-based CLI in `src/cli/commands/` — each command file exports a register function
- `src/cli/program.ts` — imports and registers all command modules
- No terminal color library currently in use — output is plain text
- `console.log()` / `console.error()` used for CLI output in existing commands

### Integration Points
- `src/cli/program.ts` — where new command modules are registered
- `state/runs/<taskId>/trace-N.json` — trace data files to read
- `src/schemas/trace.ts` — TypeScript types for trace data

</code_context>

<deferred>
## Deferred Ideas

- Token usage display — requires stable session JSONL format documentation; revisit when OpenClaw stabilizes the format

</deferred>

---

*Phase: 27-trace-cli*
*Context gathered: 2026-03-07*
