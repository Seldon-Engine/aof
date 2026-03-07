# Project Research Summary

**Project:** AOF v1.5 Event Tracing & Session Observability
**Domain:** Agent orchestration observability -- post-hoc tracing and completion enforcement for autonomous agent sessions
**Researched:** 2026-03-06
**Confidence:** HIGH

## Executive Summary

AOF v1.5 solves a specific, verified problem: agents can exit cleanly without doing meaningful work, and the current fallback in `assign-executor.ts` auto-completes these tasks, losing all accountability. The fix is two-pronged: (1) stop trusting exit codes by enforcing explicit `aof_task_complete` calls, and (2) capture structured traces from OpenClaw session transcripts so operators can see what agents actually did. No new dependencies are needed -- the existing stack (Node.js, Zod, Commander, write-file-atomic) covers every requirement.

The recommended approach is a graduated rollout. Completion enforcement must start in warn-only mode (log but still allow the existing fallback) to avoid breaking existing agents that may not reliably call `aof_task_complete`. Trace capture hooks into the existing `onRunComplete` callback but must be best-effort and never block task state transitions. A new `completion-handler.ts` centralizes the post-session logic currently split between `assign-executor.ts` and `ProtocolRouter`, making the completion flow testable and extensible. The CLI (`aof trace <task-id>`) reads stored trace files and presents summary or debug views using the existing raw ANSI rendering pattern.

The primary risk is enforcement that is too aggressive, breaking the existing fallback path and causing tasks to pile up in blocked/deadletter states. This is mitigated by graduated enforcement and by designing tracing as server-side capture (reading OpenClaw session files) rather than requiring agents to report trace data. Secondary risks include race conditions when reading session files that may still be flushing to disk, and the undocumented nature of the OpenClaw session JSONL format. Both are addressed through defensive parsing with graceful degradation.

## Key Findings

### Recommended Stack

No new runtime dependencies. The existing stack covers all v1.5 requirements. This is a strong signal that the feature set aligns well with the project's architecture.

**Core technologies (all already installed):**
- **Node.js 22** (readline, fs/promises): Session JSONL parsing and trace file I/O
- **Zod 3.24.x**: Trace record schemas with `.passthrough()` for forward compatibility against OpenClaw format changes
- **Commander 14.x**: `aof trace <task-id>` CLI command registration
- **write-file-atomic 7.x**: Crash-safe trace file writes following existing run artifact pattern
- **vitest 3.x**: Unit and integration tests for parser, store, and formatter

**Explicitly not adding:** chalk/picocolors (raw ANSI convention), JSONL libraries (trivial parsing), OpenTelemetry (deferred to v2), CLI table libraries (manual formatting suffices), date libraries (built-in Date handles duration math).

### Expected Features

**Must have (table stakes):**
- **Completion enforcement** -- Change `onRunComplete` fallback from auto-complete to blocked. Surgical change at `assign-executor.ts:191-195`. Without this, v1.5 delivers no value.
- **Session trace capture** -- Parse OpenClaw session JSONL after agent completion, extract tool calls, token usage, completion status. Core infrastructure for all observability.
- **Trace file storage** -- Write `trace.json` to task artifact directory (`state/runs/<taskId>/`), co-located with existing `run.json` and `run_result.json`.
- **Trace CLI** -- `aof trace <task-id>` with summary (default) and debug (`--debug`) output modes. The operator-facing payoff for the infrastructure work.
- **SKILL.md completion guidance** -- Minimal text addition (~50 tokens, fits within 485-token headroom) reinforcing that exiting without `aof_task_complete` blocks the task.

**Should have (differentiators):**
- **No-op detection** -- Auto-flag sessions with zero meaningful tool calls. Directly addresses the triggering incident.
- **Trace event emission** -- `trace.captured`, `trace.capture_failed`, `completion.enforcement` events in existing JSONL event system.
- **Debug flag on tasks** -- Per-task `metadata.debug: true` controls trace verbosity (summary vs. full reasoning capture). Must use metadata bag, not new frontmatter field.
- **Retry-aware trace accumulation** -- Store trace history across retries so next agent sees what prior agents tried.

**Defer to v1.6+:**
- Prior-failure injection into task prompts (depends on retry-aware accumulation)
- Trace retention/cleanup policy (not urgent until disk usage is a concern)
- OpenTelemetry integration (explicitly v2 scope)
- Real-time session streaming, dashboards, full session replay, cross-task correlation

### Architecture Approach

The architecture introduces four new components and modifies three existing ones, all following established patterns. The central design decision is a new `completion-handler.ts` that centralizes post-session logic (trace capture + enforcement + state transitions) currently split across two code paths. This handler is invoked from `onRunComplete` for both simple tasks and DAG hops, ensuring all completions get traced.

**Major components:**
1. **`src/trace/capture.ts`** (NEW) -- Reads OpenClaw session JSONL, parses turns, computes stats. Read-only with respect to OpenClaw files. Graceful degradation on missing/corrupt files.
2. **`src/trace/store.ts`** (NEW) -- Thin read/write wrapper over task artifact directory. Writes `trace.json` (or `trace-<hopId>.json` for DAG tasks) using write-file-atomic.
3. **`src/trace/types.ts`** (NEW) -- Zod schemas for `SessionTrace`, `TraceTurn`, `TraceStats`. Versioned (`version: 1`) for future evolution.
4. **`src/dispatch/completion-handler.ts`** (NEW) -- Centralizes: stop lease, capture trace (best-effort), check task status, enforce completion. Replaces inline logic in assign-executor.
5. **`src/cli/commands/trace.ts`** (NEW) -- CLI command with summary/debug/json output modes.
6. **`src/dispatch/assign-executor.ts`** (MODIFIED) -- `onRunComplete` simplified to single call to `handleAgentCompletion()`.
7. **`src/schemas/event.ts`** (MODIFIED) -- Three new event types added to EventType enum.

### Critical Pitfalls

1. **Enforcement breaks existing fallback** -- The most dangerous pitfall. Hard enforcement causes working tasks to deadletter. Prevention: graduated rollout (warn-only first, opt-in hard enforcement later). Never fully remove the fallback path.

2. **Race condition reading session files** -- OpenClaw may still be flushing when `onRunComplete` fires. Prevention: add file-stability check (stat twice, 200ms apart), use streaming parser that handles truncated trailing lines, handle ENOENT gracefully.

3. **Schema changes break existing agents** -- New required fields on `CompletionReportPayload` would reject agents running stale tool schemas. Prevention: all new fields must be `.optional()` with defaults. Write migration tests validating v1.4 payloads against v1.5 schemas.

4. **SKILL.md token budget exceeded** -- Adding verbose tracing instructions blows past the 2150-token ceiling. Prevention: tracing is server-side capture, not agent-side reporting. The one addition (~50 tokens) fits. Use `formatTaskInstruction()` for dispatch-time instructions that bypass the budget gate.

5. **Trace capture blocks scheduler poll loop** -- Synchronous I/O during trace capture delays dispatch. Prevention: trace capture is fire-and-forget from `onRunComplete`, with per-trace timeout (5s max).

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Completion Enforcement (Stop the Bleeding)

**Rationale:** Highest ROI, lowest effort. Immediately stops the hallucinated-completion problem without any new infrastructure. Independent of all other work.
**Delivers:** Tasks that exit without `aof_task_complete` get blocked instead of auto-completed. Warning events logged. SKILL.md updated with completion expectations.
**Addresses:** Completion enforcement (table stakes #1), SKILL.md guidance (table stakes #5), formatTaskInstruction update.
**Avoids:** Pitfall 1 (graduated enforcement -- warn-only mode first), Pitfall 3 (no schema breaking changes), Pitfall 5 (minimal token budget impact).
**Estimated effort:** 1-2 days.

### Phase 2: Trace Infrastructure (Capture and Store)

**Rationale:** Critical path -- everything else depends on having structured trace data. Must be built before CLI or no-op detection. Groups naturally because capture, storage, and schemas are tightly coupled.
**Delivers:** Every completed agent session produces a `trace.json` in the task artifact directory. Event types for trace lifecycle. No-op detection flags suspicious sessions.
**Addresses:** Session trace capture (table stakes #2), trace file storage (table stakes #3), no-op detection (differentiator), trace event emission (differentiator).
**Avoids:** Pitfall 2 (defensive I/O with stability check), Pitfall 4 (size caps and text preview limits), Pitfall 8 (passthrough Zod schemas for OpenClaw format), Pitfall 11 (async/best-effort capture).
**Estimated effort:** 3-4 days.

### Phase 3: Trace CLI (Operator Interface)

**Rationale:** The user-visible payoff for phases 1-2. Can be partially built in parallel with Phase 2 since it only depends on the trace store interface. Includes debug flag for per-task verbosity control.
**Delivers:** `aof trace <task-id>` command with summary, `--debug`, and `--json` output modes. Per-task debug flag via metadata bag.
**Addresses:** Trace CLI (table stakes #4), debug flag on tasks (differentiator).
**Avoids:** Pitfall 6 (use metadata bag, not new frontmatter field), Pitfall 7 (summary default, streaming reader for large traces).
**Estimated effort:** 2-3 days.

### Phase 4: Integration Testing and Polish

**Rationale:** End-to-end verification after all components are wired. DAG trace capture integration. Documentation updates.
**Delivers:** Verified end-to-end flow (dispatch -> agent -> trace -> CLI). DAG hop traces. Backward compatibility verified.
**Addresses:** DAG trace capture, integration test coverage, documentation.
**Avoids:** Pitfall 9 (store sessionId, resolve path at read time for DAG tasks).
**Estimated effort:** 1-2 days.

### Phase Ordering Rationale

- **Phase 1 is independent** and delivers immediate value with minimal risk. It can ship as a hotfix before trace infrastructure exists.
- **Phase 2 before Phase 3** because the CLI needs trace data to display. Building storage first also forces schema decisions early, which Pitfall 6 warns is critical.
- **Phase 3 can overlap with Phase 2** since the CLI only depends on the trace store interface (types.ts + store.ts), not the capture logic.
- **Phase 4 last** because integration testing requires all components to be in place. DAG trace capture is a low-complexity addition once the simple-task path works.
- This ordering matches the dependency graph from FEATURES.md and the build sequence from ARCHITECTURE.md.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2 (Trace Infrastructure):** The OpenClaw session JSONL format is undocumented and verified only from live files. Parser implementation needs golden fixture tests from real session data. The race condition on file reads (Pitfall 2) needs a concrete implementation strategy (lazy read vs. stability check vs. delay).

Phases with standard patterns (skip research-phase):
- **Phase 1 (Completion Enforcement):** Fully identified code path, surgical change. No unknowns.
- **Phase 3 (Trace CLI):** Follows established CLI patterns (Commander.js, raw ANSI rendering). Well-documented in the codebase.
- **Phase 4 (Integration Testing):** Standard testing patterns, no novel integration points.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All technologies already installed and verified. Zero new dependencies. Existing patterns confirmed in codebase. |
| Features | HIGH | Core problem precisely identified (assign-executor.ts:191-195). Session JSONL format verified from real files. Feature dependencies mapped with build order. |
| Architecture | HIGH | All integration points identified with file and line references. Component boundaries follow existing patterns (run artifacts, event logger, CLI commands). |
| Pitfalls | HIGH | All pitfalls derived from direct codebase analysis. Backward compatibility risks enumerated with specific file references and test strategies. |

**Overall confidence:** HIGH -- All four research files are based on direct source code analysis with line-level references, not external documentation or inference. The existing codebase provides clear patterns for every new component.

### Gaps to Address

- **OpenClaw session JSONL format stability:** The format is undocumented. AOF must parse defensively and maintain golden fixture tests. If OpenClaw provides a stable schema or versioning in the future, the parser should adopt it. Until then, use `.passthrough()` and extract only needed fields.
- **Enforcement rollout strategy:** The exact configuration mechanism for graduated enforcement (warn vs. block mode) is not specified. Options include: org-chart config, environment variable, or per-agent setting. Decide during Phase 1 implementation.
- **Trace capture timing:** The optimal strategy for handling the session file race condition (Pitfall 2) needs validation. The lazy-read approach (capture at `aof trace` time, not at `onRunComplete` time) is simpler but means traces are not pre-computed. The eager approach (capture at `onRunComplete` with stability check) is more complex but provides immediate trace availability. Decide during Phase 2 implementation.
- **DAG hop trace correlation:** The mechanism for associating traces with specific DAG hops (using `hopId` as discriminator in the filename) is proposed but not validated against the existing DAG workflow state. Verify during Phase 4.

## Sources

### Primary (HIGH confidence)
- AOF source code: `src/dispatch/assign-executor.ts` -- fallback completion path, onRunComplete callback
- AOF source code: `src/openclaw/openclaw-executor.ts` -- session lifecycle, resolveSessionFilePath, formatTaskInstruction
- AOF source code: `src/schemas/` -- protocol, task, event, run-result schemas
- AOF source code: `src/events/logger.ts` -- JSONL event infrastructure and existing parsing patterns
- AOF source code: `src/recovery/run-artifacts.ts` -- run artifact read/write patterns
- AOF source code: `src/protocol/router.ts` -- ProtocolRouter, DAG completion handling
- AOF source code: `skills/aof/SKILL.md` -- 1665 tokens, 2150 ceiling, 485 tokens headroom
- Real OpenClaw session data: `~/.openclaw/agents/*/sessions/*.jsonl` -- verified format, message types, tool call structure

### Secondary (MEDIUM confidence)
- OpenClaw session JSONL format: Verified from live files but undocumented by OpenClaw. Format may change between versions.
- `resolveSessionFilePath()` API: Works today but is an internal OpenClaw function, not a public API contract.

---
*Research completed: 2026-03-06*
*Ready for roadmap: yes*
