# Phase 26: Trace Infrastructure - Research

**Researched:** 2026-03-07
**Domain:** Session JSONL parsing, structured trace extraction, best-effort post-processing
**Confidence:** HIGH

## Summary

Phase 26 adds post-session trace capture: after an agent session completes, parse the OpenClaw session JSONL file and produce a structured `trace-N.json` in the task's run artifact directory. The parser must be fully defensive (the JSONL format is undocumented and unstable) and the capture must be best-effort -- failures never block task state transitions.

The implementation has four clear components: (1) a session JSONL parser that extracts tool calls and metadata, (2) a trace writer that persists `trace-N.json` files alongside `run_result.json`, (3) integration hooks in the two `onRunComplete` callbacks (top-level and DAG hop), and (4) no-op detection logic (ENFC-03 deferred from Phase 25). All four components follow established AOF patterns (best-effort try/catch, event logging, Zod schemas, `write-file-atomic`).

**Primary recommendation:** Create a `src/trace/` module with `session-parser.ts`, `trace-writer.ts`, and `noop-detector.ts`. Hook into the existing `onRunComplete` callbacks in `assign-executor.ts` and `dag-transition-handler.ts`. Use the same artifact directory pattern as `run-artifacts.ts`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Extract tool calls + session-level metadata (model, provider, duration, thinking level)
- Skip reasoning/thinking text in summary mode; include it in debug mode only
- Tool call capture: tool name + truncated input (first 200 chars) in summary mode
- Skip token usage extraction -- format is undocumented and unstable
- Store model and provider info from `model_change` JSONL entries
- Unknown JSONL entry types: skip silently, count them, include `unknownEntries` count in trace
- Parser must never throw on malformed data -- best-effort extraction
- `trace-N.json` lives alongside `run_result.json` in `state/runs/<taskId>/`
- Numbered files for retries: `trace-1.json`, `trace-2.json`, `trace-3.json` -- append-only, no file mutation
- Each trace includes a reference to the raw session JSONL file path (from `resolveSessionFilePath`)
- Trace lifecycle events (`trace.captured`, `trace.capture_failed`) emitted to JSONL event log
- `metadata.debug` flag on the task controls verbosity (default: summary when not set)
- Summary: tool name + truncated input (200 chars), no reasoning text
- Debug: tool name + full input + full output/result + assistant reasoning/thinking text
- Same schema shape for both modes -- debug just has more data in the same fields
- 1MB cap on debug traces -- truncate content if total JSON exceeds ~1MB, note truncation in trace metadata
- "Meaningful tool call" = any tool call at all (consistent with Phase 25 decision)
- Zero tool calls in a session = flagged as suspicious no-op
- Applies to both top-level tasks AND DAG hop sessions
- No-op flag surfaced in: trace metadata (`noopDetected: true`) AND `completion.noop_detected` event to JSONL event log
- Task completes normally but carries the suspicious flag (warn, don't block)
- If session JSONL is missing/unreadable: skip no-op detection entirely (not suspicious)
- Short sessions with at least one tool call are NOT flagged
- When no-op detected AND enforcement triggered: diagnostic message enhanced to say "zero tool calls" explicitly
- The `onRunComplete` callback in both `assign-executor.ts` and `dag-transition-handler.ts` is the trigger point

### Claude's Discretion
- Exact trace JSON schema field names and nesting
- How to determine the attempt number for `trace-N.json` naming (count existing files or use dispatch counter)
- Session JSONL line-by-line streaming vs full file read
- Truncation strategy details for the 1MB debug cap

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| TRAC-01 | OpenClaw session JSONL is parsed after agent completion to extract tool calls, token usage, and output | Session parser module; JSONL format documented below with entry types and content structure |
| TRAC-02 | Structured `trace.json` is written to task artifact directory alongside `run_result.json` | Trace writer using same `state/runs/<taskId>/` directory as `run-artifacts.ts`; `write-file-atomic` for safe writes |
| TRAC-03 | Trace capture is best-effort and never blocks task state transitions | Best-effort try/catch pattern; trace capture runs after state transition in `onRunComplete` |
| TRAC-04 | Trace events (`trace.captured`, `trace.capture_failed`) emitted to JSONL event log | New event types added to `EventType` enum; `EventLogger.log()` for emission |
| TRAC-05 | Traces accumulate across retries so subsequent agents can see prior attempt history | `trace-N.json` naming with N determined by counting existing trace files in the directory |
| TRAC-06 | Per-task `metadata.debug` flag controls full vs summary trace verbosity | Read from `task.frontmatter.metadata.debug`; same schema shape, debug fills more fields |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | ^3.24.0 | Trace schema validation | Already used for all schemas in AOF |
| write-file-atomic | ^7.0.0 | Safe trace file writes | Already used for run artifacts, prevents partial writes |
| node:fs/promises | built-in | Read session JSONL, list existing traces | Standard Node.js file operations |
| node:readline | built-in | Line-by-line JSONL parsing | Memory-efficient for large session files |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:path | built-in | Path resolution for trace files | Joining task artifact directory paths |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| readline for JSONL | Full file readFile + split | Full read is simpler but session files can be large; readline is safer for memory |
| Zod for trace schema | Plain TypeScript types | Zod adds runtime validation which catches bugs; matches project convention |

**Installation:**
```bash
# No new dependencies needed -- all libraries already in project
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── trace/
│   ├── session-parser.ts    # Parse OpenClaw session JSONL -> raw extraction
│   ├── trace-writer.ts      # Build trace object + write trace-N.json
│   ├── noop-detector.ts     # Zero-tool-call detection logic
│   └── __tests__/
│       ├── session-parser.test.ts
│       ├── trace-writer.test.ts
│       └── noop-detector.test.ts
├── schemas/
│   └── trace.ts             # Zod schema for trace-N.json
```

### Pattern 1: Best-Effort Post-Processing in onRunComplete
**What:** Trace capture hooks into the existing `onRunComplete` callback, wrapping all trace logic in try/catch so failures never propagate.
**When to use:** Always -- this is the only trigger point for trace capture.
**Example:**
```typescript
// In assign-executor.ts onRunComplete callback, AFTER enforcement logic:
try {
  const traceResult = await captureTrace({
    taskId: action.taskId,
    sessionId: outcome.sessionId,
    durationMs: outcome.durationMs,
    store,
    logger,
    debug: currentTask?.frontmatter.metadata?.debug === true,
  });
  if (traceResult.noopDetected) {
    await logger.log("completion.noop_detected", "scheduler", {
      taskId: action.taskId,
      payload: { sessionId: outcome.sessionId, toolCallCount: 0 },
    });
  }
} catch {
  try {
    await logger.log("trace.capture_failed", "scheduler", {
      taskId: action.taskId,
      payload: { sessionId: outcome.sessionId, error: "trace capture exception" },
    });
  } catch {
    // Even logging failure is best-effort
  }
}
```

### Pattern 2: Defensive JSONL Line Parsing
**What:** Parse each line independently with try/catch. Unknown types are counted but not stored.
**When to use:** For all session JSONL parsing.
**Example:**
```typescript
// Each line parsed independently -- one bad line doesn't kill the whole trace
for await (const line of lineReader) {
  try {
    const entry = JSON.parse(line);
    switch (entry.type) {
      case "session": extractSessionMeta(entry, trace); break;
      case "model_change": extractModel(entry, trace); break;
      case "thinking_level_change": extractThinking(entry, trace); break;
      case "message": extractMessage(entry, trace, debugMode); break;
      case "custom": /* skip silently */ break;
      default: trace.unknownEntries++; break;
    }
  } catch {
    trace.parseErrors++;
  }
}
```

### Pattern 3: Attempt Number from File Listing
**What:** Determine trace-N number by counting existing `trace-*.json` files in the task directory.
**When to use:** When writing a new trace file.
**Example:**
```typescript
const taskDir = join(store.projectRoot, "state", "runs", taskId);
const files = await readdir(taskDir).catch(() => []);
const existing = files.filter(f => /^trace-\d+\.json$/.test(f));
const nextN = existing.length + 1;
const tracePath = join(taskDir, `trace-${nextN}.json`);
```

### Anti-Patterns to Avoid
- **Throwing from parser on malformed data:** The parser MUST swallow all errors. Malformed JSONL lines are silently skipped with a counter increment.
- **Blocking state transitions on trace capture:** Trace capture runs AFTER enforcement/transition logic, never before or during.
- **Mutating existing trace files:** Once written, a trace file is immutable. New attempts create new numbered files.
- **Storing full content in summary mode:** Summary mode truncates tool call inputs to 200 chars and excludes reasoning text entirely.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic file writes | Manual write + rename | `write-file-atomic` | Already used everywhere in AOF; handles edge cases |
| Schema validation | Manual type checking | Zod schemas | Project convention; catches malformed data at boundaries |
| Event logging | Custom log file writing | `EventLogger.log()` | Existing infrastructure with symlinks, rotation, callbacks |

**Key insight:** All infrastructure pieces exist. This phase is purely about the new parsing logic and wiring it into existing hooks.

## Common Pitfalls

### Pitfall 1: Session JSONL File Not Found
**What goes wrong:** The session JSONL path from `resolveSessionFilePath` may not exist (agent crashed early, path resolution fails).
**Why it happens:** The JSONL file is written by OpenClaw, not AOF. It may not exist or may be incomplete.
**How to avoid:** Check file existence before attempting to read. If missing, emit `trace.capture_failed` and return gracefully.
**Warning signs:** `ENOENT` errors in trace capture.

### Pitfall 2: Large Session Files Causing Memory Issues
**What goes wrong:** Reading a multi-MB session JSONL into memory at once can spike RSS.
**Why it happens:** Long agent sessions produce large JSONL files with many tool calls and full output.
**How to avoid:** Use `readline` for line-by-line streaming. Track accumulated size for the 1MB debug cap.
**Warning signs:** Process memory spikes during trace capture.

### Pitfall 3: Race Condition Between Trace Capture and Task Directory
**What goes wrong:** The `state/runs/<taskId>/` directory might not exist yet when trace writer runs.
**Why it happens:** If `writeRunArtifact` hasn't been called yet (unlikely but possible with timing).
**How to avoid:** Always `mkdir({ recursive: true })` before writing, same as `writeRunArtifact` does.
**Warning signs:** `ENOENT` on directory.

### Pitfall 4: Debug Traces Exceeding 1MB
**What goes wrong:** Full debug traces with large tool outputs can produce enormous JSON files.
**Why it happens:** Tool outputs (file reads, command output) can be very large.
**How to avoid:** Track serialized size during construction. When approaching 1MB, truncate remaining content and add `truncated: true` to trace metadata.
**Warning signs:** Trace files growing beyond expected size.

### Pitfall 5: Resolving Session File Path Without ExtensionApi
**What goes wrong:** `resolveSessionFilePath` is on the ExtensionApi which is loaded lazily by OpenClawAdapter.
**Why it happens:** The trace capture needs the session file path but may not have direct access to ExtensionApi.
**How to avoid:** The session file path follows a predictable pattern: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`. Alternatively, store the resolved path from `spawnSession` in the outcome or as a utility function.
**Warning signs:** Cannot resolve session file path at trace capture time.

### Pitfall 6: No-op Detection on Missing Sessions
**What goes wrong:** If session JSONL is missing, incorrectly flagging as no-op.
**Why it happens:** Missing file means zero tool calls parsed, which matches no-op criteria.
**How to avoid:** Per user decision: if session JSONL is missing/unreadable, skip no-op detection entirely.
**Warning signs:** False no-op flags on failed sessions.

## Code Examples

### OpenClaw Session JSONL Format (Verified from Real Files)

The session JSONL has one JSON object per line. Entry types observed:

```typescript
// Entry 1: Session metadata (always first line)
{ type: "session", version: 3, id: "<uuid>", timestamp: "<iso>", cwd: "<path>" }

// Entry 2+: Model/thinking configuration
{ type: "model_change", id: "<hex>", parentId: null, timestamp: "<iso>",
  provider: "openrouter", modelId: "google/gemini-3.1-pro-preview-customtools" }

{ type: "thinking_level_change", id: "<hex>", parentId: "<hex>",
  timestamp: "<iso>", thinkingLevel: "low" }

// Custom entries (model snapshots, etc.)
{ type: "custom", customType: "model-snapshot", data: { ... },
  id: "<hex>", parentId: "<hex>", timestamp: "<iso>" }

// User message
{ type: "message", id: "<hex>", parentId: "<hex>", timestamp: "<iso>",
  message: { role: "user", content: [{ type: "text", text: "..." }] } }

// Assistant message with tool calls
{ type: "message", id: "<hex>", parentId: "<hex>", timestamp: "<iso>",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "..." },      // reasoning text
      { type: "toolCall", id: "<id>", name: "exec",
        arguments: { command: "..." } }            // tool invocation
    ]
  }
}

// Tool result
{ type: "message", id: "<hex>", parentId: "<hex>", timestamp: "<iso>",
  message: {
    role: "toolResult",
    toolCallId: "<id>", toolName: "exec",
    content: [{ type: "text", text: "..." }]       // tool output
  }
}
```

Key observations:
- **parentId linked list:** Each entry references its parent, forming a conversation tree
- **Tool calls in assistant messages:** Look for `content` items with `type: "toolCall"` (also seen as `type: "tool_use"` per CONTEXT.md)
- **Thinking text in assistant messages:** `type: "thinking"` content items (often empty string)
- **Tool results as separate messages:** `role: "toolResult"` with `toolCallId` linking back

### Recommended Trace Schema

```typescript
import { z } from "zod";

const ToolCallTrace = z.object({
  name: z.string(),
  input: z.string(),           // truncated to 200 chars in summary mode
  output: z.string().optional(), // only in debug mode
  toolCallId: z.string().optional(),
});

const TraceSchema = z.object({
  version: z.literal(1),
  taskId: z.string(),
  sessionId: z.string(),
  attemptNumber: z.number().int().positive(),
  capturedAt: z.string().datetime(),

  // Session metadata
  session: z.object({
    sessionFilePath: z.string(),
    durationMs: z.number(),
    model: z.string().optional(),
    provider: z.string().optional(),
    thinkingLevel: z.string().optional(),
  }),

  // Tool calls
  toolCalls: z.array(ToolCallTrace),
  toolCallCount: z.number().int(),

  // Content (debug mode only has reasoning)
  reasoning: z.array(z.string()).optional(), // debug mode only

  // Detection flags
  noopDetected: z.boolean(),

  // Parse metadata
  meta: z.object({
    mode: z.enum(["summary", "debug"]),
    unknownEntries: z.number().int().default(0),
    parseErrors: z.number().int().default(0),
    truncated: z.boolean().default(false),
    totalEntriesParsed: z.number().int(),
  }),
});
```

### Session File Path Resolution

```typescript
// Option 1: Use the known path pattern directly (avoids ExtensionApi dependency)
function resolveSessionPath(sessionId: string, agentId: string): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim()
    || process.env.CLAWDBOT_STATE_DIR?.trim()
    || join(homedir(), ".openclaw");
  return join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`);
}

// Option 2: Pass resolved path through AgentRunOutcome (cleaner but needs interface change)
// The path is already resolved in openclaw-executor.ts line 107:
//   const sessionFile = ext.resolveSessionFilePath(sessionId);
// Could store it on the outcome or on task metadata.
```

### Trace Capture Entry Point

```typescript
export interface CaptureTraceOptions {
  taskId: string;
  sessionId: string;
  agentId: string;
  durationMs: number;
  store: ITaskStore;
  logger: EventLogger;
  debug: boolean;
}

export interface CaptureTraceResult {
  success: boolean;
  noopDetected: boolean;
  tracePath?: string;
  error?: string;
}

export async function captureTrace(opts: CaptureTraceOptions): Promise<CaptureTraceResult> {
  // 1. Resolve session file path
  // 2. Parse session JSONL (best-effort)
  // 3. Detect no-op (zero tool calls)
  // 4. Build trace object (summary or debug mode)
  // 5. Determine attempt number (count existing trace-*.json)
  // 6. Write trace-N.json atomically
  // 7. Emit trace.captured event
  // 8. Return result
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No trace capture | Post-session JSONL parsing | Phase 26 (now) | First observability into agent sessions |
| No enforcement | Completion enforcement (Phase 25) | Phase 25 | Tasks blocked when agent skips aof_task_complete |
| No no-op detection | Zero-tool-call flagging | Phase 26 (now) | Catches hallucinated completions |

**Key context:**
- The session JSONL format is owned by OpenClaw, not AOF. It is undocumented and may change.
- `resolveSessionFilePath` is available on ExtensionApi but the path pattern is predictable.
- The `onRunComplete` callback already handles enforcement (Phase 25) -- trace capture adds to it.

## Open Questions

1. **Session file path access pattern**
   - What we know: `resolveSessionFilePath(sessionId)` is available during `spawnSession` and the path is stored in `sessionFile` local variable. The path pattern is `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`.
   - What's unclear: Whether to pass the resolved path through `AgentRunOutcome` (requires interface change) or reconstruct it from the known pattern.
   - Recommendation: Reconstruct from pattern -- avoids changing `AgentRunOutcome` interface. The pattern is stable (used since OpenClaw inception). Add the agent ID to the outcome or use it from the callback closure.

2. **1MB truncation strategy for debug mode**
   - What we know: Debug traces must cap at ~1MB of JSON.
   - What's unclear: Whether to truncate individual tool outputs, drop entire tool calls, or truncate the final serialized JSON.
   - Recommendation: Build trace incrementally, tracking serialized size. When approaching 1MB, truncate remaining tool call inputs/outputs to empty strings and set `meta.truncated = true`. This preserves the tool call structure (names, counts) while capping content.

3. **Agent ID availability in onRunComplete**
   - What we know: In `assign-executor.ts`, `action.agent` is available in the closure. In `dag-transition-handler.ts`, `hop.role` is available.
   - What's unclear: Whether the agent ID needs normalization (the `normalizeAgentId` method strips `agent:` prefix).
   - Recommendation: Apply same normalization as `OpenClawAdapter.normalizeAgentId()` when constructing the session file path.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^3.0.0 |
| Config file | vitest.config.ts (root) |
| Quick run command | `npx vitest run src/trace/ --reporter=verbose` |
| Full suite command | `npx vitest run --reporter=verbose` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TRAC-01 | Session JSONL parsed to extract tool calls and metadata | unit | `npx vitest run src/trace/__tests__/session-parser.test.ts -x` | Wave 0 |
| TRAC-02 | trace-N.json written to artifact directory | unit | `npx vitest run src/trace/__tests__/trace-writer.test.ts -x` | Wave 0 |
| TRAC-03 | Trace capture never blocks state transitions | unit | `npx vitest run src/trace/__tests__/trace-writer.test.ts -x` | Wave 0 |
| TRAC-04 | trace.captured / trace.capture_failed events emitted | unit | `npx vitest run src/trace/__tests__/trace-writer.test.ts -x` | Wave 0 |
| TRAC-05 | Traces accumulate across retries (trace-1, trace-2, ...) | unit | `npx vitest run src/trace/__tests__/trace-writer.test.ts -x` | Wave 0 |
| TRAC-06 | metadata.debug controls summary vs debug verbosity | unit | `npx vitest run src/trace/__tests__/session-parser.test.ts -x` | Wave 0 |
| ENFC-03 | No-op detection flags zero-tool-call sessions | unit | `npx vitest run src/trace/__tests__/noop-detector.test.ts -x` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/trace/ --reporter=verbose`
- **Per wave merge:** `npx vitest run --reporter=verbose`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/trace/__tests__/session-parser.test.ts` -- covers TRAC-01, TRAC-06
- [ ] `src/trace/__tests__/trace-writer.test.ts` -- covers TRAC-02, TRAC-03, TRAC-04, TRAC-05
- [ ] `src/trace/__tests__/noop-detector.test.ts` -- covers ENFC-03
- [ ] `tests/fixtures/session-*.jsonl` -- test fixture files with known content for deterministic parsing tests
- [ ] `src/schemas/trace.ts` -- Zod schema (tested via unit tests)

## Sources

### Primary (HIGH confidence)
- Real OpenClaw session JSONL file examined: `~/.openclaw/agents/researcher/sessions/c4273beb-*.jsonl` -- verified entry types, content structure, linked-list parentId pattern
- Existing codebase: `src/recovery/run-artifacts.ts` -- artifact directory pattern, `write-file-atomic` usage
- Existing codebase: `src/dispatch/assign-executor.ts` -- `onRunComplete` callback structure and enforcement flow
- Existing codebase: `src/dispatch/dag-transition-handler.ts` -- DAG hop `onRunComplete` callback
- Existing codebase: `src/openclaw/openclaw-executor.ts` -- `resolveSessionFilePath`, `AgentRunOutcome` construction
- Existing codebase: `src/events/logger.ts` -- `EventLogger.log()` API
- Existing codebase: `src/schemas/event.ts` -- `EventType` enum for adding new event types

### Secondary (MEDIUM confidence)
- CONTEXT.md user decisions -- implementation constraints from discussion phase

### Tertiary (LOW confidence)
- Session JSONL `tool_use` content type mentioned in CONTEXT.md but not observed in examined file (only `toolCall` seen) -- parser should handle both

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already in project, no new dependencies
- Architecture: HIGH -- follows existing patterns exactly (run-artifacts, event logging, onRunComplete hooks)
- Pitfalls: HIGH -- based on real code examination and JSONL format analysis
- JSONL format: MEDIUM -- examined one real file; format is undocumented and may vary across providers/versions

**Research date:** 2026-03-07
**Valid until:** 2026-04-07 (stable -- no external dependencies changing)
