# Roadmap: AOF

## Milestones

- ✅ **v1.0 AOF Production Readiness** — Phases 1-3 (shipped 2026-02-26)
- ✅ **v1.1 Stabilization & Ship** — Phases 4-9 (shipped 2026-02-27)
- ✅ **v1.2 Task Workflows** — Phases 10-16 (shipped 2026-03-03)
- ✅ **v1.3 Seamless Upgrade** — Phases 17-20 (shipped 2026-03-04)
- ✅ **v1.4 Context Optimization** — Phases 21-24 (shipped 2026-03-04)
- ✅ **v1.5 Event Tracing** — Phases 25-27 (shipped 2026-03-08)
- 🚧 **v1.8 Task Notifications** — Phases 28-32 (in progress)

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

<details>
<summary>✅ v1.5 Event Tracing (Phases 25-27) — SHIPPED 2026-03-08</summary>

- [x] Phase 25: Completion Enforcement (2/2 plans) — completed 2026-03-07
- [x] Phase 26: Trace Infrastructure (2/2 plans) — completed 2026-03-08
- [x] Phase 27: Trace CLI (2/2 plans) — completed 2026-03-08

See: `.planning/milestones/v1.5-ROADMAP.md` for full details

</details>

### v1.8 Task Notifications (In Progress)

**Milestone Goal:** Let agents subscribe to task outcomes and receive callbacks, eliminating the dependent-task polling workaround.

- [x] **Phase 28: Schema and Storage** - Subscription data model, Zod schema, and co-located filesystem persistence (completed 2026-03-09)
- [x] **Phase 29: Subscription API** - MCP tools for creating and canceling subscriptions (dispatch-time and standalone) (completed 2026-03-10)
- [x] **Phase 30: Callback Delivery** - Scheduler-driven callback dispatch with retry and tracing (gap closure in progress) (completed 2026-03-10)
- [x] **Phase 31: Granularity, Safety, and Hardening** - All-transitions granularity, loop prevention, and restart durability (completed 2026-03-11)
- [x] **Phase 32: Agent Guidance** - SKILL.md update with callback behavior and idempotency expectations (completed 2026-03-11)
- [x] **Phase 33: Callback Wiring Fixes** - Wire deliverAllGranularityCallbacks into production and propagate callbackDepth through MCP boundary (gap closure) (completed 2026-03-12)

## Phase Details

### Phase 28: Schema and Storage
**Goal**: Subscription data can be created, read, updated, and deleted with schema validation and crash-safe persistence
**Depends on**: Nothing (first phase of v1.8)
**Requirements**: SUB-04
**Success Criteria** (what must be TRUE):
  1. A `TaskSubscription` Zod schema exists that validates subscriber agent, granularity level, and subscription state
  2. Subscriptions are persisted as co-located `subscriptions.json` files in task artifact directories
  3. Subscription writes are atomic (crash during write does not corrupt existing data)
  4. Subscription CRUD operations (create, read, list, delete) work via a `SubscriptionStore` class
**Plans**: 1 plan
Plans:
- [x] 28-01-PLAN.md — Subscription schema and SubscriptionStore CRUD with TDD

### Phase 29: Subscription API
**Goal**: Agents can subscribe to task outcomes through MCP tools -- at dispatch time or after
**Depends on**: Phase 28
**Requirements**: SUB-01, SUB-02, SUB-03
**Success Criteria** (what must be TRUE):
  1. Agent can pass a `subscribe` parameter on `aof_dispatch` to subscribe to the created task's outcomes in a single atomic call
  2. Agent can subscribe to an already-existing task via `aof_task_subscribe` tool
  3. Agent can cancel a subscription via `aof_task_unsubscribe` tool
  4. Subscribing to an already-terminal task triggers immediate catch-up delivery (no silent miss)
**Plans**: 1 plan
Plans:
- [x] 29-01-PLAN.md — Wire SubscriptionStore into MCP tools (context, subscribe, unsubscribe, dispatch extension)

### Phase 30: Callback Delivery
**Goal**: Subscribed agents receive callback sessions with task results when subscribed events fire
**Depends on**: Phase 29
**Requirements**: DLVR-01, DLVR-02, DLVR-03, DLVR-04, GRAN-01
**Success Criteria** (what must be TRUE):
  1. When a subscribed task reaches a terminal state (done/cancelled/deadletter), the scheduler spawns a new session to the subscriber agent with task outcome as context
  2. Failed callback deliveries retry up to 3 times before marking the subscription as failed
  3. Callback sessions produce traces (trace-N.json) like normal dispatches
  4. Callback delivery never blocks or delays the underlying task's state transition
  5. Completion-granularity subscriptions fire exactly once per terminal state transition
**Plans**: 3 plans
Plans:
- [x] 30-01-PLAN.md — Schema extension, delivery function, and callback payload builder (TDD)
- [x] 30-02-PLAN.md — Wire delivery into onRunComplete, scheduler retry scan, and org chart validation (TDD)
- [x] 30-03-PLAN.md — Gap closure: wire captureTrace into callback delivery onRunComplete (DLVR-03)

### Phase 31: Granularity, Safety, and Hardening
**Goal**: All-transitions granularity works with batching, callback loops are impossible, and pending deliveries survive daemon restarts
**Depends on**: Phase 30
**Requirements**: GRAN-02, SAFE-01, SAFE-02
**Success Criteria** (what must be TRUE):
  1. `"all"` granularity subscriptions fire on every state transition, with transitions batched per poll cycle into a single callback
  2. Callback chains cannot loop infinitely -- depth counter or cross-cycle delivery prevents runaway cascades
  3. Pending subscription deliveries are re-evaluated on daemon startup (no lost callbacks across restarts)
  4. A callback-spawned task that itself triggers a callback respects a maximum depth limit
**Plans**: 2 plans
Plans:
- [x] 31-01-PLAN.md — "All" granularity delivery with batched transitions and schema extensions (TDD)
- [x] 31-02-PLAN.md — Callback depth limiting and daemon restart recovery (TDD)

### Phase 32: Agent Guidance
**Goal**: Agents understand how to use and respond to callbacks through updated standing context
**Depends on**: Phase 31
**Requirements**: GUID-01
**Success Criteria** (what must be TRUE):
  1. SKILL.md documents the `subscribe` parameter on `aof_dispatch` and the `aof_task_subscribe` / `aof_task_unsubscribe` tools
  2. SKILL.md explains idempotency expectations for callback handlers (at-least-once delivery means agents may receive duplicate callbacks)
  3. Budget gate CI test still passes after SKILL.md update (context size stays under ceiling)
**Plans**: 1 plan
Plans:
- [x] 32-01-PLAN.md — SKILL.md subscription docs, callback handler contract, and budget gate adjustment

### Phase 33: Callback Wiring Fixes
**Goal**: All-granularity delivery fires in real-time and callback depth limiting actually prevents infinite loops
**Depends on**: Phase 32
**Requirements**: GRAN-02, SAFE-01
**Gap Closure**: Closes integration gaps from v1.8 milestone audit
**Success Criteria** (what must be TRUE):
  1. `deliverAllGranularityCallbacks` is called from `assign-executor.ts` `onRunComplete` so "all" granularity subscribers get real-time notifications on every state transition
  2. `handleAofDispatch` reads `callbackDepth` from session context and writes it to new task `frontmatter.callbackDepth` so depth limiting works across callback chains
  3. Existing tests continue to pass; new integration tests cover the wired paths
**Plans**: 1 plan
Plans:
- [ ] 33-01-PLAN.md — Wire deliverAllGranularityCallbacks into onRunComplete and propagate callbackDepth through MCP boundary

## Progress

**Execution Order:**
Phases execute in numeric order: 28 -> 29 -> 30 -> 31 -> 32 -> 33

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
| 27. Trace CLI | v1.5 | 2/2 | Complete | 2026-03-08 |
| 28. Schema and Storage | v1.8 | 1/1 | Complete | 2026-03-09 |
| 29. Subscription API | v1.8 | 1/1 | Complete | 2026-03-10 |
| 30. Callback Delivery | v1.8 | 3/3 | Complete | 2026-03-10 |
| 31. Granularity, Safety, and Hardening | v1.8 | 2/2 | Complete | 2026-03-11 |
| 32. Agent Guidance | v1.8 | 1/1 | Complete | 2026-03-11 |
| 33. Callback Wiring Fixes | 1/1 | Complete    | 2026-03-12 | - |
