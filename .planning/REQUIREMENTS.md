# Requirements: AOF v1.2 Task Workflows

**Defined:** 2026-03-02
**Core Value:** Tasks never get dropped -- they survive gateway restarts, API failures, rate limits, and agent crashes, always resuming and completing end-to-end without human intervention.

## v1.2 Requirements

Requirements for per-task workflow DAG execution. Each maps to roadmap phases.

### DAG Schema & Data Model

- [x] **DAG-01**: Task can carry a workflow DAG definition with typed hops and edges
- [x] **DAG-02**: Each hop specifies a target role/agent, conditions, timeout, and auto-advance vs review behavior
- [x] **DAG-03**: DAG execution state (hop statuses, current position) persists on task frontmatter atomically
- [x] **DAG-04**: Workflow DAG is validated on creation (cycle detection, unreachable hops, missing roles)

### Execution Engine

- [x] **EXEC-01**: Scheduler dispatches each hop as an independent OpenClaw session (no nesting)
- [x] **EXEC-02**: On hop completion, scheduler evaluates DAG graph and advances eligible next hops
- [x] **EXEC-03**: Completion-triggered advancement dispatches next hop immediately (poll cycle as fallback)
- [x] **EXEC-04**: Conditional hops evaluate a JSON DSL expression to determine execute vs skip
- [x] **EXEC-05**: Skipped hops propagate skip to downstream dependents with no other satisfied inputs
- [x] **EXEC-06**: Parallel-eligible hops dispatch in sequence (serialized by OpenClaw constraint) without blocking each other
- [x] **EXEC-07**: Join hops support configurable join type (all predecessors vs any predecessor)
- [x] **EXEC-08**: Hop lifecycle follows state machine: pending → ready → dispatched → complete/failed/skipped

### Workflow Authoring

- [x] **TMPL-01**: Workflow templates can be defined in project configuration
- [x] **TMPL-02**: Agent can compose an ad-hoc workflow DAG at task creation time
- [x] **TMPL-03**: Both templates and ad-hoc workflows resolve to the same runtime WorkflowDAG schema

### Artifact Handoff

- [x] **ARTF-01**: Each hop writes output to a per-hop subdirectory in the task work directory
- [x] **ARTF-02**: Downstream hops can read upstream hop outputs via documented directory conventions

### Safety & Compatibility

- [x] **SAFE-01**: Hop conditions use a restricted JSON DSL (no eval/new Function) for agent-composed workflows
- [x] **SAFE-02**: Existing gate-based tasks coexist with DAG tasks via dual-mode evaluator
- [x] **SAFE-03**: Each hop supports timeout with escalation to a specified role
- [x] **SAFE-04**: Hop rejection resets downstream hops and re-dispatches (configurable rejection strategy)
- [ ] **SAFE-05**: Existing linear gate workflows can be lazily migrated to equivalent DAG format

### Documentation & Companion Skill

- [ ] **DOCS-01**: User guide updated with workflow DAG concepts, authoring, and monitoring
- [ ] **DOCS-02**: Developer docs updated with DAG schema reference, evaluator internals, and extension points
- [ ] **DOCS-03**: AOF companion skill updated to teach agents how to compose workflow DAGs (parameters, best practices, examples)
- [ ] **DOCS-04**: Outdated gate references removed from companion skill and documentation
- [ ] **DOCS-05**: Auto-generated CLI reference updated with any new workflow commands

## Future Requirements

Deferred to later milestones. Tracked but not in current roadmap.

### Self-Healing

- **HEAL-01**: Circuit breaker for persistent dispatch failures
- **HEAL-02**: Dead-letter resurrection with automatic retry
- **HEAL-03**: Stuck session recovery via force-complete

### Agent Setup

- **SETUP-01**: Agent-guided org chart setup via interview
- **SETUP-02**: Standalone daemon executor wiring

### Memory

- **MEM-01**: Memory search reranker for improved retrieval
- **MEM-02**: Memory tier auto compaction

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-task DAGs (cross-task orchestration) | v1.2 is intra-task DAGs only; cross-task deferred to v2 |
| Visual DAG editor / UI | CLI-first; no UI in v1 |
| Nested agent sessions | OpenClaw constraint -- hops are independent sessions |
| Real-time DAG execution streaming | JSONL event logging sufficient for observability |
| Hot-reloading workflow templates | Restart to pick up template changes is acceptable |
| Distributed / multi-host DAG execution | Single-machine deployment for now |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DAG-01 | Phase 10 | Complete |
| DAG-02 | Phase 10 | Complete |
| DAG-03 | Phase 10 | Complete |
| DAG-04 | Phase 10 | Complete |
| EXEC-01 | Phase 12 | Complete |
| EXEC-02 | Phase 12 | Complete |
| EXEC-03 | Phase 12 | Complete |
| EXEC-04 | Phase 11 | Complete |
| EXEC-05 | Phase 11 | Complete |
| EXEC-06 | Phase 12 | Complete |
| EXEC-07 | Phase 11 | Complete |
| EXEC-08 | Phase 10 | Complete |
| TMPL-01 | Phase 14 | Complete |
| TMPL-02 | Phase 14 | Complete |
| TMPL-03 | Phase 14 | Complete |
| ARTF-01 | Phase 14 | Complete |
| ARTF-02 | Phase 14 | Complete |
| SAFE-01 | Phase 13 | Complete |
| SAFE-02 | Phase 12 | Complete |
| SAFE-03 | Phase 13 | Complete |
| SAFE-04 | Phase 13 | Complete |
| SAFE-05 | Phase 15 | Pending |
| DOCS-01 | Phase 15 | Pending |
| DOCS-02 | Phase 15 | Pending |
| DOCS-03 | Phase 15 | Pending |
| DOCS-04 | Phase 15 | Pending |
| DOCS-05 | Phase 15 | Pending |

**Coverage:**
- v1.2 requirements: 27 total
- Mapped to phases: 27
- Unmapped: 0

---
*Requirements defined: 2026-03-02*
*Last updated: 2026-03-02 after roadmap creation*
