# Architecture Patterns: Agent Event Tracing and Session Observability (v1.5)

**Domain:** Event tracing, completion enforcement, session trace capture for AOF agent orchestration
**Researched:** 2026-03-06
**Confidence:** HIGH (direct source code analysis of all integration points, no external dependencies)

## Executive Summary

AOF v1.4 shipped context optimization but agents remain opaque. When an agent completes (or fails), AOF knows the outcome but not what happened during the session. The v1.5 milestone adds three capabilities: (1) completion enforcement so agents cannot silently exit without reporting, (2) session trace capture that pulls OpenClaw transcripts into the task's artifact tree, and (3) a CLI that surfaces traces for debugging.

The architecture challenge is that these three features touch different layers but share a critical timing dependency: trace capture must happen after the agent session ends but before the task transitions to its final state. The existing `onRunComplete` callback in `assign-executor.ts` is the natural hook point, but it currently handles only the fallback case (agent didn't call `aof_task_complete`). The architecture must extend this callback to always capture traces while preserving the existing fallback logic.

This document maps every integration point, specifies new vs. modified components, defines data flow changes, and provides a dependency-ordered build sequence.

---

## 1. Current Architecture (As-Is State)

### 1.1 Agent Session Lifecycle

```
Scheduler poll()
  |
  +-- executeAssignAction() in assign-executor.ts
  |     +-- acquireLease()
  |     +-- executor.spawnSession(context, { onRunComplete })
  |           |
  |           +-- OpenClawAdapter.spawnSession()
  |                 +-- runAgentBackground() [fire-and-forget]
  |                       |
  |                       +-- runEmbeddedPiAgent()   # Agent executes
  |                       |     +-- agent calls aof_task_complete (tool)
  |                       |     |     +-- writes run_result.json
  |                       |     |     +-- sends completion.report envelope
  |                       |     |     +-- ProtocolRouter.handleCompletionReport()
  |                       |     |           +-- writeRunResult()
  |                       |     |           +-- applyCompletionOutcome()
  |                       |     |           +-- completeRunArtifact()
  |                       |     |           +-- cascadeOnCompletion()
  |                       |     |
  |                       |     +-- OR: agent exits WITHOUT calling aof_task_complete
  |                       |
  |                       +-- builds AgentRunOutcome
  |                       +-- calls onRunComplete(outcome)
  |                             |
  |                             +-- stopLeaseRenewal()
  |                             +-- if task still in-progress:
  |                                   +-- FALLBACK: transition review->done or blocked
```

### 1.2 Key Observations

**Two completion paths exist today:**

| Path | Trigger | Where | What Happens |
|------|---------|-------|--------------|
| **Happy path** | Agent calls `aof_task_complete` tool | `ProtocolRouter.handleCompletionReport()` | run_result.json written, task transitions, cascade |
| **Fallback path** | Agent exits without `aof_task_complete` | `onRunComplete` callback in `assign-executor.ts` | Task auto-transitioned based on exit code |

**Critical gap:** The fallback path (lines 172-226 of `assign-executor.ts`) auto-transitions the task to `done` if the agent "succeeded" (exit code 0). This trusts the exit code, which is exactly what v1.5 must stop doing.

**OpenClaw session transcripts** live at `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`. Each line is a turn with role, model, token counts, tool calls, and text content. The `sessionId` is already tracked in task metadata (line 232-242 of `assign-executor.ts`) and in `AgentRunOutcome`.

**Run artifacts** live at `<projectRoot>/state/runs/<taskId>/` and already include `run.json` (lifecycle), `run_result.json` (completion data), and `run_heartbeat.json` (liveness).

### 1.3 DAG Path Session Lifecycle

For DAG workflow tasks, the completion flow is different:

```
onRunComplete fires
  |
  +-- ProtocolRouter.handleSessionEnd()
        +-- for each in-progress DAG task with run_result:
              +-- handleDAGHopCompletion()
              +-- completeRunArtifact()
              +-- dispatch next hop or complete DAG
```

The DAG path consumes `run_result.json` and advances the workflow. Trace capture must work for both simple tasks and DAG hop completions.

---

## 2. Recommended Architecture

### 2.1 Component Architecture

```
                    +--------------------------+
                    |    CLI Layer (new)        |
                    |  aof trace <task-id>      |
                    |    --debug, --json        |
                    +--------+-----------------+
                             |
                             | reads
                             v
                    +--------------------------+
                    |  Trace Store (new)        |
                    |  src/trace/store.ts       |
                    |  - readTrace(taskId)      |
                    |  - writeTrace(taskId, t)  |
                    |  - listTraces(taskId)     |
                    +--------+-----------------+
                             |
                             | writes to
                             v
            +-----------------------------------+
            | Task Artifact Tree (existing)     |
            | <projectRoot>/state/runs/<taskId>/|
            |   run.json          (existing)    |
            |   run_result.json   (existing)    |
            |   run_heartbeat.json(existing)    |
            |   trace.json        (NEW)         |
            +-----------------------------------+
                             ^
                             | captures
                             |
                    +--------------------------+
                    |  Trace Capture (new)      |
                    |  src/trace/capture.ts     |
                    |  - captureSessionTrace()  |
                    |  - reads OpenClaw JSONL   |
                    |  - writes trace.json      |
                    +--------+-----------------+
                             ^
                             | invoked by
                             |
     +----------------------------------------------+
     |  Completion Handler (modified)                |
     |  src/dispatch/completion-handler.ts (new)     |
     |  - handleAgentCompletion()                    |
     |  - enforces explicit completion               |
     |  - captures trace                             |
     |  - then delegates to existing transition logic|
     +----------------------------------------------+
                             ^
                             | called from
                             |
     +----------------------------------------------+
     |  Assign Executor (modified)                   |
     |  onRunComplete callback refactored to call    |
     |  completion-handler.handleAgentCompletion()   |
     +----------------------------------------------+
```

### 2.2 Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| `src/trace/capture.ts` (NEW) | Read OpenClaw session JSONL, parse turns, compute stats, write structured trace | OpenClaw filesystem, trace store |
| `src/trace/store.ts` (NEW) | Read/write trace.json to task artifact tree | Run artifacts filesystem |
| `src/trace/types.ts` (NEW) | Zod schemas for SessionTrace, TraceTurn, TraceStats | Used by capture, store, CLI |
| `src/dispatch/completion-handler.ts` (NEW) | Centralized post-session logic: enforce completion, capture trace, delegate transitions | assign-executor, trace capture, protocol router |
| `src/cli/commands/trace.ts` (NEW) | `aof trace <task-id>` command with summary/debug/json output | Trace store, task store |
| `src/dispatch/assign-executor.ts` (MODIFIED) | onRunComplete callback simplified to delegate to completion-handler | Completion handler |
| `src/context/skills.ts` + SKILL.md (MODIFIED) | Updated instructions requiring explicit `aof_task_complete` | Agent sessions |

### 2.3 Data Flow

#### Trace Capture Flow (New)

```
Agent session completes (success or failure)
  |
  +-- OpenClawAdapter.runAgentBackground() fires onRunComplete(outcome)
  |
  +-- assign-executor.ts onRunComplete callback
        |
        +-- completionHandler.handleAgentCompletion(outcome, taskId, correlationId)
              |
              +-- 1. Stop lease renewal (existing)
              |
              +-- 2. Capture session trace (NEW)
              |     +-- resolve session JSONL path from agentId + sessionId
              |     +-- captureSessionTrace(sessionPath, taskId, sessionId)
              |           +-- read ~/.openclaw/agents/<agent>/sessions/<sessionId>.jsonl
              |           +-- parse each line -> TraceTurn[]
              |           +-- compute TraceStats (turns, tokens, tools, duration)
              |           +-- write trace.json to state/runs/<taskId>/trace.json
              |
              +-- 3. Check completion status (MODIFIED)
              |     +-- re-read task from store
              |     +-- if task NOT in-progress -> agent already completed (happy path)
              |     |     return (trace captured, done)
              |     +-- if task still in-progress -> enforcement kicks in
              |
              +-- 4. Completion enforcement (NEW)
                    +-- if outcome.success:
                    |     +-- DO NOT auto-complete to done
                    |     +-- transition to blocked with reason:
                    |     |   "agent_completed_without_aof_task_complete"
                    |     +-- log enforcement event
                    |
                    +-- if outcome.error or outcome.aborted:
                          +-- transition to blocked (same as today, but with better reason)
                          +-- log error event
```

#### Trace Read Flow (New)

```
User runs: aof trace <task-id>
  |
  +-- resolve task (store.get or store.getByPrefix)
  +-- read trace.json from state/runs/<taskId>/trace.json
  +-- format output:
        +-- default: summary (agent, duration, tokens, outcome, tool calls count)
        +-- --debug: full turn-by-turn with tool calls and text
        +-- --json: raw trace.json content
```

#### DAG Trace Capture Flow

For DAG tasks, each hop gets its own trace. The trace file uses the hop ID as a discriminator:

```
DAG hop completes
  |
  +-- handleSessionEnd() in router.ts
        |
        +-- captureSessionTrace() for the hop
        |     +-- write to state/runs/<taskId>/trace-<hopId>.json
        |
        +-- handleDAGHopCompletion() (existing)
        +-- dispatch next hop (existing)
```

The `aof trace` command shows all traces for a task, with hop labels for DAG tasks.

---

## 3. New Components

### 3.1 Trace Types (`src/trace/types.ts`)

```typescript
import { z } from "zod";

export const TraceTurn = z.object({
  index: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "system", "tool_result"]),
  model: z.string().optional(),
  tokenCount: z.number().int().nonnegative().optional(),
  toolCalls: z.array(z.object({
    name: z.string(),
    input: z.record(z.unknown()).optional(),
  })).default([]),
  textPreview: z.string().max(500).optional(),  // First 500 chars for debug view
  timestamp: z.string().datetime().optional(),
});

export const TraceStats = z.object({
  totalTurns: z.number().int().nonnegative(),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  uniqueToolsUsed: z.array(z.string()),
  durationMs: z.number().int().nonnegative(),
  model: z.string().optional(),
});

export const SessionTrace = z.object({
  version: z.literal(1),
  taskId: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  hopId: z.string().optional(),  // Present for DAG hop traces
  capturedAt: z.string().datetime(),
  outcome: z.enum(["completed", "failed", "aborted", "enforcement_blocked"]),
  stats: TraceStats,
  turns: z.array(TraceTurn),
});

export type TraceTurn = z.infer<typeof TraceTurn>;
export type TraceStats = z.infer<typeof TraceStats>;
export type SessionTrace = z.infer<typeof SessionTrace>;
```

### 3.2 Trace Capture (`src/trace/capture.ts`)

Responsibility: Read OpenClaw session JSONL, parse into structured trace, compute stats.

Key design decisions:
- **Read-only with respect to OpenClaw** -- never modify session files, only read
- **Graceful degradation** -- if session file missing or unreadable, log warning and skip (do not block task transitions)
- **Size cap** -- truncate trace to last N turns (configurable, default 200) to avoid unbounded memory use
- **Text preview** -- store only first 500 chars of assistant responses (full text stays in OpenClaw)

OpenClaw session JSONL format (each line):
```json
{"role":"user","text":"...","model":"...","inputTokens":N,"outputTokens":N,"toolCalls":[{"name":"..."}],...}
```

The capture function resolves the session file path using the `extensionAPI.resolveSessionFilePath()` already loaded by `OpenClawAdapter`, or falls back to the convention: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`.

### 3.3 Trace Store (`src/trace/store.ts`)

Thin wrapper over the existing run artifacts filesystem:

```typescript
export async function writeTrace(
  store: ITaskStore,
  taskId: string,
  trace: SessionTrace,
  hopId?: string,
): Promise<void> {
  // Writes to: <projectRoot>/state/runs/<taskId>/trace.json
  // Or for DAG hops: <projectRoot>/state/runs/<taskId>/trace-<hopId>.json
}

export async function readTrace(
  store: ITaskStore,
  taskId: string,
  hopId?: string,
): Promise<SessionTrace | undefined> { ... }

export async function listTraces(
  store: ITaskStore,
  taskId: string,
): Promise<Array<{ hopId?: string; trace: SessionTrace }>> { ... }
```

### 3.4 Completion Handler (`src/dispatch/completion-handler.ts`)

Centralizes the post-session logic currently split between `assign-executor.ts` (fallback) and `ProtocolRouter` (happy path). The handler:

1. Always captures the trace (regardless of completion path)
2. Enforces explicit completion (new behavior)
3. Delegates state transitions to existing code

```typescript
export interface CompletionHandlerDeps {
  store: ITaskStore;
  logger: EventLogger;
  /** Agent ID for resolving session file path */
  agentId: string;
  /** Correlation ID from dispatch */
  correlationId?: string;
}

export async function handleAgentCompletion(
  outcome: AgentRunOutcome,
  deps: CompletionHandlerDeps,
): Promise<void> {
  // 1. Stop lease renewal
  stopLeaseRenewal(deps.store, outcome.taskId);

  // 2. Capture trace (best-effort, never blocks transitions)
  try {
    await captureAndStoreTrace(outcome, deps);
  } catch (err) {
    console.warn(`[AOF] Trace capture failed for ${outcome.taskId}: ${(err as Error).message}`);
  }

  // 3. Re-read task
  const task = await deps.store.get(outcome.taskId);
  if (!task) return;

  // 4. If task already transitioned (agent called aof_task_complete) -> done
  if (task.frontmatter.status !== "in-progress") return;

  // 5. Enforcement: agent exited without aof_task_complete
  await enforceCompletion(outcome, task, deps);
}
```

### 3.5 Trace CLI (`src/cli/commands/trace.ts`)

New `aof trace <task-id>` command:

```
aof trace <task-id>           # Summary: agent, duration, tokens, outcome, tool count
aof trace <task-id> --debug   # Full turn-by-turn with tool calls
aof trace <task-id> --json    # Raw trace JSON
aof trace <task-id> --hop <id> # Specific DAG hop trace
```

Summary output format:
```
Task: TASK-abc123 "Implement auth module"
Agent: swe-backend
Session: 7a3f...
Duration: 4m 32s
Tokens: 12,450 in / 8,200 out
Tool calls: 23 (Read: 8, Edit: 6, Bash: 5, aof_task_complete: 1, ...)
Outcome: completed
```

Debug output adds turn-by-turn:
```
[1] user: Execute the task: TASK-abc123...
[2] assistant: I'll start by reading the task file... [tools: Read(1)]
[3] tool_result: (Read result)
[4] assistant: Now I'll implement... [tools: Edit(2), Bash(1)]
...
```

---

## 4. Modified Components

### 4.1 `assign-executor.ts` onRunComplete Callback

**Current:** Lines 172-226 contain inline fallback logic.
**Change:** Replace inline logic with call to `handleAgentCompletion()`.

```typescript
// BEFORE (current):
onRunComplete: async (outcome) => {
  stopLeaseRenewal(store, action.taskId);
  const currentTask = await store.get(action.taskId);
  if (!currentTask) return;
  if (currentTask.frontmatter.status !== "in-progress") return;
  // ... inline fallback transitions
}

// AFTER (v1.5):
onRunComplete: async (outcome) => {
  await handleAgentCompletion(outcome, {
    store,
    logger,
    agentId: action.agent!,
    correlationId,
  });
}
```

This is a **refactor with behavior change**: the new handler captures traces for ALL completions (not just fallback) and changes the enforcement behavior (block instead of auto-complete).

### 4.2 `ProtocolRouter.handleSessionEnd()` (DAG path)

**Current:** Processes run_result for DAG hop completion.
**Change:** Add trace capture call before processing DAG transitions.

The trace capture call is added inside the lock, after reading run_result but before `handleDAGHopCompletion()`. The hop's `correlationId` from workflow state provides the session ID.

### 4.3 SKILL.md Updates

The SKILL.md content injected into agent sessions needs stronger language about `aof_task_complete`:

**Current instruction (in `formatTaskInstruction` of `openclaw-executor.ts`, line 314):**
```
**IMPORTANT:** When you have completed this task, call the `aof_task_complete` tool...
```

**v1.5 change:** Strengthen to convey consequence:
```
**MANDATORY:** You MUST call `aof_task_complete` when done. If you exit without calling it,
your work will be marked as incomplete and the task will be blocked for manual review.
The trace of your session will be captured for debugging.
```

This also requires updating the compressed SKILL.md in the skills directory and verifying the budget gate CI test still passes.

### 4.4 Event Schema Extension

Add new event types to `src/schemas/event.ts`:

| Event Type | When | Payload |
|------------|------|---------|
| `trace.captured` | After successful trace capture | `{ taskId, sessionId, hopId?, stats }` |
| `trace.capture_failed` | When trace capture fails | `{ taskId, sessionId, error }` |
| `completion.enforcement` | When agent exits without aof_task_complete | `{ taskId, sessionId, agentId, durationMs, outcome }` |

---

## 5. Patterns to Follow

### Pattern 1: Best-Effort Trace Capture

**What:** Trace capture must never block or fail task state transitions. If the OpenClaw session file is missing, corrupted, or unreadable, log a warning and continue.

**When:** Every trace capture invocation.

**Example:**
```typescript
async function captureAndStoreTrace(
  outcome: AgentRunOutcome,
  deps: CompletionHandlerDeps,
): Promise<void> {
  const sessionPath = resolveSessionPath(deps.agentId, outcome.sessionId);

  let turns: TraceTurn[];
  try {
    turns = await parseSessionJSONL(sessionPath);
  } catch {
    // Session file missing or unreadable -- log and return
    await deps.logger.log("trace.capture_failed", "system", {
      taskId: outcome.taskId,
      payload: { sessionId: outcome.sessionId, error: "session_file_unreadable" },
    });
    return;
  }

  const stats = computeStats(turns, outcome.durationMs);
  const trace: SessionTrace = {
    version: 1,
    taskId: outcome.taskId,
    sessionId: outcome.sessionId,
    agentId: deps.agentId,
    capturedAt: new Date().toISOString(),
    outcome: mapOutcome(outcome),
    stats,
    turns,
  };

  await writeTrace(deps.store, outcome.taskId, trace);
}
```

### Pattern 2: Enforcement as Blocked (Not Failed)

**What:** When an agent exits without calling `aof_task_complete`, the task transitions to `blocked` (not `done`). This preserves the work the agent did while flagging that explicit completion was missing.

**When:** Completion enforcement in the completion handler.

**Rationale:**
- `blocked` is correct because the task needs human review to determine if the work was actually completed
- `done` is wrong because it trusts the exit code, which is the exact problem v1.5 solves
- `deadletter` is too aggressive -- the agent may have done useful work
- The trace provides the evidence needed to decide what to do next

### Pattern 3: Trace at Artifact Level (Not Event Level)

**What:** Session traces are stored as structured JSON files in the task's run artifact directory, not as event log entries.

**When:** All trace storage.

**Rationale:**
- Event log (JSONL) is append-only, daily-rotated, hard to query for a specific task
- Run artifacts are task-scoped, already indexed by task ID, already used for `run.json` and `run_result.json`
- Traces can be large (hundreds of turns) -- event log entries should be small
- The event log gets a `trace.captured` event with stats (lightweight pointer), the trace.json has full content

### Pattern 4: Centralized Completion Handler

**What:** Extract post-session logic into a single `completion-handler.ts` instead of having it split between `assign-executor.ts` (fallback) and `ProtocolRouter` (happy path).

**When:** v1.5 refactoring.

**Rationale:**
- Currently, trace capture would need to be added in TWO places (the callback and the protocol router)
- Both paths need enforcement logic
- A single handler makes the completion flow testable in isolation
- The handler receives `AgentRunOutcome` (already contains everything needed)

---

## 6. Anti-Patterns to Avoid

### Anti-Pattern 1: Capturing Traces Inline in OpenClawAdapter

**What:** Adding trace capture logic directly in `OpenClawAdapter.runAgentBackground()`.

**Why bad:** The adapter's job is session lifecycle management. Trace capture is an AOF concern, not a gateway concern. Putting it in the adapter would:
- Violate the GatewayAdapter abstraction (MockAdapter would need it too)
- Make the adapter harder to test
- Couple trace format to the adapter implementation

**Instead:** The completion handler (AOF layer) calls trace capture after the adapter fires onRunComplete.

### Anti-Pattern 2: Storing Full Agent Responses in Traces

**What:** Copying the full text of every assistant response into trace.json.

**Why bad:** Agent responses can be very long (code generation, analysis). Full traces would be megabytes. The OpenClaw session JSONL already has the full content.

**Instead:** Store only a 500-char preview per turn in the trace. The `--debug` CLI flag shows previews. For full content, users can inspect the OpenClaw session file directly (path included in trace metadata).

### Anti-Pattern 3: Breaking the Happy Path

**What:** Changing how `aof_task_complete` works or adding trace capture inside the tool handler.

**Why bad:** The happy path (agent calls `aof_task_complete` -> ProtocolRouter -> state transition) works correctly. Trace capture should be orthogonal to it. Adding logic inside the tool handler would slow down the tool response and add failure modes during the agent session.

**Instead:** Trace capture happens AFTER the session ends, in the onRunComplete callback. The happy path remains untouched. The only change is: even on happy path, the onRunComplete callback now captures the trace (but does NOT re-transition the task since it's already transitioned).

### Anti-Pattern 4: Making Enforcement a Hard Block on First Occurrence

**What:** Immediately blocking ALL tasks where agents don't call `aof_task_complete`, with no rollout path.

**Why bad:** If the SKILL.md update doesn't reach all agents or some agents can't access the tool, this would block all work.

**Instead:** Enforcement should be loggable before it's enforceable. Consider a configuration option (`enforcement: "log" | "block"`) that starts in `log` mode (warns but still auto-completes) and switches to `block` after verification. This is a safer rollout path.

---

## 7. Scalability Considerations

| Concern | Current Scale | v1.5 Impact | Mitigation |
|---------|---------------|-------------|------------|
| Trace file size | N/A | ~50-200KB per trace (200 turns, text previews) | Cap at 200 turns, 500-char previews |
| Session file reads | N/A | One read per completed task | JSONL is streaming-parseable, no full-file load needed |
| Disk usage | state/runs/<taskId>/ has 3 files (~5KB total) | +1 file per task (~100KB) | 20x increase per task, manageable for single-machine |
| DAG tasks | 1 run_result per hop | 1 trace per hop | N traces for N-hop DAG, still bounded |
| CLI response time | N/A | Read + parse trace.json | Sub-100ms for typical traces |

---

## 8. Integration Points Summary

| Integration Point | Source File | Change Type | Complexity |
|-------------------|-------------|-------------|------------|
| Trace types + schemas | `src/trace/types.ts` (NEW) | Zod schemas for trace data | Low |
| Trace capture logic | `src/trace/capture.ts` (NEW) | Read OpenClaw JSONL, parse, compute stats | Medium |
| Trace store | `src/trace/store.ts` (NEW) | Read/write trace.json to artifact tree | Low |
| Completion handler | `src/dispatch/completion-handler.ts` (NEW) | Centralized post-session handler | Medium |
| onRunComplete refactor | `src/dispatch/assign-executor.ts` | Replace inline fallback with handler call | Medium |
| DAG trace capture | `src/protocol/router.ts` handleSessionEnd | Add trace capture before DAG transition | Low |
| Trace CLI | `src/cli/commands/trace.ts` (NEW) | aof trace command with output modes | Medium |
| CLI registration | `src/cli/program.ts` | Register trace subcommand | Low |
| Event schema | `src/schemas/event.ts` | Add trace.captured, completion.enforcement types | Low |
| SKILL.md update | `skills/aof/SKILL.md` | Strengthen completion requirements | Low |
| Task instruction | `src/openclaw/openclaw-executor.ts` | Update formatTaskInstruction text | Low |
| Budget gate test | CI | Verify updated SKILL.md stays under token ceiling | Low |

---

## 9. Recommended Build Order

### Phase 1: Foundation (No Dependencies Between Items)

**1A. Trace types and schemas**
- Write `src/trace/types.ts` with SessionTrace, TraceTurn, TraceStats Zod schemas
- Unit test schema validation

**1B. Trace capture (read-only)**
- Write `src/trace/capture.ts` with `parseSessionJSONL()` and `computeStats()`
- Unit test with mock JSONL files (create test fixtures)
- This is pure parsing logic, no side effects

**1C. Trace store**
- Write `src/trace/store.ts` with read/write/list functions
- Unit test with mock ITaskStore
- Follows existing run-artifacts.ts patterns exactly

### Phase 2: Completion Handler (Depends on 1A, 1B, 1C)

**2A. Completion handler**
- Write `src/dispatch/completion-handler.ts`
- Implement `handleAgentCompletion()` with:
  - Trace capture (calls 1B)
  - Trace storage (calls 1C)
  - Completion enforcement logic
  - Lease renewal stop
- Unit test with MockAdapter and mock store
- Test both happy path (task already transitioned) and enforcement path

**2B. Event schema extension**
- Add `trace.captured`, `trace.capture_failed`, `completion.enforcement` to event types
- Update Zod schema

### Phase 3: Integration (Depends on Phase 2)

**3A. assign-executor.ts refactor**
- Replace onRunComplete inline logic with `handleAgentCompletion()` call
- Ensure all existing tests pass (behavior changes are intentional)
- Add new tests for enforcement behavior

**3B. DAG path trace capture**
- Add trace capture in `ProtocolRouter.handleSessionEnd()` DAG path
- Before `handleDAGHopCompletion()`, capture trace for the completing hop
- Test with mock DAG task

**3C. SKILL.md + formatTaskInstruction updates**
- Update compressed SKILL.md in skills directory
- Update `formatTaskInstruction()` in `openclaw-executor.ts`
- Run budget gate CI test to verify token ceiling

### Phase 4: CLI (Depends on Phase 1C)

**4A. Trace CLI command**
- Write `src/cli/commands/trace.ts` with summary/debug/json output modes
- Register in `src/cli/program.ts`
- Can be built in parallel with Phase 2-3 since it only depends on trace store (1C)

### Phase 5: Polish + Release

**5A. Integration testing**
- End-to-end test: dispatch task -> agent completes -> trace captured -> CLI reads trace
- Test with DAG workflow: dispatch hop -> hop completes -> hop trace captured
- Test enforcement: agent exits without aof_task_complete -> task blocked

**5B. Documentation**
- Update CLI reference (auto-generated from Commander tree)
- Add trace section to user guide

### Phase Dependency Summary

```
Phase 1A ---+
Phase 1B ---+--> Phase 2A --> Phase 3A --> Phase 5A --> Phase 5B
Phase 1C ---+                 Phase 3B
             |    Phase 2B    Phase 3C
             |
             +--> Phase 4A (parallel with Phase 2-3)
```

Phases 1A, 1B, 1C are fully independent. Phase 4A (CLI) only needs 1C. Phase 2 needs all of Phase 1. Phase 3 needs Phase 2. Phase 5 needs Phase 3 + 4.

---

## 10. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| OpenClaw session JSONL format changes between versions | MEDIUM | Best-effort parsing with graceful fallback; version field in trace schema |
| Session file not available (race condition, agent on different host in future) | LOW | Best-effort capture; log warning; trace.capture_failed event |
| Enforcement breaks existing workflows where agents can't access aof_task_complete | HIGH | Rollout with `enforcement: "log"` mode first; verify tool availability before enabling `"block"` mode |
| Budget gate test fails after SKILL.md update | LOW | Minimal text changes; test before commit |
| Trace files accumulate without cleanup | LOW | Same lifecycle as run artifacts; deferred cleanup to v2 |
| onRunComplete refactor introduces regressions | MEDIUM | Comprehensive test coverage; behavior change is intentional and well-defined |

---

## Sources

- Direct source code analysis of `/Users/xavier/Projects/aof/src/`
- `src/dispatch/executor.ts` -- GatewayAdapter interface, AgentRunOutcome
- `src/dispatch/assign-executor.ts` -- onRunComplete callback (lines 172-226)
- `src/openclaw/openclaw-executor.ts` -- OpenClawAdapter, session lifecycle, formatTaskInstruction
- `src/protocol/router.ts` -- ProtocolRouter, handleCompletionReport, handleSessionEnd
- `src/dispatch/dag-transition-handler.ts` -- DAG hop completion handling
- `src/recovery/run-artifacts.ts` -- Run artifact read/write patterns
- `src/schemas/protocol.ts` -- CompletionReportPayload, protocol envelope
- `src/schemas/run-result.ts` -- RunResult schema
- `src/store/interfaces.ts` -- ITaskStore interface, writeTaskOutput
- `src/context/skills.ts` -- SkillManifest loading
- `src/events/logger.ts` -- EventLogger patterns
- OpenClaw session transcript convention: `~/.openclaw/agents/<agent>/sessions/<sessionId>.jsonl`
- Confidence: HIGH -- all findings based on direct code inspection with line-level references
