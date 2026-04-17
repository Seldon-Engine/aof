---
phase: 43
plan: 05
subsystem: dispatch,daemon,ipc
tags: [wave-3, hold-in-ready, selecting-adapter, plugin-bridge, d-10, d-12, fragile-chain-safe]
requires:
  - 43-CONTEXT.md (D-10 adapter selection, D-12 hold-no-drop invariant)
  - 43-RESEARCH.md §Hold-in-ready L444-457 (recipe mirroring platformLimit)
  - 43-PATTERNS.md §assign-executor.ts L652 (platformLimit analog)
  - 43-03-SUMMARY.md (IPC route map and IpcDeps typed for Wave 2 fields)
  - 43-04-SUMMARY.md (SpawnQueue, PluginRegistry, PluginBridgeAdapter, SelectingAdapter landed)
  - 43-01-SUMMARY.md (Wave 0 bug-043-dispatch-hold.test.ts RED anchor — this plan turns GREEN)
provides:
  - Hold-in-ready branch in assign-executor.ts recognising SelectingAdapter's `no-plugin-attached` sentinel (D-12)
  - `dispatch.held` EventType registered in src/schemas/event.ts
  - startAofDaemon wires SpawnQueue + PluginRegistry + PluginBridgeAdapter + SelectingAdapter and passes them into attachIpcRoutes (D-09/D-10)
  - deliverSpawnResult bridges IPC /v1/spawns/{id}/result → pluginBridgeAdapter.deliverResult → dispatch-pipeline callbacks
  - Operational startup log "daemon adapter configuration" with daemonMode + dryRun
affects:
  - Wave 3 plan 43-06 (plugin-side long-poll client consumes /v1/spawns/* routes that this plan makes operational)
  - Wave 3+ plan 43-07 (openclaw adapter thin-bridge restructure — pluginRegistry.hasActivePlugin() is true once spawn-poller attaches)
  - tests/integration/hold-no-plugin.test.ts (AOF_INTEGRATION=1 — turns GREEN once harness override provides daemon.mode="plugin-bridge")
tech-stack:
  added: []   # all runtime deps already in tree
  patterns:
    - "Hold-in-ready dispatch branch: sentinel error string → releaseLease + emit event, no retry/deadletter/blocked transition (mirrors platformLimit capacity-exhaustion flow at assign-executor.ts L196-227)"
    - "SelectingAdapter as daemon executor: primary (PluginBridgeAdapter) + fallback (StandaloneAdapter) + mode flag; dispatch-time routing via PluginRegistry probe"
    - "Wired IpcDeps.deliverSpawnResult as adapter-method binding (arrow function closes over pluginBridgeAdapter) — keeps route handler free of dispatch-pipeline knowledge"
key-files:
  created:
    - src/daemon/__tests__/daemon-selecting-adapter.test.ts
  modified:
    - src/dispatch/assign-executor.ts (hold-in-ready branch between platformLimit and classifySpawnError paths)
    - src/schemas/event.ts (dispatch.held enum entry)
    - src/daemon/daemon.ts (SelectingAdapter + SpawnQueue + PluginRegistry construction; attachIpcRoutes deps extended)
key-decisions:
  - "Literal `result.error === \"no-plugin-attached\"` match in assign-executor.ts rather than extending classifySpawnError with a third classification: keeps the change surgical per CLAUDE.md fragile dispatch chain guidance, and mirrors the existing platformLimit branch shape exactly."
  - "Placement of hold branch: BETWEEN platformLimit (L196-227) and classifySpawnError (~L229) — hold takes precedence over permanent/transient classification for this specific sentinel. Same relative position the platformLimit branch occupies for its error class."
  - "Added `dispatch.held` to the `EventType` enum: EventLogger.log() validates against this union at call sites in the same compile pass — surfacing any typo immediately. Without the enum entry, TypeScript would reject the logger.log() call."
  - "SelectingAdapter construction wrapped in opts.dryRun ternary: when dryRun=true we keep executor=undefined (same as prior behavior). The adapter components (spawnQueue, pluginRegistry, pluginBridgeAdapter) are constructed unconditionally because attachIpcRoutes references them even when dispatch is off (IPC routes serve non-spawn surfaces too)."
  - "Logged 'daemon adapter configuration' at info level with daemonMode + dryRun on startup for ops visibility. No secrets included."
patterns-established:
  - "Hold-in-ready dispatch: sentinel error → releaseLease + emit event → return {executed:false, failed:false}. Now has TWO in-tree implementations (platformLimit and no-plugin-attached); future capacity-signalling errors can follow this template."
  - "Daemon-side adapter wiring: construct all primitives (queue, registry, primary, fallback) up-front; wrap in a selector; pass the queue/registry/delivery into IPC routes. Single construction site, single teardown site."

requirements-completed:
  - D-10
  - D-12

# Metrics
duration: ~15min
completed: 2026-04-17
---

# Phase 43 Plan 05: Hold-in-Ready + SelectingAdapter Wiring Summary

**D-12 hold-in-ready branch added to assign-executor.ts (recognising SelectingAdapter's `no-plugin-attached` sentinel) and SelectingAdapter wired as the daemon's executor — Wave 0 bug-043-dispatch-hold.test.ts flipped RED → GREEN (6/6).**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-04-17
- **Tasks:** 2
- **Files modified:** 3 (assign-executor.ts, event.ts, daemon.ts)
- **Files created:** 1 (daemon-selecting-adapter.test.ts)

## Accomplishments

- Hold-in-ready branch in `assign-executor.ts` recognises `result.error === "no-plugin-attached"` from SelectingAdapter and handles it like the platformLimit capacity-exhaustion flow: release lease, emit `dispatch.held` event with `reason: "no-plugin-attached"`, return `{executed: false, failed: false}`. No retry increment, no deadletter, no blocked transition — task stays in `ready/`.
- `dispatch.held` registered in the `EventType` enum (`src/schemas/event.ts`).
- `startAofDaemon` constructs `SpawnQueue`, `PluginRegistry`, `PluginBridgeAdapter`, and `SelectingAdapter` (fronting `StandaloneAdapter` as fallback) in a single wiring block. `executor = new SelectingAdapter({ primary: pluginBridgeAdapter, fallback: standaloneAdapter, registry: pluginRegistry, mode: getConfig().daemon.mode })`.
- `attachIpcRoutes` now receives `spawnQueue`, `pluginRegistry`, and `deliverSpawnResult = (id, result) => pluginBridgeAdapter.deliverResult(id, result)` — the `/v1/spawns/wait` and `/v1/spawns/{id}/result` routes added in 43-04 become end-to-end operational.
- Wave 0 `bug-043-dispatch-hold.test.ts` (6 D-12 assertions) flipped RED → GREEN. New `daemon-selecting-adapter.test.ts` (4 assertions) passes. CLAUDE.md fragile dispatch chain constraint preserved — `scheduler.ts`, `task-dispatcher.ts`, `action-executor.ts`, `scheduler-helpers.ts` all untouched.

## Task Commits

1. **Task 1: Add hold-in-ready branch to assign-executor.ts** — `45b3f63` (feat)
2. **Task 2: Wire SelectingAdapter + SpawnQueue + PluginRegistry into startAofDaemon** — `f7b4529` (feat)

## Exact Diff Placement in assign-executor.ts

The new branch sits between the existing `platformLimit` branch (L196-227) and the `classifySpawnError` path. Unified diff shape:

```typescript
// ...platformLimit branch ends around L227 with:
        return { executed, failed };
      }

+     // Phase 43 D-12: no-plugin-attached → hold task in ready/, no retry increment.
+     // Mirrors the platformLimit branch above — release lease, leave in ready/, emit
+     // `dispatch.held`, neither count as executed nor failed.
+     if (result.error === "no-plugin-attached") {
+       log.info({ taskId: action.taskId, op: "hold" }, "holding task: no plugin attached");
+       try {
+         await releaseLease(store, action.taskId, action.agent!);
+       } catch (releaseErr) { ... }
+       try {
+         await logger.log("dispatch.held", "scheduler", {
+           taskId: action.taskId,
+           payload: { reason: "no-plugin-attached", agent: action.agent, correlationId },
+         });
+       } catch (logErr) { ... }
+       return { executed, failed };   // both false
+     }
+
      const errorClass = classifySpawnError(result.error ?? "unknown");
```

Ordering is load-bearing: the literal match runs before `classifySpawnError` so a "permanent"/"transient"/"rate_limited" classification never shadows the hold semantics.

## Daemon Startup Log Line

Ops visibility added in `startAofDaemon`:

```
{"level":30, "component":"daemon", "daemonMode":"plugin-bridge", "dryRun":false, "msg":"daemon adapter configuration"}
```

Logged after adapter construction, before `AOFService` start.

## Files Created/Modified

- `src/dispatch/assign-executor.ts` — new hold-in-ready branch (lines ~229-258, between platformLimit and classifySpawnError paths)
- `src/schemas/event.ts` — added `"dispatch.held"` to `EventType` enum
- `src/daemon/daemon.ts` — construct SpawnQueue/PluginRegistry/PluginBridgeAdapter/SelectingAdapter; pass spawnQueue/pluginRegistry/deliverSpawnResult into attachIpcRoutes; startup log line
- `src/daemon/__tests__/daemon-selecting-adapter.test.ts` — new — 4 tests: SelectingAdapter is the wired executor in plugin-bridge mode; plugin-bridge + no plugin → sentinel; standalone mode falls through to StandaloneAdapter (not sentinel); dryRun=true → executor undefined

## Decisions Made

- **Literal match over classifySpawnError extension** (CLAUDE.md fragile chain guidance): placed the `result.error === "no-plugin-attached"` check directly in `assign-executor.ts` rather than threading a third `"hold"` classification through `scheduler-helpers.ts::classifySpawnError`. Keeps scheduler-helpers.ts and the surrounding dispatch chain untouched — `git diff HEAD src/dispatch/scheduler.ts src/dispatch/task-dispatcher.ts src/dispatch/action-executor.ts src/dispatch/scheduler-helpers.ts` is empty.
- **Hold branch placement**: after platformLimit (so both capacity-exhaustion analogs are adjacent), before classifySpawnError (so the literal match wins over classification). Same shape as the platformLimit branch — releases lease via `releaseLease(...)`, emits event via `logger.log("dispatch.held", ...)`, returns `{ executed: false, failed: false }`.
- **Adapter components constructed unconditionally**, wrapped only the `SelectingAdapter` in the `opts.dryRun` ternary. Rationale: `attachIpcRoutes` needs `spawnQueue` and `pluginRegistry` regardless of dispatch mode (IPC still serves `/v1/tool/invoke`, session events, etc. in dryRun), and `pluginBridgeAdapter` owns the `deliverSpawnResult` map. Only the executor itself (which drives dispatch) is mode-gated.
- **Test reaches in via `service.schedulerConfig.executor`** — this is a private field of `AOFService`; we use a typed `as unknown as { schedulerConfig: { executor?: unknown } }` cast to inspect the wired adapter instance. This is the minimum-invasive assertion we could make without exposing the executor as a public getter. The alternative (add a public `getExecutor()` method) was rejected as API-surface creep for a single test.

## Deviations from Plan

None — plan executed exactly as specified.

The plan's `<action>` block sketched an additional `<behavior>` bullet ("Place the new branch BETWEEN the platformLimit branch and the existing `classifySpawnError` path"), which was honored verbatim. No deviations from rules 1-4.

## Issues Encountered

None — both tasks compiled and passed tests on first run after edits.

## CLAUDE.md Compliance

- `git diff HEAD~2 -- src/dispatch/scheduler.ts src/dispatch/task-dispatcher.ts src/dispatch/action-executor.ts src/dispatch/scheduler-helpers.ts` → empty (fragile dispatch chain untouched — only `assign-executor.ts` modified, per plan constraint).
- `grep -c 'process.env' src/dispatch/assign-executor.ts src/daemon/daemon.ts` → unchanged (no new env reads).
- `grep -c 'console\.' src/daemon/daemon.ts src/dispatch/assign-executor.ts` → 0 (new code uses `createLogger`-returned loggers only).
- `.js` import suffixes on all new imports in daemon.ts.
- `getConfig()` used for `daemon.mode` (no `process.env` read).

## Verification Evidence

**Typecheck:** `npm run typecheck` → clean.

**Critical tests (RED → GREEN):**
```
$ npx vitest run src/dispatch/__tests__/bug-043-dispatch-hold.test.ts
 Test Files  1 passed (1)
      Tests  6 passed (6)

$ npx vitest run src/daemon/__tests__/daemon-selecting-adapter.test.ts
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

**No regression in adjacent suites:**
```
$ npx vitest run src/daemon/__tests__/ src/dispatch/__tests__/ src/ipc/__tests__/
 Test Files  62 passed (62)
      Tests  736 passed (736)
```

**Full non-e2e suite:** 2942 passed. Three pre-existing failures (unrelated to this plan): `src/openclaw/__tests__/daemon-ipc-client.test.ts`, `src/openclaw/__tests__/event-forwarding.test.ts`, `src/packaging/migrations/__tests__/007-daemon-required.test.ts` — all Wave-0 RED anchors for subsequent plans (43-06 thin-bridge restructure, 43-0X migration). Confirmed identical failures present before this plan's commits.

**Acceptance-criteria grep checks (from PLAN):**

| Check | Expected | Actual |
|---|---|---|
| `grep -c 'result.error === "no-plugin-attached"' src/dispatch/assign-executor.ts` | ≥ 1 | 1 ✓ |
| `grep -c 'dispatch.held' src/dispatch/assign-executor.ts` | ≥ 1 | 2 ✓ |
| `grep -c '"no-plugin-attached"' src/dispatch/assign-executor.ts` | ≥ 2 | 2 ✓ (check + payload) |
| `grep -c 'op: "hold"' src/dispatch/assign-executor.ts` | ≥ 1 | 1 ✓ |
| `grep -c "new SelectingAdapter\|new PluginBridgeAdapter\|new SpawnQueue\|new PluginRegistry" src/daemon/daemon.ts` | ≥ 4 | 4 ✓ |
| `grep -c "getConfig().daemon.mode" src/daemon/daemon.ts` | ≥ 1 | 1 ✓ |
| `grep -c "pluginBridgeAdapter.deliverResult" src/daemon/daemon.ts` | ≥ 1 | 1 ✓ |

## Threat Flags

No new security-relevant surface beyond the PLAN `<threat_model>` register.

- T-43-mode-toggle (accept): honored — `daemon.mode` is same-uid-readable via `AOF_DAEMON_MODE` env; no new escalation path.
- T-43-held-task-starvation (accept): D-12 held tasks stay in `ready/` as designed; PROJECT.md "tasks never get dropped" upheld. Metrics wiring deferred to a follow-up per plan's threat model.
- T-43-fragile-chain (mitigate): enforced — fragile dispatch chain diff verified empty via `git diff HEAD~2 src/dispatch/{scheduler,task-dispatcher,action-executor,scheduler-helpers}.ts`. No changes to those files.

## Integration Test Status (AOF_INTEGRATION=1)

Not executed as part of this plan's unit-test cycle. `tests/integration/hold-no-plugin.test.ts` expects the harness to set `daemon.mode = "plugin-bridge"`; that override wiring in `startTestDaemon` is a separate concern (the harness currently inherits `AOFDaemonOptions` which doesn't include a daemon.mode flag — injection is via `resetConfig` or `AOF_DAEMON_MODE` env). The daemon-side behavior is proven by the new `daemon-selecting-adapter.test.ts` which uses `resetConfig({ daemon: { mode: "plugin-bridge" } })`. Wave 3+ plans (notably 43-06 plugin thin-bridge) will likely add the harness override and turn `hold-no-plugin.test.ts` GREEN end-to-end.

## TDD Gate Compliance

Task 1: Wave 0 RED anchor `bug-043-dispatch-hold.test.ts` existed from plan 43-01 (commit predates this plan). RED → GREEN gate observed: 6 failing tests before edit, 6 passing after. No new `test(...)` commit authored because the RED state was pre-landed.

Task 2: New `daemon-selecting-adapter.test.ts` authored alongside the implementation in the same commit. In a strict RED-then-GREEN sequence this would be two commits; the plan allowed test + impl together ("tdd=true" at task granularity, not file granularity). The pre-commit verification (`npx vitest run ... --reporter=default`) captured the 2-failing-2-passing RED state before the implementation — documented above in the `Verification Evidence` section.

## Next Plan Readiness

Wave 3 is now plumbed end-to-end on the daemon side:

- Plugins that open a `GET /v1/spawns/wait` long-poll are registered implicitly via `PluginRegistry.register(req, res)` (called from `handleSpawnWait` in 43-04).
- When `SelectingAdapter.spawnSession` sees `pluginRegistry.hasActivePlugin() === true`, it routes to `PluginBridgeAdapter` which enqueues on `SpawnQueue`.
- The long-poll handler picks the request from the queue and responds, the plugin runs the spawn, and posts back via `POST /v1/spawns/{id}/result` → `handleSpawnResult` → `deps.deliverSpawnResult(id, result)` → `pluginBridgeAdapter.deliverResult(id, result)` → fires `onRunComplete` → dispatch-pipeline callback.
- When no plugin is attached in `plugin-bridge` mode, `SelectingAdapter` returns the `"no-plugin-attached"` sentinel → `assign-executor.ts` hold branch → lease released, `dispatch.held` emitted, task stays in `ready/`.

Plan 43-06 (plugin thin-bridge + spawn-poller) is the next closing piece: a plugin-side `DaemonIpcClient.waitForSpawn()` that drives the long-poll, plus `OpenClawAdapter` running the spawn. That plan flips `tests/integration/long-poll-spawn.test.ts` GREEN.

## Self-Check: PASSED

- [x] `.planning/phases/43-thin-plugin-daemon-authority/43-05-SUMMARY.md` exists
- [x] `src/daemon/__tests__/daemon-selecting-adapter.test.ts` exists
- [x] Task 1 commit `45b3f63` present in `git log`
- [x] Task 2 commit `f7b4529` present in `git log`
- [x] `npm run typecheck` exits 0
- [x] `bug-043-dispatch-hold.test.ts` — 6/6 passing (flipped RED → GREEN)
- [x] `daemon-selecting-adapter.test.ts` — 4/4 passing
- [x] Fragile chain files unmodified: `git diff HEAD~2 src/dispatch/scheduler.ts src/dispatch/task-dispatcher.ts src/dispatch/action-executor.ts src/dispatch/scheduler-helpers.ts` → empty
- [x] `dispatch.held` registered in `EventType` enum
- [x] `'no-plugin-attached'` classifier branch present in `assign-executor.ts` (literal match, between platformLimit and classifySpawnError)
- [x] `actionsFailed` does NOT increment on hold (verified by bug-043 test "scheduler.poll reports hold as neither executed nor failed")
- [x] No modifications to STATE.md, ROADMAP.md, or REQUIREMENTS.md
- [x] 4 new constructions in daemon.ts: `new SpawnQueue`, `new PluginRegistry`, `new PluginBridgeAdapter`, `new SelectingAdapter`
- [x] `deliverSpawnResult: (id, result) => pluginBridgeAdapter.deliverResult(id, result)` wired into attachIpcRoutes

---
*Phase: 43-thin-plugin-daemon-authority*
*Completed: 2026-04-17*
