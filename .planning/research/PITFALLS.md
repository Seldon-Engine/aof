# Pitfalls Research: v1.5 Event Tracing & Session Observability

**Domain:** Agent event tracing, completion enforcement, and session trace capture for filesystem-based orchestration
**Researched:** 2026-03-06
**Confidence:** HIGH (based on direct codebase analysis of existing completion, executor, and schema systems)

---

## Critical Pitfalls

Mistakes that cause rewrites, break existing agents, or lose data.

### Pitfall 1: Completion Enforcement Breaks the Existing Fallback Path

**What goes wrong:**
The current system has a deliberate fallback in `assign-executor.ts` (lines 172-226): when an agent finishes without calling `aof_task_complete`, the `onRunComplete` callback detects the task is still `in-progress` and auto-transitions it through `review -> done` (on success) or to `blocked` (on failure). This fallback is the safety net that makes AOF "tasks never get dropped" work today.

If completion enforcement naively rejects tasks that don't call `aof_task_complete`, the fallback path becomes a punishment loop: agent finishes work successfully -> enforcement rejects it -> task gets blocked or deadlettered -> after 3 failures, task goes to deadletter. The agent did the work but didn't call the tool, and now the completed work is lost.

**Why it happens:**
The enforcement goal ("require explicit `aof_task_complete`") directly conflicts with the existing resilience goal ("tasks survive agent crashes"). Developers implement enforcement as a hard gate without recognizing that the fallback path handles a real failure mode: agents may not have the `aof_task_complete` tool available (OpenClaw plugin wiring issue), may hit token limits before calling it, or may crash mid-execution.

**Consequences:**
- Previously-completing tasks start deadlettering
- Work is done but not recorded
- Operators see a spike in deadletter tasks after v1.5 upgrade with no code change on agent side
- Trust in the system erodes ("it worked before the update")

**Prevention:**
1. Enforcement must be graduated, not binary. Phase 1: log a warning event (`completion.enforcement.fallback_used`) when the fallback path fires, but still allow the fallback. Phase 2: add a per-task or per-agent `requireExplicitComplete: true` flag that enables hard enforcement opt-in. Phase 3: make it default after telemetry shows agents reliably call the tool.
2. The `onRunComplete` callback in `assign-executor.ts` should record WHY the agent didn't call `aof_task_complete` (timeout? error? success without tool call?) as structured metadata on the task. This data feeds the trace.
3. The SKILL.md prompt already includes a `**CRITICAL:** Before starting work, verify that the \`aof_task_complete\` tool is available` instruction (openclaw-executor.ts line 314). Enforcement should check whether the agent acknowledged this instruction before penalizing.
4. Never remove the fallback path entirely -- downgrade it to a "fallback with warning event" that is always available as a safety net.

**Detection:**
- Monitor `dispatch.fallback` events in events.jsonl -- a spike after deployment means enforcement is too aggressive
- Test the upgrade path: deploy v1.5 with existing agents that do NOT have updated SKILL.md and verify tasks still complete
- CI test: spawn a mock agent that exits without calling `aof_task_complete` and assert the task still reaches `done` (with a warning event)

**Phase to address:** Must be the first thing implemented -- before any trace capture or CLI work.

---

### Pitfall 2: Race Condition Reading OpenClaw Session .jsonl Files

**What goes wrong:**
OpenClaw writes session transcripts as `.jsonl` files (the `resolveSessionFilePath` function returns paths like `/tmp/s/{sessionId}.jsonl`). AOF's trace capture needs to read these files after the agent session completes. But there is a race condition:

1. `runEmbeddedPiAgent` returns (the agent is "done")
2. AOF's `onRunComplete` callback fires
3. AOF tries to read the session .jsonl file
4. OpenClaw may still be flushing the final lines to disk (write buffers, fsync not yet called)

The result: truncated traces, missing the final tool calls (including `aof_task_complete` itself), or `ENOENT` if the file hasn't been created yet (short sessions).

**Why it happens:**
The `runEmbeddedPiAgent` promise resolves when the agent's main loop ends, but the session file writer is a separate I/O stream that may flush asynchronously. This is a classic producer-consumer race: the producer (OpenClaw session writer) and the consumer (AOF trace reader) don't share a synchronization primitive.

**Consequences:**
- Traces missing the completion event (ironic for a tracing feature)
- Intermittent truncation that only shows up under load (when disk I/O is slow)
- Flaky tests that pass on fast local disks but fail in CI

**Prevention:**
1. Do NOT read the session file in the `onRunComplete` callback. Instead, record the session file path in task metadata (`sessionFilePath`) and read it lazily -- only when `aof trace <task-id>` is called or during a scheduled trace-capture pass.
2. Add a small delay (500ms-1s) or a file-stable check (stat the file twice, 200ms apart, and verify size hasn't changed) before reading.
3. Use a streaming JSONL reader that handles truncated final lines gracefully (skip incomplete trailing line instead of throwing a parse error).
4. Store the captured trace as a separate file in the task's work directory (e.g., `tasks/done/TASK-xxx/trace.jsonl`) rather than depending on the OpenClaw session file remaining available. OpenClaw may clean up session files.
5. Handle `ENOENT` gracefully -- short sessions or test sessions may not produce a file. The trace output should say "No session transcript available" rather than crashing.

**Detection:**
- Test with a mock session file that is still being written (append lines after the reader starts)
- Test with an empty/missing session file
- Test with a session file that has a truncated final JSON line

**Phase to address:** Implement trace capture with defensive I/O from the start. Do not assume the file is complete when you read it.

---

### Pitfall 3: CompletionReportPayload Schema Extension Breaks Existing Agents

**What goes wrong:**
The `CompletionReportPayload` schema in `schemas/protocol.ts` has fixed required fields: `outcome`, `summaryRef`, `tests`, `notes`. If v1.5 adds new required fields (e.g., `traceId`, `sessionMetrics`, `toolCallCount`) to capture richer completion data, every existing agent that calls `aof_task_complete` will start failing Zod validation because they don't send the new fields.

This is particularly dangerous because:
- The protocol schema is used in the router (`protocol/router.ts`) which validates incoming messages
- Agents may have cached/stale SKILL.md from before the update
- OpenClaw subagent sessions use the tool schema from the MCP server, which is wired at gateway startup -- restarting the gateway picks up new schemas, but running sessions don't

**Why it happens:**
Schema-first design (a strength of AOF) becomes a hazard when schemas evolve. Zod's `.object()` is strict by default -- extra fields are stripped, missing fields fail validation. Adding required fields is a breaking change.

**Consequences:**
- Agents calling `aof_task_complete` get validation errors
- Tasks pile up in `in-progress` because completion is rejected
- The fallback path (Pitfall 1) fires for every task, flooding logs

**Prevention:**
1. ALL new fields on `CompletionReportPayload` must be `.optional()` with `.default()` values. No exceptions.
2. If the `aof_task_complete` MCP tool input schema changes, add new fields as optional with defaults. The tool handler should compute/populate missing fields server-side rather than requiring the agent to send them.
3. Version the completion payload: add a `payloadVersion?: number` field that defaults to `1`. New fields are only expected when `payloadVersion >= 2`. This lets old agents continue working.
4. Write a migration test: parse a v1.4-era completion report against the v1.5 schema and assert it passes validation.
5. Use `.passthrough()` on the Zod schema if you need agents to include arbitrary trace metadata without pre-defining every field.

**Detection:**
- CI test: validate sample completion payloads from v1.4 against v1.5 schemas
- Monitor `protocol.message.rejected` events after deployment

**Phase to address:** Schema changes must happen first, before any code that depends on new fields.

---

## Moderate Pitfalls

### Pitfall 4: Disk Space Exhaustion from Unbounded Trace Storage

**What goes wrong:**
Each task gets a trace file copied from the OpenClaw session .jsonl. Session files can be large: a 30-minute agent session with verbose tool calls can produce 1-10MB of JSONL. With the scheduler running autonomously and completing dozens of tasks per day, trace storage grows unboundedly. On a single-machine deployment (the only supported mode), this eventually fills the disk.

The problem is worse than raw file size because:
- OpenClaw session files contain full request/response bodies (including file contents the agent read)
- Tasks in `done/` are never cleaned up automatically
- The `~/.openclaw/aof/` data directory is on the same partition as the system

**Prevention:**
1. Define a retention policy from day one: traces older than N days (default: 30) are auto-deleted by a scheduler maintenance pass.
2. Set a maximum trace file size (e.g., 5MB). If the session .jsonl exceeds this, capture only the first and last N lines (head + tail) to preserve the beginning (dispatch context) and end (completion).
3. Store traces compressed (gzip). JSONL compresses very well (10-20x ratio for repetitive tool call JSON).
4. Make trace capture opt-in per task or per agent via the org chart config, not always-on. A `trace: true` field on the task or agent config.
5. Add a `aof trace --cleanup` CLI command for manual cleanup.
6. Log a warning event when trace storage exceeds a threshold (e.g., 500MB total).

**Detection:**
- Monitor disk usage of `~/.openclaw/aof/tasks/` over time
- Add a health check to `aof smoke` that warns if trace storage exceeds threshold

**Phase to address:** Build retention policy and size limits into the trace capture implementation, not as a follow-up.

---

### Pitfall 5: SKILL.md Token Budget Exceeded by Tracing Instructions

**What goes wrong:**
v1.4 invested heavily in compressing SKILL.md from 3411 to 1665 tokens (51.2% reduction) with a CI budget gate enforcing a 2150-token ceiling. Adding tracing instructions ("always report your tool calls", "include session metrics in completion", "use structured output for trace data") pushes the SKILL.md over the budget gate, causing CI to fail.

If developers bypass the budget gate to add tracing instructions, the seed tier (563 tokens) bloats, increasing context cost for every dispatched task -- directly undoing v1.4's optimization.

**Why it happens:**
Tracing requires agent cooperation, and cooperation requires instructions. The tension is between "agents need to know about tracing" and "context budget is fixed."

**Prevention:**
1. Do NOT add tracing instructions to SKILL.md. Tracing should be infrastructure-level: AOF captures the session file and extracts trace data server-side, without requiring the agent to do anything differently.
2. The one instruction that matters -- "call `aof_task_complete`" -- is already in the prompt (openclaw-executor.ts `formatTaskInstruction`). That prompt is NOT counted against the SKILL.md budget because it's injected at dispatch time, not in the skill file.
3. If agent-side reporting is absolutely needed, add it to the dispatch prompt in `formatTaskInstruction()` rather than SKILL.md. The dispatch prompt is per-task and doesn't have a shared budget gate.
4. The `aof_task_complete` tool schema can include optional fields for agent-reported metrics without changing the skill documentation. Agents that know about the fields use them; others don't.
5. If SKILL.md must change, trade existing content for tracing content (remove something to make room) rather than raising the budget ceiling.

**Detection:**
- CI budget gate test (`context/__tests__/budget.test.ts`) will catch this automatically
- Track seed tier token count across versions

**Phase to address:** Design tracing as server-side capture from the start. Only add agent-side instructions if server-side capture proves insufficient.

---

### Pitfall 6: Debug Flag Per-Task Creates Schema Migration Headache

**What goes wrong:**
Adding a `debug: boolean` or `verbosity: "normal" | "verbose" | "debug"` field to the task frontmatter schema (`TaskFrontmatter` in `schemas/task.ts`) means every existing task file on disk fails validation when read by the new code, unless the field has a default value. But even with a default, there's a subtler issue: the task serializer writes the field to every task file going forward, meaning tasks created by v1.5 cannot be read by v1.4 (no forward compatibility).

**Why it happens:**
AOF stores tasks as YAML frontmatter files. Schema changes mean file format changes. There's no migration framework for individual task field additions (the v1.3 migration framework handles structural changes, not additive field additions).

**Prevention:**
1. Use the existing `metadata: z.record(z.string(), z.unknown())` bag for debug flags. Store as `metadata.debug: true` or `metadata.traceLevel: "verbose"`. The metadata bag is already schema-flexible and survives round-trips.
2. Do NOT add a top-level frontmatter field for per-task debug flags. Top-level fields are schema-validated and create forward/backward compatibility issues.
3. If a typed field is needed, add it as `.optional()` with no default (so it's omitted from serialization when not set). Check `schemas/task.ts` line 109: `metadata: z.record(z.string(), z.unknown()).default({})` -- this is the escape hatch.
4. The CLI flag (`--debug`) should set a metadata flag at task creation or dispatch time, not modify the schema.

**Detection:**
- Create a task with v1.5, downgrade to v1.4, and verify the task file still parses
- Zod validation test: parse a v1.4-era task frontmatter against v1.5 schema

**Phase to address:** Decide on metadata bag vs. schema field before any implementation begins.

---

### Pitfall 7: `aof trace` CLI Hangs on Large Trace Files

**What goes wrong:**
Running `aof trace <task-id>` on a task with a 10MB session transcript tries to load the entire file into memory, parse every JSONL line, format it, and dump it to stdout. On a terminal, this produces thousands of lines of output that scroll past instantly, providing no useful information. Worse, the CLI appears to hang during the parsing phase.

**Prevention:**
1. Default output should be a summary: number of tool calls, duration, outcome, errors -- not the full transcript. A `--full` flag shows everything.
2. Implement streaming: read the JSONL file line by line (Node readline or transform stream), format each event, and write to stdout incrementally. Never load the entire file into memory.
3. Add pagination: `--limit N` shows the first N events. `--tail N` shows the last N events (useful for seeing the completion).
4. Filter flags: `--tools` shows only tool calls, `--errors` shows only errors, `--timing` shows a timeline summary.
5. Consider using the existing `views/` rendering infrastructure (views/renderers.ts) which already handles formatting for the kanban board.

**Detection:**
- Test with a 10MB synthetic .jsonl file and measure time-to-first-output
- Test with an empty trace file

**Phase to address:** Build the summary view first, add full transcript later.

---

### Pitfall 8: OpenClaw Session File Format Changes Without Warning

**What goes wrong:**
AOF treats OpenClaw session .jsonl files as an external data source. The format of these files is defined by OpenClaw, not AOF. If OpenClaw updates and changes the JSONL schema (field renames, new event types, structural changes), AOF's trace parser silently produces wrong or empty output.

This is an integration boundary issue: AOF calls `resolveSessionFilePath` (from OpenClaw's `extensionAPI.js`) to get the file path, but the file content format is undocumented and may change between OpenClaw versions.

**Why it happens:**
The session file format is an internal implementation detail of OpenClaw, not a public API. AOF is reaching across the integration boundary to read an internal file format.

**Prevention:**
1. Build the JSONL parser defensively: use `z.object().passthrough()` for each line type, extract only the fields you need, and ignore unknown fields/types.
2. Define the minimum required fields for each trace event type and assert only those. If a line doesn't parse, skip it with a warning rather than failing the entire trace.
3. Pin the expected format version somewhere (e.g., `trace-format-version: 1` in config) so you can detect when OpenClaw's format has diverged.
4. Write integration tests that parse real (anonymized) session .jsonl files from the current OpenClaw version. Keep these as golden fixtures so format changes are detected by CI.
5. If possible, request that OpenClaw document or stabilize the session file format. Until then, treat the parser as a best-effort decoder.

**Detection:**
- Golden fixture tests that parse real session .jsonl samples
- If any line in the trace fails to parse, log a `trace.parse_warning` event rather than failing

**Phase to address:** Build parser with defensive/passthrough parsing from day one. Do not model the full OpenClaw event schema -- only extract what you need.

---

## Minor Pitfalls

### Pitfall 9: Session File Path Changes Between OpenClaw Versions

**What goes wrong:**
AOF stores the session file path (returned by `resolveSessionFilePath(sessionId)`) in task metadata for later trace retrieval. If OpenClaw moves session files to a different directory structure in an update, the stored paths become stale. `aof trace` fails with ENOENT for tasks completed before the OpenClaw update.

**Prevention:**
1. Store the session ID, not the resolved path. Re-resolve the path at read time by calling `resolveSessionFilePath` again.
2. Fall back gracefully: if the resolved path doesn't exist, try common alternative locations before giving up.
3. When capturing traces to the task directory, the captured copy is path-independent. Prioritize reading the captured copy over the original session file.

**Phase to address:** Store sessionId in metadata (already done in assign-executor.ts line 237), resolve path at trace-read time.

---

### Pitfall 10: Event Type Enum Exhaustion

**What goes wrong:**
The `EventType` enum in `schemas/event.ts` already has 60+ entries. Adding trace-related events (trace.captured, trace.parse_warning, trace.cleanup, completion.enforcement.fallback_used, etc.) further bloats the enum. Every new event type is a Zod enum entry that must be added to the schema, and any typo or missing entry causes a runtime validation error that crashes event logging.

**Prevention:**
1. Use a namespace prefix consistently: `trace.*` for all trace events. This makes the enum scannable and avoids collisions.
2. Consider switching to `z.string().startsWith("trace.")` for trace events rather than adding each one to the enum. This is a bigger refactor but prevents enum explosion.
3. For v1.5, add the minimum set of events needed: `trace.captured`, `trace.capture_failed`, `completion.enforcement.warn`. Add more only when you have concrete consumers.
4. The existing pattern of `try { await logger.log(...) } catch { /* non-fatal */ }` throughout the codebase means a missing event type won't crash the scheduler, but it will silently drop the event. Add a test that validates all logged event types against the schema.

**Phase to address:** Add events incrementally, not all at once. Start with 3-4 trace events maximum.

---

### Pitfall 11: Trace Capture Slows Down the Scheduler Poll Loop

**What goes wrong:**
If trace capture (reading session files, parsing JSONL, writing trace files) is done synchronously in the scheduler's poll loop or `onRunComplete` callback, it adds I/O latency to every task completion. With the scheduler already doing filesystem scans, lease management, DAG evaluation, and SLA checks per poll, adding trace I/O could push poll duration beyond the `pollTimeoutMs` (default 30s), triggering `poll.timeout` events and missed dispatch windows.

**Prevention:**
1. Trace capture must be asynchronous and decoupled from the poll loop. Fire-and-forget from `onRunComplete`, or better yet, run as a separate maintenance pass (like SLA checking or murmur evaluation).
2. Queue trace captures and process them in a background worker or at the end of the poll cycle, after all dispatch actions are complete.
3. Set a per-trace timeout: if reading/parsing a session file takes more than 5 seconds, skip it and retry next poll.
4. Add trace capture duration to poll telemetry so you can monitor the overhead.

**Phase to address:** Design trace capture as async/background from the start. Never block the dispatch path.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Completion enforcement | Breaking existing fallback path (Pitfall 1) | Graduated enforcement: warn-only first, opt-in hard enforcement later |
| Schema changes | Breaking existing agents (Pitfall 3) | All new fields optional with defaults; payload versioning |
| Session file reading | Race condition on file I/O (Pitfall 2) | Lazy read with stability check; streaming parser; handle ENOENT |
| Trace storage | Disk exhaustion (Pitfall 4) | Retention policy, size limits, compression from day one |
| SKILL.md changes | Token budget exceeded (Pitfall 5) | Server-side capture only; no SKILL.md changes needed |
| Debug flag | Schema migration (Pitfall 6) | Use metadata bag, not new frontmatter field |
| CLI trace output | Hang on large files (Pitfall 7) | Summary default, streaming reader, filter flags |
| OpenClaw format | Undocumented format changes (Pitfall 8) | Defensive parsing, golden fixtures, passthrough schemas |
| Scheduler performance | Poll loop slowdown (Pitfall 11) | Async/background trace capture, never block dispatch |

---

## Backward Compatibility Checklist

These are the specific integration points where v1.5 changes risk breaking existing v1.4 behavior:

| Integration Point | File | Risk | Test |
|-------------------|------|------|------|
| `onRunComplete` fallback | `dispatch/assign-executor.ts:172-226` | Enforcement may suppress fallback | Spawn agent without tool, assert task reaches `done` |
| `CompletionReportPayload` schema | `schemas/protocol.ts:86-95` | New required fields break agents | Parse v1.4 payload against v1.5 schema |
| `TaskFrontmatter` schema | `schemas/task.ts:82-133` | New fields break forward compat | Parse v1.5 task with v1.4 code |
| `EventType` enum | `schemas/event.ts:17-142` | Missing event type drops events | Validate all logged types against schema |
| SKILL.md budget | `context/__tests__/budget.test.ts` | Exceeding 2150 token ceiling | CI budget gate (already exists) |
| Session file path | `openclaw/openclaw-executor.ts:107` | Path stale after OC update | Store sessionId, resolve at read time |
| `formatTaskInstruction` prompt | `openclaw/openclaw-executor.ts:301-317` | Prompt changes affect all agents | Review prompt diff before deployment |

---

## Sources

- Direct codebase analysis of AOF v1.4 source (2826+ tests, TypeScript)
- `src/dispatch/assign-executor.ts` -- fallback completion path (onRunComplete callback)
- `src/openclaw/openclaw-executor.ts` -- session file path resolution, embedded agent launch
- `src/schemas/protocol.ts` -- CompletionReportPayload schema
- `src/schemas/task.ts` -- TaskFrontmatter schema, metadata bag
- `src/schemas/event.ts` -- EventType enum (60+ entries)
- `src/context/budget.ts` -- token estimation and budget evaluation
- `src/dispatch/scheduler.ts` -- poll loop structure and performance constraints
- `src/dispatch/failure-tracker.ts` -- deadletter transition logic (3 failures threshold)
- `skills/aof/SKILL.md` -- agent skill injection (1665 tokens, 2150 ceiling)
- `skills/aof/SKILL-SEED.md` -- seed tier (563 tokens)
- OpenClaw test mocks showing `.jsonl` session file format (`resolveSessionFilePath`)
