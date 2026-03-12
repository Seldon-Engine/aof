# Requirements: AOF v1.10 Codebase Cleanups

**Defined:** 2026-03-12
**Core Value:** Tasks never get dropped — they survive gateway restarts, API failures, rate limits, and agent crashes, always resuming and completing end-to-end without human intervention.

## v1.10 Requirements

Requirements for codebase cleanup milestone. Each maps to roadmap phases.

### Dead Code

- [x] **DEAD-01**: Legacy gate system removed — gate-evaluator.ts, gate-conditional.ts, gate-context-builder.ts, gate.ts schema, workflow.ts schema (~900 lines source)
- [x] **DEAD-02**: Legacy gate test files removed — gate-evaluator.test.ts, gate-enforcement.test.ts, gate-conditional.test.ts, gate-context-builder.test.ts, gate-timeout.test.ts, gate.test.ts, task-gate-extensions.test.ts (~2,000 lines tests)
- [x] **DEAD-03**: Gate barrel re-exports removed from schemas/index.ts and dispatch/index.ts
- [x] **DEAD-04**: Lazy gate-to-DAG migration removed from FilesystemTaskStore (get, getByPrefix, list) and migration/gate-to-dag.ts
- [x] **DEAD-05**: Unused imports cleaned from scheduler.ts (18+ symbols from prior extractions)
- [x] **DEAD-06**: 13 unused MCP output schemas removed from mcp/tools.ts (~100 lines)
- [x] **DEAD-07**: Deprecated type aliases removed (DispatchResult, Executor, MockExecutor) from executor.ts and dispatch/index.ts
- [x] **DEAD-08**: Commented-out code removed (event.ts import, promotion.ts Phase 2 block, stale JSDoc references)
- [x] **DEAD-09**: Deprecated notifier param removed from AOFService constructor

### Bug Fixes

- [ ] **BUG-01**: buildTaskStats counts cancelled and deadletter statuses — prevents false "all tasks blocked" alerts
- [ ] **BUG-02**: Daemon startTime initialized inside startAofDaemon() — not at module load
- [ ] **BUG-03**: UpdatePatch.blockers moved to correct position in type (or removed if truly unused)
- [x] **BUG-04**: TOCTOU race in transitionTask/acquireLease mitigated — scheduler-initiated transitions routed through task lock manager

### Config Registry

- [ ] **CFG-01**: Zod-based ConfigRegistry singleton with typed schema covering all AOF_* env vars
- [ ] **CFG-02**: Lazy initialization with resetConfig() for test isolation
- [ ] **CFG-03**: All 11 scattered process.env reads consolidated into registry (except AOF_CALLBACK_DEPTH cross-process mutation)
- [ ] **CFG-04**: Config module has zero upward dependencies — sits at bottom of module hierarchy alongside schemas

### Structured Logging

- [ ] **LOG-01**: Pino integrated as structured logging library with JSON output to stderr
- [ ] **LOG-02**: Log levels configurable via AOF_LOG_LEVEL env var (read from config registry)
- [ ] **LOG-03**: Child loggers created per module for contextual logging (dispatch, scheduler, protocol, daemon, service)
- [ ] **LOG-04**: Core module console.* calls replaced with structured logger (~120 calls in dispatch, service, protocol, daemon)
- [ ] **LOG-05**: 36 silent catch blocks in dispatch remediated — errors logged at warn/debug level instead of swallowed
- [ ] **LOG-06**: CLI console.* output unchanged — user-facing output is not logging
- [ ] **LOG-07**: EventLogger (audit JSONL) unchanged — operational logging and audit events remain separate systems

### Code Refactoring

- [ ] **REF-01**: executeAssignAction() decomposed — onRunComplete callback, trace capture, callback delivery extracted into named helpers
- [ ] **REF-02**: executeActions() 415-line switch decomposed — each case extracted into named handler function
- [ ] **REF-03**: Tool registration unified — shared handler functions between OpenClaw adapter and MCP server, thin adapter layer for each
- [ ] **REF-04**: Callback delivery code deduplicated in assign-executor.ts — single deliverAllCallbacksSafely() helper
- [ ] **REF-05**: Trace capture code deduplicated in assign-executor.ts — single captureTraceSafely() helper
- [ ] **REF-06**: Gate-to-DAG migration check deduplicated in task-store.ts — single migrateIfNeeded() method (or removed with DEAD-04)
- [ ] **REF-07**: OpenClaw adapter withPermissions() HOF replaces 10 copy-pasted execute blocks with as-any casts
- [ ] **REF-08**: MCP tools.ts god file split — inline schemas moved to shared location, registration logic decomposed

### Architecture

- [ ] **ARCH-01**: Circular dependency between dispatch/ and protocol/ broken — completion-utils.ts extracted to shared location
- [ ] **ARCH-02**: Store abstraction bypass fixed — 14 direct serializeTask+writeFileAtomic call sites routed through ITaskStore
- [ ] **ARCH-03**: Config→org upward import fixed — lintOrgChart dependency inverted or moved
- [ ] **ARCH-04**: MCP→CLI hidden dependency fixed — createProjectStore() moved to projects/ or store/
- [ ] **ARCH-05**: Duplicate loadProjectManifest() implementations unified into shared utility
- [ ] **ARCH-06**: memory/index.ts split — barrel exports separated from registerMemoryModule() logic

### Test Infrastructure

- [ ] **TEST-01**: Shared test harness created (createTestHarness/withTestProject) — eliminates ~60 duplicated setup/teardown blocks
- [ ] **TEST-02**: Typed mock factories created (createMockStore, createMockLogger) — replaces as-any cast pattern across test files
- [ ] **TEST-03**: Coverage config expanded beyond current 6 files to track all source modules
- [ ] **TEST-04**: 8 test files with missing temp dir cleanup fixed
- [ ] **TEST-05**: Existing src/testing/ utilities promoted — adoption across test files that currently duplicate their functionality

## Future Requirements

### Test Coverage Expansion

- **TCOV-01**: Unit tests for action-executor.ts (415 lines, zero tests)
- **TCOV-02**: Unit tests for escalation.ts (493 lines, zero tests)
- **TCOV-03**: Unit tests for task-dispatcher.ts (290 lines, zero tests)
- **TCOV-04**: Unit tests for notification policy sub-modules (934 lines, zero direct tests)
- **TCOV-05**: CLI command handler tests (2,711 lines, zero tests)

### Further Refactoring

- **FREF-01**: Dispatch module decomposition (26 files, ~6,800 LOC — extract murmur, callbacks, leases)
- **FREF-02**: process.env consolidation for non-AOF vars (OpenClaw vars)
- **FREF-03**: Module-level mutable state encapsulation (effectiveConcurrencyLimit, throttleState, leaseRenewalTimers)

## Out of Scope

| Feature | Reason |
|---------|--------|
| CLI console.* replacement | CLI output is user-facing, not diagnostic logging |
| EventLogger changes | Audit events are a separate system from operational logging |
| OpenClaw env var consolidation | AOF_CALLBACK_DEPTH cross-process mutation must stay; OPENCLAW_* vars are external |
| Full dispatch module decomposition | Too large for cleanup milestone — do targeted extraction only |
| New test coverage for untested modules | Write characterization tests where needed for refactoring, but full coverage is future work |
| Performance optimization (nextTaskId scan) | Low priority, not a cleanup item |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DEAD-01 | Phase 34 | Complete |
| DEAD-02 | Phase 34 | Complete |
| DEAD-03 | Phase 34 | Complete |
| DEAD-04 | Phase 34 | Complete |
| DEAD-05 | Phase 34 | Complete |
| DEAD-06 | Phase 34 | Complete |
| DEAD-07 | Phase 34 | Complete |
| DEAD-08 | Phase 34 | Complete |
| DEAD-09 | Phase 34 | Complete |
| BUG-01 | Phase 35 | Pending |
| BUG-02 | Phase 35 | Pending |
| BUG-03 | Phase 35 | Pending |
| BUG-04 | Phase 35 | Complete |
| CFG-01 | Phase 36 | Pending |
| CFG-02 | Phase 36 | Pending |
| CFG-03 | Phase 36 | Pending |
| CFG-04 | Phase 36 | Pending |
| LOG-01 | Phase 37 | Pending |
| LOG-02 | Phase 37 | Pending |
| LOG-03 | Phase 37 | Pending |
| LOG-04 | Phase 37 | Pending |
| LOG-05 | Phase 37 | Pending |
| LOG-06 | Phase 37 | Pending |
| LOG-07 | Phase 37 | Pending |
| REF-01 | Phase 38 | Pending |
| REF-02 | Phase 38 | Pending |
| REF-03 | Phase 38 | Pending |
| REF-04 | Phase 38 | Pending |
| REF-05 | Phase 38 | Pending |
| REF-06 | Phase 38 | Pending |
| REF-07 | Phase 38 | Pending |
| REF-08 | Phase 38 | Pending |
| ARCH-01 | Phase 39 | Pending |
| ARCH-02 | Phase 39 | Pending |
| ARCH-03 | Phase 39 | Pending |
| ARCH-04 | Phase 39 | Pending |
| ARCH-05 | Phase 39 | Pending |
| ARCH-06 | Phase 39 | Pending |
| TEST-01 | Phase 40 | Pending |
| TEST-02 | Phase 40 | Pending |
| TEST-03 | Phase 40 | Pending |
| TEST-04 | Phase 40 | Pending |
| TEST-05 | Phase 40 | Pending |

**Coverage:**
- v1.10 requirements: 43 total
- Mapped to phases: 43
- Unmapped: 0

---
*Requirements defined: 2026-03-12*
*Last updated: 2026-03-12 after roadmap creation*
