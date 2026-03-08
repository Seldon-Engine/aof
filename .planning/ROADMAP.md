# Roadmap: AOF

## Milestones

- ✅ **v1.0 AOF Production Readiness** — Phases 1-3 (shipped 2026-02-26)
- ✅ **v1.1 Stabilization & Ship** — Phases 4-9 (shipped 2026-02-27)
- ✅ **v1.2 Task Workflows** — Phases 10-16 (shipped 2026-03-03)
- ✅ **v1.3 Seamless Upgrade** — Phases 17-20 (shipped 2026-03-04)
- ✅ **v1.4 Context Optimization** — Phases 21-24 (shipped 2026-03-04)
- 📋 **v1.5 Event Tracing** — Phases 25-27 (planned)

## Phases

<details>
<summary>✅ v1.0 AOF Production Readiness (Phases 1-3) — SHIPPED 2026-02-26</summary>

- [x] Phase 1: Foundation Hardening (2/2 plans) — completed 2026-02-26
- [x] Phase 2: Daemon Lifecycle (3/3 plans) — completed 2026-02-26
- [x] Phase 3: Gateway Integration (2/2 plans) — completed 2026-02-26

See: `.planning/milestones/v1.0-ROADMAP.md` for full details

</details>

<details>
<summary>✅ v1.1 Stabilization & Ship (Phases 4-9) — SHIPPED 2026-02-27</summary>

- [x] Phase 4: Memory Fix & Test Stabilization (3/3 plans) — completed 2026-02-26
- [x] Phase 5: CI Pipeline (2/2 plans) — completed 2026-02-26
- [x] Phase 6: Installer (2/2 plans) — completed 2026-02-26
- [x] Phase 7: Projects (3/3 plans) — completed 2026-02-26
- [x] Phase 8: Production Dependency Fix (1/1 plan) — completed 2026-02-26
- [x] Phase 9: Documentation & Guardrails (5/5 plans) — completed 2026-02-27

See: `.planning/milestones/v1.1-ROADMAP.md` for full details

</details>

<details>
<summary>✅ v1.2 Task Workflows (Phases 10-16) — SHIPPED 2026-03-03</summary>

- [x] Phase 10: DAG Schema Foundation (2/2 plans) — completed 2026-03-03
- [x] Phase 11: DAG Evaluator (2/2 plans) — completed 2026-03-03
- [x] Phase 12: Scheduler Integration (2/2 plans) — completed 2026-03-03
- [x] Phase 13: Timeout, Rejection, Safety (3/3 plans) — completed 2026-03-03
- [x] Phase 14: Templates, Ad-Hoc API, Artifacts (3/3 plans) — completed 2026-03-03
- [x] Phase 15: Migration and Documentation (3/3 plans) — completed 2026-03-03
- [x] Phase 16: Integration Wiring Fixes (1/1 plan) — completed 2026-03-03

See: `.planning/milestones/v1.2-ROADMAP.md` for full details

</details>

<details>
<summary>✅ v1.3 Seamless Upgrade (Phases 17-20) — SHIPPED 2026-03-04</summary>

- [x] Phase 17: Migration Foundation & Framework Hardening (3/3 plans) — completed 2026-03-04
- [x] Phase 18: DAG-as-Default (1/1 plan) — completed 2026-03-04
- [x] Phase 19: Verification & Smoke Tests (2/2 plans) — completed 2026-03-04
- [x] Phase 20: Release Pipeline, Documentation & Release Cut (1/1 plan) — completed 2026-03-04

See: `.planning/milestones/v1.3-ROADMAP.md` for full details

</details>

<details>
<summary>✅ v1.4 Context Optimization (Phases 21-24) — SHIPPED 2026-03-04</summary>

- [x] Phase 21: Tool & Workflow API (2/2 plans) — completed 2026-03-04
- [x] Phase 22: Compressed Skill (1/1 plan) — completed 2026-03-04
- [x] Phase 23: Tiered Context Delivery (2/2 plans) — completed 2026-03-04
- [x] Phase 24: Verification & Budget Gate (1/1 plan) — completed 2026-03-04

See: `.planning/milestones/v1.4-ROADMAP.md` for full details

</details>

### 📋 v1.5 Event Tracing (Planned)

**Milestone Goal:** Make agent work visible and trustworthy — enforce explicit completion, capture session traces, and surface what agents actually did (or didn't do).

- [x] **Phase 25: Completion Enforcement** - Stop trusting exit codes; require explicit aof_task_complete and update agent guidance (completed 2026-03-07)
- [x] **Phase 26: Trace Infrastructure** - Capture and store structured session traces from OpenClaw transcripts (completed 2026-03-08)
- [ ] **Phase 27: Trace CLI** - Operator-facing trace presentation with summary, debug, and DAG views

## Phase Details

### Phase 25: Completion Enforcement
**Goal**: Tasks that exit without explicit completion are caught and handled, not silently auto-completed
**Depends on**: Phase 24 (v1.4 complete)
**Requirements**: ENFC-01, ENFC-02, ENFC-03, ENFC-04, GUID-01, GUID-02
**Success Criteria** (what must be TRUE):
  1. When an agent exits without calling `aof_task_complete`, the task is marked failed (not done) and the operator can see why
  2. Enforcement mode is configurable — warn-only mode logs the violation but allows the existing fallback, block mode prevents auto-completion
  3. Sessions with zero meaningful tool calls are flagged as suspicious in the event log
  4. SKILL.md and dispatch-time instructions tell agents that exiting without `aof_task_complete` blocks the task
  5. All enforcement actions emit structured events to the JSONL event log
**Plans**: 2 plans
Plans:
- [ ] 25-01-PLAN.md — Enforcement logic for top-level tasks and DAG hops (ENFC-01, ENFC-04)
- [ ] 25-02-PLAN.md — Agent guidance in SKILL.md and formatTaskInstruction (GUID-01, GUID-02)

### Phase 26: Trace Infrastructure
**Goal**: Every completed agent session produces a structured trace record that captures what the agent did
**Depends on**: Phase 25
**Requirements**: TRAC-01, TRAC-02, TRAC-03, TRAC-04, TRAC-05, TRAC-06
**Success Criteria** (what must be TRUE):
  1. After an agent session completes, the OpenClaw session JSONL is parsed and a structured `trace.json` appears in the task artifact directory
  2. Trace capture never blocks or delays task state transitions — if capture fails, the task still transitions normally
  3. Trace lifecycle events (`trace.captured`, `trace.capture_failed`) are emitted to the JSONL event log
  4. When a task is retried, subsequent traces accumulate alongside prior attempt traces so the full history is preserved
  5. The per-task `metadata.debug` flag controls whether traces store full detail or summary-only
**Plans**: 2 plans
Plans:
- [ ] 26-01-PLAN.md — Trace schema, session parser, and no-op detector (TRAC-01, TRAC-06)
- [ ] 26-02-PLAN.md — Trace writer, event types, and onRunComplete integration (TRAC-02, TRAC-03, TRAC-04, TRAC-05)

### Phase 27: Trace CLI
**Goal**: Operators can inspect what any agent did on any task through a CLI command
**Depends on**: Phase 26
**Requirements**: PRES-01, PRES-02, PRES-03, PRES-04
**Success Criteria** (what must be TRUE):
  1. `aof trace <task-id>` shows a human-readable summary including tool calls made, outcome, duration, and model info
  2. `aof trace <task-id> --debug` shows the full tool call details and reasoning text
  3. `aof trace <task-id> --json` outputs structured trace data suitable for piping to jq or other tools
  4. For DAG workflow tasks, `aof trace <task-id>` shows per-hop traces with hop identification so operators can see what each stage did
**Plans**: 2 plans
Plans:
- [ ] 27-01-PLAN.md — Trace reader and formatter with TDD (PRES-01, PRES-02, PRES-03, PRES-04)
- [ ] 27-02-PLAN.md — CLI command wiring and program registration (PRES-01, PRES-02, PRES-03, PRES-04)

## Progress

**Execution Order:**
Phases execute in numeric order: 25 → 26 → 27

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation Hardening | v1.0 | 2/2 | Complete | 2026-02-26 |
| 2. Daemon Lifecycle | v1.0 | 3/3 | Complete | 2026-02-26 |
| 3. Gateway Integration | v1.0 | 2/2 | Complete | 2026-02-26 |
| 4. Memory Fix & Test Stabilization | v1.1 | 3/3 | Complete | 2026-02-26 |
| 5. CI Pipeline | v1.1 | 2/2 | Complete | 2026-02-26 |
| 6. Installer | v1.1 | 2/2 | Complete | 2026-02-26 |
| 7. Projects | v1.1 | 3/3 | Complete | 2026-02-26 |
| 8. Production Dependency Fix | v1.1 | 1/1 | Complete | 2026-02-26 |
| 9. Documentation & Guardrails | v1.1 | 5/5 | Complete | 2026-02-27 |
| 10. DAG Schema Foundation | v1.2 | 2/2 | Complete | 2026-03-03 |
| 11. DAG Evaluator | v1.2 | 2/2 | Complete | 2026-03-03 |
| 12. Scheduler Integration | v1.2 | 2/2 | Complete | 2026-03-03 |
| 13. Timeout, Rejection, Safety | v1.2 | 3/3 | Complete | 2026-03-03 |
| 14. Templates, Ad-Hoc API, Artifacts | v1.2 | 3/3 | Complete | 2026-03-03 |
| 15. Migration and Documentation | v1.2 | 3/3 | Complete | 2026-03-03 |
| 16. Integration Wiring Fixes | v1.2 | 1/1 | Complete | 2026-03-03 |
| 17. Migration Foundation & Framework Hardening | v1.3 | 3/3 | Complete | 2026-03-04 |
| 18. DAG-as-Default | v1.3 | 1/1 | Complete | 2026-03-04 |
| 19. Verification & Smoke Tests | v1.3 | 2/2 | Complete | 2026-03-04 |
| 20. Release Pipeline, Documentation & Release Cut | v1.3 | 1/1 | Complete | 2026-03-04 |
| 21. Tool & Workflow API | v1.4 | 2/2 | Complete | 2026-03-04 |
| 22. Compressed Skill | v1.4 | 1/1 | Complete | 2026-03-04 |
| 23. Tiered Context Delivery | v1.4 | 2/2 | Complete | 2026-03-04 |
| 24. Verification & Budget Gate | v1.4 | 1/1 | Complete | 2026-03-04 |
| 25. Completion Enforcement | v1.5 | 2/2 | Complete | 2026-03-07 |
| 26. Trace Infrastructure | v1.5 | 2/2 | Complete | 2026-03-08 |
| 27. Trace CLI | v1.5 | 0/2 | Not started | - |
