---
phase: 46-daemon-state-freshness-fix-project-discovery-one-shot-bug-st
plan: 04
subsystem: infra
tags: [pino, pino-roll, logging, log-rotation, worker-thread, launchd, BUG-046-1C]

# Dependency graph
requires:
  - phase: 38-structured-logging
    provides: pino-based createLogger() factory with child-logger component binding
provides:
  - "pino-roll@^4.0.0 worker-thread transport wired into getRootLogger()"
  - "Bounded log disk use: <dataDir>/logs/aof.log rotated 50MB × 5 (250MB worst-case)"
  - "fd:2 (stderr) dropped from pino's destination chain"
  - "TEST-ONLY __setLoggerTransportForTests escape hatch for synchronous test transports"
  - "resetLogger() now releases the worker-thread transport via .end() (orphan-vitest-workers fix)"
affects: [release-notes, daemon-stderr-log-truncation, future log-aggregation work]

# Tech tracking
tech-stack:
  added: [pino-roll@^4.0.0 (Matteo Collina, MIT, sonic-boom-backed)]
  patterns:
    - "Production-or-test transport pattern: production-only pino-roll worker thread, plus an explicit TEST-ONLY override hook so tests can inject a synchronous PassThrough without spawning the worker"
    - "Source-level config-sniff regression tests (read source file as text, regex-assert on configuration shape) — avoids spawning worker threads inside vitest"

key-files:
  created:
    - "src/logging/__tests__/bug-046c-rotation-wired.test.ts (4 source-level config assertions)"
    - ".planning/phases/46-daemon-state-freshness-fix-project-discovery-one-shot-bug-st/deferred-items.md (documents pre-existing dist/-dependent CLI tests)"
  modified:
    - "src/logging/index.ts (pino.transport({target: pino-roll}); resetLogger calls .end(); test override hook)"
    - "src/logging/__tests__/logger.test.ts (uses __setLoggerTransportForTests in beforeEach/afterEach)"
    - "package.json (pino-roll@^4.0.0 in dependencies)"
    - "package-lock.json (resolved deps)"

key-decisions:
  - "Drop gzip-on-rotation requirement (CONTEXT.md addendum Q1) — pino-roll@4 has no native support; 5×50MB raw is bounded and predictable; gzip can be added later as an optimization"
  - "Drop fd:2 from pino's destination chain entirely (CONTEXT.md addendum Q2) — adding pino-roll alone would have left the launchd-captured daemon-stderr.log growth path open"
  - "Option (c) from Phase 46 revision: production wires pino-roll exactly, tests use a TEST-ONLY __setLoggerTransportForTests escape hatch with synchronous PassThrough — no sleep()/setTimeout() added to test code, no flaky worker-thread synchronization"
  - "Source-level config-sniff regression tests instead of behavioral tests of pino-roll itself — avoids spawning the worker thread inside vitest (orphan-worker hazard from CLAUDE.md)"

patterns-established:
  - "Worker-thread transport release in resetLogger() — call .end() on the destination so vitest pool doesn't leak workers (mandatory for any future pino transport that spawns workers)"
  - "TEST-ONLY escape hatch for singleton state — module-private setter exported with __ prefix and JSDoc clearly marking it as test infrastructure"

requirements-completed: [BUG-046-1C]

# Metrics
duration: 13 min
completed: 2026-04-25
---

# Phase 46 Plan 04: Bounded log rotation via pino-roll Summary

**pino-roll@4 worker-thread transport wired into getRootLogger() (50 MB × 5, mkdir:true) with fd:2 dropped from the destination chain — the 172 MB daemon-stderr.log growth path is structurally closed.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-04-25T15:52:55Z
- **Completed:** 2026-04-25T16:05:16Z
- **Tasks:** 2 (TDD: RED → GREEN)
- **Files modified:** 4 (+ 1 deferred-items.md doc)

## Accomplishments

- `pino-roll@^4.0.0` installed and wired into `src/logging/index.ts:getRootLogger()` with `size: '50m'`, `limit: { count: 5 }`, `mkdir: true`, file path `<dataDir>/logs/aof.log`.
- `pino.destination({ fd: 2 })` removed entirely. fd:2 is no longer a pino destination during normal operation; launchd's `StandardErrorPath` capture (`daemon-stderr.log`) becomes a rare-event channel for Node-level uncaught crashes only.
- `resetLogger()` now calls `.end()` on the worker-thread transport, plugging the orphan-vitest-workers leak that would otherwise force `kill -9` after every aborted test run.
- New regression test `bug-046c-rotation-wired.test.ts` (4 cases) — source-level config sniffs that don't spawn the pino-roll worker thread inside vitest.
- All 9 existing `logger.test.ts` cases remain GREEN. Test transport override (`__setLoggerTransportForTests`) keeps the singleton path synchronous in tests; no `sleep()` / `setTimeout()` was added to test code.

## Task Commits

Each task was committed atomically:

1. **Task 1: RED — pino-roll dep + config-sniff regression tests** — `23ee0e3` (test)
2. **Task 2: GREEN — wire pino-roll, drop fd:2, release worker on reset** — `60c4a9d` (fix)

## Files Created/Modified

- `src/logging/index.ts` — replaced `pino.destination({ fd: 2, sync: false })` with `pino.transport({ target: 'pino-roll', options: { file, size, limit, mkdir } })`; `resetLogger()` now calls `.end()` on the dest; added TEST-ONLY `__setLoggerTransportForTests(stream)` for synchronous test transports.
- `src/logging/__tests__/bug-046c-rotation-wired.test.ts` — 4 source-level regression cases: pino.transport wiring, no fd:2 destination, pino-roll declared in deps, .end() in resetLogger.
- `src/logging/__tests__/logger.test.ts` — beforeEach injects a `PassThrough` via `__setLoggerTransportForTests`; afterEach clears it. Existing 4 `setTimeout` calls are unchanged (they synchronize against test-local pino instances built directly against PassThrough, NOT the singleton).
- `package.json` / `package-lock.json` — added `pino-roll@^4.0.0` (Matteo Collina, MIT). Transitive deps: `date-fns@4.1.0`, `sonic-boom@4.0.1`.

## Decisions Made

- **CONTEXT.md addendum Q1 — gzip-on-rotation dropped.** pino-roll@4 has no native gzip support. 5×50MB = 250MB worst-case is bounded and predictable; gzip can be added later as an optimization without breaking anything (e.g. by swapping to `rotating-file-stream` with a custom adapter, or by adding a post-rotation external gzip step).
- **CONTEXT.md addendum Q2 — fd:2 dropped from pino's destination chain.** Adding pino-roll while keeping `pino.destination({ fd: 2 })` would have left the launchd-captured `daemon-stderr.log` growth path open. With fd:2 dropped, that file becomes a rare-event channel — Node's default uncaught-exception handler still writes to stderr (and launchd still captures it), but pino's structured per-line output never lands there.
- **Option (c) — TEST-ONLY transport override.** Both alternatives were worse: (a) refactor every existing logger.test.ts case to await pino-roll's worker (flaky, leaks workers), (b) add `sleep()` / `setTimeout()` everywhere (forbidden by acceptance criteria; flaky). The escape hatch keeps production wiring untouched and tests synchronous.
- **Source-level config-sniff regression tests.** `bug-046c-rotation-wired.test.ts` reads `index.ts` as text and regex-asserts on configuration shape. This avoids re-testing pino-roll's rotation behavior (that's the library's job) and avoids spawning the worker thread inside vitest. Behavioral validation lives in production deploy verification.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] TypeScript narrowing error on `pino()` second argument**
- **Found during:** Task 2 (initial GREEN write)
- **Issue:** Module-level `let dest: DestinationStream | null = null;` caused `tsc --noEmit` to reject the call site `pino({...}, dest)` with `TS2345: Type 'DestinationStream | null' is not assignable to parameter of type 'DestinationStream | undefined'.` The `??` expression has the right narrow type at the assignment site, but TS reads `dest` again at the `pino()` call and sees the wider `| null` from the var declaration.
- **Fix:** Bound the non-null transport to a local `const transport: DestinationStream = testTransportOverride ?? pino.transport({...});`, then assigned both `dest = transport;` and passed `transport` (not `dest`) to `pino()`. Module-level `dest` retains its `| null` shape so `resetLogger()` can still null it after `.end()`.
- **Files modified:** `src/logging/index.ts`
- **Verification:** `npm run typecheck` clean; all 13 logger tests still GREEN.
- **Committed in:** `60c4a9d` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — TypeScript narrowing).
**Impact on plan:** Minor; required for compilation. No scope creep — the local-binding fix is the standard idiom for narrowing module-level mutable state in TS.

## Issues Encountered

- **Full unit suite reported 17 pre-existing failures across 4 test files.** Investigation: 15 failures in `src/commands/__tests__/{memory-cli,org-drift-cli}.test.ts` spawn `node dist/cli/index.js`, but `dist/` does not exist in this fresh worktree. 1 failure in `src/drift/__tests__/adapters.test.ts` times out depending on the `openclaw` CLI binary state. 1 failure in `src/views/__tests__/watcher.test.ts` is a known fs-event race (verified: passes when run in isolation against the un-modified base commit). **None are caused by Plan 04 changes.** Documented in `.planning/phases/46-.../deferred-items.md` per executor scope-boundary protocol.

## Threat Flags

None — no new security-relevant surface introduced. The pino-roll worker thread is in-process, no network/IPC. Filesystem writes go to `<dataDir>/logs/` which inherits operator-controlled permissions from the data dir (per Plan 04's `<threat_model>` T-46-04-01 through T-46-04-04, all dispositions accepted/mitigated).

## TDD Gate Compliance

- ✓ RED gate: `test(46-04): add RED config-sniff regression for pino-roll wiring (BUG-046c)` — `23ee0e3` (3/4 cases initially RED, as designed; the 4th — pino-roll-in-deps — passed once `npm install pino-roll` ran in the same task per the plan's specified ordering).
- ✓ GREEN gate: `fix(46-04): wire pino-roll transport, drop fd:2 destination (BUG-046c)` — `60c4a9d` (all 4 RED cases now GREEN; 9 existing logger.test.ts cases unchanged).
- No REFACTOR commit needed — implementation is minimal and clean.

## Operator Note for Release Notes

Existing `daemon-stderr.log` files at upgrade time will keep their accumulated bytes. After deploy, operators should manually truncate:

```bash
: > ~/.aof/data/logs/daemon-stderr.log
```

Going forward, that file will only grow at the rare-event rate (Node-level uncaught crashes via Node's default stderr handler). The structured pino output now lives in `~/.aof/data/logs/aof.log` with rotation.

## Open Follow-up (Phase 47 backlog candidate)

Dropping fd:2 from the destination chain introduces a small silent-crash risk if pino-roll's worker thread fails to initialize (the Node uncaughtException handler still writes to stderr via Node's default, which launchd captures — but the window during pino-roll worker init is unprotected, microseconds-to-milliseconds).

**Proposed mitigation (NOT in Phase 46 scope):**

```typescript
// daemon entrypoint
process.on('uncaughtException', (e) => {
  fs.appendFileSync(
    join(resolveDataDir(), "logs", "aof-fatal.log"),
    `[${new Date().toISOString()}] ${e.stack ?? e.message}\n`,
  );
});
```

Synchronous fallback to a fixed file (no rotation, append-only) so fatal crashes always have somewhere to land regardless of pino-roll worker state. Filed as a discrete backlog entry — small surface, big debuggability win.

## Next Phase Readiness

- Bug 1C closed; the 172 MB log incident from 2026-04-24 is structurally impossible.
- Wave 1 (Plans 04 / 05 / 06) can land in any order — Plan 04 is fully isolated (`src/logging/` only).
- No blockers for Phase 46 completion. Deploy verification (post-merge gate) should:
  1. Confirm `<dataDir>/logs/aof.log` is created on first daemon start.
  2. Confirm `daemon-stderr.log` does not grow under normal traffic (only on crash).
  3. Truncate the legacy `daemon-stderr.log` on upgraded installs.

## Self-Check: PASSED

- ✓ `src/logging/index.ts` exists and contains `target: "pino-roll"`, `mkdir: true`, `size: "50m"`, `count: 5`, `.end()`.
- ✓ `src/logging/index.ts` does NOT contain `pino.destination({ fd: 2 ...})`.
- ✓ `src/logging/__tests__/bug-046c-rotation-wired.test.ts` exists with 4 `it()` cases (all GREEN post-Task-2).
- ✓ `src/logging/__tests__/logger.test.ts` modified to use `__setLoggerTransportForTests` in beforeEach/afterEach; setTimeout count unchanged at 4 (all in test-local pino instances, not singleton).
- ✓ `package.json` declares `"pino-roll": "^4.0.0"` in dependencies; `package-lock.json` resolved.
- ✓ `npm run typecheck` clean.
- ✓ `npx madge --circular --extensions ts src/` reports no circular deps.
- ✓ Commit `23ee0e3` (test) found in `git log --all`.
- ✓ Commit `60c4a9d` (fix) found in `git log --all`.
- ✓ All 13 logger tests GREEN (4 new + 9 existing).
- ✓ No orphan vitest workers after test runs (verified empty).

---
*Phase: 46-daemon-state-freshness-fix-project-discovery-one-shot-bug-st*
*Plan: 04*
*Completed: 2026-04-25*
