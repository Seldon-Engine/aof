# Roadmap: AOF

## Milestones

- ✅ **v1.0 AOF Production Readiness** — Phases 1-3 (shipped 2026-02-26)
- ✅ **v1.1 Stabilization & Ship** — Phases 4-9 (shipped 2026-02-27)
- ✅ **v1.2 Task Workflows** — Phases 10-16 (shipped 2026-03-03)
- ✅ **v1.3 Seamless Upgrade** — Phases 17-20 (shipped 2026-03-04)
- ✅ **v1.4 Context Optimization** — Phases 21-24 (shipped 2026-03-04)
- ✅ **v1.5 Event Tracing** — Phases 25-27 (shipped 2026-03-08)
- ✅ **v1.8 Task Notifications** — Phases 28-33 (shipped 2026-03-12)
- 🚧 **v1.10 Codebase Cleanups** — Phases 34-40 (in progress)

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

<details>
<summary>✅ v1.8 Task Notifications (Phases 28-33) — SHIPPED 2026-03-12</summary>

- [x] Phase 28: Schema and Storage (1/1 plan) — completed 2026-03-09
- [x] Phase 29: Subscription API (1/1 plan) — completed 2026-03-10
- [x] Phase 30: Callback Delivery (3/3 plans) — completed 2026-03-10
- [x] Phase 31: Granularity, Safety, and Hardening (2/2 plans) — completed 2026-03-11
- [x] Phase 32: Agent Guidance (1/1 plan) — completed 2026-03-11
- [x] Phase 33: Callback Wiring Fixes (1/1 plan) — completed 2026-03-12

See: `.planning/milestones/v1.8-ROADMAP.md` for full details

</details>

### v1.10 Codebase Cleanups (In Progress)

**Milestone Goal:** Eliminate accumulated entropy from 8 milestones of agent-built code — dead code removal, bug fixes, architectural refactoring, centralized config, structured logging, and test infrastructure improvements.

- [x] **Phase 34: Dead Code Removal** - Remove ~2,900 lines of legacy gate system code, unused exports, deprecated aliases, and commented-out code (completed 2026-03-12)
- [x] **Phase 35: Bug Fixes** - Fix buildTaskStats counts, daemon startTime initialization, UpdatePatch.blockers, and TOCTOU race mitigation (completed 2026-03-12)
- [x] **Phase 36: Config Registry** - Centralize all process.env reads into a Zod-validated, typed config singleton (completed 2026-03-12)
- [x] **Phase 37: Structured Logging** - Replace core module console.* calls with leveled JSON logger, remediate silent catch blocks (completed 2026-03-13)
- [x] **Phase 38: Code Refactoring** - Extract helpers from god functions, unify tool registration, deduplicate patterns (completed 2026-03-13)
- [x] **Phase 39: Architecture Fixes** - Break circular dependencies, fix store abstraction bypass, fix layering violations (completed 2026-03-13)
- [ ] **Phase 40: Test Infrastructure** - Shared test harness, typed mock factories, coverage config expansion, temp dir cleanup

## Phase Details

### Phase 34: Dead Code Removal
**Goal**: Codebase reduced by ~2,900 lines with clean TypeScript compilation and no legacy gate symbols remaining
**Depends on**: Nothing (first phase of v1.10)
**Requirements**: DEAD-01, DEAD-02, DEAD-03, DEAD-04, DEAD-05, DEAD-06, DEAD-07, DEAD-08, DEAD-09
**Success Criteria** (what must be TRUE):
  1. `tsc --noEmit` passes with zero errors after all gate system source files, test files, and barrel re-exports are deleted
  2. `grep -r` for gate-evaluator, gate-conditional, gate-context-builder, GateSchema, WorkflowGateSchema across src/ and tests/ returns zero hits (excluding migration stubs)
  3. No unused imports remain in scheduler.ts, no deprecated type aliases exist in executor.ts or dispatch/index.ts, no commented-out code blocks remain in event.ts or promotion.ts
  4. All existing tests pass (vitest full suite green) — no regressions from removals
**Plans:** 2/2 plans complete
Plans:
- [ ] 34-01-PLAN.md — Gate system removal (source, tests, re-exports, migration, imports)
- [ ] 34-02-PLAN.md — Cleanup unused MCP schemas, deprecated aliases, commented code, notifier

### Phase 35: Bug Fixes
**Goal**: Known correctness bugs fixed — task statistics accurate, daemon timing correct, type definitions clean, race conditions mitigated
**Depends on**: Phase 34
**Requirements**: BUG-01, BUG-02, BUG-03, BUG-04
**Success Criteria** (what must be TRUE):
  1. `buildTaskStats()` includes cancelled and deadletter statuses in its counts — a project with deadlettered tasks no longer triggers false "all tasks blocked" alerts
  2. Daemon startTime reflects actual daemon start (inside `startAofDaemon()`) not module import time — `/status` endpoint reports correct uptime after restart
  3. `UpdatePatch.blockers` is correctly positioned in the type definition (or removed if unused) — no type errors when using task update operations
  4. Scheduler-initiated state transitions (transitionTask, acquireLease) go through the task lock manager — concurrent operations on the same task are serialized
**Plans:** 2/2 plans complete
Plans:
- [ ] 35-01-PLAN.md — Fix buildTaskStats counts, daemon startTime, remove blockers dead code (BUG-01, BUG-02, BUG-03)
- [ ] 35-02-PLAN.md — Route scheduler transitions through shared task lock manager (BUG-04)

### Phase 36: Config Registry
**Goal**: All AOF configuration resolved through a single typed registry — no scattered process.env reads outside src/config/
**Depends on**: Phase 35
**Requirements**: CFG-01, CFG-02, CFG-03, CFG-04
**Success Criteria** (what must be TRUE):
  1. `getConfig()` returns a frozen, Zod-validated object with typed access to all AOF_* env vars — invalid config at startup produces a clear error listing all issues
  2. `resetConfig()` provides complete test isolation — tests can override config values without affecting other tests
  3. `grep -r "process.env" src/` returns zero hits outside src/config/ (except the documented AOF_CALLBACK_DEPTH cross-process mutation in callback-delivery.ts)
  4. The config module imports nothing from dispatch/, service/, store/, or any module above it in the dependency hierarchy
**Plans:** 2/2 plans complete
Plans:
- [ ] 36-01-PLAN.md — Config registry singleton with Zod schema, rename manager.ts, barrel updates (CFG-01, CFG-02, CFG-04)
- [ ] 36-02-PLAN.md — Consolidate all process.env reads into registry (CFG-03)

### Phase 37: Structured Logging
**Goal**: Core modules emit leveled, structured JSON logs to stderr — silent catch blocks remediated, CLI output unchanged
**Depends on**: Phase 36
**Requirements**: LOG-01, LOG-02, LOG-03, LOG-04, LOG-05, LOG-06, LOG-07
**Success Criteria** (what must be TRUE):
  1. Running the daemon with `AOF_LOG_LEVEL=debug` produces JSON log lines on stderr with level, timestamp, component, and message fields — setting level to `error` suppresses info/warn/debug output
  2. Each core module (dispatch, scheduler, protocol, daemon, service) uses a child logger with its component name — log output is filterable by component
  3. The 36 previously-silent catch blocks in dispatch/ now emit at least a warn-level log line with the error — no errors are silently swallowed in core modules
  4. CLI commands (`aof status`, `aof trace`, etc.) still produce human-readable console output — CLI is not affected by the structured logger
  5. EventLogger (audit JSONL) continues to write to its own files unchanged — operational logging and audit events remain separate systems
**Plans:** 3/3 plans complete
Plans:
- [ ] 37-01-PLAN.md — Logger factory module (install Pino, createLogger/resetLogger, tests)
- [ ] 37-02-PLAN.md — Migrate dispatch/ console.* calls and remediate silent catch blocks
- [ ] 37-03-PLAN.md — Migrate remaining core modules, verify CLI and EventLogger boundaries

### Phase 38: Code Refactoring
**Goal**: God functions decomposed into testable helpers, tool registration unified, duplicated patterns consolidated
**Depends on**: Phase 37
**Requirements**: REF-01, REF-02, REF-03, REF-04, REF-05, REF-06, REF-07, REF-08
**Success Criteria** (what must be TRUE):
  1. `executeAssignAction()` and `executeActions()` are decomposed — each contains no more than ~50 lines of orchestration logic, with business logic in named helper functions that can be tested independently
  2. Tool registration for OpenClaw adapter and MCP server shares handler functions through a common layer — adding a new tool requires implementing the handler once, not twice
  3. Callback delivery and trace capture code each exist in exactly one place (single helper function) — no copy-paste duplication in assign-executor.ts
  4. MCP tools.ts inline schemas are moved to a shared location — the god file is split into focused modules
**Plans:** 3/3 plans complete
Plans:
- [ ] 38-01-PLAN.md — Decompose executeAssignAction, deduplicate callback/trace helpers (REF-01, REF-04, REF-05, REF-06)
- [ ] 38-02-PLAN.md — Decompose executeActions switch into domain handler modules (REF-02)
- [ ] 38-03-PLAN.md — Unify tool registration, split MCP god file, withPermissions HOF (REF-03, REF-07, REF-08)

### Phase 39: Architecture Fixes
**Goal**: Module dependency graph is clean — no circular imports, no store abstraction bypass, no layering violations
**Depends on**: Phase 37 (can run after or alongside Phase 38)
**Requirements**: ARCH-01, ARCH-02, ARCH-03, ARCH-04, ARCH-05, ARCH-06
**Success Criteria** (what must be TRUE):
  1. `madge --circular src/` reports zero circular dependencies — the dispatch/protocol cycle is broken via extracted shared utility
  2. Zero direct `serializeTask()` + `writeFileAtomic()` call sites exist outside the store module — all 14 bypass sites route through ITaskStore methods
  3. Config module does not import from org/ — the lintOrgChart dependency is inverted or relocated
  4. MCP server does not import from CLI — `createProjectStore()` lives in projects/ or store/, and `loadProjectManifest()` has a single implementation
  5. memory/index.ts barrel exports are separated from `registerMemoryModule()` initialization logic
**Plans:** 3/3 plans complete
Plans:
- [ ] 39-01-PLAN.md — Break dispatch and tools circular dependency cycles (ARCH-01)
- [ ] 39-02-PLAN.md — Fix layering violations, relocate modules, split memory barrel, break simple cycles (ARCH-03, ARCH-04, ARCH-05, ARCH-06)
- [ ] 39-03-PLAN.md — Route store bypass sites through ITaskStore, restrict exports (ARCH-02)

### Phase 40: Test Infrastructure
**Goal**: Test utilities standardized — shared harness eliminates setup duplication, typed mocks replace as-any casts, coverage tracks all modules
**Depends on**: Phase 38, Phase 39
**Requirements**: TEST-01, TEST-02, TEST-03, TEST-04, TEST-05
**Success Criteria** (what must be TRUE):
  1. `createTestHarness()` / `withTestProject()` utility exists and is adopted by at least 10 test files — setup/teardown boilerplate reduced
  2. `createMockStore()` and `createMockLogger()` factories return properly typed mocks — test files using them have zero `as any` casts for store/logger construction
  3. Vitest coverage config tracks all src/ modules (not just the current 6 files) — `vitest run --coverage` produces a report covering the full source tree
  4. The 8 test files with missing temp dir cleanup have proper `afterEach` blocks that remove temporary directories
**Plans:** 2 plans
Plans:
- [ ] 40-01-PLAN.md — Create test harness, mock factories, coverage config (TEST-01, TEST-02, TEST-03, TEST-05)
- [ ] 40-02-PLAN.md — Migrate test files to shared harness and typed mocks (TEST-01, TEST-02, TEST-04, TEST-05)
## Progress

**Execution Order:**
Phases execute in numeric order: 34 -> 35 -> 36 -> 37 -> 38 -> 39 -> 40

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
| 31. Granularity, Safety, Hardening | v1.8 | 2/2 | Complete | 2026-03-11 |
| 32. Agent Guidance | v1.8 | 1/1 | Complete | 2026-03-11 |
| 33. Callback Wiring Fixes | v1.8 | 1/1 | Complete | 2026-03-12 |
| 34. Dead Code Removal | 2/2 | Complete    | 2026-03-12 | - |
| 35. Bug Fixes | 2/2 | Complete    | 2026-03-12 | - |
| 36. Config Registry | 2/2 | Complete    | 2026-03-12 | - |
| 37. Structured Logging | 3/3 | Complete    | 2026-03-13 | - |
| 38. Code Refactoring | 3/3 | Complete    | 2026-03-13 | - |
| 39. Architecture Fixes | 3/3 | Complete    | 2026-03-13 | - |
| 40. Test Infrastructure | v1.10 | 0/2 | Not started | - |
