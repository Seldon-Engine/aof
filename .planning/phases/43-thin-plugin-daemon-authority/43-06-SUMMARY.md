---
phase: 43-thin-plugin-daemon-authority
plan: 06
subsystem: ipc
tags: [unix-socket, long-poll, daemon-ipc-client, spawn-poller, plugin-bridge, node-http]

requires:
  - phase: 43-thin-plugin-daemon-authority
    provides: "43-01 Wave 0 RED tests (daemon-ipc-client.test.ts), 43-03 /v1/tool/invoke + IPC schemas, 43-04 spawn-queue + /v1/spawns/wait + plugin-registry"
provides:
  - "src/openclaw/daemon-ipc-client.ts — DaemonIpcClient class over node:http Unix socket (8 methods: invokeTool, waitForSpawn, postSpawnResult, postSessionEnd, postAgentEnd, postBeforeCompaction, postMessageReceived, selfCheck)"
  - "ensureDaemonIpcClient module-scope singleton (Pitfall 3 — survives OpenClaw per-session plugin reload)"
  - "runAgentFromSpawnRequest(api, sr) — standalone async entry point for executing a SpawnRequest through runEmbeddedPiAgent and returning a SpawnResultPost"
  - "src/openclaw/spawn-poller.ts — startSpawnPollerOnce long-poll loop + idempotency gate + exponential backoff on socket errors"
affects: [43-07-adapter-thin-bridge, 43-08-migration, 43-wave-4]

tech-stack:
  added: []
  patterns:
    - "Unix-socket HTTP client via node:http request({ socketPath }) — replaces fetch to avoid AbortSignal.timeout fragility over Unix sockets (Pitfall 4)"
    - "Module-scope singleton guard (ensureDaemonIpcClient / spawnPollerStarted) as the successor to the legacy schedulerService pattern for surviving OpenClaw plugin reloads"
    - "Fire-and-forget spawn dispatch: long-poll loop kicks off agent execution with void and reconnects for the next request, posting results asynchronously"

key-files:
  created:
    - "src/openclaw/daemon-ipc-client.ts"
    - "src/openclaw/spawn-poller.ts"
    - "src/openclaw/__tests__/spawn-poller.test.ts"
  modified:
    - "src/openclaw/openclaw-executor.ts"

key-decisions:
  - "OpenClawAdapter strategy: Option 3 (standalone function extraction) chosen — runAgentFromSpawnRequest is a top-level async fn alongside OpenClawAdapter; shared private helpers prepareEmbeddedRun + executeEmbeddedRun handle validation and execution for both paths"
  - "OpenClawAdapter class retained intact and delegates to the same shared helpers — 19 existing adapter tests remain GREEN with no behavioural change, so standalone/legacy call-sites keep working while 43-07 migrates the plugin"
  - "invokeTool returns the parsed { result } | { error } envelope even on daemon 5xx responses so IpcErrorKind values reach the caller — only genuine transport faults (non-JSON body, socket gone, timeout) reject"
  - "Spawn-poller waitForSpawn timeout = 35_000ms (server 25s keepalive + 5s grace + 5s buffer) so the daemon's 204 keepalive always fires before the client-side socket timeout"

patterns-established:
  - "Plugin-side IPC over daemon.sock uses node:http, never fetch — Pitfall 4 is now a load-bearing convention captured in DaemonIpcClient, propagating to every future plugin"
  - "Module-scope singletons survive OpenClaw's per-session plugin reload — ensureDaemonIpcClient and spawnPollerStarted demonstrate the pattern, replacing the old schedulerService"
  - "SpawnRequest-driven agent execution: runAgentFromSpawnRequest awaits the full run and returns a SpawnResultPost; fire-and-forget semantics live in the poller, not the executor"

requirements-completed: [D-05, D-06, D-07, D-09]

duration: 7min
completed: 2026-04-17
---

# Phase 43 Plan 06: Plugin-side DaemonIpcClient + spawn-poller Summary

**Plugin-side Unix-socket IPC client (8 methods over node:http) and idempotent long-poll spawn-poller that dispatches SpawnRequests through a newly-factored runAgentFromSpawnRequest, unlocking the daemon-authority inversion for 43-07.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-04-17T18:25:33Z
- **Completed:** 2026-04-17T18:32:52Z
- **Tasks:** 2
- **Files modified:** 1
- **Files created:** 3

## Accomplishments

- `DaemonIpcClient` implements all 8 Phase-43 IPC endpoints (invokeTool, waitForSpawn, postSpawnResult, 4 session-event forwards, selfCheck) over `node:http` `request({ socketPath })` — never `fetch` (Pitfall 4). Turns the Wave 0 RED test `daemon-ipc-client.test.ts` GREEN.
- `ensureDaemonIpcClient` singleton keyed by socketPath survives OpenClaw's per-session plugin reload — the same survival trick the legacy `schedulerService` relies on, pre-refactor.
- `runAgentFromSpawnRequest` extracted as a standalone async entry point inside `openclaw-executor.ts`; awaits the full embedded agent run and returns a `SpawnResultPost`. `OpenClawAdapter` stays intact — 19 existing tests + 4 platform-limit tests all still pass.
- `spawn-poller` runs the long-poll loop with `startSpawnPollerOnce` (idempotent module-scope gate), reconnects immediately on 204 keepalive, applies bounded exponential backoff (1s → 30s cap) on socket errors, and synthesizes a `kind: "exception"` SpawnResultPost when the handler throws so the daemon lease can reclaim cleanly.

## Task Commits

1. **Task 1: DaemonIpcClient + ensureDaemonIpcClient singleton** — `1e39708` (feat)
2. **Task 2 RED: spawn-poller tests (idempotency, keepalive, backoff, exception posting)** — `f6c95ef` (test)
3. **Task 2 GREEN: spawn-poller loop + runAgentFromSpawnRequest refactor** — `9f9ecd4` (feat)

## Files Created/Modified

- `src/openclaw/daemon-ipc-client.ts` — NEW. 283 lines. DaemonIpcClient class with 8 public methods + module singleton (`ensureDaemonIpcClient`, `resetDaemonIpcClient`). All requests use `node:http` with `{ socketPath, path, method, timeout }`. `invokeTool` parses the InvokeToolResponse envelope from any status so daemon error-kinds propagate; `waitForSpawn` returns `undefined` on HTTP 204 and parsed SpawnRequest on 200.
- `src/openclaw/spawn-poller.ts` — NEW. 131 lines. Module-scope `spawnPollerStarted` gate; `startSpawnPollerOnce(client, api)` kicks off `runLoop` via `void …catch(…)`; loop uses 35s `waitForSpawn` timeout, fire-and-forget `runAgentFromSpawnRequest` dispatch, immediate reconnect on 204, exponential backoff 1s → 30s on socket errors.
- `src/openclaw/__tests__/spawn-poller.test.ts` — NEW. 5 tests covering: happy path dispatch, 204 keepalive no-op, idempotent second start, handler-throws exception post, and backoff-after-error recovery. Mocks `runAgentFromSpawnRequest` + a synthetic `DaemonIpcClient` with a scripted wait-queue.
- `src/openclaw/openclaw-executor.ts` — MODIFIED. Refactored around two private helpers (`prepareEmbeddedRun`, `executeEmbeddedRun`) shared by `OpenClawAdapter.spawnSession` (fire-and-forget) and the new `runAgentFromSpawnRequest` (awaits completion). Behaviour preserved — all 19 executor tests pass.

## Decisions Made

**OpenClawAdapter strategy: Option 3 (standalone function extraction).** The plan listed three options. Picked Option 3 because:
- `OpenClawAdapter` has one heavyweight constructor dependency (`ITaskStore`) that the plugin will shed in 43-07 but is still in use by the existing dispatch stack and tests. Keeping the class intact with a `store?` argument and running both call-sites through shared private helpers means zero churn for legacy callers and 19 existing tests stay GREEN verbatim.
- Option 1 (constructor overload with `undefined` store) would have left the adapter half-initialized in the plugin path — brittle.
- Option 2 (no-op stub store) adds a dead type that never gets used once 43-07 removes the adapter from the plugin.
- Option 3 lets us remove OpenClawAdapter from the plugin's import graph in 43-07 without regressing the standalone dispatch tests that still construct it directly.

**OpenClawAdapter class kept (not removed or shrunk).** 43-06 is explicitly side-channel work; 43-07 owns the thin-bridge restructure of `adapter.ts`. Removing OpenClawAdapter now would break the in-process dispatch path before the IPC path is wired, violating the "never have both simultaneously broken" rule that motivates the phase's wave structure.

**Backoff schedule on repeated socket errors.** `runLoop` starts at `INITIAL_BACKOFF_MS = 1_000`; each consecutive error doubles with `Math.min(backoffMs * 2, 30_000)`. So the sequence is 1s → 2s → 4s → 8s → 16s → 30s → 30s … On every success (whether a 200 SpawnRequest or a 204 keepalive) the backoff resets to 1s. This matches the Research §Long-Poll Protocol recommendation (lines 502-504) and provides graceful recovery when the daemon restarts mid-poll: the plugin reconnects within 30s at worst regardless of how long the daemon was down.

**invokeTool on non-2xx responses.** The test file's "503 on daemon overload" case asserts that the plugin resolves with `{ error: { kind: "unavailable" } }` rather than throwing. Rationale: daemon error envelopes carry structured `IpcErrorKind` metadata that callers need to classify the failure (validation vs permission vs unavailable). Throwing would collapse all of that into a single string. Only transport-level faults (non-JSON body, socket EOF, timeout) reject — those are genuine programmer errors, not contract-level failures.

## Deviations from Plan

None — plan executed exactly as written. Task 1's plan code sample was followed essentially verbatim (with added doc comments and factoring of `postRaw`/`getRaw` for reuse). Task 2's refactor used the planner's recommended Option 3.

One minor clarification not a deviation: the plan's sketch used `postJson<TReq, TRes>` returning parsed JSON directly, but the test for 503 responses requires the client to return the parsed error envelope rather than throw on non-2xx. The implementation uses `postRaw` (returns `{ statusCode, body }`) as the primitive, then `invokeTool` specifically parses the envelope via `InvokeToolResponse.safeParse`. All other methods (`postSpawnResult`, `postSessionEnd`, etc.) still `requireSuccess` on non-2xx because they return `void` and have no envelope to carry structured errors.

## Issues Encountered

None. Both RED tests flipped cleanly to GREEN on first implementation pass. Typecheck clean. No downstream test regressions traced to this plan (the failing `event-forwarding.test.ts` is the Wave 0 RED anchor expected to stay red until 43-07 rewires `adapter.ts`).

## Self-Check: PASSED

- `src/openclaw/daemon-ipc-client.ts` — EXISTS ✓
- `src/openclaw/spawn-poller.ts` — EXISTS ✓
- `src/openclaw/__tests__/spawn-poller.test.ts` — EXISTS ✓
- Commits present: `1e39708` ✓, `f6c95ef` ✓, `9f9ecd4` ✓
- Acceptance greps:
  - `ensureDaemonIpcClient`: 3 occurrences ✓ (≥1 required)
  - `resetDaemonIpcClient`: 1 occurrence ✓ (≥1 required)
  - `fetch(` in daemon-ipc-client.ts: 0 ✓ (required 0)
  - `httpRequest|http.request`: 5 occurrences ✓ (≥1 required)
  - 8 async methods in daemon-ipc-client.ts: 8 occurrences ✓ (≥8 required)
  - `createLogger` in daemon-ipc-client.ts: 2 occurrences ✓ (≥1 required)
  - `process.env|console.` in daemon-ipc-client.ts: 0 ✓ (required 0)
  - `spawnPollerStarted` in spawn-poller.ts: 8 occurrences ✓ (≥2 required)
  - `waitForSpawn|postSpawnResult` in spawn-poller.ts: 6 occurrences ✓ (≥2 required)
  - `runAgentFromSpawnRequest` in spawn-poller.ts: 3 occurrences ✓ (≥1 required)
  - `backoffMs.*Math.min` in spawn-poller.ts: 1 occurrence ✓ (≥1 required)
  - `export.*runAgentFromSpawnRequest` in openclaw-executor.ts: 1 occurrence ✓ (≥1 required)
- Test results:
  - `src/openclaw/__tests__/daemon-ipc-client.test.ts` — 8/8 GREEN (was Wave 0 RED)
  - `src/openclaw/__tests__/spawn-poller.test.ts` — 5/5 GREEN
  - `src/openclaw/__tests__/executor.test.ts` — 19/19 GREEN (no regression from refactor)
  - `src/openclaw/__tests__/openclaw-executor-platform-limit.test.ts` — 4/4 GREEN
  - `src/ipc/__tests__/` full suite — 39/39 GREEN
  - `src/dispatch/__tests__/{plugin-bridge-adapter,selecting-adapter}.test.ts` — GREEN
- `npm run typecheck` — clean

## Next Phase Readiness

43-07 can now remove `schedulerService` from `src/openclaw/adapter.ts` and replace its `registerAofPlugin` body with:
1. `const client = ensureDaemonIpcClient({ socketPath: daemonSocketPath(opts.dataDir) })` — readiness probe via `client.selfCheck()` with bounded retry.
2. Tool-registry loop → thin IPC proxy calling `client.invokeTool(envelope)` with the captured `toolCallId` + `correlationId` (and `mergeDispatchNotificationRecipient` pre-send for `aof_dispatch`).
3. `startSpawnPollerOnce(client, api)` — spawn-poller kicks off, idempotent across plugin reloads.
4. Selective event forwarding via `client.postSessionEnd`, `postAgentEnd`, `postBeforeCompaction`, `postMessageReceived` (D-07 A1-amended).

`event-forwarding.test.ts` (Wave 0 RED) stays red until 43-07 wires the event hooks through. Other side channels (IPC schemas, daemon routes, plugin-registry, spawn-queue, PluginBridgeAdapter, SelectingAdapter) are already in place from 43-03 and 43-04, so the main-channel rewrite has everything it needs.

No new blockers. No CLAUDE.md violations (no `process.env` outside the allowed `AOF_CALLBACK_DEPTH` reference; all logging via `createLogger`; `node:http` used per Pitfall 4).

---
*Phase: 43-thin-plugin-daemon-authority*
*Completed: 2026-04-17*
