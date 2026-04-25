---
phase: 46-daemon-state-freshness-fix-project-discovery-one-shot-bug-st
verified: 2026-04-25T12:25:00Z
status: passed
score: 6/6 must-haves verified
overrides_applied: 0
re_verification: null
---

# Phase 46: Daemon state freshness — Verification Report

**Phase Goal:** Fix the four daemon-side bugs surfaced by the 2026-04-24 incident cluster (Tier A): (1A) status/location drift on deadletter transition; (1C) bounded log rotation via `pino-roll@4`; (2A) per-poll project rediscovery; (2B) routing-target validation at `aof_dispatch`; (2C) envelope-actor injection at `/v1/tool/invoke`.
**Verified:** 2026-04-25T12:25:00Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

Goal-derived must-haves (one per requirement ID, plus structural completeness checks):

| #  | Truth | Status | Evidence |
|----|-------|--------|----------|
| 1  | BUG-046-1A-ATOMIC: `transitionToDeadletter` performs frontmatter-stamp + file-move atomically via `metadataPatch` (no separate `save()` call) | VERIFIED | `src/dispatch/failure-tracker.ts:96-105` — single `await store.transition(taskId, "deadletter", { reason, metadataPatch: {...} })` call. `bug-046a-atomic-transition.test.ts` (3/3 GREEN) including a Proxy-counted `save() === 0` assertion. |
| 2  | BUG-046-1A-RECONCILE: `FilesystemTaskStore.init()` heals on-disk drift between `frontmatter.status` and directory location at boot | VERIFIED | `src/store/task-store.ts:148-256` — `init()` calls `await this.reconcileDrift()`; new private method walks `lintTasks` "Status mismatch:" issues and renames misfiled files. STATUS_DIRS allowlist guards path-traversal. `bug-046a-startup-reconciliation.test.ts` (3/3 GREEN). |
| 3  | BUG-046-1C: `pino-roll@4` wired into `getRootLogger()` with `size:'50m'`, `count:5`, `mkdir:true`; `fd:2` removed; `resetLogger()` calls `.end()` | VERIFIED | `src/logging/index.ts:64-103` — `pino.transport({ target: "pino-roll", options: { file, size: "50m", limit: { count: 5 }, mkdir: true }})`. No `pino.destination({ fd: 2 })` anywhere. `package.json:85` declares `"pino-roll": "^4.0.0"`. `resetLogger()` (lines 127-143) calls `.end()` on the worker. `bug-046c-rotation-wired.test.ts` (4/4 GREEN). |
| 4  | BUG-046-2A: A project created post-`AOFService.init()` is discovered on the next `runPoll()` invocation | VERIFIED | `src/service/aof-service.ts:304-341` — new private `rediscoverProjects()` diffs `discoverProjects(vaultRoot)` against `projectStores`, adds new, deletes vanished. `runPoll()` (line 459) calls it FIRST inside `try{}`. Reuses existing `pollQueue` serialization (no new lock, no fs watcher). `bug-046b-project-rediscovery.test.ts` (3/3 GREEN). |
| 5  | BUG-046-2B: `aof_dispatch` rejects empty-routing with clear error before any file is written; defaults from `project.owner.lead`/`owner.team` with case-insensitive `"system"` sentinel skip | VERIFIED | `src/tools/project-tools.ts:193-223` — three-branch logic (try explicit → try project-owner default → reject). `.toLowerCase() !== "system"` check at lines 204, 206. `routing: { agent, team, role }` literal at line 271 uses defaulted locals. `bug-046d-routing-required.test.ts` (8/8 GREEN). |
| 6  | BUG-046-2C: IPC route injects `envelope.actor` into `inner.data.actor` when absent; plugin-side `mergeDispatchNotificationRecipient` falls back `params.actor` to `captured.actor` | VERIFIED | `src/ipc/routes/invoke-tool.ts:176-179` — `enrichedParams` ternary spreads envelope `actor` into `inner.data` only when undefined; explicit precedence preserved. `src/openclaw/dispatch-notification.ts:38-57` — `consumeToolCall` reordered ahead of `notifyOnCompletion=false` early-return; `enriched` object injects `captured.actor` when params has no actor. `bug-046e-actor-injection.test.ts` (3/3 GREEN) + `bug-046e-dispatch-notification-actor.test.ts` (4/4 GREEN). |

**Score:** 6/6 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/store/interfaces.ts` | `ITaskStore.transition` opts shape extended with `metadataPatch` | VERIFIED | Field at line 116; type `Record<string, unknown>`. JSDoc at lines 108-115 cites Phase 46 / Bug 1A. |
| `src/store/task-mutations.ts` | `TransitionOpts.metadataPatch` + applied in `transitionTask` BEFORE `writeFileAtomic` | VERIFIED | `TransitionOpts.metadataPatch` at line 119. Applied at lines 184-189, BEFORE the new-location write. |
| `src/dispatch/failure-tracker.ts` | `transitionToDeadletter` is single atomic `store.transition` call (no `save() + transition()` split) | VERIFIED | Lines 96-105 single call. `trackDispatchFailure` and `resetDispatchFailures` retain bare `store.save()` (intentional — metadata-only writes, no rename). Audit-trail `eventLogger.log("task.deadlettered", ...)` preserved. |
| `src/store/task-store.ts` | `reconcileDrift()` called from `init()`; uses `lintTasks` walk; STATUS_DIRS allowlist | VERIFIED | `init()` calls `await this.reconcileDrift()` at line 153. Method at lines 186-256 filters on `"Status mismatch:"`, validates target via `STATUS_DIRS.includes`, renames .md + companion dir. |
| `src/service/aof-service.ts` | `rediscoverProjects()` called from `runPoll()` before `pollAllProjects()` | VERIFIED | Method at lines 304-341. `runPoll()` calls `await this.rediscoverProjects()` at line 459, BEFORE `pollAllProjects()` at line 462. No `fs.watch` / `chokidar`. |
| `src/logging/index.ts` | `pino.transport` with pino-roll target, size 50m, count 5, mkdir true; no `pino.destination({fd:2})`; `.end()` in `resetLogger` | VERIFIED | Lines 83-91 production wiring. `if (process.env["VITEST"] === "true")` (lines 77-80) is the c643c24 cross-plan fix that defaults to a discard `PassThrough` in vitest — does not affect production wiring. `resetLogger` (lines 127-143) calls `.end()`. |
| `package.json` | `pino-roll@^4.0.0` declared in `dependencies` | VERIFIED | Line 85: `"pino-roll": "^4.0.0"`. |
| `src/tools/project-tools.ts` | Routing validation + project-owner defaulting + `system` sentinel | VERIFIED | Import `loadProjectManifest` at line 11. Validation block at lines 193-223. `routing: { agent, team, role }` defaulted-locals literal at line 271. |
| `src/ipc/routes/invoke-tool.ts` | Envelope actor injected into `inner.data` before `def.handler(ctx, ...)` | VERIFIED | Lines 165-181. `enrichedParams` ternary; `def.handler(ctx, enrichedParams)` at line 181. Old `def.handler(ctx, inner.data)` removed. |
| `src/openclaw/dispatch-notification.ts` | `consumeToolCall` reordered ahead of `notifyOnCompletion=false` early-return; `params.actor` falls back to `captured.actor` | VERIFIED | Lines 38-57. `consumeToolCall` at line 45 (before `if (raw === false)` at line 60). `enriched` object spreads `captured.actor` into params when no `existingActor`. |

All artifacts exist, are substantive, and are wired (Levels 1–3).

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `failure-tracker.transitionToDeadletter` | `task-mutations.transitionTask` | `store.transition(id, "deadletter", { metadataPatch })` | WIRED | Single call site; metadata patch contains all 5 deadletter* fields. |
| `task-mutations.transitionTask` | `writeFileAtomic(newPath)` | `task.frontmatter.metadata = {...}` BEFORE serialize+write | WIRED | Patch applied at lines 184-189; subsequent `writeFileAtomic` of the new-location file lands the patched frontmatter on first write. |
| `task-store.init()` | `task-store.reconcileDrift()` | `await this.reconcileDrift()` | WIRED | Direct call at line 153 after STATUS_DIRS mkdir loop. |
| `task-store.reconcileDrift()` | `task-validation.lintTasks` | `this.lint()` returns "Status mismatch:" entries | WIRED | Filtered on `issue.startsWith("Status mismatch:")` at line 189. |
| `aof-service.runPoll()` | `aof-service.rediscoverProjects()` | first `await` inside `try{}` | WIRED | Line 459, before `pollAllProjects()`. Serialized via `pollQueue`. |
| `aof-service.rediscoverProjects()` | `projects.registry.discoverProjects` | `await discoverProjects(this.vaultRoot)` | WIRED | Line 307. |
| `logging/index.getRootLogger` | `pino-roll` worker | `pino.transport({ target: "pino-roll", options: { ... } })` | WIRED | Lines 83-91, production-only branch (vitest env uses PassThrough sink per c643c24). |
| `logging/index.resetLogger` | transport.end() | `.end()` invocation | WIRED | Lines 134-138. |
| `project-tools.aofDispatch` | `manifest.loadProjectManifest` | `await loadProjectManifest(ctx.store, projectId)` | WIRED | Line 201. |
| `project-tools.aofDispatch` | rejection (no routing) | `throw new Error("...requires a routing target...")` | WIRED | Lines 217-222. Thrown BEFORE `ctx.store.create` (line 264) — verified by `bug-046d-routing-required.test.ts` no-file-on-reject case. |
| `ipc.invoke-tool.handleInvokeTool` | `def.handler(ctx, enrichedParams)` | enriched with `envelope.actor` when undefined | WIRED | Lines 176-181; matches "explicit > envelope > undefined" precedence. |
| `dispatch-notification.mergeDispatchNotificationRecipient` | `captured.actor` | `enriched = { ...params, actor: captured.actor }` when no `existingActor` | WIRED | Lines 50-57. Reorder of `consumeToolCall` ahead of `notifyOnCompletion=false` early-return is documented in module docstring. |

All key links verified.

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `transitionToDeadletter` | `task.frontmatter.metadata.deadletter*` | computed from `errorClass`, `lastFailureReason`, `failureCount`, `task.frontmatter.routing.agent` | yes | FLOWING |
| `reconcileDrift` | `issues` from `this.lint()` | filesystem walk via `lintTasks(tasksDir, statusDir, logger)` | yes | FLOWING |
| `rediscoverProjects` | `discovered` projects | `discoverProjects(this.vaultRoot)` reads `<vaultRoot>/Projects/*/project.yaml` | yes | FLOWING |
| `getRootLogger` (production) | log records | `pino.transport(...)` worker writes to `<dataDir>/logs/aof.log` | yes | FLOWING (production); STATIC sink in vitest by design |
| `aofDispatch` defaulted routing | `agent`/`team` locals | `manifest.owner.lead/team` from disk | yes | FLOWING |
| `enrichedParams` | `inner.data.actor` | `envelope.actor` from authenticated IPC request | yes | FLOWING |
| `mergeDispatchNotificationRecipient` enriched | `params.actor` | `captured.actor` from `OpenClawToolInvocationContextStore` | yes | FLOWING |

No HOLLOW or DISCONNECTED artifacts. The vitest-only PassThrough sink in `logging/index.ts` is intentional per the c643c24 cross-plan fix to avoid the worker-thread loader bug in vitest workers; production code path (`process.env["VITEST"] !== "true"`) wires pino-roll exactly as specified.

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Bug 1A regression (atomic + reconcile) | `./scripts/test-lock.sh run src/dispatch/__tests__/bug-046a-atomic-transition.test.ts src/store/__tests__/bug-046a-startup-reconciliation.test.ts` | 6/6 passed (638ms) | PASS |
| Bug 2A + Bug 1C + Bug 2B regressions | `./scripts/test-lock.sh run src/service/__tests__/bug-046b-project-rediscovery.test.ts src/logging/__tests__/bug-046c-rotation-wired.test.ts src/tools/__tests__/bug-046d-routing-required.test.ts` | 15/15 passed (1.52s) | PASS |
| Bug 2C regression (envelope + plugin) | `./scripts/test-lock.sh run src/ipc/__tests__/bug-046e-actor-injection.test.ts src/openclaw/__tests__/bug-046e-dispatch-notification-actor.test.ts` | 7/7 passed (402ms) | PASS |
| BUG-005 + concurrent-transition (upstream invariants preserved) | `./scripts/test-lock.sh run src/dispatch/__tests__/deadletter-frontmatter-stamp.test.ts src/dispatch/__tests__/deadletter-integration.test.ts src/store/__tests__/task-store-concurrent-transition.test.ts` | 12/12 passed (764ms) | PASS |
| Multi-project polling + AOFService + dispatch-notification (upstream invariants preserved) | `./scripts/test-lock.sh run src/service/__tests__/multi-project-polling.test.ts src/service/__tests__/aof-service.test.ts src/openclaw/__tests__/dispatch-notification.test.ts` | 28/28 passed (13.31s) | PASS |
| TypeScript build | `npm run typecheck` | clean (exit 0) | PASS |
| Circular dependencies | `npx madge --circular --extensions ts src/` | "No circular dependency found!" (595 files) | PASS |

Total: 68/68 directly-verified tests passing across phase-46 fixes and adjacent invariants. No new circular deps. TypeScript clean.

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| BUG-046-1A-ATOMIC | 46-01 | `transitionToDeadletter` becomes atomic via `metadataPatch` | SATISFIED | `failure-tracker.ts:96-105`; `task-mutations.ts:184-189`; `interfaces.ts:116`. 3/3 regression tests GREEN. |
| BUG-046-1A-RECONCILE | 46-02 | Startup reconciliation pass at `FilesystemTaskStore.init()` | SATISFIED | `task-store.ts:148-256`. 3/3 regression tests GREEN. |
| BUG-046-1C | 46-04 | Bounded log rotation via `pino-roll@4` (50 MB × 5, no gzip), drop `fd:2` | SATISFIED | `logging/index.ts:83-91` (production); `package.json:85`. 4/4 regression tests GREEN. |
| BUG-046-2A | 46-03 | Per-poll project rediscovery so post-startup projects become live within one poll cycle | SATISFIED | `aof-service.ts:304-341` + line 459 wiring. 3/3 regression tests GREEN. |
| BUG-046-2B | 46-05 | Routing-target validation at `aof_dispatch` create time with optional default + `"system"` sentinel | SATISFIED | `project-tools.ts:193-223`. 8/8 regression tests GREEN. |
| BUG-046-2C | 46-06 | Envelope-actor injection at `/v1/tool/invoke` + plugin-side defense-in-depth | SATISFIED | `invoke-tool.ts:176-181`; `dispatch-notification.ts:38-57`. 3/3 IPC + 4/4 plugin regression tests GREEN. |

All 6 requirement IDs SATISFIED. No ORPHANED requirements (every plan's `requirements:` field maps to a roadmap ID; every roadmap ID is claimed by exactly one plan). No requirement IDs declared in plans that are absent from the ROADMAP.

---

### Anti-Patterns Found

Review of files modified in this phase against project skills + stub-detection patterns:

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/dispatch/failure-tracker.ts` | 42, 154 | `trackDispatchFailure` and `resetDispatchFailures` still call bare `store.save(task)` | Info | INTENTIONAL — these update counters only and never rename files; the Phase 46 atomic invariant ("metadata stamps that *accompany* status transitions go through `metadataPatch`") only applies to status-changing paths. Documented in 46-REVIEW.md WR-01. Not a bug. |
| `src/logging/index.ts` | 77-80 | `if (process.env["VITEST"] === "true")` returns a `PassThrough` discard sink | Info | INTENTIONAL — this is the c643c24 cross-plan fix. The vitest worker-thread loader cannot resolve `pino-roll` from worker context. Production path (line 82-91) wires pino-roll exactly as the plan required. Phase 46 must-have applies to production wiring; the vitest branch does not weaken it. |
| `src/store/task-store.ts` | 220-224 | `currentStatus` regex parse of `lintTasks` issue string | Info | DOCUMENTED brittleness — `46-REVIEW.md` WR-03 recommends switching to structural extraction from `oldPath`. Companion-dir rename silently degrades to "skipped" if format changes; .md rename still succeeds (no data loss). Recommended for Phase 47 backlog. |
| `src/store/task-mutations.ts` | 231-234 | `unlink(newPath).catch(() => {})` swallows rollback errors | Info | DOCUMENTED — `46-REVIEW.md` IN-05 recommends adding a warn log. Pre-existing pattern; not introduced by Phase 46. Recommended for Phase 47 backlog. |
| `src/logging/index.ts` | 127-143 | `resetLogger` ordering relies on `__setLoggerTransportForTests(null)` being called AFTER `resetLogger` | Info | DOCUMENTED — `46-REVIEW.md` WR-02 recommends defensive `dest = null` ordering. No live failure mode in current tests; recommended hardening for Phase 47 backlog. |

**No Blockers, no Warnings, 5 Info items** — all already captured in 46-REVIEW.md. None gate phase completion.

**Stub scan:** spot-checked all 7 modified source files for placeholder patterns (`return null`, `TODO`, `FIXME`, empty handler, hardcoded empty array). None found. The pino-roll vitest fallback is the only "default to empty/no-op" pattern, and it's an explicit cross-platform compatibility fix, not a stub.

---

### Human Verification Required

None blocking. The validation strategy (46-VALIDATION.md) flags three behaviors as manual-only:

1. **launchd-stderr.log no longer grows during normal operation** (Plan 04) — requires the actual launchd plist + a running daemon over multiple poll cycles. Not feasible in unit test. **Pre-deploy gate**, not a Phase 46 acceptance gate; the unit test (`bug-046c-rotation-wired.test.ts`) covers the code-level wiring.
2. **Newly-created project is dispatched without daemon restart** (Plan 03) — E2E confirmation against real OpenClaw + filesystem. The unit test (`bug-046b-project-rediscovery.test.ts`) covers the in-memory invariant; the real-install confirmation happens during deploy verification.
3. **172 MB log incident does not recur** (Plan 04) — negative confirmation testable only by elapsed time. Pre-deploy gate.

These items are post-deploy verifications, not gating items for phase verification. Phase 46 is structurally complete and the unit-suite contract is satisfied.

---

### Gaps Summary

No gaps. All 6 requirement IDs are SATISFIED. All 6 plans landed with TDD RED → GREEN sequence (verified in git log: `test(46-NN)` commits precede `fix(46-NN)` commits for every plan). All 7 regression test files exist and PASS (28 total tests). All upstream invariants (BUG-005 stamp, concurrent-transition, multi-project polling, AOFService base behavior, dispatch-notification baseline) remain GREEN. TypeScript typecheck and madge cycle-check both clean.

The cross-plan integration fix (c643c24, post-merge) is sound: it preserves the production pino-roll wiring while bypassing the vitest worker-thread loader bug. The fix does not weaken any Phase 46 must-have — `bug-046c-rotation-wired.test.ts` is a source-level config sniff (regex on `index.ts` text), so it remains GREEN regardless of runtime branch.

Pre-existing CLI test failures (`memory-cli.test.ts`, `org-drift-cli.test.ts`, `adapters.test.ts`, `watcher.test.ts`) are documented in `deferred-items.md` and confirmed unrelated to Phase 46 surface area. The user-supplied note confirms 3006/3010 unit tests pass post-merge with 1 pre-existing flake (watcher.test.ts), which is consistent with the deferred-items inventory.

---

_Verified: 2026-04-25T12:25:00Z_
_Verifier: Claude (gsd-verifier)_
