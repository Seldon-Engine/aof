# Domain Pitfalls

**Domain:** Large-scale TypeScript codebase cleanup, config centralization, and logging refactoring
**Researched:** 2026-03-12

## Critical Pitfalls

Mistakes that cause rewrites, regressions, or multi-day debugging sessions.

### Pitfall 1: Removing Dead Code That Has Live Side-Effect Imports

**What goes wrong:** Deleting deprecated gate files (`gate-evaluator.ts`, `gate-conditional.ts`, `gate-context-builder.ts`, `gate.ts`, `workflow.ts`) causes import resolution failures in files that still reference them. AOF has active imports of gate symbols in `scheduler.ts` (lines 22, 25, 27), `assign-executor.ts` (lines 150-169), `escalation.ts` (`checkGateTimeouts`), and barrel re-exports in `schemas/index.ts` and `dispatch/index.ts`.

**Why it happens:** Deprecated code gets left in place through multiple milestones (v1.3 through v1.9 in AOF's case). Other modules accumulate imports to it. A naive "delete the deprecated files" approach misses the web of references.

**Consequences:** TypeScript compilation fails. If you fix the obvious imports but miss one barrel re-export, downstream consumers that import from the barrel get `undefined` at runtime without a compile error (barrel exports silently skip missing re-exports in some bundler configurations).

**Prevention:**
1. Before deleting any file, run `tsc --noEmit` to establish a green baseline.
2. Use the TypeScript compiler as your safety net: delete files, run `tsc --noEmit`, fix every error.
3. Search for string references too: grep for `gate-evaluator`, `gate-conditional`, `checkGateTimeouts`, `GateOutcome`, `GateTransition` across the entire codebase including test files, comments, and JSDoc.
4. Remove barrel re-exports (`schemas/index.ts` lines 94-101, `dispatch/index.ts` lines 11-18) at the same time as source files.
5. Delete test files for gate system (~2000+ lines across 7 test files) in the same commit as source deletion.

**Detection:** `tsc --noEmit` fails. Vitest fails with "cannot find module" errors. Runtime `TypeError: X is not a function`.

**AOF-specific:** The lazy gate-to-DAG migration in `task-store.ts` (lines 251-258, 292-298, 343-352) runs on every `get()`/`list()` call. Removing this path changes behavior for any hypothetical gate-format tasks. Since AOF is post-v1.3, no gate-format tasks should exist, but verify with a search of the tasks directory before removing.

**Phase:** Dead Code Removal (Phase 1 -- do this first, it reduces codebase size by ~2900 lines and simplifies all subsequent work).

---

### Pitfall 2: Extracting God Functions and Breaking Implicit State Dependencies

**What goes wrong:** The 544-line `assign-executor.ts` and 415-line `action-executor.ts` are refactored into smaller helper functions, but the extraction changes the order of operations, alters closure variable capture, or breaks implicit dependencies between code blocks that share mutable state.

**Why it happens:** God functions accumulate implicit contracts: variable A must be set before block B executes; a try/catch at line 200 protects side effects from line 150. When you extract line 150-180 into a helper, the try/catch at 200 no longer protects it. Additionally, `assign-executor.ts` has 15 swallowed catch blocks -- extracting code into helpers can change which errors are caught vs. propagated.

**Consequences:** Subtle behavior changes that pass TypeScript compilation and most happy-path tests but fail under error conditions. The 229 swallowed catch blocks across 72 files mean error handling is invisible -- you cannot reason about what happens when extracted helpers throw.

**Prevention:**
1. Write characterization tests BEFORE refactoring: capture current behavior including error paths for the god functions.
2. Extract one helper at a time. Run full test suite after each extraction.
3. Preserve the exact same try/catch boundaries when extracting. If a block was inside a `} catch {`, the extracted function must still be called inside that same catch scope.
4. For `assign-executor.ts`, the 15 empty catch blocks are a hazard map: document what each one swallows before extracting.
5. Use the "extract function" refactoring with pure inputs/outputs first (data transformations), leave side-effecting code in the main function until the pure extractions are stable.
6. `action-executor.ts` has zero tests. Write tests before touching it.

**Detection:** E2E dispatch tests fail. Integration tests in `tests/integration/dispatch-pipeline.test.ts` (only 5 cases) are insufficient -- expand these before refactoring.

**AOF-specific:** Module-level mutable state in `scheduler.ts` (`effectiveConcurrencyLimit`), `throttle.ts` (`throttleState`), and `lease-manager.ts` (`leaseRenewalTimers`) complicates extraction. If a helper function reads from module-level state that was expected to be set by a prior code block in the same function, extraction creates a temporal coupling bug.

**Phase:** Code Refactoring (Phase 3 -- after dead code removal and bug fixes are stable).

---

### Pitfall 3: Big-Bang Logging Migration Breaks Error Output and Test Assertions

**What goes wrong:** Replacing 751 `console.*` calls with a structured logger in a single pass breaks tests that assert on `console.error`/`console.warn` output, changes CLI user-facing output, and silences errors in the 229 swallowed catch blocks that happen to include the one `console.debug` you were supposed to add.

**Why it happens:** `console.log` in a Node.js CLI project serves three different purposes: (1) user-facing CLI output (must remain on stdout), (2) debug/diagnostic logging (should go to structured logger), (3) error reporting (should go to structured logger at error level). Replacing all three with the same logger call conflates these concerns.

**Consequences:** CLI commands produce JSON log lines instead of human-readable output. Tests that spy on `console.error` break. The daemon's JSONL event logging (`EventLogger`) conflicts with a new structured logger writing to the same output. Debug information that was previously silent (swallowed catches) becomes noisy.

**Prevention:**
1. Categorize every `console.*` call before replacing: CLI output (keep as `console.log` or use a dedicated CLI output function), diagnostic logging (replace with logger), error reporting (replace with logger.error).
2. Create the logger abstraction first with a `createLogger(module: string)` factory. Make it a thin wrapper initially -- just prefix with timestamp and module name.
3. Migrate module-by-module, not all 751 calls at once. Start with daemon/scheduler (non-CLI, pure background processing). CLI commands come last.
4. Add log levels: `error`, `warn`, `info`, `debug`. Default to `info`. The 229 swallowed catch blocks should get `debug`-level logging (visible only with `AOF_DEBUG`).
5. Never replace `console.log` in CLI command handlers with the structured logger -- CLI output is a separate concern.
6. Run the full test suite after each module migration.

**Detection:** CLI output becomes garbled JSON. Tests using `vi.spyOn(console, 'error')` fail. Users see no output from `aof` commands. Daemon logs become unreadable.

**AOF-specific:** AOF already has a JSONL `EventLogger` for operational events. The new structured logger must not conflict with it. The logger is for developer/operator diagnostics; EventLogger is for the event stream that tools consume. Keep them separate.

**Phase:** Structured Logging (Phase 4 -- after config centralization provides the log level setting).

---

### Pitfall 4: Config Centralization Introduces a Boot-Order Dependency

**What goes wrong:** A centralized config registry that validates all env vars at startup fails during test runs, CLI help commands, or module imports that don't need the full config. Tests that set `process.env` after module import find that the config registry already cached the old value.

**Why it happens:** The natural pattern is `const config = loadConfig()` at module scope, which runs at import time. If any required env var is missing, the module throws on import. Tests that need to set env vars must do so before any import, which is impossible with vitest's static import analysis.

**Consequences:** `aof --help` crashes because `AOF_ROOT` isn't set. Test files fail to import because the config registry demands env vars that the test doesn't need. Config values are stale because they were cached at import time but the test changed `process.env` afterward.

**Prevention:**
1. Use lazy initialization: `getConfig()` function that initializes on first call, not at module scope. Cache after first call.
2. Provide a `resetConfig()` function for tests (like the existing `resetThrottleState()` pattern).
3. Validate at startup boundaries (daemon start, CLI command execution), not at module import time.
4. Allow config to be created with overrides for testing: `createConfig({ AOF_ROOT: tmpDir })`.
5. Migrate incrementally: replace `process.env.X` one module at a time, keeping old access working until the module is fully migrated.
6. AOF already has 3 patterns for env access (`process.env` direct, `src/config/paths.ts`, `src/projects/__tests__/resolver.test.ts` mutations). Consolidate to one.

**Detection:** Tests fail with "missing required config" errors. `aof --help` crashes. Config values don't update between test cases.

**AOF-specific:** `src/projects/__tests__/resolver.test.ts` directly mutates `process.env.AOF_ROOT` and manually restores in `afterEach`. The config registry must handle this pattern or these tests break. The `src/config/paths.ts` module already exists as a partial config centralization -- extend it rather than creating a parallel system.

**Phase:** Config Centralization (Phase 3 -- after dead code removal and bug fixes, before logging).

---

## Moderate Pitfalls

### Pitfall 5: Breaking Circular Dependencies Changes Module Load Order

**What goes wrong:** Breaking circular dependencies between dispatch modules (scheduler <-> assign-executor <-> action-executor) changes the order in which module-level code executes. Module-level mutable state (`effectiveConcurrencyLimit`, `throttleState`, `leaseRenewalTimers`) may be read before initialization.

**Prevention:**
1. Use `madge` to map the circular dependency graph before making changes.
2. Break cycles by extracting shared types/interfaces into a separate file that both modules import from (dependency inversion).
3. Replace barrel file imports (`import { X } from '../dispatch'`) with direct file imports (`import { X } from '../dispatch/specific-file'`).
4. Test module load order explicitly: create a test that imports the entry point and verifies all exports are defined (not `undefined`).

**AOF-specific:** `src/dispatch/index.ts` and `src/schemas/index.ts` are barrel files that re-export everything. These are the most common cause of circular dependencies. After removing gate exports, audit remaining exports for cycles.

**Phase:** Architecture Fixes (Phase 3).

---

### Pitfall 6: Test Infrastructure Changes Break Unrelated Tests via Shared State

**What goes wrong:** Introducing a shared test harness (`createTestHarness()`) that centralizes the tmpDir + store + logger setup pattern changes the timing or structure of test setup. Tests that relied on specific initialization order or leaked state between cases break.

**Prevention:**
1. Add the shared harness as an OPTION, not a mandate. Don't rewrite 60+ test files at once.
2. Migrate one test file at a time to the shared harness. Run full suite after each migration.
3. The shared harness must call `cleanup()` in `afterEach`, not `afterAll`. 8 test files currently lack cleanup -- fix these first.
4. Create typed mock factories (`createMockStore()`, `createMockLogger()`) that implement the full interface. Do not use `as any`. This catches interface drift at compile time.
5. Ensure `resetThrottleState()` and similar state-reset functions are called in the shared harness's cleanup.

**Detection:** Previously passing tests fail after importing the new harness. Tests pass individually but fail when run together (`vitest --sequence`).

**AOF-specific:** 217 instances of `new FilesystemTaskStore` or `new EventLogger` in test files. The shared harness should not change how these are constructed -- just centralize the boilerplate. The existing `src/testing/` utilities are barely used (only 3 imports) -- figure out why before creating more shared utilities.

**Phase:** Test Infrastructure (Phase 5 -- last, after all refactoring is stable).

---

### Pitfall 7: Removing Gate System Breaks Migration Framework

**What goes wrong:** The gate-to-DAG batch migration (`src/packaging/migrations/002-gate-to-dag-batch.ts`) and lazy migration in `task-store.ts` exist to handle upgrades from pre-v1.3 installations. Removing these without updating the migration framework means users upgrading from very old versions get corrupted data.

**Prevention:**
1. Keep the migration file but mark it as a no-op: `export async function migrate() { /* gate-to-DAG migration removed in v1.10; gate format no longer supported */ return { migrated: 0 }; }`.
2. Alternatively, add a version guard: if upgrading from <v1.3, refuse and tell the user to upgrade to v1.3 first.
3. Remove the lazy migration from `task-store.ts` -- it runs on every read and the per-read overhead is the bigger problem.
4. Document the removal in UPGRADING.md.

**Phase:** Dead Code Removal (Phase 1).

---

### Pitfall 8: Expanding Coverage Config Reveals Failures in Uncovered Code

**What goes wrong:** The current `vitest.config.ts` only tracks coverage for 6 files. Expanding to the full codebase reveals that actual coverage is much lower than believed. This creates pressure to write tests quickly, leading to shallow tests that don't catch real bugs.

**Prevention:**
1. Expand coverage config but don't set coverage thresholds initially. Use it as a measurement tool, not a gate.
2. Focus coverage effort on the modules identified as critical untested: `action-executor.ts` (415 lines, zero tests), `escalation.ts` (493 lines, zero tests), `task-dispatcher.ts` (290 lines, zero tests).
3. Write characterization tests for untested code before refactoring it -- these tests document current behavior, not desired behavior.
4. Don't count gate test removal (~2000 lines) against coverage numbers.

**Phase:** Test Infrastructure (Phase 5).

---

### Pitfall 9: TOCTOU Race Fix Changes Concurrency Semantics

**What goes wrong:** Fixing the TOCTOU race in `task-mutations.ts` (lines 135-219) and `lease.ts` (lines 45-103) by routing all transitions through the `InMemoryTaskLockManager` changes the concurrency behavior of the scheduler. Operations that previously ran in parallel now serialize, potentially causing performance degradation or deadlocks if the lock manager has unexpected behavior under load.

**Prevention:**
1. The current TOCTOU race is theoretical in single-process Node.js (true concurrency is rare, only async interleaving). Assess whether the fix is worth the complexity.
2. If fixing, add the lock manager integration behind a feature flag initially.
3. Write concurrent dispatch tests before making the change -- the current 5-case integration test is insufficient.
4. Profile scheduler poll latency before and after the change.

**Phase:** Bug Fixes (Phase 2).

---

## Minor Pitfalls

### Pitfall 10: Stale JSDoc References Mislead Future Contributors

**What goes wrong:** JSDoc comments reference non-existent files (`gate-transition-handler.ts`), promise removal in versions long past (v1.3), or contain commented-out code for "Phase 2" features. These mislead contributors into thinking dead code is alive or planned features are imminent.

**Prevention:** Include a JSDoc cleanup pass in the dead code removal phase. Grep for `@deprecated`, `TODO`, `FIXME`, `Phase 2`, file references in comments.

**Phase:** Dead Code Removal (Phase 1).

---

### Pitfall 11: Dynamic Imports Survive Dead Code Removal

**What goes wrong:** `task-store.ts` uses `dynamic import()` for `node:fs/promises` and `yaml` inside `loadWorkflowConfig()` (lines 92-94) despite both being statically imported already. These dynamic imports are invisible to dead code analysis tools and TypeScript's import resolution. Similar patterns may exist elsewhere.

**Prevention:** Grep for `import(` (dynamic import syntax) across the codebase. Replace with static imports where the module is already imported at the top of the file.

**Phase:** Dead Code Removal (Phase 1).

---

### Pitfall 12: `as any` Casts in Tests Hide Interface Drift

**What goes wrong:** 120 `as any` casts in test files mean mock objects can silently drift from real interfaces. When config centralization or logging refactoring changes interfaces (e.g., adding a required `logger` parameter), tests with `as any` mocks still compile and pass, but the real code fails.

**Prevention:** Replace `as any` casts with properly typed mock factories as part of test infrastructure work. Prioritize mocks for `ITaskStore` and `EventLogger` since these are the most commonly mocked interfaces (217 instances).

**Phase:** Test Infrastructure (Phase 5).

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Dead Code Removal | Removing gate files breaks barrel exports and downstream imports | Delete source + tests + barrel re-exports in single atomic commit; validate with `tsc --noEmit` |
| Dead Code Removal | Gate migration removal breaks upgrade path for pre-v1.3 users | Keep migration file as no-op stub; remove lazy migration from task-store read path |
| Dead Code Removal | Stale JSDoc and commented-out code remains after file deletion | Grep for all deprecated symbols, file references, and `@deprecated` tags |
| Dead Code Removal | Dynamic imports invisible to dead code tools | Grep for `import(` syntax; replace redundant dynamic imports with static |
| Bug Fixes | TOCTOU race fix serializes scheduler operations | Profile before/after; consider whether fix is worth complexity for single-process Node.js |
| Bug Fixes | `buildTaskStats` fix changes alert behavior | Add `cancelled` and `deadletter` to stats; update `activeTasks` calculation to exclude both |
| Config Centralization | Config validates at import time, breaking tests and CLI help | Lazy initialization with `getConfig()`, test-time `resetConfig()`, validate at startup boundaries only |
| Config Centralization | Replacing `process.env` access breaks test env mutation patterns | Provide `createConfig(overrides)` for tests; migrate incrementally module-by-module |
| Structured Logging | Replacing console.* in CLI commands produces JSON instead of human output | Categorize calls first (CLI output vs. diagnostic logging); never replace CLI output console calls |
| Structured Logging | Logger conflicts with existing JSONL EventLogger | Keep them separate: logger = operator diagnostics, EventLogger = structured event stream |
| God Function Refactoring | Extraction changes try/catch boundaries around swallowed errors | Map all 15 empty catches in assign-executor before extracting; preserve catch scope boundaries |
| God Function Refactoring | Module-level mutable state creates temporal coupling in extracted helpers | Pass state as explicit parameters to extracted functions rather than reading module globals |
| Circular Dependency Fixes | Breaking cycles changes module load order and initialization | Use `madge` for mapping; extract shared types to dedicated interface files; replace barrel imports |
| Test Infrastructure | Shared harness changes test setup timing | Add as option, migrate one file at a time, run full suite after each migration |
| Test Infrastructure | Coverage expansion reveals low numbers, creating pressure for shallow tests | Use coverage as measurement, not gate; write characterization tests for untested critical modules |
| Test Infrastructure | `as any` casts hide interface drift from refactoring | Replace with typed mock factories before major interface changes |

## Recommended Phase Ordering (Based on Pitfall Dependencies)

1. **Dead Code Removal** -- Reduces codebase by ~2900 lines, eliminates `new Function()` security risk, removes gate-related complexity from all subsequent phases.
2. **Bug Fixes** -- Fix `buildTaskStats`, `startTime`, `UpdatePatch.blockers`. Small, targeted changes that reduce risk in later phases.
3. **Config Centralization + Architecture Fixes** -- Break circular deps and centralize config together since both involve restructuring imports and module boundaries.
4. **Structured Logging** -- Depends on config centralization (log level setting). Migrate module-by-module, daemon first, CLI last.
5. **God Function Refactoring** -- Depends on having characterization tests and stable architecture. Highest risk of subtle behavioral changes.
6. **Test Infrastructure** -- Last because every other phase produces test changes. Consolidate patterns after all refactoring is done, not before.

## Sources

- [How to Delete Dead Code in TypeScript Projects](https://camchenry.com/blog/deleting-dead-code-in-typescript)
- [Dead Code Detection: Why We Chose Knip Over ts-prune](https://levelup.gitconnected.com/dead-code-detection-in-typescript-projects-why-we-chose-knip-over-ts-prune-8feea827da35)
- [Fixing Circular Dependencies: Barrel Files and God Classes](https://medium.com/@idrussalam95/fixing-circular-dependencies-in-node-js-a-battle-against-barrel-files-and-god-classes-e7d13df995f0)
- [How to Fix Circular Dependency Issues in JavaScript/TypeScript](https://medium.com/visual-development/how-to-fix-nasty-circular-dependency-issues-once-and-for-all-in-javascript-typescript-a04c987cf0de)
- [Ditch process.env, Use a Typed Config](https://echobind.com/post/ditch-process-env-use-a-typed-config)
- [Configuration Management for TypeScript Node.js Apps](https://medium.com/@andrei-trukhin/configuration-management-for-typescript-node-js-apps-60b6c99d6331)
- [Moving Beyond console.log: Structured Logging Saves Production](https://medium.com/@adesh.barve20/how-moving-beyond-console-log-66100d7b46fe)
- [Replace console.log with Structured Logging Using LogTape](https://sentry.io/cookbook/structured-logging-logtape/)
- [Refactoring by Breaking Functions Apart: TypeScript](https://auth0.com/blog/refactoring-breaking-functions-apart-typescript/)
- AOF `.planning/codebase/CONCERNS.md` -- primary source for AOF-specific issues (HIGH confidence)
- AOF `.planning/codebase/TESTS.md` -- primary source for test infrastructure state (HIGH confidence)

---

*Pitfalls analysis: 2026-03-12*
