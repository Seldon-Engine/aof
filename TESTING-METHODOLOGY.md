# Testing Methodology — AOF (Agentic Ops Fabric)

**Philosophy:** Testing Honeycomb + Observability-Driven Development  
**Last updated:** 2026-02-23  
**Test runner:** Vitest 2.x  
**Total tests (audit baseline):** ~2,200 across 220 files

---

## Philosophy

We do not optimize for code coverage %. We test **system behavior at observable boundaries**:

- **What went to disk** — task files, event logs, filesystem state
- **What metrics were emitted** — Prometheus counters and gauges
- **What state transitions occurred** — task status, lifecycle events

If a bug could ship without breaking any test, that test is missing.

---

## Honeycomb Layer Map

AOF's tests already follow the Honeycomb distribution. The numbers below come from the 2026-02-23 audit of all 220 test files.

| Layer | Location | What it tests | File count | When to add |
|-------|----------|---------------|------------|-------------|
| E2E / Workflow | `tests/e2e/suites/` | Full workflows: init → dispatch → complete → events | ~20 files | New user journeys or regression scenarios |
| Contract | `src/integration/__tests__/` | Plugin API vs real OpenClaw | 1 file (gap) | New external integrations |
| Integration / Service | `src/**/__tests__/` | Scheduler, store, service with real deps | ~160 files | All new features |
| Narrow integration | `src/**/__tests__/` | CLI commands, daemon lifecycle, OS interactions | ~25 files | CLI commands, process boundaries |
| Fine-grained | `src/**/__tests__/` | Zod schemas, pure serializers, pure algorithms | ~15 files | Pure functions only |

**Key finding from audit:** 75.5% of files are already KEEP. AOF has been practicing Honeycomb implicitly. This is a cleanup and instrumentation initiative, not a rewrite.

---

## Boundaries

### Test with real implementations

- `FilesystemTaskStore` — always use real `mkdtemp`, never mock
- `EventLogger` — always real; use `readEventLogEntries()` helper to assert
- `AOFService` — real service instance with real store and real logger
- `MurmurStateManager` — real implementation (not vi.fn() stubs)

### Test via interface contract

- `Executor` — use `MockExecutor` (the designated test-only stub); executor is an external system boundary
- `OpenClaw gateway` — use containerized OpenClaw in `tests/integration/openclaw/`
- `@inquirer/prompts` — mock at CLI test boundary (prompts are an external I/O boundary)
- `openclaw-cli.js` — mock in CLI wizard tests (it shells out to an external process)
- HTTP APIs — use `fetch` with a real mock at the network boundary; never mock `fetch` globally for logic tests

### Never mock

- Internal modules you own — if you're mocking an internal, extract the boundary instead
- `node:fs/promises` in integration tests — use real `mkdtemp`
- `node:path`, `node:crypto` — these are pure
- `FilesystemTaskStore` — the store is fast enough; no justification for mocking it

---

## ODD Assertion Requirements

ODD (Observability-Driven Development) means tests verify what an outside observer can see — not internal state.

Every integration test that exercises a workflow (dispatch, transition, error, recovery) **must** assert on at least one of:

**1. Event log:**
```typescript
const events = await readEventLogEntries(eventsDir);
expect(findEvents(events, "task.dispatched")).toHaveLength(1);
expect(findEvents(events, "task.dispatched")[0]?.taskId).toBe(taskId);
```

**2. Task state on disk:**
```typescript
const tasks = await readTasksInDir(join(tmpDir, "tasks", "in-progress"));
expect(tasks.some(t => t.frontmatter.id === taskId)).toBe(true);
```

**3. Metric state** (for scheduler and service tests):
```typescript
const count = await getMetricValue(metrics, "aof_tasks_total", { state: "done" });
expect(count).toBe(1);
```

**Import helpers from `src/testing/`:**
```typescript
import { readEventLogEntries, findEvents, expectEvent, getMetricValue, readTasksInDir } from "../../testing/index.js";
```

---

## Test Commands

```bash
# All tests
npx vitest run

# Watch mode (development)
npx vitest

# Coverage (boundary surfaces only)
npx vitest run --coverage

# E2E suite only
npx vitest run tests/e2e/

# Contract tests only
npx vitest run src/integration/
```

---

## Coverage Target

We track **boundary coverage**, not line coverage:

- [ ] Every state transition in `VALID_TRANSITIONS` has an integration test
- [ ] Every event type in `EventType` has an ODD emission test
- [ ] Every Prometheus metric has at least one assertion in `metrics-emission.test.ts`
- [ ] Every gateway handler has a contract test against real OpenClaw
- [ ] No `vi.mock()` on internal implementation details

---

## Prohibited Patterns

```typescript
// ❌ Spying on console to test error paths — this is the most common antipattern in AOF
vi.spyOn(console, "error");
consoleErrors.some(msg => msg.includes("failed")); // ← never assert on console text

// ❌ Mocking internal modules you own
vi.mock("../../store/task-store");
vi.mock("../../events/logger");

// ❌ Spying on internal methods as a proxy for behavior
vi.spyOn(router, "handleStatusUpdate");
vi.spyOn(adapter, "registerAofPlugin");

// ❌ Exporting internal state for test access
export function resetThrottleState() { ... } // smell: test-only export from production module

// ❌ Code coverage % as a quality signal
// "I got coverage to 90%" proves nothing about correctness

// ✅ Assert event log (ODD — what an observer sees)
const events = await readEventLogEntries(eventsDir);
expect(events.some(e => e.type === "scheduler.error")).toBe(true);

// ✅ Assert filesystem state (ODD — what's on disk)
const tasks = await readTasksInDir(join(tmpDir, "tasks", "done"));
expect(tasks.find(t => t.frontmatter.id === taskId)).toBeDefined();

// ✅ Assert metric counters (ODD — what Prometheus sees)
const after = await getMetricValue(metrics, "aof_scheduler_loop_duration_seconds_count");
expect(after).toBeGreaterThan(before ?? 0);
```

---

## Known Gaps

*From the 2026-02-23 audit of all 220 test files. Verdicts: 166 KEEP, 32 REFACTOR, 20 EXPAND, 2 conditional DELETE.*

### Audit summary

| Verdict | Count | Description |
|---------|-------|-------------|
| KEEP | 166 (75.5%) | Correctly structured — no action needed |
| REFACTOR | 32 (14.5%) | Antipattern present — fix before adding new tests |
| EXPAND | 20 (9.1%) | Correct structure, thin coverage — add test cases |
| DELETE | 2 (0.9%) | Conditional — confirm redundancy after REFACTOR |

---

### REFACTOR targets (32 files)

The dominant antipattern across all 32 files is **console-spy-as-assertion**: capturing `console.error` / `console.warn` / `console.info` into arrays and asserting on the text strings. Replace with ODD event log assertions in every case.

#### Priority 1 — Console spy assertions in dispatch (10 files)

These convert `vi.spyOn(console.*)` assertions to `expectEvent(events, ...)` assertions. Tracked under **AOF-honeycomb-004**.

| File | Spy target | Replace with |
|------|-----------|--------------|
| `dispatch/__tests__/bug-001-dispatch-execution.test.ts` | `console.info/error` | Event log assertions |
| `dispatch/__tests__/bug-002-003-dispatch-wiring.test.ts` | `console.error` | `type: "dispatch.error"` event |
| `dispatch/__tests__/bug-002-error-logging.test.ts` | `console.error` → `consoleErrors[]` | `expectEvent(events, "dispatch.error")` |
| `dispatch/__tests__/bug-002-log-event-consistency.test.ts` | `console.info/error` → arrays | `findEvents(events, type)` |
| `dispatch/__tests__/bug-003-error-propagation.test.ts` | `console.error` → `consoleErrors[]` | `expectEvent(events, "dispatch.error")` |
| `dispatch/__tests__/bug-004-stuck-tasks.test.ts` | `console.warn` → `consoleWarns[]` | `findEvents(events, "scheduler.warning")` |
| `dispatch/__tests__/dag-gating.test.ts` | `consoleSpy.toHaveBeenCalledWith(...)` | `type: "gate.warning"` event |
| `dispatch/__tests__/deadletter.test.ts` | `errorSpy.toHaveBeenCalledWith(...)` | `type: "task.deadlettered"` event |
| `dispatch/__tests__/gap-004-routing-diagnostic.test.ts` | `console.info/error/warn` → arrays | Event log assertions |
| `dispatch/__tests__/gate-conditional.test.ts` | `consoleWarnSpy.toHaveBeenCalledTimes(3)` | Structured warning event from gate-conditional |

#### Priority 2 — Console spy + internal test export (2 files)

| File | Issue | Action |
|------|-------|--------|
| `dispatch/__tests__/scheduler-throttling.test.ts` | `console.info` spy plus `resetThrottleState()` exported from production code | Expose throttle state via event payload or metric; remove internal export |
| `dispatch/__tests__/resource-serialization.test.ts` | `console.warn` spy for serialization warning | Emit `resource.blocked` event; assert on event log |

#### Priority 3 — Mocked internal dependencies in murmur (3 files)

These mock `ITaskStore`, `EventLogger`, and `MurmurStateManager` — all internally owned. Replace with real implementations.

| File | Mocks | Action |
|------|-------|--------|
| `murmur/__tests__/cleanup.test.ts` | `ITaskStore`, `EventLogger`, `MurmurStateManager` | Use real `FilesystemTaskStore` + real `EventLogger` + real `MurmurStateManager` |
| `murmur/__tests__/murmur-e2e.test.ts` | Mock store + mock logger in an "E2E" test | Real `FilesystemTaskStore` + real `EventLogger` — E2E tests require real implementations |
| `murmur/__tests__/murmur-concurrency.test.ts` | Mock store + mock logger | Real `FilesystemTaskStore` + real `EventLogger`; file locking only works with real I/O |

#### Priority 4 — Spy on owned method (2 files)

| File | Spy | Action |
|------|-----|--------|
| `protocol/__tests__/router.test.ts` | `vi.spyOn(router, "handleStatusUpdate")` | Assert on observable effects (task status changes, event log entries) instead |
| `openclaw/__tests__/plugin.unit.test.ts` | `vi.spyOn(adapter, "registerAofPlugin")` | Move to `src/integration/__tests__/plugin-contract.test.ts`; test against real OpenClaw API |

#### Priority 5 — Regression suite overlap (13 files — confirm during refactor)

Thirteen `bug-00X-*.test.ts` files in `dispatch/__tests__/` may have scenario overlap with the newer consolidated regression suites (`bug-001-004-new-regression.test.ts`, `bug-001-005-regression.test.ts`). Verify and consolidate duplicates after Priority 1–4 refactors are complete.

---

### DELETE targets (2 files — conditional)

Do not delete until the REFACTOR phase confirms full coverage.

| File | Condition for deletion |
|------|------------------------|
| `dispatch/__tests__/bug-002-error-logging.test.ts` | Redundant if `bug-002-003-dispatch-wiring.test.ts` + event log regression suite fully cover executor error logging after refactor |
| `dispatch/__tests__/bug-003-error-propagation.test.ts` | Redundant if `bug-001-005-regression.test.ts` provides equivalent coverage after ODD assertions are added |

---

### EXPAND targets (20 files)

These files are at the correct Honeycomb layer but have too few tests for the surface they cover. Add test cases; do not restructure.

| File | Tests now | Target | What to add |
|------|-----------|--------|-------------|
| `cli/__tests__/metrics-cli.test.ts` | 4 | 8 | Error paths, no-metrics case, custom format |
| `cli/__tests__/project-utils.test.ts` | 5 | 10 | Edge cases for all util functions |
| `cli/__tests__/task-resurrect.test.ts` | 5 | 10 | Resurrect from done, from cancelled, with dependencies |
| `cli/commands/__tests__/daemon-integration.test.ts` | 3 | 8 | Concurrent start, port conflict, config override |
| `cli/commands/__tests__/task-close.test.ts` | 3 | 8 | Close in wrong state, close with pending deps |
| `context/__tests__/steward-integration.test.ts` | 4 | 10 | Budget exceeded alert, multi-context steward, metric assertion |
| `daemon/__tests__/server.test.ts` | 4 | 8 | Concurrent requests, error responses, shutdown |
| `delegation/__tests__/delegation.test.ts` | 1 | 8 | Concurrent, timeout, retry, delegation chain |
| `dispatch/__tests__/deadletter-integration.test.ts` | 1 | 6 | Multiple failures, threshold boundary, recovery after deadletter |
| `dispatch/__tests__/e2e-platform-limit.test.ts` | 2 | 8 | Exact-at-limit, just-below-limit, mixed agents |
| `events/__tests__/logger.test.ts` | 4 | 10 | Concurrent writes, rotation, malformed events, replay |
| `gateway/__tests__/handlers.test.ts` | 2 | 12 | All handler routes, error responses, auth, payload validation |
| `mcp/__tests__/subscriptions.test.ts` | 2 | 8 | Subscription lifecycle, error handling, reconnect |
| `memory/__tests__/chunker.test.ts` | 2 | 8 | Large doc chunking, overlap, boundary conditions |
| `memory/__tests__/hybrid-search.test.ts` | 1 | 6 | Score merging, FTS-only fallback, empty vector results |
| `metrics/__tests__/exporter.test.ts` | 19 | 25+ | ODD emission tests after specific workflows (AOF-honeycomb-005) |
| `openclaw/__tests__/adapter.test.ts` | 1 | 8 | Config overrides, service registration, tool registration |
| `service/__tests__/aof-service.test.ts` | 6 | 12 | ODD metric and event assertions per scheduler poll |
| `store/__tests__/task-store-error-logging.test.ts` | 3 | 8 | Concurrent error, malformed file, recovery path |
| `tools/__tests__/aof-tools-events.test.ts` | 4 | 10 | ODD event assertions for each tool invocation type |
| `tests/integration/dispatch-pipeline.test.ts` | 4 | 10 | Error path, retry, concurrent pipelines |
| `tests/integration/plugin-load.test.ts` | 3 | 8 | Invalid plugin, version mismatch, hot reload |

---

### Structural gaps (contract and E2E layers)

These gaps require new files, not changes to existing ones:

- **Contract layer is nearly empty.** `src/integration/__tests__/` has only one file (`bug-005-tool-persistence.test.ts`). `plugin-contract.test.ts` is the priority addition (AOF-honeycomb-006).
- **No metric emission integration tests.** `src/integration/__tests__/metrics-emission.test.ts` needs to be created to verify Prometheus counters update correctly after scheduler polls and task transitions (AOF-honeycomb-005).
- **`gateway/__tests__/handlers.test.ts` severely under-covered.** Two tests for the full gateway handler surface is inadequate. See EXPAND table above.

---

### Honeycomb health by module

| Module | Verdict summary | Status |
|--------|-----------------|--------|
| `schemas/` | 16 KEEP | ✅ Excellent |
| `store/` | 10 KEEP, 1 EXPAND | ✅ Excellent |
| `tests/e2e/suites/` | 17 KEEP | ✅ Excellent |
| `dispatch/` | 17 KEEP, 13 REFACTOR, 2 EXPAND, 1 DELETE | ⚠️ Good structure, console-spy antipattern widespread |
| `murmur/` | 3 KEEP, 3 REFACTOR | ⚠️ Mock-internal antipattern in 3 files |
| `gateway/` | 1 EXPAND | ❌ Severely under-covered (2 tests total) |
| `memory/` | 16 KEEP, 8 EXPAND | ✅ Good structure, CRUD operations thin |
| `openclaw/` | 6 KEEP, 1 REFACTOR | ✅ Good — external boundaries mostly correct |
| `protocol/` | 7 KEEP, 1 REFACTOR | ✅ Good |
| `context/` | 10 KEEP, 1 EXPAND | ✅ Good |
| `cli/` + `cli/commands/` | 12 KEEP, 3 EXPAND | ✅ Good |
| `events/` | 4 KEEP, 1 EXPAND | ✅ Good |
| `service/` | 2 KEEP, 1 EXPAND | ✅ Good — needs ODD assertions |
| `tests/integration/` | 3 KEEP, 2 EXPAND | ✅ Good |
| Others | 23 KEEP, 1 EXPAND | ✅ Generally healthy |

---

### Expected test delta after full initiative

| Task | Tests removed | Tests added | Net |
|------|--------------|-------------|-----|
| Refactor dispatch console-spy tests | ~40 (spy assertions deleted) | ~40 (event log assertions) | ±0 |
| Refactor murmur mock-internal tests | ~10 | ~10 | ±0 |
| Add metrics emission tests (AOF-honeycomb-005) | 0 | ~15 | +15 |
| Add lifecycle E2E test (AOF-honeycomb-006) | 0 | ~10 | +10 |
| ODD assertions on existing tests (AOF-honeycomb-007) | 0 | ~30 | +30 |
| **Total** | **~50** | **~105** | **+55** |

Target after initiative completes: ~2,260 tests (from ~2,200 baseline), with higher signal density.

---

## Appendix A — Mock decision rules

When you encounter `vi.mock()` or `vi.spyOn()`:

```
What is being mocked?
├── External system (OpenClaw gateway, HTTP API, OS process, @inquirer/prompts)?
│   → KEEP — correct boundary
├── Internal module owned by this project?
│   → REFACTOR — remove mock, use real implementation
└── Node built-in (fs, path, crypto)?
    ├── CLI test with no tmpdir available? → KEEP with justification comment
    └── Anything else? → REFACTOR (use real tmpdir)

Why is it mocked?
├── "It's slow" → KEEP but add @slow tag; consider fixture data
├── "It's flaky" → REFACTOR — a flaky dep is an untested contract
└── "It's hard to set up" → REFACTOR — difficulty means a test helper is missing
```

---

## Appendix B — ODD assertion cheatsheet

```typescript
// Assert event type was emitted
const events = await readEventLogEntries(eventsDir);
expect(findEvents(events, "task.dispatched")).toHaveLength(1);

// Assert specific event fields
const evt = expectEvent(events, "task.transitioned");
expect(evt.fromStatus).toBe("ready");
expect(evt.toStatus).toBe("in-progress");

// Assert metric counter incremented
const before = await getMetricValue(metrics, "aof_delegation_events_total");
await runSomeWorkflow();
const after = await getMetricValue(metrics, "aof_delegation_events_total");
expect(after).toBeGreaterThan(before ?? 0);

// Assert task is in the correct directory
const readyTasks = await readTasksInDir(join(tmpDir, "tasks", "ready"));
expect(readyTasks.find(t => t.frontmatter.id === "TASK-001")).toBeDefined();
const inProgressTasks = await readTasksInDir(join(tmpDir, "tasks", "in-progress"));
expect(inProgressTasks.find(t => t.frontmatter.id === "TASK-001")).toBeUndefined();
```
