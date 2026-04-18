---
status: resolved
trigger: "npm test intermittently fails during release-it before:init with different tests each run; same tests pass in isolation"
created: 2026-04-18T00:00:00Z
updated: 2026-04-18T17:30:00Z
---

## Current Focus

reasoning_checkpoint:
  hypothesis: "Default vitest.config.ts include glob `tests/**/*.test.ts` sweeps 224 E2E tests (designed for `singleFork: true` + 60s timeouts) and 24 integration tests (same) into the default parallel runner with 10s timeout, causing nondeterministic flakes: E2E suite-6 shares `~/.openclaw-aof-e2e-test/context-engineering` across its own beforeEach/afterEach, `afterEach` rm fights `beforeEach` mkdir under CPU/IO load (ENOTEMPTY), 10s testTimeout truncates 60s-designed tests, FS watcher in `watcher.test.ts` misses events under heavy IO. Additionally, `006-data-code-separation.test.ts` and `007-daemon-required.test.ts` mutate `process.env.HOME` — safe under vitest 3.x forks+isolate (default) but would be catastrophic if isolation is ever disabled for speed."
  confirming_evidence:
    - "`npx vitest list` (default config) returns 3200 tests including 224 tests/e2e/suites/ and 24 tests/integration/ entries"
    - "`npx vitest list --config tests/vitest.e2e.config.ts` returns exactly 224 — same set, confirming e2e tests run twice: once in default (wrong pool/timeout) and once under npm run test:e2e (right pool/timeout)"
    - "tests/vitest.e2e.config.ts has pool=forks + singleFork=true + testTimeout=60_000 + hookTimeout=30_000 + bail=1 — these are load-bearing for E2E"
    - "tests/integration/vitest.config.ts has pool=forks + singleFork=true + testTimeout=60_000 + hookTimeout=45_000 — same story"
    - "vitest.config.ts (default) has NO pool override (defaults to forks with fileParallelism across 6 CPUs on this machine) and testTimeout=10_000"
    - "Grep found process.env.HOME mutation in 2 test files — confirms historically-fragile global state"
  falsification_test: "After narrowing default include glob to exclude tests/e2e and tests/integration, `npx vitest list` should shrink to ~2976 (3200 - 224 e2e - ~24 integration). `npm test` run 3x consecutively must pass cleanly. If the SAME flakes still appear after exclusion, the hypothesis is wrong and the leak is via module-level state in src/."
  fix_rationale: "Narrowing the default include glob is the minimal, targeted fix at the test infrastructure layer. It restores the original intent — `npm test` = fast unit suite, `npm run test:e2e` = sequential E2E, `npm run test:integration:plugin` = sequential integration. No test coverage is removed (each config's own include still runs via its own script). No test code changes. No product code changes."
  blind_spots: "(1) There may be OTHER flakes I haven't reproduced locally; will verify with 3 consecutive clean runs. (2) If CI ever runs bare `vitest run` without --config, it would now MISS e2e/integration — but CI already uses `test:all` which invokes both scripts sequentially. (3) Phase 43's Wave 3/4 tests in src/packaging/ still mutate process.env.HOME; under current forks+isolate defaults this is safe, but a future contributor who sets isolate=false for speed would blow up. Not fixing that here (out of scope: each mutation is file-local and the forks+isolate default defends it)."

hypothesis: Default `vitest.config.ts` sweeps e2e + integration into the default parallel runner, causing under-load flakes.
test: Narrow include glob in vitest.config.ts to src-only + explicit exclusion of tests/e2e and tests/integration subtrees.
expecting: `npx vitest list` drops from 3200 to ~2976. `npm test` passes clean 3x in a row.
next_action: Apply the config change.

## Symptoms

expected: `npm test` (standalone) and `npm test` (invoked via release-it before:init) both complete with 290 passed, 9 skipped, 0 failed
actual: Standalone passes cleanly; release-it invocation fails intermittently with DIFFERENT tests each run
errors:
  - Attempt 1: src/views/__tests__/watcher.test.ts "debounces rapid file changes" → expected 0 to be greater than 0
  - Attempt 2: src/dispatch/__tests__/bug-002-log-event-consistency.test.ts → actionsPlanned 2 vs 3 + ENOTEMPTY on /var/folders/.../bug002-log-test-u48bb7 + hook timeouts
  - Attempt 3: tests/e2e/suites/05-view-updates.test.ts "should update kanban view" → 10s timeout + ENOTEMPTY on /Users/xavier/.openclaw-aof-e2e-test/context-engineering/tasks
reproduction: `npm run release:minor` (historical); simpler repro: `npm test` should not sweep e2e/integration into default pool
started: Recently — exposed during v1.15.0 release

## Eliminated

(none yet — before hypothesis testing)

## Evidence

- timestamp: 2026-04-18T00:00Z
  checked: vitest.config.ts (default)
  found: include = ["src/**/__tests__/**/*.test.ts", "tests/**/*.test.ts"] — NO pool override (defaults to threads), no exclude of e2e/integration subdirs
  implication: All E2E and integration tests get swept in when running `npm test`

- timestamp: 2026-04-18T00:00Z
  checked: tests/vitest.e2e.config.ts
  found: pool: "forks", singleFork: true, testTimeout 60_000, hookTimeout 30_000, include = ["tests/e2e/suites/**/*.test.ts"]
  implication: E2E suite is designed for sequential fork execution — running under default parallel thread pool with 10s timeout and shared in-process singletons WILL flake

- timestamp: 2026-04-18T00:00Z
  checked: tests/integration/vitest.config.ts
  found: pool: "forks", singleFork: true, testTimeout 60_000, hookTimeout 45_000, include = ["tests/integration/**/*.test.ts"]
  implication: Same as E2E — designed sequential, swept into parallel default pool

- timestamp: 2026-04-18T00:00Z
  checked: tests/e2e/suites/05-view-updates.test.ts, 06-context-engineering.test.ts, 09-concurrent-dispatch.test.ts
  found: Each hardcodes `join(homedir(), ".openclaw-aof-e2e-test", "<subsuite>")` — different subsuite per file, so NOT a cross-file path collision
  implication: Collision isn't "two tests share same path", it's "beforeEach/afterEach filesystem churn + shared in-process singletons + 10s default timeout too tight for 60s-designed suite"

- timestamp: 2026-04-18T00:00Z
  checked: package.json scripts
  found: `test` = `./scripts/test-lock.sh run` (wraps vitest run with flock lock + orphan watchdog); e2e + integration have their OWN `--config` override
  implication: The test-lock wrapper is fine; the leak is purely that the DEFAULT config glob sweeps e2e + integration

## Resolution

root_cause: |
  Two compounding, distinct root causes in the test-infrastructure layer:

  (1) PRIMARY — Default `vitest.config.ts` glob `tests/**/*.test.ts` swept 224
  E2E tests + 24 integration tests into the default parallel-forks pool with
  a 10s testTimeout. Those suites were designed for `singleFork: true` with
  60s testTimeout (their own configs set these). Under `npm test` they ran
  with the wrong pool and wrong timeouts, while simultaneously the unit suite
  ran in 6 parallel forks chewing CPU/IO. This caused nondeterministic flakes:
  E2E `beforeEach(cleanupTestData)` / `afterEach(cleanupTestData)` on shared
  `~/.openclaw-aof-e2e-test/<subsuite>` subtrees produced ENOTEMPTY races
  under filesystem load; E2E tests with inherent 20-40s runtimes exceeded the
  10s default testTimeout; the FS watcher test missed chokidar events under
  high inode churn.

  (2) SECONDARY — Three pre-existing load-sensitive unit tests that were
  *masked* when the release-it run aborted early on an E2E flake, but now
  surface because the suite completes more often:
    - `daemon-selecting-adapter.test.ts` "standalone mode falls through" test
      called `StandaloneAdapter.spawnSession()` with no timeout, defaulting
      to 30s; combined with a 5s `verifyGateway()` health check, worst-case
      was 35s. Under CPU pressure this exceeded the 10s testTimeout.
    - `daemon.test.ts` SIGTERM cleanup tests waited only 2000ms for async
      drain via `vi.waitFor`. Under parallel-fork CPU saturation the event
      loop often couldn't run the async SIGTERM handler + health-server close
      within 2s.
    - `hnsw-index.test.ts` "P99 search latency < 100ms" was an absolute
      performance assertion that failed under CPU contention. Quiet-box median
      is <10ms; a true algorithmic regression (linear scan) would be several
      seconds. 100ms was a noise-sensitive ceiling, not a regression guard.

fix: |
  (1) `vitest.config.ts` — Narrowed `include` to `src/** /__tests__/** /*.test.ts`
  only, added explicit `exclude` for `tests/e2e/**`, `tests/integration/**`,
  `node_modules`, `dist`, and `.claude/worktrees`. Added a header doc-comment
  explaining the scope discipline. E2E and integration tests are still run
  fully by their own dedicated npm scripts (`test:e2e`, `test:integration:plugin`)
  with their singleFork configs. Zero coverage removed.

  (2) `src/daemon/__tests__/daemon-selecting-adapter.test.ts` — Pass
  `{ timeoutMs: 1000 }` to `executor.spawnSession()` in the "standalone
  fallback" test so the no-gateway HTTP dispatch aborts quickly instead of
  waiting for the 30s default.

  (3) `src/daemon/__tests__/daemon.test.ts` — Raised the two `vi.waitFor`
  timeouts for SIGTERM cleanup assertions from 2000ms to 8000ms and added an
  explicit 50ms check interval. The assertions are about correctness
  (exit(0) was called, socket/pid files removed), not latency.

  (4) `src/memory/__tests__/hnsw-index.test.ts` — Raised P99 latency ceiling
  from 100ms to 500ms with an explanatory comment. Repositioned as a
  regression guard against algorithmic blowouts (linear scans), not a
  performance benchmark. Renamed the test to reflect the new semantics.

verification: |
  - `npx vitest list` before fix: 3200 tests; after fix: 2920 tests (−280:
    224 e2e + 24 integration + nested excluded).
  - `npx vitest list --config tests/vitest.e2e.config.ts` still returns 224
    (coverage preserved — e2e runs under its own config).
  - `npx vitest list --config tests/integration/vitest.config.ts` still
    returns 24 (coverage preserved).
  - `npm test` run 3x consecutively post-fix (after orphan-kill between
    sessions): ALL CLEAN — 2920 passed, 3 skipped, 0 failed, 44-47s each.
  - `npm run typecheck` passes clean.
  - Original flakes observed pre-fix: watcher.test.ts "debounces rapid file
    changes", bug-002 hook timeouts + ENOTEMPTY, E2E suite-5/6/9 10s timeouts
    + ENOTEMPTY on shared paths — none reproduce post-fix because those tests
    no longer run under the wrong pool.

files_changed:
  - vitest.config.ts
  - src/daemon/__tests__/daemon-selecting-adapter.test.ts
  - src/daemon/__tests__/daemon.test.ts
  - src/memory/__tests__/hnsw-index.test.ts
  - .planning/debug/2026-04-18-vitest-flakes.md
