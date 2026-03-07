# Requirements: AOF v1.5 Event Tracing

**Defined:** 2026-03-07
**Core Value:** Tasks never get dropped — they survive gateway restarts, API failures, rate limits, and agent crashes, always resuming and completing end-to-end without human intervention.

## v1.5 Requirements

Requirements for event tracing milestone. Each maps to roadmap phases.

### Completion Enforcement

- [ ] **ENFC-01**: Task is marked failed (not done) when agent exits without calling `aof_task_complete`
- [ ] **ENFC-02**: Enforcement mode is configurable (warn-only logs but allows fallback, block prevents auto-completion)
- [ ] **ENFC-03**: No-op detection flags sessions with zero meaningful tool calls as suspicious
- [ ] **ENFC-04**: Enforcement events (`completion.enforcement`, `completion.noop_detected`) emitted to JSONL event log

### Trace Capture

- [ ] **TRAC-01**: OpenClaw session JSONL is parsed after agent completion to extract tool calls, token usage, and output
- [ ] **TRAC-02**: Structured `trace.json` is written to task artifact directory alongside `run_result.json`
- [ ] **TRAC-03**: Trace capture is best-effort and never blocks task state transitions
- [ ] **TRAC-04**: Trace events (`trace.captured`, `trace.capture_failed`) emitted to JSONL event log
- [ ] **TRAC-05**: Traces accumulate across retries so subsequent agents can see prior attempt history
- [ ] **TRAC-06**: Per-task `metadata.debug` flag controls full vs summary trace verbosity

### Trace Presentation

- [ ] **PRES-01**: `aof trace <task-id>` CLI command shows trace summary (tool calls, outcome, duration, token usage)
- [ ] **PRES-02**: `--debug` flag shows full tool calls and reasoning text
- [ ] **PRES-03**: `--json` flag outputs structured trace data for programmatic consumption
- [ ] **PRES-04**: DAG workflow tasks show per-hop traces with hop identification

### Agent Guidance

- [ ] **GUID-01**: SKILL.md updated to instruct agents that exiting without `aof_task_complete` blocks the task
- [ ] **GUID-02**: `formatTaskInstruction()` includes completion expectations in dispatch-time context

## Future Requirements

Deferred to v1.6+. Tracked but not in current roadmap.

### Trace Intelligence

- **TINT-01**: Prior-failure trace summaries injected into task prompts for retry agents
- **TINT-02**: Trace retention/cleanup policy with configurable age limits
- **TINT-03**: Cross-task trace correlation for related tasks

### Advanced Observability

- **AOBS-01**: Real-time session streaming during agent execution
- **AOBS-02**: OpenTelemetry integration for distributed tracing
- **AOBS-03**: Dashboard/web UI for trace browsing

## Out of Scope

| Feature | Reason |
|---------|--------|
| OpenTelemetry integration | Explicitly deferred to v2 |
| Real-time session streaming | High complexity, traces are post-hoc for v1.5 |
| Web UI / dashboard | CLI-first approach, consistent with project philosophy |
| Modifying OpenClaw session format | AOF reads OpenClaw files, doesn't control them |
| Trace-based auto-retry decisions | Requires trace intelligence not yet built |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| ENFC-01 | — | Pending |
| ENFC-02 | — | Pending |
| ENFC-03 | — | Pending |
| ENFC-04 | — | Pending |
| TRAC-01 | — | Pending |
| TRAC-02 | — | Pending |
| TRAC-03 | — | Pending |
| TRAC-04 | — | Pending |
| TRAC-05 | — | Pending |
| TRAC-06 | — | Pending |
| PRES-01 | — | Pending |
| PRES-02 | — | Pending |
| PRES-03 | — | Pending |
| PRES-04 | — | Pending |
| GUID-01 | — | Pending |
| GUID-02 | — | Pending |

**Coverage:**
- v1.5 requirements: 16 total
- Mapped to phases: 0
- Unmapped: 16 ⚠️

---
*Requirements defined: 2026-03-07*
*Last updated: 2026-03-07 after initial definition*
