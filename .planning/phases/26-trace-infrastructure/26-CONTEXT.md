# Phase 26: Trace Infrastructure - Context

**Gathered:** 2026-03-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Every completed agent session produces a structured trace record (`trace.json`) by parsing the OpenClaw session JSONL. Trace capture is best-effort and never blocks task state transitions. Includes no-op detection (ENFC-03 deferred from Phase 25). Does NOT include CLI presentation (Phase 27).

</domain>

<decisions>
## Implementation Decisions

### Session Parsing
- Extract tool calls + session-level metadata (model, provider, duration, thinking level)
- Skip reasoning/thinking text in summary mode; include it in debug mode only
- Tool call capture: tool name + truncated input (first 200 chars) in summary mode
- Skip token usage extraction — format is undocumented and unstable
- Store model and provider info from `model_change` JSONL entries
- Unknown JSONL entry types: skip silently, count them, include `unknownEntries` count in trace
- Parser must never throw on malformed data — best-effort extraction

### Trace Storage
- `trace-N.json` lives alongside `run_result.json` in `state/runs/<taskId>/`
- Numbered files for retries: `trace-1.json`, `trace-2.json`, `trace-3.json` — append-only, no file mutation
- Each trace includes a reference to the raw session JSONL file path (from `resolveSessionFilePath`)
- Trace lifecycle events (`trace.captured`, `trace.capture_failed`) emitted to JSONL event log

### Debug vs Summary Mode
- `metadata.debug` flag on the task controls verbosity (default: summary when not set)
- Summary: tool name + truncated input (200 chars), no reasoning text
- Debug: tool name + full input + full output/result + assistant reasoning/thinking text
- Same schema shape for both modes — debug just has more data in the same fields
- 1MB cap on debug traces — truncate content if total JSON exceeds ~1MB, note truncation in trace metadata

### No-op Detection (ENFC-03)
- "Meaningful tool call" = any tool call at all (consistent with Phase 25 decision)
- Zero tool calls in a session = flagged as suspicious no-op
- Applies to both top-level tasks AND DAG hop sessions
- No-op flag surfaced in: trace metadata (`noopDetected: true`) AND `completion.noop_detected` event to JSONL event log
- Task completes normally but carries the suspicious flag (warn, don't block)
- If session JSONL is missing/unreadable: skip no-op detection entirely (not suspicious)
- Short sessions with at least one tool call are NOT flagged — only zero tool calls triggers it
- When no-op detected AND enforcement triggered (no `aof_task_complete`): diagnostic message enhanced to say "zero tool calls" explicitly

### Claude's Discretion
- Exact trace JSON schema field names and nesting
- How to determine the attempt number for `trace-N.json` naming (count existing files or use dispatch counter)
- Session JSONL line-by-line streaming vs full file read
- Truncation strategy details for the 1MB debug cap

</decisions>

<specifics>
## Specific Ideas

- The `onRunComplete` callback in both `assign-executor.ts` (top-level) and `dag-transition-handler.ts` (DAG hops) is the natural trigger point for trace capture
- `resolveSessionFilePath(sessionId)` from the `ExtensionApi` interface resolves session JSONL paths — store this path in the trace
- Session JSONL uses linked-list via `parentId` references. Entry types observed: `session`, `model_change`, `thinking_level_change`, `custom`, `message` (with roles: user, assistant, toolResult)
- Tool calls appear inside `message` entries with `role: "assistant"` as content items with `type: "toolCall"` or `type: "tool_use"`
- The original Phase 25 incident: architect agent ran 13 seconds, zero tool calls, hallucinated completion. No-op detection would flag exactly this pattern.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/recovery/run-artifacts.ts`: `writeRunResult()`/`readRunResult()` — same directory resolution for trace files
- `src/events/logger.ts`: `EventLogger.log()` — for `trace.captured` and `trace.capture_failed` events
- `src/dispatch/executor.ts`: `AgentRunOutcome` interface — has `sessionId` and `durationMs` needed for trace
- `src/openclaw/openclaw-executor.ts`: `ExtensionApi.resolveSessionFilePath()` — resolves session JSONL path
- `src/memory/cold-tier.ts`: `logTranscript()` — existing pattern for writing session data to disk

### Established Patterns
- Run artifacts stored in `state/runs/<taskId>/` — trace files follow same convention
- `onRunComplete` callback pattern for post-session processing — trace capture hooks in here
- Best-effort with try/catch: existing pattern where logging/artifact failures never crash the scheduler
- Task metadata bag (`frontmatter.metadata`) — for `debug` flag and potentially `noopDetected`

### Integration Points
- `src/dispatch/assign-executor.ts:172` — `onRunComplete` callback for top-level tasks
- `src/dispatch/dag-transition-handler.ts:324` — `onRunComplete` callback for DAG hops
- `src/openclaw/openclaw-executor.ts:259-266` — where `AgentRunOutcome` is constructed (has sessionId)
- Session JSONL files at `~/.openclaw/agents/<agent>/sessions/<sessionId>.jsonl`

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 26-trace-infrastructure*
*Context gathered: 2026-03-07*
