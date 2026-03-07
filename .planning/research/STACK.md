# Technology Stack

**Project:** AOF v1.5 Event Tracing & Session Observability
**Researched:** 2026-03-06
**Scope:** Stack additions/changes for session transcript parsing, structured trace storage, CLI trace viewing, and completion enforcement

## Executive Assessment

**No new runtime dependencies required.** The existing stack covers all needs for v1.5. Session transcript parsing is line-by-line JSONL (Node.js built-in `readline` or manual split), structured trace storage uses the same filesystem patterns as the task store, and CLI output uses the project's existing raw ANSI code approach (no library). Zod validates trace schemas. Vitest tests everything.

The one area that warrants attention is the OpenClaw session JSONL format -- it is an internal format without a published schema, so AOF must parse it defensively with version detection.

**Confidence:** HIGH -- all capabilities verified against installed packages and existing codebase patterns.

## Existing Stack (Confirmed Current)

| Technology | Installed | Purpose for v1.5 | Status |
|------------|-----------|-------------------|--------|
| Node.js | 22 (pinned) | `readline` for streaming JSONL parse, `fs/promises` for trace I/O | Sufficient |
| TypeScript | 5.7.x | Type-safe trace schemas and parsers | Sufficient |
| zod | 3.24.x | Session transcript schemas, trace record validation | Sufficient |
| commander | 14.0.x | `aof trace <task-id>` command registration | Sufficient |
| vitest | 3.0.x | Unit/integration tests for parser, trace store, CLI output | Sufficient |
| write-file-atomic | 7.x | Atomic trace file writes | Sufficient |
| yaml | 2.7.x | Reading task frontmatter to locate session IDs | Sufficient |
| gray-matter | 4.0.3 | Task file parsing for trace correlation | Sufficient |

## What Each v1.5 Feature Needs

### 1. Session Transcript Parsing

**What:** Parse OpenClaw session `.jsonl` files into structured trace records. Each line is a JSON object with a `type` field.

**OpenClaw Session JSONL Format (verified from live files):**

```
Line types:
  session        - Session metadata (version, id, timestamp, cwd)
  model_change   - Provider/model switch (provider, modelId)
  thinking_level_change - Thinking level adjustment
  custom         - Custom events (e.g., model-snapshot)
  message        - Conversation turn (role: user|assistant|toolResult)

Assistant message fields:
  message.role       = "assistant"
  message.content[]  = [{type: "thinking"}, {type: "text"}, {type: "toolCall"}]
  message.usage      = {input, output, cacheRead, cacheWrite, totalTokens, cost: {input, output, cacheRead, cacheWrite, total}}
  message.model      = "claude-sonnet-4-5"
  message.provider   = "anthropic-api"
  message.stopReason = "toolUse" | "endTurn"

Tool call content block:
  {type: "toolCall", id, name, arguments: {...}}

Tool result message:
  message.role       = "toolResult"
  message.toolCallId = <matches toolCall.id>
  message.toolName   = <tool name>
  message.isError    = boolean
```

**Stack needed:** Node.js built-in only.
- `fs/promises.readFile()` for small-to-medium session files (typical: 30-200 lines, <1MB)
- `String.split('\n')` + `JSON.parse()` per line (same pattern as `EventLogger.query()`)
- No streaming needed -- session files are bounded by agent timeout (5min default)

**Why not use a JSONL library:** The parsing is trivial (split + JSON.parse), the project already does it in `EventLogger.query()`, and adding a dependency for one function call adds maintenance burden with zero value.

**Schema approach:** Use Zod with `.passthrough()` for forward compatibility. Parse only the fields AOF needs; ignore unknown fields so future OpenClaw versions don't break AOF.

### 2. Structured Trace Storage

**What:** Write a trace summary file alongside task artifacts after session completion.

**Stack needed:** Existing only.
- `write-file-atomic` for crash-safe trace writes (already used for task mutations)
- Filesystem layout: `tasks/<status>/TASK-<id>/trace.json` (co-located with task)
- Zod schema for trace record validation

**Trace record structure (recommended):**

```typescript
const TraceRecord = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  capturedAt: z.string().datetime(),
  session: z.object({
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional(),
    durationMs: z.number(),
    model: z.string(),
    provider: z.string(),
  }),
  turns: z.number(),           // Total conversation turns
  toolCalls: z.number(),       // Total tool invocations
  toolBreakdown: z.record(z.string(), z.number()), // tool_name -> count
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
    totalTokens: z.number(),
    totalCost: z.number(),
  }),
  completion: z.object({
    calledTaskComplete: z.boolean(),
    outcome: z.string().optional(),
    summary: z.string().optional(),
  }),
  errors: z.array(z.object({
    turn: z.number(),
    tool: z.string().optional(),
    message: z.string(),
  })),
});
```

### 3. CLI Trace Viewing (`aof trace <task-id>`)

**What:** Display trace summary (default) or full debug output for a task's session trace.

**Stack needed:** Existing only.
- `commander` for command registration (same pattern as all other `aof` commands)
- Raw ANSI escape codes for colored output (project convention -- see `src/views/renderers.ts`)

**Why not add chalk/picocolors:** The project already uses raw ANSI codes everywhere (`\x1b[36m` etc. in `renderers.ts`). Adding a color library now would create inconsistency. Follow the existing pattern.

**Output modes:**
- **Summary (default):** Task ID, session duration, model, total tokens, cost, tool call counts, completion status. Fits in ~15 lines.
- **Debug (`--debug`):** Full turn-by-turn view with tool calls, token counts per turn, errors, and timing.

### 4. Completion Enforcement

**What:** Detect when an agent session ends without calling `aof_task_complete`, and flag/handle it.

**Stack needed:** Existing only.
- `AgentRunOutcome` callback (already wired in `OpenClawAdapter.runAgentBackground()`)
- `EventLogger` for logging enforcement events
- New event types in `EventType` Zod enum: `"trace.captured"`, `"completion.missing"`, `"completion.enforced"`

**Integration point:** The `onRunComplete` callback in `OpenClawAdapter` already fires when an agent run ends. The completion enforcement logic hooks into this:
1. Agent run completes (callback fires)
2. Check if `aof_task_complete` was called during the session (check task status)
3. If not: log `completion.missing` event, optionally force-complete with degraded status

### 5. Session Data Access (OpenClaw APIs)

**What:** Locate session transcript files for a given task/session ID.

**Two access paths (no new dependencies):**

1. **Direct filesystem read** (primary): `resolveSessionFilePath(sessionId)` from OpenClaw's `extensionAPI.js` returns the path to the `.jsonl` file. AOF already loads this module. Path pattern: `~/.openclaw/agents/<agent>/sessions/<sessionId>.jsonl`

2. **OpenClaw gateway tools** (alternative): `sessions_list` and `sessions_history` are registered gateway tools (verified in INTEGRATIONS.md). AOF can call these via the plugin API if needed, but direct file read is simpler and doesn't require gateway to be running.

**Recommendation:** Use direct filesystem read. The session file path is deterministic (`resolveSessionFilePath`), the file format is known, and it avoids a dependency on the gateway being active during trace capture.

## What NOT to Add

| Library | Why Not |
|---------|---------|
| `chalk` / `picocolors` | Project uses raw ANSI codes everywhere; adding a library creates inconsistency |
| `jsonl-parse` / `ndjson` | Trivial parsing (split + JSON.parse); existing pattern in EventLogger |
| `@opentelemetry/*` | Explicitly deferred to v2 per PROJECT.md |
| `cli-table3` / `tty-table` | Summary output is simple enough for manual formatting; `renderers.ts` proves the pattern |
| `dayjs` / `date-fns` | ISO date handling with built-in `Date` is sufficient for duration calculations |
| `ora` / spinners | Trace reading is fast (local file, <1MB); no async loading indicator needed |
| Any JSONL streaming library | Session files are bounded by timeout (5min = ~200 turns max, well under memory limits) |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| JSONL parsing | Built-in split+parse | `ndjson` / `jsonl-parse` | Zero value over 3 lines of code; adds dep |
| CLI colors | Raw ANSI (existing) | `picocolors` (2.1KB) | Would work but creates inconsistency with 150+ files using raw codes |
| Trace storage | JSON file per task | SQLite trace table | Filesystem-based principle; trace is per-task, not queryable across tasks |
| Session access | Direct file read | Gateway API (`sessions_history`) | Requires gateway running; file read is simpler and more reliable |
| Trace format | Single `trace.json` | Append-only JSONL | Traces are write-once summaries, not event streams; JSON is simpler |

## Integration Points with Existing Stack

### EventLogger Extension
Add new event types to `src/schemas/event.ts`:
```typescript
// Add to EventType enum:
"trace.captured",       // Trace successfully written
"completion.missing",   // Agent ended without aof_task_complete
"completion.enforced",  // System force-completed a task
```
No schema changes beyond enum extension.

### OpenClawAdapter Extension
The `onRunComplete` callback in `runAgentBackground()` is the hook point. After the callback fires:
1. Read session file via `resolveSessionFilePath(sessionId)`
2. Parse JSONL into trace record
3. Write `trace.json` to task directory
4. Log `trace.captured` event

### Commander CLI Extension
Register `aof trace <task-id>` in `src/cli/program.ts` following existing command patterns:
```typescript
registerTraceCommands(program);
```

### Task Store Extension
Add `getTraceDir(taskId)` method or utility to resolve `tasks/<status>/TASK-<id>/` as the trace storage location. The task's work directory already exists for artifact handoff in DAG workflows.

## File Organization (Recommended)

```
src/
  trace/
    parser.ts           # Parse OpenClaw session JSONL -> structured data
    store.ts            # Read/write trace.json files
    schemas.ts          # Zod schemas for trace records
    formatter.ts        # CLI output formatting (summary + debug modes)
    index.ts            # Public API
    __tests__/
      parser.test.ts
      store.test.ts
      formatter.test.ts
  cli/
    commands/
      trace.ts          # aof trace <task-id> command
```

## Sources

- OpenClaw session JSONL format: Verified from live session file `~/.openclaw/agents/swe-pm/sessions/927da406-29a0-465a-9267-3a0a1130b3f9.jsonl`
- Existing ANSI pattern: `src/views/renderers.ts` (raw escape codes, no library)
- Existing JSONL parsing: `src/events/logger.ts` lines 212-240 (`EventLogger.query()`)
- Gateway adapter: `src/openclaw/openclaw-executor.ts` (`resolveSessionFilePath`, `onRunComplete`)
- Event schema: `src/schemas/event.ts` (EventType Zod enum)
- Package.json: Verified installed dependencies and versions
- PROJECT.md: v1.5 milestone scope, constraints, out-of-scope items
