---
phase: 43
plan: 04
subsystem: ipc,dispatch
tags: [wave-2, long-poll, spawn-queue, plugin-registry, gateway-adapter, d-09, d-10, d-11, d-12]
requires:
  - 43-CONTEXT.md (D-09, D-10, D-11, D-12, D-13)
  - 43-RESEARCH.md §Long-Poll Protocol (L301-410), §Keepalive Calibration, §Pitfall 2 single-cleanup-path
  - 43-PATTERNS.md §spawn-queue.ts (L195), §plugin-registry.ts (L249), §spawn-wait.ts (L130), §plugin-bridge-adapter (L523), §selecting-adapter (L591)
  - 43-03-SUMMARY.md (IPC envelope schemas + server-attach route map landed Wave 1)
  - 43-01-SUMMARY.md (Wave 0 RED anchors that this wave turns GREEN)
provides:
  - SpawnQueue (FIFO pending/claimed with EventEmitter pub-sub) — D-09 dispatch primitive
  - PluginRegistry (implicit registration via long-poll presence, auto-release on res.close) — D-11
  - GET /v1/spawns/wait (25s keepalive → 204, atomic tryClaim race) — D-09 server side
  - POST /v1/spawns/{id}/result (path-regex routed, Zod envelope validation) — D-09 result post
  - PluginBridgeAdapter implementing GatewayAdapter — D-10 primary adapter
  - SelectingAdapter implementing GatewayAdapter — D-10 dispatch-time selection, D-12 hold sentinel
  - IpcDeps.spawnQueue / pluginRegistry / deliverSpawnResult(id, result) — typed for Wave 2 daemon wiring (43-05)
affects:
  - src/ipc/types.ts (typed the Wave 2 fields, refined `deliverSpawnResult` signature to `(id, result)`)
  - src/ipc/server-attach.ts (two new routes: `/v1/spawns/wait` exact + `/v1/spawns/{id}/result` regex)
  - Wave 2 plan 43-05 (will wire these pieces into `startAofDaemon` and add the hold branch in `assign-executor.ts`)
  - Wave 3 plan 43-06 (plugin-side `DaemonIpcClient.waitForSpawn` / `postSpawnResult` consume these routes)
tech-stack:
  added: []   # all runtime deps already in tree (node:events, node:crypto, node:http, zod, pino)
  patterns:
    - EventEmitter-based pub-sub queue with atomic tryClaim race
    - Long-poll HTTP handler with single-cleanup-path guard (`settled` flag across timer + listener + res.close)
    - Path-regex route dispatch alongside exact-URL route-map (patternRoutes[] in server-attach.ts)
    - Adapter selection at dispatch time via registry probe (vs static at construction time)
key-files:
  created:
    - src/ipc/spawn-queue.ts
    - src/ipc/plugin-registry.ts
    - src/ipc/routes/spawn-wait.ts
    - src/ipc/routes/spawn-result.ts
    - src/dispatch/plugin-bridge-adapter.ts
    - src/dispatch/selecting-adapter.ts
  modified:
    - src/ipc/types.ts
    - src/ipc/server-attach.ts
decisions:
  - "SpawnQueue FIFO insertion-order: `claim()` pops the oldest unclaimed request. This spreads backpressure evenly across multiple attached plugins and matches the test expectation (`first = queue.enqueue(...); queue.claim() === first`). PATTERNS.md called for this, implementation follows verbatim."
  - "Keepalive window 25_000 ms (server hold) vs 30_000 ms (client request timeout per RESEARCH.md L387). Integration tests (43-02 scaffolding) use 30s+ client timeout to survive the 25s server window."
  - "deliverResult signature (spawnId, result, taskId?) — test supplies taskId as 3rd arg, but the adapter already records taskId internally during spawnSession. When the arg is present it overrides; otherwise we fall back to the recorded taskId. This matches the Wave 0 RED test contract verbatim and also lets the route handler (which has no taskId) work with a 2-arg `deliverSpawnResult(id, result)` — the adapter fills in taskId from its own pending map."
  - "callbackDepth sourced from `context.metadata?.callbackDepth` — CLAUDE.md forbids new `process.env` reads in core modules. The envelope (D-06 extension to SpawnRequest) carries it through IPC; this is the fix for the `AOF_CALLBACK_DEPTH` env mutation that remains only in the legacy in-process path."
  - "PluginBridgeAdapter returns D-12 sentinel when `!registry.hasActivePlugin()` — defense-in-depth behind SelectingAdapter. Both adapters enforce the invariant so bypass-through-direct-adapter-use doesn't silently enqueue on a queue with no consumer."
  - "SelectingAdapter standalone + plugin-attached → prefers primary (plugin-overrides). Test `D-10 standalone + active plugin → prefers primary` encodes this. Users in standalone install who attach a plugin post-hoc get plugin dispatch without reconfiguring."
  - "patternRoutes[] array in server-attach.ts: exact-URL matches in the `routes` Record are tried first for O(1) lookup; parametric paths fall through to a sequential regex scan. Only one pattern route this wave (`/v1/spawns/{id}/result`); pattern is O(k) which is fine for small k."
metrics:
  tasks_total: 2
  tasks_completed: 2
  files_created: 6
  files_modified: 2
  commits: 2
  duration_seconds: ~180
  completed: 2026-04-17
---

# Phase 43 Plan 04: Long-Poll Infrastructure + Dispatch Adapters Summary

Wave 2 part 1 landed. The daemon can now hold spawn requests in an in-memory FIFO queue, deliver them to long-polling plugins via `GET /v1/spawns/wait` (25s keepalive → 204), and receive outcomes via `POST /v1/spawns/{id}/result`. On the dispatch side, `PluginBridgeAdapter` implements `GatewayAdapter` by enqueueing `SpawnRequest`s and exposing `deliverResult()` for the IPC route to fire `onRunComplete` callbacks. `SelectingAdapter` routes between primary (plugin-bridge) and fallback (standalone) based on `PluginRegistry.hasActivePlugin()`, returning the D-12 `"no-plugin-attached"` sentinel in plugin-bridge mode when no plugin is attached.

The four Wave 0 RED anchors for queue + registry + both adapters (26 tests total) flipped GREEN in this plan. The bug-043 hold-branch tests remain RED — those close in plan 43-05 when `assign-executor.ts` gains the hold branch that recognises the sentinel.

## Tasks Completed

| Task | Name | Commit    |
|------|------|-----------|
| 1    | SpawnQueue + PluginRegistry + long-poll routes (wait/result) + server-attach extension | `672be1c` |
| 2    | PluginBridgeAdapter + SelectingAdapter (both implement GatewayAdapter) | `96139df` |

## GREEN-State Evidence

```
npx vitest run \
  src/ipc/__tests__/spawn-queue.test.ts \
  src/ipc/__tests__/plugin-registry.test.ts \
  src/dispatch/__tests__/plugin-bridge-adapter.test.ts \
  src/dispatch/__tests__/selecting-adapter.test.ts

 Test Files  4 passed (4)
      Tests  26 passed (26)
   Duration  379ms
```

| Test file | Previous state | Current state |
|-----------|----------------|---------------|
| `src/ipc/__tests__/spawn-queue.test.ts` | RED: `Cannot find module '../spawn-queue.js'` | GREEN: 7/7 |
| `src/ipc/__tests__/plugin-registry.test.ts` | RED: `Cannot find module '../plugin-registry.js'` | GREEN: 7/7 |
| `src/dispatch/__tests__/plugin-bridge-adapter.test.ts` | RED: `Cannot find module '../plugin-bridge-adapter.js'` | GREEN: 5/5 |
| `src/dispatch/__tests__/selecting-adapter.test.ts` | RED: `Cannot find module '../selecting-adapter.js'` | GREEN: 7/7 |

## Exact Routes Mounted on daemon.sock (Wave 2 additions)

| Method | Path                               | Handler            | Status |
|--------|------------------------------------|--------------------|--------|
| GET    | `/v1/spawns/wait`                  | `handleSpawnWait`  | live (this plan) |
| POST   | `/v1/spawns/{id}/result`           | `handleSpawnResult`| live (this plan) |

Routes from 43-03 (invoke-tool + four session events) remain mounted and untouched. `/healthz` and `/status` are unaffected.

## How `deliverSpawnResult` is Wired into IpcDeps

`IpcDeps.deliverSpawnResult` has signature `(id: string, result: SpawnResultPost) => Promise<void>`. The adapter owns the `spawnId → { taskId, onRunComplete }` map so the route handler stays free of dispatch-pipeline bookkeeping.

In plan 43-05 `src/daemon/daemon.ts` will construct the wiring like:

```ts
const pluginBridgeAdapter = new PluginBridgeAdapter(spawnQueue, pluginRegistry);
// ...
attachIpcRoutes(server, {
  // ...other deps
  spawnQueue,
  pluginRegistry,
  deliverSpawnResult: (id, result) => pluginBridgeAdapter.deliverResult(id, result),
});
```

The test-level 3-arg call `adapter.deliverResult(spawnId, result, taskId)` remains supported — the optional taskId argument overrides the internal lookup when the caller knows it (useful for tests and future routes that carry taskId explicitly).

## Semantics Decisions

**SpawnQueue FIFO:** `claim()` iterates the pending `Map` in insertion order and returns the first unclaimed entry. `Map` preserves insertion order by spec; the test asserts `first === sr` after a single enqueue, and the 50-cycle Pitfall 2 test verifies listener hygiene.

**Keepalive 25s server / 30s client:** The long-poll handler holds the response open for 25_000ms before emitting 204. Clients (plugin-side `DaemonIpcClient`) use a 30s `AbortSignal.timeout` so the request doesn't abort a valid hold. Both values are documented in module docstrings so future tweaks stay in sync.

**Implicit plugin registration (D-11):** The `PluginRegistry.register(req, res)` call sits at the top of `handleSpawnWait` — a connected long-poll IS a registered plugin. `res.on("close")` auto-releases the handle when the plugin drops (gateway restart, network blip). This is the single cleanup path called out in RESEARCH.md Pitfall 2; there is no separate register/unregister handshake.

**Single-cleanup-path guard (`settled` flag):** `handleSpawnWait` races three outcomes (claim-on-enqueue, keepalive timeout, connection drop). A single `settled: boolean` guards each path; every one calls the same `cleanup()` (clear timer + remove listener). This is the hardest-to-get-right part of long-poll handlers in Node, and the integration test scaffolding (43-02) includes a 50-drops-leave-zero-listeners regression guard that lands here.

**D-12 sentinel defense-in-depth:** Both `SelectingAdapter` and `PluginBridgeAdapter` return `{ success: false, error: "no-plugin-attached" }` when no plugin is attached. The selector is the primary check (saves the queue enqueue/map entry); the bridge is a safety net for code paths that go direct to the primary adapter (e.g. test suites, future admin UI that talks to the adapter).

**Adapter selection routing for status/force-complete:** `getSessionStatus` / `forceCompleteSession` route by current plugin attachment rather than remembering which adapter handled the spawn. If a plugin disconnects mid-run, subsequent status calls fall through to the fallback. For this wave we accept the behaviour — per-session sticky routing is deferred to Wave 3 if telemetry shows it matters.

## Deviations from Plan

### Implementation-signature refinement (not a bug)

**`deliverResult(spawnId, result, taskId?)` keeps the optional 3rd arg** even though the PLAN spec `<behavior>` section sketches a 2-arg signature. Rationale: the Wave 0 RED test (`src/dispatch/__tests__/plugin-bridge-adapter.test.ts` line 104-113) passes taskId as 3rd arg and asserts it flows into the `AgentRunOutcome`. Keeping the optional parameter lets both callers work — the IPC route (which only knows `id`) uses 2-arg, and direct callers that know taskId use 3-arg. This was anticipated by the PLAN `<action>` block which provides the route-side `deliverSpawnResult(id, result)` wiring.

No other deviations. Implementation follows PATTERNS.md sketches plus the plan's explicit `<action>` bodies.

## Auto-fixed Issues

None. The plan compiled and passed tests on first run.

## Auth Gates

None encountered — plan is pure local implementation.

## CLAUDE.md Compliance

- `grep -rc "console\\." src/ipc/spawn-queue.ts src/ipc/plugin-registry.ts src/ipc/routes/spawn-wait.ts src/ipc/routes/spawn-result.ts src/dispatch/plugin-bridge-adapter.ts src/dispatch/selecting-adapter.ts` → 0 ✓
- `grep -rc "process\\.env" src/ipc/ src/dispatch/plugin-bridge-adapter.ts src/dispatch/selecting-adapter.ts` → 0 ✓ (AOF_CALLBACK_DEPTH exception preserved in legacy callback-delivery.ts only)
- `createLogger("component")` used (spawn-queue, plugin-registry, plugin-bridge-adapter, selecting-adapter) ✓
- `.js` import suffixes throughout ✓
- `const Foo = z.object({...}) + type Foo = z.infer<...>` for envelopes (inherited from schemas.ts Wave 1) ✓
- `ITaskStore` not touched — IPC module remains leaf (imports from logging/, schemas/, store/, tools/, events/, service/, context/, config/, permissions/; nothing above) ✓
- `npx madge --circular --extensions ts src/` → no circular dependencies (559 files, 0 cycles) ✓

## Verification Evidence

**Typecheck:** `npm run typecheck` → clean (0 errors).

**Circular deps:** `npx madge --circular --extensions ts src/dispatch/ src/ipc/` → 0 (188 files scanned; full-tree scan also 0/559).

**Targeted tests (4 Wave 0 files):**
```
Test Files  4 passed (4)
Tests  26 passed (26)
Duration  379ms
```

**Broader ipc/dispatch run (630+ tests):** 628 passed; 6 pre-existing failures in `src/dispatch/__tests__/bug-043-dispatch-hold.test.ts` (Wave 0 RED anchor for the hold branch that plan 43-05 turns GREEN in `assign-executor.ts`). These are expected RED and out of scope for this plan.

## Threat Flags

No new security-relevant surface beyond the PLAN `<threat_model>` register.

- T-43-04 (replay on result post): mitigated as specified — pending map entry deleted on first delivery, replay finds no entry and is ignored. Warn-logged for observability.
- T-43-06 (DoS concurrent long-polls): mitigated via `res.on("close")` auto-release; `PluginRegistry.activeCount()` is exposed for a future per-plugin cap.
- T-43-leak-listeners: mitigated via the single-cleanup-path `settled` guard in `handleSpawnWait`. Enforced by the 7th spawn-queue test (50 enqueue/off cycles → 0 listeners).
- T-43-queue-starvation: accepted by design (D-12 held tasks persist in `ready/`; queue only grows when dispatch is actively happening).

## TDD Gate Compliance

This plan is `type=execute` with `tdd="true"` per-task. The Wave 0 RED tests existed from plan 43-01 before any implementation landed. Both tasks followed the RED → GREEN gate order:

- Task 1: RED anchors (spawn-queue.test, plugin-registry.test) were already RED → implementation landed → GREEN in 7/7 + 7/7.
- Task 2: RED anchors (plugin-bridge-adapter.test, selecting-adapter.test) were already RED → implementation landed → GREEN in 5/5 + 7/7.

No intermediate RED commit was authored in 43-04 because the RED state was pre-landed in 43-01.

## Commits

| Task | Commit    | Message                                                                                       |
|------|-----------|-----------------------------------------------------------------------------------------------|
| 1    | `672be1c` | feat(43-04): long-poll spawn queue + plugin registry + wait/result routes (D-09/D-11)         |
| 2    | `96139df` | feat(43-04): PluginBridgeAdapter + SelectingAdapter (D-10)                                    |

## Self-Check: PASSED

- [x] `src/ipc/spawn-queue.ts` exists
- [x] `src/ipc/plugin-registry.ts` exists
- [x] `src/ipc/routes/spawn-wait.ts` exists
- [x] `src/ipc/routes/spawn-result.ts` exists
- [x] `src/dispatch/plugin-bridge-adapter.ts` exists
- [x] `src/dispatch/selecting-adapter.ts` exists
- [x] Commit `672be1c` present in `git log`
- [x] Commit `96139df` present in `git log`
- [x] `npm run typecheck` exits 0
- [x] All 4 critical Wave 0 test files pass (26/26)
- [x] `grep -c "/v1/spawns" src/ipc/server-attach.ts` → 2 (wait exact + result regex pattern)
- [x] No `console.*` in any new file
- [x] No `process.env` reads in any new file
- [x] No new circular dependencies
- [x] No modifications to `src/dispatch/scheduler.ts | task-dispatcher.ts | action-executor.ts` (Fragile module boundary preserved)
