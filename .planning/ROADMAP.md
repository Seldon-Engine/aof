# Roadmap: AOF

## Milestones

- ✅ **v1.0 AOF Production Readiness** — Phases 1-3 (shipped 2026-02-26)
- ✅ **v1.1 Stabilization & Ship** — Phases 4-9 (shipped 2026-02-27)
- 🚧 **v1.2 Task Workflows** — Phases 10-15 (in progress)

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

### 🚧 v1.2 Task Workflows

**Milestone Goal:** Tasks carry workflow DAGs that the scheduler executes hop-by-hop, replacing the linear gate system with conditional branching, parallel paths, and artifact handoff between agents.

- [ ] **Phase 10: DAG Schema Foundation** — Zod schemas for hops, workflow DAGs, execution state, and creation-time validation
- [ ] **Phase 11: DAG Evaluator** — Pure-function DAG evaluation: readiness propagation, conditional logic, skip cascading, and hop lifecycle
- [ ] **Phase 12: Scheduler Integration** — Scheduler dispatches hops as independent sessions, advances DAGs on completion, dual-mode gate/DAG coexistence
- [ ] **Phase 13: Timeout, Rejection, and Safety** — Per-hop timeout with escalation, rejection with downstream reset, restricted JSON DSL for agent-authored conditions
- [ ] **Phase 14: Templates, Ad-Hoc API, and Artifacts** — Workflow templates in project config, agent-composed ad-hoc DAGs, hop-scoped artifact directories
- [ ] **Phase 15: Migration and Documentation** — Gate-to-DAG lazy migration, user/developer/skill docs, gate reference cleanup, CLI reference update

## Phase Details

### Phase 10: DAG Schema Foundation
**Goal**: Every data shape for workflow DAGs is defined, validated, and backward-compatible with existing tasks
**Depends on**: Phase 9 (v1.1 complete)
**Requirements**: DAG-01, DAG-02, DAG-03, DAG-04, EXEC-08
**Success Criteria** (what must be TRUE):
  1. A task can be created with an inline workflow DAG definition containing typed hops and edges, and Zod validates it at parse time
  2. Each hop in a DAG specifies target role/agent, conditions, timeout, auto-advance vs review behavior, and dependency edges
  3. Invalid DAGs (cycles, unreachable hops, missing roles) are rejected at creation time with actionable error messages
  4. DAG execution state (per-hop status following pending/ready/dispatched/complete/failed/skipped lifecycle) persists on task frontmatter via atomic writes
  5. Existing gate-based tasks parse and function without modification (schema is additive, not breaking)
**Plans:** 2 plans

Plans:
- [ ] 10-01-PLAN.md -- DAG Zod schemas (Hop, WorkflowDefinition, HopState, WorkflowState) + validateDAG() + initializeWorkflowState() with TDD
- [ ] 10-02-PLAN.md -- TaskFrontmatter integration (workflow field, gate/DAG mutual exclusivity, barrel exports, YAML round-trip)

### Phase 11: DAG Evaluator
**Goal**: A pure-function evaluator determines next-hop readiness, conditional outcomes, and DAG completion from any execution state
**Depends on**: Phase 10
**Requirements**: EXEC-04, EXEC-05, EXEC-07
**Success Criteria** (what must be TRUE):
  1. Given a DAG state and a hop completion event, the evaluator returns all state updates (hop status changes, newly ready hops, optional task status change) as a single result object
  2. Conditional hops evaluate a JSON DSL expression against hop results and task context, resolving to execute or skip
  3. Skipped hops propagate skip to downstream dependents that have no other satisfied input path
  4. Join hops correctly wait for all predecessors (AND-join) or advance on any predecessor (OR-join) based on configuration
**Plans**: TBD

### Phase 12: Scheduler Integration
**Goal**: The scheduler dispatches DAG hops as independent OpenClaw sessions and advances the DAG on each completion
**Depends on**: Phase 11
**Requirements**: EXEC-01, EXEC-02, EXEC-03, EXEC-06, SAFE-02
**Success Criteria** (what must be TRUE):
  1. The scheduler dispatches each hop as an independent OpenClaw session (no nesting), with hop context injected into the agent dispatch
  2. On hop completion, the scheduler evaluates the DAG graph and dispatches eligible next hops within the same poll cycle
  3. Completion-triggered advancement dispatches the next hop immediately on completion report, with the poll cycle as fallback
  4. Parallel-eligible hops (no mutual dependency) dispatch in sequence without blocking each other, respecting the one-session-at-a-time OpenClaw constraint
  5. Gate-based tasks and DAG-based tasks coexist via a dual-mode evaluator that routes to the correct code path based on task frontmatter
**Plans**: TBD

### Phase 13: Timeout, Rejection, and Safety
**Goal**: DAG execution handles failure modes gracefully -- timeouts escalate, rejections cascade correctly, and agent-authored conditions are sandboxed
**Depends on**: Phase 12
**Requirements**: SAFE-01, SAFE-03, SAFE-04
**Success Criteria** (what must be TRUE):
  1. A hop that exceeds its configured timeout triggers escalation to a specified role
  2. A rejected hop resets itself and all downstream hops to pending, then re-dispatches according to configurable rejection strategy
  3. Agent-composed workflow conditions use a restricted JSON DSL (no eval/new Function) that is validated by Zod at creation time
  4. A rejection loop (same hop rejected N times) triggers circuit-breaker behavior rather than infinite retry
**Plans**: TBD

### Phase 14: Templates, Ad-Hoc API, and Artifacts
**Goal**: Users define reusable workflow templates, agents compose workflows at task creation, and hops exchange artifacts through documented conventions
**Depends on**: Phase 12
**Requirements**: TMPL-01, TMPL-02, TMPL-03, ARTF-01, ARTF-02
**Success Criteria** (what must be TRUE):
  1. Named workflow templates can be defined in project configuration and referenced by name at task creation time
  2. An agent can compose an ad-hoc workflow DAG inline when creating a task, without requiring a pre-defined template
  3. Both template-referenced and ad-hoc inline workflows resolve to the same runtime WorkflowDAG schema at dispatch time
  4. Each hop writes output to a per-hop subdirectory in the task work directory, and downstream hops can read upstream outputs via documented directory conventions
**Plans**: TBD

### Phase 15: Migration and Documentation
**Goal**: Existing gate workflows migrate cleanly to DAG format, and all documentation reflects the new workflow system
**Depends on**: Phase 13, Phase 14
**Requirements**: SAFE-05, DOCS-01, DOCS-02, DOCS-03, DOCS-04, DOCS-05
**Success Criteria** (what must be TRUE):
  1. Existing linear gate workflows can be lazily migrated to equivalent DAG format without manual intervention
  2. User guide documents workflow DAG concepts, authoring patterns, and monitoring with enough detail for a new user to create their first workflow
  3. Developer docs cover DAG schema reference, evaluator internals, and extension points for contributors
  4. AOF companion skill teaches agents how to compose workflow DAGs with parameters, best practices, and examples
  5. Outdated gate references are removed from companion skill and documentation, and CLI reference reflects any new workflow commands

## Progress

**Execution Order:** Phases 10-12 are sequential; 13 and 14 branch from 12 in parallel; 15 joins after both 13 and 14 complete.

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
| 10. DAG Schema Foundation | v1.2 | 0/2 | In progress | - |
| 11. DAG Evaluator | v1.2 | 0/? | Not started | - |
| 12. Scheduler Integration | v1.2 | 0/? | Not started | - |
| 13. Timeout, Rejection, and Safety | v1.2 | 0/? | Not started | - |
| 14. Templates, Ad-Hoc API, and Artifacts | v1.2 | 0/? | Not started | - |
| 15. Migration and Documentation | v1.2 | 0/? | Not started | - |
