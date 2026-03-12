# Test Quality & Coverage Analysis

**Analysis Date:** 2026-03-12

## Overview

- **Test framework:** Vitest
- **Total test files:** 239 (in `src/__tests__/`) + 24 (in `tests/`)
- **Total test cases:** ~3,233 (2,923 in `src/`, 310 in `tests/`)
- **Config:** `vitest.config.ts` (unit), `tests/vitest.e2e.config.ts` (E2E), `tests/integration/vitest.config.ts` (integration)
- **Shared test utilities:** `src/testing/` (3 files, barely used — only 3 imports across all tests)

---

## 1. Untested Modules

Source files with **no corresponding test file** anywhere. Sorted by risk (size and criticality).

### Critical (>200 lines, core logic)

| Module | Lines | Risk |
|--------|-------|------|
| `src/dispatch/escalation.ts` | 493 | Escalation logic for stuck/failed tasks — no tests |
| `src/dispatch/action-executor.ts` | 415 | Executes dispatch actions — no tests |
| `src/dispatch/scheduler-helpers.ts` | 312 | Helper functions for scheduler — no tests |
| `src/dispatch/task-dispatcher.ts` | 290 | Core task dispatch coordination — no tests |
| `src/tools/task-workflow-tools.ts` | 406 | Workflow tool definitions — no tests |
| `src/tools/task-crud-tools.ts` | 287 | CRUD tool definitions — no tests |
| `src/cli/commands/memory.ts` | 605 | Memory CLI command handlers — no tests |
| `src/cli/commands/setup.ts` | 435 | Setup CLI command — no tests |
| `src/cli/commands/project.ts` | 389 | Project CLI command — no tests |
| `src/cli/commands/system-commands.ts` | 372 | System CLI commands — no tests |
| `src/cli/commands/config-commands.ts` | 280 | Config CLI commands — no tests |
| `src/events/notification-policy/rules.ts` | 293 | Notification rule evaluation — no tests |
| `src/events/notification-policy/engine.ts` | 195 | Notification engine orchestration — no tests |
| `src/events/notification-policy/loader.ts` | 113 | Policy file loading — no tests |
| `src/store/task-lifecycle.ts` | 241 | State machine for task transitions — no tests |
| `src/store/task-mutations.ts` | 219 | Task field mutation logic — no tests |
| `src/store/task-deps.ts` | 190 | Dependency resolution — no tests |
| `src/store/task-validation.ts` | 121 | Input validation — no tests |
| `src/store/task-file-ops.ts` | 106 | Filesystem operations for tasks — no tests |
| `src/daemon/standalone-adapter.ts` | 215 | Standalone daemon adapter — no tests |
| `src/packaging/openclaw-cli.ts` | 209 | OpenClaw CLI integration — no tests |

### Medium (100-200 lines)

| Module | Lines | Risk |
|--------|-------|------|
| `src/dispatch/throttle.ts` | 134 | Rate throttling — no tests |
| `src/dispatch/failure-tracker.ts` | 135 | Failure tracking — no tests |
| `src/protocol/router-helpers.ts` | 143 | Router helper functions — no tests |
| `src/protocol/parsers.ts` | 126 | Protocol message parsing — no tests |
| `src/tools/query-tools.ts` | 121 | Query tool definitions — no tests |
| `src/tools/project-tools.ts` | 153 | Project tool definitions — no tests |
| `src/cli/commands/task-dep.ts` | 114 | Task dependency CLI — no tests |
| `src/config/sla-defaults.ts` | 112 | SLA default configuration — no tests |
| `src/events/notification-policy/batcher.ts` | 99 | Event batching — no tests |
| `src/events/notification-policy/watcher.ts` | 88 | File watcher for policies — no tests |
| `src/events/notification-policy/deduper.ts` | 71 | Event deduplication — no tests |
| `src/packaging/migrations/002-gate-to-dag-batch.ts` | 138 | Data migration — no tests |
| `src/packaging/migrations/001-default-workflow-template.ts` | 79 | Data migration — no tests |
| `src/packaging/migrations/003-version-metadata.ts` | 80 | Data migration — no tests |

### Lower Risk (small or leaf files)

| Module | Lines | Notes |
|--------|-------|-------|
| `src/dispatch/murmur-hooks.ts` | 70 | Small integration glue |
| `src/dispatch/lease-manager.ts` | 92 | Lease management wrapper |
| `src/config/paths.ts` | 78 | Path resolution |
| `src/org/loader.ts` | varies | Org chart file loading |
| `src/org/linter-helpers.ts` | varies | Linter utility functions |
| `src/mcp/adapter.ts` | 68 | MCP adapter glue |
| `src/mcp/server.ts` | 18 | Thin server wrapper |
| `src/adapters/console-notifier.ts` | varies | Console output adapter |
| `src/plugin.ts` | varies | Plugin entry point |
| `src/cli/program.ts` | varies | CLI program bootstrap |

**Note:** Some `src/store/` sub-modules (`task-lifecycle.ts`, `task-mutations.ts`, `task-deps.ts`, `task-file-ops.ts`, `task-validation.ts`) are tested indirectly through `src/store/__tests__/task-store*.test.ts` files which test `FilesystemTaskStore`. However, they have **no direct unit tests**, meaning edge cases in these extracted modules are likely untested.

Similarly, `src/memory/tools/*.ts` files have no co-located tests but ARE tested from `src/memory/__tests__/memory-*.test.ts` files that exercise the tool interfaces.

---

## 2. Shallow Tests

### Trivially Shallow (interface/type smoke tests only)

| Test File | Lines | Cases | Issue |
|-----------|-------|-------|-------|
| `src/memory/__tests__/embeddings-provider.test.ts` | 18 | 1 | Tests a mock implementation of the interface, not a real provider. Zero value. |
| `src/__tests__/version.test.ts` | 18 | 1 | Only checks version is a string |

### Shallow Coverage (happy path only, missing error/edge paths)

| Test File | Lines | Cases | Missing |
|-----------|-------|-------|---------|
| `src/memory/__tests__/memory-get.test.ts` | 33 | 2 | No tests for: binary files, large files, permission errors, empty files, concurrent reads |
| `src/openclaw/__tests__/matrix-notifier.test.ts` | 29 | 2 | Only tests send success + send failure. No tests for: message formatting, channel validation, retry behavior |
| `src/memory/__tests__/memory-store.test.ts` | 111 | 2 | Only tests basic store + path resolution. Missing: duplicate content, invalid tags, disk full, concurrent writes, large content chunking edge cases |
| `src/memory/__tests__/memory-list.test.ts` | 89 | 2 | Only tests basic list + empty result. Missing: pagination, sorting, filter combinations, large result sets |
| `src/memory/__tests__/memory-delete.test.ts` | 105 | 2 | Only tests delete + missing file. Missing: concurrent delete, delete during read, index consistency after partial failure |
| `src/plugins/watchdog/__tests__/index.test.ts` | 69 | varies | Watchdog plugin has minimal integration testing |
| `src/plugins/watchdog/__tests__/restart-tracker.test.ts` | 71 | varies | Restart tracker lacks edge cases around time boundaries |
| `src/projects/__tests__/resolver.test.ts` | 78 | varies | Mutates `process.env` directly — fragile, no isolation |

---

## 3. Test Anti-Patterns

### Excessive Mocking (hides real behavior)

**`src/cli/__tests__/init-steps-lifecycle.test.ts`** — 38 `vi.mock()` calls. Mocks `node:fs`, `node:fs/promises`, `yaml`, schemas, packaging, and daemon modules. Every external dependency is mocked, meaning the test only verifies internal branching logic against mock return values. If any mocked interface changes, tests pass but real code breaks.

**`src/cli/commands/__tests__/trace.test.ts`** — 19 `vi.mock()` calls. Similar over-mocking of filesystem, process state, and CLI utilities.

**`src/cli/__tests__/init-sync.test.ts`** — 12 `vi.mock()` calls.

**`src/murmur/__tests__/cleanup.test.ts`** — 12 `vi.mock()` calls for a cleanup module.

**`src/dispatch/__tests__/dag-transition-handler.test.ts`** — 10 `vi.mock()` calls for transition handler.

**Pattern:** CLI and init-step tests mock everything and test nothing real. They verify "if fs.readFile returns X, the function returns Y" — but never verify that the function actually calls fs.readFile with the right path.

### `as any` Casts (type safety bypass)

120 occurrences of `as any` across test files. Concentrated in:
- `src/tools/__tests__/bug-008-lifecycle-consistency.test.ts` (14 casts) — casting event payloads
- `src/trace/__tests__/trace-writer.test.ts` — casting mock store/logger
- `src/dispatch/__tests__/callback-delivery.test.ts` — casting mock store/logger

**Impact:** Type-unsafe mocks can drift from real interfaces without any test failure.

### Duplicated Mock Factories

Multiple test files define their own `createMockTaskStore()`, `createMockLogger()`, `createMockStore()`, and `makeMockStore()` functions with slightly different shapes:

- `src/dispatch/__tests__/callback-delivery.test.ts` — `createMockTaskStore()`, `createMockLogger()`
- `src/trace/__tests__/trace-writer.test.ts` — `createMockStore()`, `createMockLogger()`
- `src/dispatch/__tests__/dep-cascader.test.ts` — `makeMockStore()`

These are **not shared** and each implements a different subset of the interface, some with `as any`.

---

## 4. Integration Gaps

### Store sub-module interactions

The store was refactored into sub-modules (`task-lifecycle.ts`, `task-mutations.ts`, `task-deps.ts`, `task-file-ops.ts`, `task-validation.ts`) but tests only exercise them through `FilesystemTaskStore`. No tests verify:
- Validation rejection messages propagate correctly through mutations
- Lifecycle state machine interacts correctly with dependency resolution
- File operations handle concurrent writes (only lease tests exist)

### Dispatch pipeline end-to-end

The dispatch system has many sub-modules (`scheduler.ts`, `action-executor.ts`, `task-dispatcher.ts`, `escalation.ts`, `failure-tracker.ts`, `throttle.ts`) but:
- `action-executor.ts` (415 lines) — **zero tests**
- `task-dispatcher.ts` (290 lines) — **zero tests**
- `escalation.ts` (493 lines) — **zero tests**
- Integration between scheduler -> executor -> dispatcher is tested in `tests/integration/dispatch-pipeline.test.ts` (5 cases only)

### Notification policy engine

8 sub-modules totaling 934 lines in `src/events/notification-policy/`:
- `engine.ts`, `rules.ts`, `batcher.ts`, `deduper.ts`, `loader.ts`, `watcher.ts`, `audience.ts`, `severity.ts`
- Only `src/events/__tests__/notification-policy.test.ts` (645 lines, 61 cases) tests the composed behavior
- Individual sub-modules have **zero** direct tests
- `tests/integration/notification-engine.test.ts` has only 3 test cases

### MCP server + adapter

`src/mcp/server.ts` (18 lines) and `src/mcp/adapter.ts` (68 lines) have no tests. The MCP tools and resources are tested, but the server startup and adapter wiring are not.

### CLI command handlers

12 CLI command files totaling 2,711 lines have **zero tests**:
- `src/cli/commands/setup.ts` (435 lines)
- `src/cli/commands/memory.ts` (605 lines)
- `src/cli/commands/project.ts` (389 lines)
- `src/cli/commands/system-commands.ts` (372 lines)
- `src/cli/commands/config-commands.ts` (280 lines)
- `src/cli/commands/views.ts` (254 lines)

These are the primary user-facing interfaces.

---

## 5. Flaky Test Candidates

### Filesystem-dependent tests without cleanup

These tests create temp directories but have **no `afterEach` cleanup**:
- `src/context/__tests__/steward-integration.test.ts`
- `src/context/__tests__/steward.test.ts`
- `src/trace/__tests__/trace-writer.test.ts`
- `src/trace/__tests__/session-parser.test.ts`
- `src/memory/__tests__/store-schema.test.ts`
- `src/memory/__tests__/memory-get.test.ts`
- `src/dispatch/__tests__/dag-transition-handler.test.ts`
- `src/cli/__tests__/init-steps.test.ts`

**Risk:** Leaked temp dirs accumulate over time. On CI with disk pressure, old test artifacts can cause failures.

### Timing-dependent tests

- `src/packaging/__tests__/wizard.test.ts` — Uses `Date.now()` for elapsed time assertions
- `src/packaging/__tests__/channels.test.ts` — Uses `Date.now()` for elapsed time + channel freshness checks
- `src/memory/__tests__/hnsw-index.test.ts` — Uses `performance.now()` for latency assertions
- `src/memory/__tests__/curation-generator.test.ts` — Constructs dates relative to `Date.now()` without fake timers

Only 2 test files use `vi.useFakeTimers()`:
- `src/cli/__tests__/init-steps-lifecycle.test.ts`
- `src/events/__tests__/notification-policy.test.ts`

### Process environment mutation

- `src/projects/__tests__/resolver.test.ts` — Mutates `process.env.AOF_ROOT` in tests with manual restore in `afterEach`. If a test fails before restore, subsequent tests see wrong env.
- `src/mcp/__tests__/shared.test.ts` — Mutates `process.env.AOF_CALLBACK_DEPTH` without fake timers or isolation.
- `src/cli/commands/__tests__/trace.test.ts` — Mutates `process.exitCode`.

### Skipped test suite

- `src/cli/commands/__tests__/daemon-integration.test.ts` — Entire suite is `describe.skip()` with a TODO comment about timeout issues with forked daemon processes. This has been skipped indefinitely.

---

## 6. Test Duplication

### Repeated setup: FilesystemTaskStore + EventLogger + tmpDir

This exact pattern appears in **~60+ test files**:

```typescript
let tmpDir: string;
let store: ITaskStore;
let logger: EventLogger;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "aof-test-"));
  store = new FilesystemTaskStore(tmpDir);
  await store.init();
  const eventsDir = join(tmpDir, "events");
  await mkdir(eventsDir, { recursive: true });
  logger = new EventLogger(eventsDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});
```

Files include: all `src/store/__tests__/*.test.ts`, all `src/dispatch/__tests__/*.test.ts` that use real stores, all `src/tools/__tests__/*.test.ts`, and more.

**217 total occurrences** of `new FilesystemTaskStore` or `new EventLogger` in test files.

### Repeated setup: memory DB + VectorStore + FtsStore

This pattern repeats across all `src/memory/__tests__/memory-*.test.ts` files:

```typescript
let db: ReturnType<typeof initMemoryDb>;
let vectorStore: VectorStore;
let ftsStore: FtsStore;
let embeddingProvider: EmbeddingProvider;

beforeEach(() => {
  db = initMemoryDb(":memory:", EMBEDDING_DIMENSIONS);
  vectorStore = new VectorStore(db);
  ftsStore = new FtsStore(db);
  embeddingProvider = { dimensions: 4, embed: async (texts) => texts.map(() => [0, 1, 0, 0]) };
});

afterEach(() => { db.close(); });
```

Appears in: `memory-store.test.ts`, `memory-list.test.ts`, `memory-delete.test.ts`, `memory-search.test.ts`, `memory-update.test.ts`, `memory-get.test.ts`.

### Repeated mock factory: createMockTaskStore

At least 3 different implementations exist in different test files, each with different mock method sets and return types.

---

## 7. Missing Test Utilities

### Needed: `createTestHarness()` or `withTestProject()`

A shared factory that creates tmpDir + FilesystemTaskStore + EventLogger + cleanup would eliminate ~60 instances of duplicated boilerplate. Suggested location: `src/testing/harness.ts`.

```typescript
// Proposed API
const { store, logger, tmpDir, cleanup } = await createTestHarness();
// or
await withTestProject(async ({ store, logger }) => { ... });
```

### Needed: `createMemoryTestEnv()`

A shared factory for memory DB + stores + embedding provider would eliminate duplication across 6+ memory test files. Suggested location: `src/testing/memory-harness.ts`.

### Needed: Typed mock factories

Shared `createMockStore()`, `createMockLogger()` factories that implement the full interface (not `as any` casts) would:
- Reduce 120 `as any` casts
- Catch interface drift at compile time
- Suggested location: `src/testing/mocks.ts`

### Needed: `withFakeTimers()` helper

Only 2 files use fake timers despite many tests depending on time. A helper would encourage proper time isolation.

### Existing utilities are underused

`src/testing/` exports `readEventLogEntries`, `findEvents`, `expectEvent`, `getMetricValue`, `readTasksInDir` but only 3 test files import from them. Many tests implement their own event reading logic (e.g., `readLastEvent()` in `src/tools/__tests__/aof-tools.test.ts`).

---

## 8. Coverage Configuration Notes

The `vitest.config.ts` coverage configuration only tracks 6 specific files:
- `src/dispatch/scheduler.ts`
- `src/store/task-store.ts`
- `src/service/aof-service.ts`
- `src/gateway/handlers.ts`
- `src/metrics/exporter.ts`
- `src/events/logger.ts`

This means **coverage reports do not reflect actual codebase coverage**. The 200+ other source files are excluded from coverage tracking.

---

## 9. E2E Test Infrastructure

**17 E2E test suites** in `tests/e2e/suites/` covering:
- Plugin registration, taskstore ops, event logging, tool execution
- Dispatch flow, view updates, context engineering, metrics
- Gateway handlers, concurrent dispatch, drift detection
- Workflow gates, block/unblock, task management, lifecycle

**Configuration:** Sequential execution (`singleFork: true`), 60s timeout (120s in CI), bail on first failure.

**Test data utility:** `tests/e2e/utils/test-data.ts` provides `seedTestData()` and `cleanupTestData()`.

**Integration tests:** 6 suites in `tests/integration/` with 31 total test cases. Run sequentially with 60s timeout.

**OpenClaw integration:** Docker-based test environment in `tests/integration/openclaw/` for gateway testing.

---

## 10. Priority Recommendations

### High Priority (untested critical paths)

1. **`src/dispatch/action-executor.ts`** (415 lines) — Executes all dispatch actions. Zero tests.
2. **`src/dispatch/escalation.ts`** (493 lines) — Escalation for stuck tasks. Zero tests.
3. **`src/dispatch/task-dispatcher.ts`** (290 lines) — Dispatch coordination. Zero tests.
4. **`src/store/task-lifecycle.ts`** (241 lines) — State machine. Tested only indirectly.
5. **`src/events/notification-policy/rules.ts`** (293 lines) + `engine.ts` (195 lines) — Notification logic. Zero direct tests.

### Medium Priority (test infrastructure)

6. **Create `src/testing/harness.ts`** — Eliminate 60+ duplicated setup/teardown blocks.
7. **Create `src/testing/mocks.ts`** — Type-safe mock factories to replace `as any` casts.
8. **Fix missing cleanup** in 8 test files listed in section 5.
9. **Expand coverage config** in `vitest.config.ts` beyond the current 6 files.

### Lower Priority (completeness)

10. **CLI command tests** — 2,711 lines of untested CLI handlers.
11. **Packaging migration tests** — 326 lines of data migrations without direct tests.
12. **Unskip or rewrite** `daemon-integration.test.ts`.

---

*Test quality analysis: 2026-03-12*
