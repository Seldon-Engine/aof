# Feature Landscape: Agent Event Tracing & Session Observability

**Domain:** Agent orchestration observability (AOF v1.5)
**Researched:** 2026-03-06

## Context

This is a SUBSEQUENT MILESTONE (v1.5). AOF already has:
- Task lifecycle with completion reports, failure tracking (3 failures -> deadletter)
- `aof_task_complete` MCP tool for explicit task completion
- `AgentRunOutcome` callback in `onRunComplete` with success/aborted/error/durationMs
- JSONL event logging (append-only, daily rotation)
- OpenClaw session files at `~/.openclaw/agents/<agent>/sessions/<sessionId>.jsonl`
- SKILL.md context injection (seed and full tiers, 2150-token budget ceiling)
- `resolveSessionFilePath()` available in OpenClawAdapter (session file path known at spawn time)

**The core problem:** Agents can hallucinate task completion. An agent exited cleanly without making meaningful tool calls, and AOF trusted the exit code (via `onRunComplete` callback) to mark the task done. The existing fallback in `assign-executor.ts` lines 191-195 auto-transitions `review -> done` on success -- this IS the hallucination pathway. Zero visibility into what agents actually did.

---

## Table Stakes

Features required for this milestone to solve the stated problem. Without these, v1.5 delivers no value.

### 1. Completion Enforcement (Don't Trust Exit Codes)

| Aspect | Detail |
|--------|--------|
| Why Expected | Core problem statement. The `onRunComplete` fallback in `assign-executor.ts` currently auto-completes tasks when agent exits successfully without calling `aof_task_complete`. This must stop. |
| Complexity | LOW |
| Depends On | `assign-executor.ts` onRunComplete callback (lines 181-226) |

**What must change:**

The existing fallback at `assign-executor.ts` lines 191-195 does:
```typescript
if (outcome.success) {
  await store.transition(action.taskId, "review", { reason: "dispatch.fallback: agent completed without calling aof_task_complete" });
  await store.transition(action.taskId, "done", { reason: "dispatch.fallback: auto-completed after successful agent run" });
}
```

This must change to:
```typescript
if (outcome.success) {
  await store.transition(action.taskId, "blocked", {
    reason: "no_explicit_completion: agent exited successfully but did not call aof_task_complete"
  });
}
```

The task stays blocked, not done. The operator can inspect via `aof trace` and decide to re-dispatch or manually complete.

**Confidence:** HIGH -- surgical code change, path is fully identified.

---

### 2. Session Trace Capture

| Aspect | Detail |
|--------|--------|
| Why Expected | Cannot diagnose what agent did without reading its session transcript. OpenClaw writes JSONL session files that contain every tool call, every response, every reasoning block. |
| Complexity | MEDIUM |
| Depends On | `OpenClawAdapter.resolveSessionFilePath()`, OpenClaw session JSONL format |

**Session JSONL format (verified from real files):**

Each line is a JSON object with a `type` field. Relevant types:
- `session` -- session metadata (id, timestamp, cwd)
- `model_change` -- provider/model selection
- `thinking_level_change` -- reasoning level
- `message` -- user/assistant messages containing:
  - `type: "text"` -- plain text
  - `type: "thinking"` -- reasoning blocks
  - `type: "toolCall"` -- tool invocations (name, id, arguments)
  - `type: "toolResult"` -- tool outputs
- `compaction` -- session was compacted (long sessions get summarized)
- `custom` -- OpenClaw-specific events (model snapshots, cache TTL)

**What AOF must do:**

1. After `onRunComplete` fires, read the session JSONL file using the path from `resolveSessionFilePath(sessionId)`
2. Parse each line, extract:
   - Tool calls: name, arguments (truncated), success/error
   - AOF tool calls specifically: `aof_task_complete`, `aof_task_update`, `aof_status_report`
   - Timestamps for duration calculation per tool call
   - Whether reasoning was used (thinking blocks present)
   - Final assistant message (likely contains completion summary)
3. Handle edge cases:
   - Session file may not exist (agent crashed before writing)
   - Session file may have `.deleted.*` suffix (OpenClaw prunes old sessions)
   - Session file may be large (100KB-1MB) -- stream line-by-line, don't load entire file into memory
   - `compaction` events mean earlier messages were summarized

**Confidence:** HIGH -- session JSONL format verified from real data at `~/.openclaw/agents/swe-backend/sessions/`.

---

### 3. Trace File Storage

| Aspect | Detail |
|--------|--------|
| Why Expected | Extracted trace data must persist in the task directory alongside existing `run.json`, `run_result.json`, `run_heartbeat.json`. |
| Complexity | LOW |
| Depends On | Task store path structure, `RunArtifact` schema pattern |

**What AOF must do:**

Write `trace.json` to the task work directory with a structured schema:

```typescript
const TraceFile = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  capturedAt: z.string().datetime(),
  duration: z.object({
    totalMs: z.number(),
    firstToolCallMs: z.number().optional(),  // time to first tool call
    lastToolCallMs: z.number().optional(),   // time of last tool call
  }),
  toolCalls: z.array(z.object({
    name: z.string(),
    category: z.enum(["aof", "file_read", "file_write", "shell", "web", "other"]),
    timestamp: z.string().datetime().optional(),
    success: z.boolean(),
    errorSummary: z.string().optional(),
  })),
  summary: z.object({
    totalToolCalls: z.number(),
    aofToolCalls: z.number(),
    fileReads: z.number(),
    fileWrites: z.number(),
    shellCommands: z.number(),
    completionCalled: z.boolean(),
    hasThinking: z.boolean(),
  }),
  flags: z.array(z.enum([
    "no_completion_call",      // agent never called aof_task_complete
    "no_tool_calls",           // agent made zero tool calls
    "no_file_modifications",   // agent read files but never wrote
    "completion_without_work", // agent called aof_task_complete but made no other tool calls
  ])).default([]),
  // Debug-only fields (populated when task has debug: true)
  reasoning: z.array(z.object({
    timestamp: z.string().datetime().optional(),
    text: z.string(),
  })).optional(),
});
```

Location: `tasks/<status>/<task-id>/trace.json` -- same directory as `run.json`.

**Confidence:** HIGH -- follows established pattern of run artifacts.

---

### 4. Trace CLI (`aof trace <task-id>`)

| Aspect | Detail |
|--------|--------|
| Why Expected | Operators need a quick way to see what an agent did. Raw JSONL is unreadable. |
| Complexity | MEDIUM |
| Depends On | Trace file storage, Commander.js CLI framework |

**Two modes:**

**Default (summary):**
```
$ aof trace TASK-2026-03-06-abc

Task: TASK-2026-03-06-abc
Agent: swe-backend | Session: 509ebb91-...
Duration: 4m 23s | Tool calls: 37

Tool Summary:
  aof_task_complete  1  (called)
  file read         12
  file write         8
  shell (exec)      14
  web fetch          2

Flags: (none)
Status: Completed normally
```

**Debug (`--debug`):**
```
$ aof trace TASK-2026-03-06-abc --debug

[same header as above]

Tool Call Timeline:
  00:00  exec        git status
  00:02  read        src/memory/store/vector-store.ts
  00:05  read        src/memory/store/schema.ts
  ...
  04:21  aof_task_complete  taskId=TASK-2026-03-06-abc summary="Fixed integer binding..."

Reasoning Excerpts: (3 blocks)
  [1] "Investigating primary key type mismatch..."
  [2] "The error suggests sqlite-vec requires integer..."
  [3] "Planning to cast the limit parameter..."
```

**Confidence:** HIGH -- follows existing CLI command patterns (`aof smoke`).

---

### 5. SKILL.md Completion Guidance

| Aspect | Detail |
|--------|--------|
| Why Expected | Agents must be instructed to provide meaningful completion reports. Current SKILL.md doesn't mention completion quality expectations. |
| Complexity | LOW |
| Depends On | `skills/aof/SKILL.md`, `skills/aof/SKILL-SEED.md`, context budget gate (2150 token ceiling, current full SKILL.md is 1665 tokens = ~485 tokens headroom) |

**What to add to SKILL.md (under "Workflow Patterns" section):**

```markdown
### Completion Requirements

When finishing work, call `aof_task_complete` with:
- `summary`: What you did and why (not just "done"). Include files changed and key decisions.
- `outputs`: List of files created or modified.
Your session is traced. Exiting without calling `aof_task_complete` blocks the task for operator review.
```

~50 tokens. Fits within budget.

**What to add to SKILL-SEED.md:**

Same text, shortened to ~30 tokens:
```markdown
**Completion:** Always call `aof_task_complete` with meaningful summary and outputs list. Exiting without it blocks the task.
```

**Also update `formatTaskInstruction()` in `openclaw-executor.ts`** (already has completion reminder at line 314) to reinforce the "will be blocked" consequence:

Change: `"your work will be lost"` to `"your work will be blocked for operator review and your session will be traced for investigation."`

**Confidence:** HIGH -- small text changes, fits token budget.

---

## Differentiators

Features that go beyond the minimum viable tracing. Not required for solving the core problem, but significantly increase the value of the tracing infrastructure.

| Feature | Value Proposition | Complexity | Dependencies | Notes |
|---------|-------------------|------------|-------------|-------|
| **Retry-aware trace accumulation** | When a task fails and retries, store traces as `trace_history[]` so the next agent sees what prior agents tried and failed at. Prevents repeating the same mistakes across retries. | Medium | Trace file storage, failure tracker | High value: the 3-failure deadletter pathway currently loses all diagnostic context. Each retry starts blind. Store previous traces alongside current trace. |
| **No-op detection** | Automatically flag sessions where agent made zero meaningful tool calls. Emit `trace.suspicious_completion` event. | Low | Tool call extraction (part of trace capture) | Directly addresses the triggering incident. Zero file writes + zero shell commands + `aof_task_complete` called = suspicious. Can integrate with existing notification rules for alerting. |
| **Prior-failure injection** | When dispatching a retry, include a "Previous attempts" section in the task instruction showing what prior agents tried and why they failed. | Medium | Retry-aware trace accumulation, `formatTaskInstruction()` | Must respect context budget. Include only: tool call summary, error message, duration. NOT full reasoning (too large). |
| **Trace event emission** | Emit JSONL events for trace lifecycle: `trace.captured`, `trace.suspicious_completion`, `trace.no_completion_call`. | Low | EventLogger, trace capture | Extends existing event types. Enables downstream alerting via existing notification rules. |
| **Debug flag on tasks** | Per-task `debug: true` metadata flag controls trace verbosity. Debug tasks capture full reasoning; normal tasks get tool-call-only summary. | Low | Task metadata, trace capture | Reasoning extraction produces large data (thinking blocks can be paragraphs). Default to summary-only. Debug flag enables full capture. Operator sets debug when investigating a problem task. |
| **Trace retention policy** | Auto-prune trace files for done tasks older than N days. Keep traces for deadlettered tasks indefinitely (forensics). | Low | Trace file storage | Prevents unbounded disk usage. Deadletter traces are the most valuable for understanding systemic failures. |

---

## Anti-Features

Features to explicitly NOT build for v1.5.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **OpenTelemetry integration** | Explicitly deferred to v2 in PROJECT.md. Adds external dependency (OTel collector). AOF is a single-machine filesystem-based tool -- OTel is designed for distributed systems. | File-based trace storage with JSONL events is sufficient. |
| **Real-time session streaming** | The problem is post-hoc investigation ("what did the agent do?"), not live monitoring. Would require WebSocket infrastructure, inter-process communication. | Capture traces after session completes. `aof trace` inspects after the fact. |
| **Dashboard / web UI** | Already out of scope per PROJECT.md. Would be a separate milestone with its own research. | `aof trace` CLI with formatted terminal output. |
| **Full session replay** | Storing entire session transcripts (100KB-1MB each) in task directories would bloat the filesystem store rapidly. 244 session files for one agent alone. | Extract structured summary (tool calls, flags, key reasoning snippets). Reference original session file path for full replay if needed. |
| **Automatic self-healing from traces** | Tempting to auto-resurrect blocked tasks based on trace analysis, but violates "no LLMs in control plane" for any intelligent healing, and "self-healing" is explicitly mentioned as deferred. | Capture and store traces. Surface flags. Let operators decide via `aof trace` + manual action. |
| **Cross-task trace correlation** | Building a trace graph across DAG workflow hops adds schema complexity without solving the immediate problem. | Store per-task traces independently. DAG workflow already tracks hop-level status. |
| **Reasoning quality scoring** | Using an LLM to evaluate reasoning quality from traces violates "no LLMs in control plane." | Expose reasoning via `--debug` flag. Let operators judge quality themselves. |
| **Session file management** | Cleaning up, archiving, or rotating OpenClaw session files. This is OpenClaw's responsibility, not AOF's. | Read session files as needed. Never write to or delete OpenClaw session directories. |

---

## Feature Dependencies

```
Completion enforcement ------> (independent, no deps -- change fallback behavior)
SKILL.md guidance -----------> (independent, no deps -- text changes)

Session trace capture -------> Trace file storage (need somewhere to write extracted traces)
Trace file storage ----------> Trace CLI (CLI reads stored trace.json files)
Trace file storage ----------> No-op detection (needs structured tool call data)
Trace file storage ----------> Trace event emission (emit events based on trace analysis)
Trace file storage ----------> Debug flag on tasks (controls what gets stored in trace)

Trace file storage ----------> Retry-aware trace accumulation (store trace history)
Retry-aware accumulation ----> Prior-failure injection (inject history into task prompt)
```

### Build Order Implications

1. **Completion enforcement and SKILL.md are independent** -- can ship as a quick fix before any trace infrastructure exists. Highest ROI, lowest effort.
2. **Session trace capture -> Trace file storage is the critical path** -- everything else depends on having structured trace data.
3. **Trace CLI is the user-visible payoff** -- should come immediately after trace storage works.
4. **Retry-aware accumulation and prior-failure injection are a paired feature** -- defer together if needed.

---

## MVP Recommendation

### Phase 1: Stop the bleeding (completion enforcement)

1. **Completion enforcement** -- Change `onRunComplete` fallback to block instead of auto-complete.
2. **SKILL.md completion guidance** -- Add explicit instructions about meaningful completion reports.
3. **Update `formatTaskInstruction()`** -- Reinforce consequences of not calling `aof_task_complete`.

Rationale: Immediately stops hallucinated completions. No new infrastructure needed.

### Phase 2: See what happened (trace infrastructure)

4. **Session trace capture** -- Parse OpenClaw session JSONL, extract tool calls.
5. **Trace file storage** -- Write `trace.json` to task directory.
6. **No-op detection** -- Flag suspicious sessions automatically.
7. **Trace event emission** -- Integrate flags with existing event system.

Rationale: Core trace infrastructure. After this phase, every agent session produces structured observability data.

### Phase 3: Investigate (CLI + debug)

8. **Trace CLI** -- `aof trace <task-id>` with summary and `--debug` modes.
9. **Debug flag on tasks** -- Per-task verbosity control for full reasoning capture.

Rationale: Makes trace data accessible to operators. The payoff for phases 1-2.

### Defer to v1.6:

- **Retry-aware trace accumulation** -- Valuable but adds complexity to trace storage schema.
- **Prior-failure injection** -- Depends on retry-aware accumulation.
- **Trace retention policy** -- Not urgent until disk usage becomes a concern.

---

## Complexity Budget

| Feature | Estimated Effort | Risk |
|---------|-----------------|------|
| Completion enforcement | 1-2 hours | Low -- surgical change in existing callback |
| SKILL.md updates | 30 min | Low -- must fit token budget (verified: ~485 tokens headroom) |
| formatTaskInstruction update | 15 min | Low -- one string change |
| Session trace capture | 4-6 hours | Medium -- JSONL streaming parser, edge cases (missing files, `.deleted` suffix, large files) |
| Trace file storage (schema + writer) | 2-3 hours | Low -- follows `RunArtifact` pattern |
| No-op detection | 1 hour | Low -- counting logic on extracted trace data |
| Trace event emission | 1 hour | Low -- extends existing EventLogger |
| Trace CLI | 3-4 hours | Low -- follows existing CLI patterns (Commander.js) |
| Debug flag | 1 hour | Low -- metadata field + conditional in trace capture |
| **Total MVP (Phases 1-3)** | **~2-3 days** | |

---

## Key Observations from Codebase

1. **The hallucination pathway is exactly identified.** `assign-executor.ts` lines 191-195: `outcome.success` triggers `review -> done` without any verification of what the agent actually did. The fix is a two-line change.

2. **Session file path is available at spawn time.** `OpenClawAdapter` already calls `ext.resolveSessionFilePath(sessionId)` (line 107). The session ID is stored in task metadata (line 236). Path resolution is a solved problem.

3. **Session JSONL is well-structured and parseable.** Verified from real data: `type: "message"` entries contain `toolCall` and `toolResult` content blocks with tool names. Categories can be derived from tool names (`aof_*`, `exec`, `read`, `write`, `web_fetch`, etc.).

4. **Session files vary wildly in size.** From 2KB (quick tasks) to 1MB+ (complex debugging sessions). Must use streaming JSONL parser (readline), not `JSON.parse(readFile())`.

5. **Some session files have `.deleted.*` suffix.** OpenClaw appears to soft-delete sessions by renaming. Trace capture must handle this: try the canonical path first, then glob for `<sessionId>.jsonl.deleted.*`.

6. **Token budget is tight but sufficient.** Full SKILL.md is 1665 tokens. Budget ceiling is 2150. That leaves ~485 tokens for additions. The proposed ~50 token addition fits comfortably.

7. **Existing run artifact pattern is the template.** `run.json`, `run_result.json`, `run_heartbeat.json` already live in task directories with Zod schemas and atomic writes. `trace.json` follows the identical pattern.

8. **The `onRunComplete` callback is the natural hook.** It already fires after agent completion with `AgentRunOutcome`. Adding trace capture here means: agent finishes -> read session JSONL -> extract trace -> write `trace.json` -> check flags -> emit events -> apply completion enforcement logic.

---

## Sources

- Codebase: `src/dispatch/assign-executor.ts` lines 181-226 -- fallback completion logic (HIGH confidence, examined directly)
- Codebase: `src/openclaw/openclaw-executor.ts` -- session lifecycle, `resolveSessionFilePath`, `runAgentBackground` (HIGH confidence)
- Codebase: `src/schemas/run.ts`, `src/schemas/run-result.ts` -- existing run artifact schemas (HIGH confidence)
- Codebase: `src/events/logger.ts` -- JSONL event infrastructure (HIGH confidence)
- Codebase: `skills/aof/SKILL.md` -- current agent instructions, 1665 tokens (HIGH confidence)
- Codebase: `skills/aof/SKILL-SEED.md` -- seed tier instructions (HIGH confidence)
- Codebase: `src/mcp/tools.ts` -- `aof_task_complete` tool registration and schema (HIGH confidence)
- Real data: `~/.openclaw/agents/swe-backend/sessions/*.jsonl` -- verified JSONL format, message types, tool call structure (HIGH confidence)
- Real data: 244 session files observed for swe-backend agent, sizes 2KB-1MB (HIGH confidence)

---
*Feature research for: AOF v1.5 Event Tracing & Session Observability*
*Researched: 2026-03-06*
