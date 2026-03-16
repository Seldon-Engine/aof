# Phase 40: Test Infrastructure - Research

**Researched:** 2026-03-13
**Domain:** Vitest test infrastructure, mock factories, coverage configuration
**Confidence:** HIGH

## Summary

Phase 40 standardizes AOF's test infrastructure across ~170+ test files. The codebase currently has widespread duplication of setup/teardown patterns (`mkdtemp` + `FilesystemTaskStore` + `EventLogger` appears in 60+ files), partial mock objects cast with `as any` (15+ files for store, 10+ for logger), coverage tracking only 6 source files out of 254, and 15 test files with missing temp directory cleanup.

The work is straightforward refactoring -- creating shared utilities in `src/testing/`, expanding the existing barrel export, and updating `vitest.config.ts`. No new libraries are needed. Vitest 3.2.4 (already installed) provides all necessary features including `vi.fn()` for mocks and v8 coverage provider.

**Primary recommendation:** Build `createTestHarness()` and typed mock factories in `src/testing/`, then systematically migrate test files to use them, expanding coverage config to `src/**/*.ts` with targeted exclusions.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Full project setup: `createTestHarness()` returns `{ store, logger, tmpDir, cleanup, readEvents, getMetric, readTasks }` -- everything needed for a typical AOF test
- `withTestProject(async ({ store, logger, ... }) => { ... })` wraps harness with auto-cleanup via `afterEach` for simple tests
- `createTestHarness()` available for complex tests needing manual control over cleanup timing
- Fold existing `src/testing/` utilities (event-log-reader, metrics-reader, task-reader) into the harness return value -- one-stop shop
- All utilities re-exported from `src/testing/index.ts`
- `createMockStore()` returns a full `ITaskStore` implementation with all methods as `vi.fn()` stubs -- zero `as any` casts needed
- `createMockLogger()` returns a full `EventLogger` implementation with stubs
- Tests override specific methods as needed: `store.get.mockResolvedValue(task)`
- Expand coverage from 6 files to all `src/` modules (excluding tests, schemas, testing utilities)
- Soft thresholds: warn on coverage regression but don't fail CI
- Coverage report generated in CI only (not on every local test run) -- avoids ~30% slowdown
- Keep `npm test` fast; add `npm run test:coverage` for CI
- Migrate ALL test files with duplicated setup/teardown (not just the minimum 10)
- Fix the 8 test files with missing temp dir cleanup as part of harness adoption (harness handles cleanup automatically)
- Promote existing `src/testing/` utilities by integrating into harness return value

### Claude's Discretion
- Whether `createMockStore()` supports pre-seeded data (e.g., `{ tasks: [task1] }`) -- decide based on how common the pattern is
- Whether `createMockLogger()` captures calls for assertion -- decide based on how tests currently assert on logging
- Whether harness supports optional project fixtures (`project.yaml`, `org-chart.yaml`) -- decide based on how many tests need them

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| TEST-01 | Shared test harness created (createTestHarness/withTestProject) -- eliminates ~60 duplicated setup/teardown blocks | Harness API pattern documented below; 60+ files identified with mkdtemp+store+logger setup duplication |
| TEST-02 | Typed mock factories created (createMockStore, createMockLogger) -- replaces as-any cast pattern across test files | ITaskStore interface has 20 methods to stub; EventLogger class has 11 public methods; existing ad-hoc mocks documented |
| TEST-03 | Coverage config expanded beyond current 6 files to track all source modules | Current config hardcodes 6 files; 254 source modules exist; coverage config pattern documented |
| TEST-04 | 8 test files with missing temp dir cleanup fixed | 15 files identified with mkdtemp but no rm() cleanup (more than estimated 8) |
| TEST-05 | Existing src/testing/ utilities promoted -- adoption across test files that currently duplicate their functionality | event-log-reader, metrics-reader, task-reader already exist; integration into harness return value eliminates need to import separately |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | 3.2.4 | Test framework | Already installed and configured; provides vi.fn(), describe/it, beforeEach/afterEach |
| @vitest/coverage-v8 | (bundled) | Coverage provider | Already configured in vitest.config.ts as `provider: "v8"` |

### Supporting
No additional libraries needed. All work uses existing Vitest APIs and Node.js built-ins.

## Architecture Patterns

### Recommended File Structure
```
src/testing/
  index.ts              # Barrel: re-exports everything
  event-log-reader.ts   # EXISTING: readEventLogEntries, findEvents, expectEvent
  metrics-reader.ts     # EXISTING: getMetricValue
  task-reader.ts        # EXISTING: readTasksInDir
  harness.ts            # NEW: createTestHarness, withTestProject
  mock-store.ts         # NEW: createMockStore (typed ITaskStore mock)
  mock-logger.ts        # NEW: createMockLogger (typed EventLogger mock)
```

### Pattern 1: Test Harness with Auto-Cleanup
**What:** `createTestHarness()` creates tmpDir, FilesystemTaskStore, EventLogger, and binds the existing testing utilities to the tmpDir. Returns all of them plus a `cleanup()` function.
**When to use:** Any test that needs a real filesystem store and event logger.

```typescript
// src/testing/harness.ts
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../store/task-store.js";
import { EventLogger } from "../events/logger.js";
import type { ITaskStore } from "../store/interfaces.js";
import { readEventLogEntries, findEvents, expectEvent } from "./event-log-reader.js";
import { getMetricValue } from "./metrics-reader.js";
import { readTasksInDir } from "./task-reader.js";

export interface TestHarness {
  tmpDir: string;
  store: ITaskStore;
  logger: EventLogger;
  eventsDir: string;
  cleanup: () => Promise<void>;
  // Bound utility functions
  readEvents: () => Promise<BaseEvent[]>;
  readTasks: () => Promise<Array<ReturnType<typeof parseTaskFile>>>;
}

export async function createTestHarness(prefix = "aof-test-"): Promise<TestHarness> {
  const tmpDir = await mkdtemp(join(tmpdir(), prefix));
  const store = new FilesystemTaskStore(tmpDir);
  await store.init();
  const eventsDir = join(tmpDir, "events");
  await mkdir(eventsDir, { recursive: true });
  const logger = new EventLogger(eventsDir);

  return {
    tmpDir,
    store,
    logger,
    eventsDir,
    cleanup: () => rm(tmpDir, { recursive: true, force: true }),
    readEvents: () => readEventLogEntries(eventsDir),
    readTasks: () => readTasksInDir(join(tmpDir, ".aof", "tasks")),
  };
}
```

### Pattern 2: withTestProject Wrapper
**What:** Calls `createTestHarness()`, passes it to the callback, then auto-cleans up.
**When to use:** Simple tests that don't need manual cleanup timing.

```typescript
export async function withTestProject(
  fn: (harness: TestHarness) => Promise<void>,
  prefix?: string,
): Promise<void> {
  const harness = await createTestHarness(prefix);
  try {
    await fn(harness);
  } finally {
    await harness.cleanup();
  }
}
```

### Pattern 3: Typed Mock Store Factory
**What:** Returns a complete `ITaskStore` implementation with all 20 methods as `vi.fn()` stubs.
**When to use:** Unit tests that need a mock store without filesystem.

```typescript
// src/testing/mock-store.ts
import { vi } from "vitest";
import type { ITaskStore } from "../store/interfaces.js";

export type MockTaskStore = {
  [K in keyof ITaskStore]: ITaskStore[K] extends (...args: any[]) => any
    ? ReturnType<typeof vi.fn> & ITaskStore[K]
    : ITaskStore[K];
};

export function createMockStore(overrides?: Partial<ITaskStore>): MockTaskStore {
  return {
    projectRoot: "/mock/project",
    projectId: "mock",
    tasksDir: "/mock/project/.aof/tasks",
    init: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(undefined),
    getByPrefix: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    countByStatus: vi.fn().mockResolvedValue({}),
    transition: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    updateBody: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(false),
    lint: vi.fn().mockResolvedValue([]),
    getTaskInputs: vi.fn().mockResolvedValue([]),
    getTaskOutputs: vi.fn().mockResolvedValue([]),
    writeTaskOutput: vi.fn().mockResolvedValue(undefined),
    addDep: vi.fn().mockResolvedValue(undefined),
    removeDep: vi.fn().mockResolvedValue(undefined),
    block: vi.fn().mockResolvedValue(undefined),
    unblock: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    saveToPath: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as MockTaskStore;
}
```

### Pattern 4: Typed Mock Logger Factory
**What:** Returns a complete `EventLogger` mock with all public methods as `vi.fn()` stubs.
**When to use:** Unit tests that need a mock logger.

```typescript
// src/testing/mock-logger.ts
import { vi } from "vitest";
import type { EventLogger } from "../events/logger.js";

export type MockEventLogger = {
  [K in keyof EventLogger]: EventLogger[K] extends (...args: any[]) => any
    ? ReturnType<typeof vi.fn> & EventLogger[K]
    : EventLogger[K];
};

export function createMockLogger(): MockEventLogger {
  const defaultEvent = {
    eventId: 1,
    type: "test",
    timestamp: new Date().toISOString(),
    actor: "test",
    payload: {},
  };
  return {
    log: vi.fn().mockResolvedValue(defaultEvent),
    logTransition: vi.fn().mockResolvedValue(undefined),
    logLease: vi.fn().mockResolvedValue(undefined),
    logDispatch: vi.fn().mockResolvedValue(undefined),
    logAction: vi.fn().mockResolvedValue(undefined),
    logSystem: vi.fn().mockResolvedValue(undefined),
    logSchedulerPoll: vi.fn().mockResolvedValue(undefined),
    logContextBudget: vi.fn().mockResolvedValue(undefined),
    logContextFootprint: vi.fn().mockResolvedValue(undefined),
    logContextAlert: vi.fn().mockResolvedValue(undefined),
    logValidationFailed: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    lastEventAt: 0,
  } as unknown as MockEventLogger;
}
```

### Pattern 5: Coverage Config Expansion
**What:** Replace hardcoded 6-file `include` list with glob pattern covering all src/ modules.
**When to use:** vitest.config.ts coverage section.

```typescript
// vitest.config.ts coverage section
coverage: {
  provider: "v8",
  reporter: ["text", "json", "html"],
  include: [
    "src/**/*.ts",
  ],
  exclude: [
    "src/**/__tests__/**",
    "src/testing/**",
    "src/schemas/**",
    "src/**/index.ts",     // Barrel re-exports only
    "src/types/**",        // Type-only files
  ],
},
```

### Anti-Patterns to Avoid
- **Partial mock with `as any`:** Creates type-unsafe mocks that miss interface changes. Use `createMockStore()` factory instead.
- **Duplicating setup in every test file:** 60+ files repeat the same mkdtemp+store+logger+cleanup pattern. Use `createTestHarness()`.
- **Forgetting cleanup:** 15 test files leak temp directories. Use `withTestProject()` or harness `cleanup()` in `afterEach`.
- **Importing testing utils individually:** Tests importing `readEventLogEntries` directly should use harness `readEvents()` bound method.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Mock store | Partial objects with `as any` | `createMockStore()` | Must track ITaskStore interface changes; 20 methods to stub |
| Mock logger | Partial objects with `as any` | `createMockLogger()` | Must track EventLogger methods; 11 methods to stub |
| Test setup | Manual mkdtemp+store+logger+cleanup | `createTestHarness()` | 6 lines of boilerplate repeated 60+ times |
| Temp dir cleanup | Manual afterEach + rm | `withTestProject()` or harness cleanup | Easy to forget (15 files already do) |

## Common Pitfalls

### Pitfall 1: Mock Store Falling Out of Sync with ITaskStore
**What goes wrong:** New methods added to `ITaskStore` won't be present in mock, causing runtime errors in tests.
**Why it happens:** Mock factory is manually maintained.
**How to avoid:** Use `satisfies ITaskStore` on the return type so TypeScript catches missing methods at compile time.
**Warning signs:** Tests failing with "xxx is not a function" errors.

### Pitfall 2: EventLogger is a Class, Not an Interface
**What goes wrong:** `EventLogger` is a concrete class with private fields (`eventsDir`, `eventCounter`, `_lastEventAt`). Trying to type-assert a plain object to `EventLogger` type requires `as unknown as EventLogger`.
**Why it happens:** No `IEventLogger` interface exists; tests mock the class directly.
**How to avoid:** Use `as unknown as EventLogger` pattern in the factory, or consider defining a minimal interface. The `as unknown as` is acceptable in the factory since it's centralized and tested.
**Warning signs:** TypeScript errors about missing private properties.

### Pitfall 3: Coverage Threshold Too Strict Too Early
**What goes wrong:** Setting hard coverage thresholds when expanding from 6 to 254 files will fail CI since most modules have no dedicated tests.
**Why it happens:** Expanding coverage tracking reveals the true (low) coverage state.
**How to avoid:** Use soft thresholds (warn, don't fail). The CONTEXT.md locks this decision.
**Warning signs:** CI failing on coverage after config change.

### Pitfall 4: Breaking Existing Tests During Migration
**What goes wrong:** Migrating test files to use harness changes behavior (e.g., different tmpDir prefix, store initialization order).
**Why it happens:** Subtle differences between manual setup and harness setup.
**How to avoid:** Run tests after each file migration, not in bulk. Ensure harness setup matches the exact pattern: `mkdtemp` -> `FilesystemTaskStore(tmpDir)` -> `store.init()` -> `mkdir(eventsDir)` -> `EventLogger(eventsDir)`.
**Warning signs:** Tests passing before migration but failing after.

### Pitfall 5: The tasks Directory Path
**What goes wrong:** `FilesystemTaskStore(tmpDir)` puts tasks in `tmpDir/.aof/tasks/`, not `tmpDir/tasks/`. The `readTasks` bound method must point to the correct path.
**Why it happens:** Store's internal directory structure includes `.aof/` prefix.
**How to avoid:** Check `store.tasksDir` to determine the correct tasks path for `readTasksInDir`.

## Code Examples

### Migrating a Test File to Harness (Before/After)

**Before:**
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

**After:**
```typescript
import { createTestHarness, type TestHarness } from "../../testing/index.js";

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

// Then use harness.store, harness.logger, harness.readEvents(), etc.
```

### Migrating Mock Store (Before/After)

**Before:**
```typescript
const mockStore = {
  get: vi.fn().mockResolvedValue(task),
  list: vi.fn().mockResolvedValue([task]),
  projectRoot: "/tmp/mock",
  projectId: "test",
  tasksDir: "/tmp/mock/tasks",
} as any;
```

**After:**
```typescript
import { createMockStore } from "../../testing/index.js";

const mockStore = createMockStore();
mockStore.get.mockResolvedValue(task);
mockStore.list.mockResolvedValue([task]);
```

### Adding test:coverage Script

```json
{
  "scripts": {
    "test:coverage": "vitest run --coverage"
  }
}
```

## Discretion Recommendations

### Pre-seeded `createMockStore()` data: YES, support it
**Rationale:** Many test files do `store.get.mockResolvedValue(task)` and `store.list.mockResolvedValue([task])` immediately after creating the mock. An optional `{ tasks: Task[] }` parameter would reduce this boilerplate. The factory would set `get` to find by ID and `list` to return all.

### `createMockLogger()` call capture: YES, include it
**Rationale:** Tests like `bug-003-plugin-stability.test.ts` assert on logger calls (`logAction`, `logDispatch`). Since all methods are `vi.fn()`, they already capture calls. No extra work needed -- the factory's default `vi.fn()` stubs inherently support assertion via `expect(logger.logDispatch).toHaveBeenCalledWith(...)`.

### Harness project fixtures: NO, skip for now
**Rationale:** Only a handful of tests need `project.yaml` or `org-chart.yaml`. These can create fixtures manually. Adding optional fixture support would complicate the harness API for a rarely-used feature.

## Files with Missing Temp Dir Cleanup (TEST-04)

Research found 15 files (more than the estimated 8) with `mkdtemp` but no `rm()` call:

1. `src/memory/__tests__/memory-update.test.ts`
2. `src/memory/__tests__/memory-search.test.ts`
3. `src/memory/__tests__/memory-delete.test.ts`
4. `src/memory/__tests__/memory-list.test.ts`
5. `src/memory/__tests__/store-schema.test.ts`
6. `src/memory/__tests__/hash.test.ts`
7. `src/memory/__tests__/memory-store.test.ts`
8. `src/memory/__tests__/hnsw-resilience.test.ts`
9. `src/memory/__tests__/hnsw-index.test.ts`
10. `src/memory/__tests__/memory-get.test.ts`
11. `src/memory/__tests__/pipeline-integration.test.ts`
12. `src/cli/__tests__/memory-health.test.ts`
13. `src/drift/__tests__/adapters.test.ts`
14. `src/commands/__tests__/org-drift-cli.test.ts`
15. `src/commands/__tests__/memory-cli.test.ts`

All need `afterEach` or `afterAll` with `rm(tmpDir, { recursive: true, force: true })`. Some of these may be candidates for harness migration; others (like memory tests) may have different setup patterns.

## Files Using `as any` for Store/Logger Mocks (TEST-02)

Key files identified with store/logger `as any` casts (main repo, excluding worktrees):

- `src/cli/commands/__tests__/trace.test.ts` (8 `store: mockStore as any` casts)
- `src/trace/__tests__/trace-writer.test.ts` (already has local `createMockStore`/`createMockLogger` but casts `as any`)
- `src/protocol/__tests__/dag-router-integration.test.ts` (`logger: logger as any`)
- `src/dispatch/__tests__/callback-delivery.test.ts` (local `createMockTaskStore` returning `as any`)
- `src/murmur/__tests__/cleanup.test.ts` (20+ `as any` casts for state manager/config)
- `src/murmur/__tests__/murmur-concurrency.test.ts` (local factories using `as unknown as`)
- `src/dispatch/__tests__/recovery-handlers.test.ts` (inline logger mock)
- `src/dispatch/__tests__/lifecycle-handlers.test.ts` (inline logger mock)
- `src/dispatch/__tests__/alert-handlers.test.ts` (inline logger mock)
- `src/dispatch/__tests__/dag-scheduler-integration.test.ts` (inline logger mock)
- `src/dispatch/__tests__/dag-timeout.test.ts` (inline logger mock)
- `src/dispatch/__tests__/dag-transition-handler.test.ts` (inline logger mock)

## Coverage Expansion Details (TEST-03)

**Current state:** 6 files explicitly listed in vitest.config.ts `coverage.include`:
- `src/dispatch/scheduler.ts`
- `src/store/task-store.ts`
- `src/service/aof-service.ts`
- `src/gateway/handlers.ts`
- `src/metrics/exporter.ts`
- `src/events/logger.ts`

**Target state:** 254 source files across 30+ directories tracked, excluding:
- `src/**/__tests__/**` (test files)
- `src/testing/**` (test utilities themselves)
- `src/schemas/**` (Zod schemas -- tested via integration)
- Barrel `index.ts` files (re-exports only, no logic)
- `src/types/**` (type-only files, no runtime code)

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 3.2.4 |
| Config file | `vitest.config.ts` |
| Quick run command | `npx vitest run --reporter=verbose` |
| Full suite command | `npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TEST-01 | Harness creates store/logger/tmpDir, cleanup works | unit | `npx vitest run src/testing/__tests__/harness.test.ts -x` | Wave 0 |
| TEST-02 | Mock factories return typed complete objects | unit | `npx vitest run src/testing/__tests__/mock-store.test.ts -x` | Wave 0 |
| TEST-03 | Coverage config tracks all src/ modules | smoke | `npx vitest run --coverage 2>&1 \| head -50` | N/A (config change) |
| TEST-04 | Temp dir cleanup present in all files | manual-only | Grep for mkdtemp files without rm() | N/A (code review) |
| TEST-05 | Testing utilities re-exported from barrel | unit | `npx vitest run src/testing/__tests__/harness.test.ts -x` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green + `npx vitest run --coverage` produces report covering full source tree

### Wave 0 Gaps
- [ ] `src/testing/__tests__/harness.test.ts` -- covers TEST-01, TEST-05 (createTestHarness, withTestProject, bound utilities)
- [ ] `src/testing/__tests__/mock-store.test.ts` -- covers TEST-02 (createMockStore returns full ITaskStore)
- [ ] `src/testing/__tests__/mock-logger.test.ts` -- covers TEST-02 (createMockLogger returns full EventLogger mock)

## Sources

### Primary (HIGH confidence)
- **Codebase analysis**: Direct inspection of vitest.config.ts, src/testing/, src/store/interfaces.ts, src/events/logger.ts, and 20+ test files
- **ITaskStore interface**: `src/store/interfaces.ts` -- 20 methods, 3 readonly properties
- **EventLogger class**: `src/events/logger.ts` -- 11 public methods, 1 getter
- **Vitest 3.2.4**: Installed version confirmed via package.json

### Secondary (MEDIUM confidence)
- **File counts**: `find` + `grep` across src/ (254 source files, 170+ test files, 60+ with mkdtemp, 15 with missing cleanup)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- Vitest already installed, no new dependencies needed
- Architecture: HIGH -- Patterns derived directly from existing codebase patterns
- Pitfalls: HIGH -- Based on direct observation of current code patterns and known TypeScript mock typing issues

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (stable infrastructure, no external dependency changes expected)
