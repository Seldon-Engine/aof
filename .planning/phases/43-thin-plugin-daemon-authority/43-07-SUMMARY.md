---
phase: 43-thin-plugin-daemon-authority
plan: 07
subsystem: openclaw
tags: [thin-bridge, daemon-authority, ipc, d-02, d-06, d-07, unix-socket, tool-registry]

requires:
  - phase: 43-thin-plugin-daemon-authority
    provides: "43-01 event-forwarding.test.ts RED anchor, 43-03 /v1/tool/invoke + /v1/event/* routes on daemon.sock, 43-04 spawn-queue + /v1/spawns/wait + PluginBridgeAdapter + SelectingAdapter, 43-05 SelectingAdapter wiring in startAofDaemon + hold-in-ready branch, 43-06 DaemonIpcClient + spawn-poller + runAgentFromSpawnRequest"
provides:
  - "src/openclaw/adapter.ts — thin IPC bridge, 145 lines (down from 393). Gutted: AOFService construction, schedulerService singleton, FilesystemTaskStore/EventLogger/AOFMetrics/NotificationPolicyEngine/ConsoleNotifier/MatrixNotifier/OpenClawChatDeliveryNotifier, resolveAdapter/OpenClawAdapter/MockAdapter, loadOrgChart/PermissionAwareTaskStore/withPermissions, resolveProjectStore/createProjectStore, api.registerService, inline aof_project_* registrations."
  - "registerAofPlugin returns { mode: 'thin-bridge', daemonSocketPath } rather than an AOFService instance — the daemon owns the scheduler now."
  - "7 OpenClaw hooks wired per D-07 + A1: 4 forwarded (session_end, agent_end, before_compaction, message_received) via DaemonIpcClient.post*, 3 local-only (message_sent, before_tool_call, after_tool_call) updating the in-plugin OpenClawToolInvocationContextStore."
  - "Tool-registry loop → IPC proxy via client.invokeTool with full D-06 envelope (pluginId, correlationId from randomUUID, toolCallId, callbackDepth)."
  - "src/openclaw/status-proxy.ts — GatewayHandler that proxies /aof/status + /aof/metrics to daemon /status over the Unix socket (Open Q4 resolution)."
  - "src/openclaw/dispatch-notification.ts — extracted mergeDispatchNotificationRecipient helper (plugin-local pre-IPC transform for aof_dispatch)."
  - "src/tools/project-management-tools.ts + tool-registry entries — aof_project_create / _list / _add_participant moved into the shared registry (Open Q2 resolution)."
  - "parseCallbackDepth function — IPC envelope is source of truth (D-06); process.env.AOF_CALLBACK_DEPTH fallback only for subscriber-triggered re-dispatch paths (CLAUDE.md §Fragile documented cross-process env exception)."

affects: [43-08-migration, 43-09-wrap-up, future-plugin-plans]

tech-stack:
  added: []
  patterns:
    - "Thin-bridge plugin architecture: plugin holds DaemonIpcClient + OpenClawToolInvocationContextStore; every state mutation goes through the daemon over /v1/tool/invoke (D-06)"
    - "Selective event forwarding: 4 hooks whose handlers mutate daemon-owned state cross IPC; 3 high-frequency capture-only hooks stay local (D-07 A1)"
    - "Gateway HTTP routes as thin IPC proxies: /aof/status + /aof/metrics forward to daemon /status over the same Unix socket, preserving the pre-Phase-43 URL contract without duplicating state in the plugin"
    - "Shared tool-registry as the single tool dispatch surface: adapter.ts registers ALL tools from toolRegistry with a uniform IPC-proxy execute closure; no adapter-specific api.registerTool blocks"

key-files:
  created:
    - "src/openclaw/status-proxy.ts"
    - "src/openclaw/dispatch-notification.ts"
    - "src/tools/project-management-tools.ts"
    - "src/tools/__tests__/project-management-tools.test.ts"
  modified:
    - "src/openclaw/adapter.ts (393 → 145 lines)"
    - "src/plugin.ts (return-type shift — no more AOFService)"
    - "src/tools/tool-registry.ts (+3 project-management entries)"
    - "src/openclaw/__tests__/adapter.test.ts (rewritten for thin-bridge shape)"
    - "src/openclaw/__tests__/plugin.unit.test.ts (updated expectations — no serviceIds entry)"
    - "src/openclaw/__tests__/event-forwarding.test.ts (two test-side bug fixes + afterEach cleanup)"

key-decisions:
  - "Open Q2 (project tools routing): moved aof_project_create / _list / _add_participant into the shared tool-registry (Phase 43-RESEARCH.md §Open Q2 recommendation). Every tool now dispatches through the single /v1/tool/invoke envelope; the daemon is the single writer for project filesystem mutations too."
  - "Open Q4 (/aof/status + /aof/metrics): kept as thin IPC proxies (not dropped). Both gateway URLs now hit daemon /status via node:http Unix-socket request and return the payload verbatim. Preserves pre-Phase-43 URL compatibility for external dashboards/scripts at the cost of ~50 lines in status-proxy.ts."
  - "parseCallbackDepth shape: IPC envelope is the source of truth; process.env.AOF_CALLBACK_DEPTH is a fallback guarded behind the envelope check so it only matters inside the legitimate callback-delivery re-dispatch cycle. CLAUDE.md §Fragile — Tread Carefully documented this as the single permitted cross-process env exception; no new process.env reads were added anywhere in adapter.ts, status-proxy.ts, dispatch-notification.ts, or project-management-tools.ts."
  - "Factored status-proxy and dispatch-notification into sibling files rather than inlining them in adapter.ts to hit the <150-line acceptance criterion while keeping adapter.ts strictly the composition seam (IPC client + hooks + tool loop + poller startup). Both sibling files are mechanical helpers with no hidden state."
  - "Rewrote adapter.test.ts to test the thin-bridge contract (D-02 invariant + invokeTool envelope shape + merge transform + error surfacing + 7-hook fan-out) instead of the legacy in-plugin AOFService path. Legacy tests (creates-openclaw-chat-subscription, project-scoped-dispatch, auto-captures-sessionKey, etc.) were assertions about in-plugin state that has moved to the daemon — daemon-side equivalents live in src/daemon/__tests__/ipc-integration.test.ts and the individual tool handler tests (src/tools/__tests__/*)."

patterns-established:
  - "Test afterEach cleanup for module-level singletons: any test that exercises registerAofPlugin must call stopSpawnPoller() + resetDaemonIpcClient() in afterEach so the module-scope poller gate doesn't carry a parked loop into the next test."
  - "Never-resolving waitForSpawn mocks: tests that don't care about spawn handling pass a mock client whose waitForSpawn returns `new Promise(() => {})` so the long-poll loop parks on await without spamming logs; afterEach's stopSpawnPoller flips the gate and the parked loop exits on the next tick."
  - "Thin-bridge AOFPluginOptions shape: post-43, only dataDir + the legacy config-passing fields (pollIntervalMs / defaultLeaseTtlMs / maxConcurrentDispatches / dryRun) are production-facing; daemonIpcClient + invocationContextStore exist purely as test-injection seams. No store/logger/metrics/service/orgChartPath/projectStores fields."

requirements-completed: [D-02, D-06, D-07]

duration: 17min
completed: 2026-04-17
---

# Phase 43 Plan 07: Thin-plugin daemon-authority — adapter restructure Summary

**Gutted `src/openclaw/adapter.ts` (393 → 145 lines) into a thin IPC bridge: no more AOFService / schedulerService singleton / store construction / permission layer / HTTP route handlers in the plugin; 4 forwarded + 3 local hooks wired per D-07 A1; tool registry loops into a uniform IPC proxy via `client.invokeTool`.**

## Performance

- **Duration:** ~17 min
- **Started:** 2026-04-17T18:40:38Z
- **Completed:** 2026-04-17T18:57:58Z
- **Tasks:** 2 (1 refactor + 1 TDD feat)
- **Files created:** 4
- **Files modified:** 6

## Accomplishments

- **D-02 structural invariant holds.** `grep -rn 'new AOFService|schedulerService' src/openclaw/adapter.ts src/plugin.ts` returns empty. The legacy in-process dual-path that CLAUDE.md flagged as fragile is physically removed; the daemon is the single writer for everything.
- **Wave 0 RED → GREEN.** `src/openclaw/__tests__/event-forwarding.test.ts` flipped from 6 failing / 3 passing to 9/9 GREEN (also fixed two test-side bugs where `forwardEvents` was used as the events dictionary instead of the return-value counters).
- **Tool registry unified.** All 16 tools (13 core + 3 project-management) now dispatch through `toolRegistry` → `client.invokeTool({ pluginId, name, params, actor, projectId, correlationId, toolCallId, callbackDepth })`. No adapter-specific `api.registerTool` blocks remain.
- **Gateway URL compatibility preserved.** `/aof/status` and `/aof/metrics` still respond on the gateway port — both routes proxy via `http.request({ socketPath, path: "/status" })` to the daemon's canonical `/status` endpoint.
- **All 925 tests pass** across `src/daemon/__tests__/`, `src/dispatch/__tests__/`, `src/tools/__tests__/`, `src/openclaw/__tests__/`, `src/ipc/__tests__/`. `npx madge --circular --extensions ts src/` reports no new cycles. `npm run typecheck` is clean.

## Task Commits

1. **Task 1: Move aof_project_* tools into shared tool-registry (Open Q2 resolution)** — `9c079d8` (refactor)
2. **Task 2: Thin-bridge restructure of src/openclaw/adapter.ts** — `412e776` (feat)

## Files Created/Modified

### Created

- `src/tools/project-management-tools.ts` — 137 lines. Zod schemas (`projectCreateSchema`, `projectListSchema`, `projectAddParticipantSchema`) + async handlers (`aofProjectCreate`, `aofProjectList`, `aofProjectAddParticipant`). `resolveVaultRoot` uses `ctx.vaultRoot` extra > `core.vaultRoot` > `core.dataDir` fallback.
- `src/tools/__tests__/project-management-tools.test.ts` — 10 tests covering all three schemas' shapes + each handler's filesystem behaviour against a tmp-dir `FilesystemTaskStore`.
- `src/openclaw/status-proxy.ts` — 50 lines. `buildStatusProxyHandler(socketPath)` returns a `GatewayHandler` that `http.request({ socketPath, path: "/status", timeout: 5_000 })`s and renders the daemon's response on the gateway port. Error and timeout paths return structured `{ error: { kind, message } }` envelopes.
- `src/openclaw/dispatch-notification.ts` — 52 lines. Extracted `mergeDispatchNotificationRecipient` (was inline L208-239 in the legacy adapter.ts). Plugin-local pre-IPC transform that pulls captured session route from the `OpenClawToolInvocationContextStore` and stitches it onto `params.notifyOnCompletion` before the IPC envelope is built.

### Modified

- `src/openclaw/adapter.ts` — **393 → 145 lines**. Kept: `registerAofPlugin`, `AOFPluginOptions`, `parseCallbackDepth`, `withCtx`, 7 `api.on` hook handlers, tool-registry loop, HTTP-route registration (now the proxy), `startSpawnPollerOnce` call. Removed: everything else (list in acceptance criteria below). Imports trimmed to: `randomUUID`, `createLogger`, `daemonSocketPath`, `toolRegistry`, `zodToJsonSchema`, `DaemonIpcClient`+`ensureDaemonIpcClient`, `startSpawnPollerOnce`, `OpenClawToolInvocationContextStore`, `buildStatusProxyHandler`, `mergeDispatchNotificationRecipient`, `OpenClawApi` type.
- `src/plugin.ts` — `registerAofPlugin` return type shift. Now captures `{ mode, daemonSocketPath }` and logs it; no `AOFService` instance is returned anywhere.
- `src/tools/tool-registry.ts` — added 3 new entries (`aof_project_create`, `aof_project_list`, `aof_project_add_participant`) + imports from `./project-management-tools.js`.
- `src/openclaw/__tests__/adapter.test.ts` — **rewritten**. Old tests asserted in-plugin AOFService/store/subscription behaviour that has migrated to the daemon. New tests (6 cases): (a) registers all 16 shared tools + 2 HTTP routes + 7 hooks and does NOT call `api.registerService`; (b) tool `execute` builds a D-06 envelope with pluginId/correlationId/toolCallId/callbackDepth; (c) `aof_dispatch` runs `mergeDispatchNotificationRecipient` and forwards the delivery; (d) `notifyOnCompletion: false` short-circuits the merge; (e) `{ error }` IPC envelopes surface as `throw new Error("kind: message")`; (f) 4/7 hooks fire `client.post*` on invocation, 3/7 don't.
- `src/openclaw/__tests__/plugin.unit.test.ts` — expectations updated: `registry.serviceIds` is now `[]` (not `["aof-scheduler"]`), and the full 16-tool list is driven by the shared registry. Added `afterEach` cleanup (`stopSpawnPoller` + `resetDaemonIpcClient`) so the module-level singletons don't carry state into the next test.
- `src/openclaw/__tests__/event-forwarding.test.ts` — two Wave 0 test bugs fixed (tests 1 and 2 invoked `forwardEvents["session_end"]` where `forwardEvents` was actually `{ captureCalls }`; switched to `forwardEvents_invoke(events, ...)` like the other 6 tests). Added `afterEach` cleanup and augmented the injected mock client with a never-resolving `waitForSpawn` to silence spawn-poller log noise.
- `.planning/phases/43-thin-plugin-daemon-authority/deferred-items.md` — appended a note that the 17 pre-existing CLI failures (`memory-cli`, `org-drift-cli`) and the missing `007-daemon-required.test.ts` file (slated for 43-08) persist through 43-07 and remain out-of-scope.

## Decisions Made

**Open Q2 — project tools routing: moved to shared tool-registry.** The research doc's recommendation (move for daemon-side uniformity) won over keeping them as plugin-local filesystem ops. Rationale: every state-mutating call now goes through the single IPC envelope; the daemon has the authoritative project store; tests and docs get one story instead of two. Tradeoff: plugin-local tests that hit `vaultRoot` directly (`src/tools/__tests__/project-management-tools.test.ts`) do so via the handler's own `resolveVaultRoot` helper, not a daemon round-trip — the IPC dispatcher is covered by `src/daemon/__tests__/ipc-integration.test.ts`.

**Open Q4 — /aof/status + /aof/metrics: kept as thin proxies.** The simpler option was to drop both routes and tell users to hit the daemon's socket directly, but the gateway URL contract predates Phase 43 and external scripts / dashboards / `aof smoke`-style probes assume `http://<gateway-host>/aof/status` returns JSON. A ~50-line proxy preserves compatibility without any plugin-local state.

**parseCallbackDepth contract.** IPC envelope (D-06) is source-of-truth; `process.env.AOF_CALLBACK_DEPTH` is only read when the caller didn't supply `params.callbackDepth`, which is exactly the subscriber-triggered re-dispatch cycle documented in `src/dispatch/callback-delivery.ts`. Fresh agent invocations always populate the envelope, so the env fallback never fires in the new thin-bridge path.

**Factor-out vs inline helpers.** Both `buildStatusProxyHandler` and `mergeDispatchNotificationRecipient` were factored into sibling files (`status-proxy.ts`, `dispatch-notification.ts`) so `adapter.ts` itself remains strictly the composition seam: IPC client + event hooks + tool loop + spawn-poller startup. Each sibling is mechanical and stateless (the merge helper depends on an injected store, not a module-level one). Inlining would have pushed adapter.ts well over the 150-line acceptance cap.

**Adapter test rewrite, not patch.** The pre-Phase-43 `adapter.test.ts` had 10 tests, most of which asserted in-plugin `FilesystemTaskStore` / `EventLogger` / `subscription file on disk` behaviour that, post-D-02, lives on the daemon. Patching them would have meant stubbing the daemon round-trip inline across every test — muddier than starting clean. The 6 new tests cover the thin-bridge contract exactly: every assertion corresponds to a plan acceptance criterion, and the daemon-side equivalents of the removed behaviour are covered by `src/daemon/__tests__/ipc-integration.test.ts` and the individual tool handler suites.

## Deviations from Plan

**1. [Rule 1 — Bug] Fixed two self-inflicted bugs in the Wave 0 event-forwarding test**

- **Found during:** Task 2 (turning the RED test GREEN)
- **Issue:** Tests 1 and 2 in `event-forwarding.test.ts` (session_end, agent_end) declared `const forwardEvents = await loadEventForwardingWiring(...)` and then invoked `forwardEvents["session_end"]?.(...)`. But `loadEventForwardingWiring` returns `{ captureCalls }` — `forwardEvents["session_end"]` is always `undefined`, the optional chain short-circuits, the mock client never gets called, and the tests could never pass even with a correct implementation underneath. The other 7 tests in the same file use the `forwardEvents_invoke(events, ...)` helper correctly.
- **Fix:** Switched tests 1 and 2 to use `forwardEvents_invoke(events, "session_end", ...)` / `("agent_end", ...)` to match the rest of the file.
- **Files modified:** `src/openclaw/__tests__/event-forwarding.test.ts`
- **Verification:** All 9 tests GREEN.
- **Committed in:** `412e776` (Task 2 commit)

**2. [Rule 2 — Missing critical] Added afterEach cleanup to prevent spawn-poller leakage across tests**

- **Found during:** Task 2 (first test-suite run after the adapter rewrite OOMed with `ERR_IPC_CHANNEL_CLOSED`)
- **Issue:** `registerAofPlugin` calls `startSpawnPollerOnce(client, api)` which sets a module-level gate (`spawnPollerStarted = true`) and kicks off a `while (spawnPollerStarted) { await client.waitForSpawn(...) ... }` loop. When a test's mock client doesn't implement `waitForSpawn` (or the first test finishes without stopping the poller), the loop keeps spinning in the background, accumulating microtasks across the suite and eventually crashing the vitest worker.
- **Fix:** (a) Added `afterEach(() => { stopSpawnPoller(); resetDaemonIpcClient(); })` to `adapter.test.ts`, `event-forwarding.test.ts`, and `plugin.unit.test.ts`. (b) In test mocks that don't care about spawn handling, set `waitForSpawn` to `() => new Promise(() => {})` so the loop parks on await without throwing.
- **Files modified:** `src/openclaw/__tests__/adapter.test.ts`, `src/openclaw/__tests__/event-forwarding.test.ts`, `src/openclaw/__tests__/plugin.unit.test.ts`
- **Verification:** `npx vitest run src/openclaw/__tests__/` — 73/73 GREEN, no OOM, no `TypeError: waitForSpawn is not a function` log spam. Full suite run `npx vitest run src/{daemon,dispatch,tools,openclaw,ipc}/__tests__/` — 925/925 GREEN.
- **Committed in:** `412e776` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 missing critical test hygiene)
**Impact on plan:** Both auto-fixes essential for correctness (Rule 1 — test code was physically broken) and test stability (Rule 2 — a leaking poller is a correctness hazard for the entire suite, not just this plan). No scope creep.

## Issues Encountered

- **CLI test baseline failures unrelated to phase.** `npm test` reports 17 pre-existing failures in `src/commands/__tests__/memory-cli.test.ts` (11) and `src/commands/__tests__/org-drift-cli.test.ts` (6), plus `src/packaging/migrations/__tests__/007-daemon-required.test.ts` fails to load (the migration file it imports is scheduled for Plan 43-08). All three were confirmed pre-existing by `git stash && npx vitest run <path>` — they reproduce on the 43-07 base commit before any changes land. Documented in `deferred-items.md`; out of scope per executor SCOPE BOUNDARY.

- **Initial `wc -l` > 150 on adapter.ts.** The first draft of the rewrite ran 320 lines (heavy doc comments on every symbol) — down to 236 after trimming docs — still above the hard cap. Solved by factoring `buildStatusProxyHandler` → `status-proxy.ts` and `mergeDispatchNotificationRecipient` → `dispatch-notification.ts`. Final adapter.ts: 145 lines. The two sibling files together add 102 lines of mechanical helpers but adapter.ts is now the pure composition seam.

## User Setup Required

None — no external service configuration required. The Phase 43 installer changes (daemon-always, migration 007) live in 43-08; this plan is the internal restructure.

## Acceptance Criteria Verification

All plan acceptance criteria satisfied:

- `wc -l src/openclaw/adapter.ts` → **145** (< 150 required) ✓
- `grep -c "new AOFService\|schedulerService" src/openclaw/adapter.ts src/plugin.ts` → **0** (D-02 structural invariant) ✓
- `grep -c "new FilesystemTaskStore\|new EventLogger\|new AOFMetrics\|new NotificationPolicyEngine" src/openclaw/adapter.ts` → **0** ✓
- `grep -c "PermissionAwareTaskStore\|resolveProjectStore\|createProjectStore\|loadOrgChart\|getStoreForActor\|withPermissions" src/openclaw/adapter.ts` → **0** ✓
- `grep -c "ensureDaemonIpcClient\|startSpawnPollerOnce" src/openclaw/adapter.ts` → **4** (≥2 required) ✓
- `grep -c "client.postSessionEnd\|client.postAgentEnd\|client.postBeforeCompaction\|client.postMessageReceived" src/openclaw/adapter.ts` → **4** (≥4 required) ✓
- `grep -c "client.invokeTool" src/openclaw/adapter.ts` → **1** (≥1 required) ✓
- `grep -c 'api.on("message_sent"\|api.on("before_tool_call"\|api.on("after_tool_call"' src/openclaw/adapter.ts` → **3** (≥3 required) ✓
- `grep -c "api.registerService" src/openclaw/adapter.ts` → **0** ✓
- `grep -c "aof_project_create\|aof_project_list\|aof_project_add_participant" src/openclaw/adapter.ts` → **0** (moved to registry) ✓
- `npx vitest run src/openclaw/__tests__/event-forwarding.test.ts` → **9/9 GREEN** (was Wave 0 RED) ✓
- `npx vitest run src/openclaw/__tests__/adapter.test.ts src/openclaw/__tests__/plugin.unit.test.ts` → **GREEN** ✓
- `npm run typecheck` → **clean** ✓
- `npx madge --circular --extensions ts src/` → **no cycles** ✓

CLAUDE.md compliance:
- No new `process.env` references (the single `parseCallbackDepth` use of `AOF_CALLBACK_DEPTH` is the documented cross-process exception and pre-dates this plan — moved from the legacy adapter verbatim) ✓
- No `console.*` in adapter.ts ✓
- All logging via `createLogger('openclaw')` ✓

## Next Phase Readiness

- **43-08 (migration):** can now land the migration that (a) installs the daemon service if absent, (b) removes any Phase-42-era "daemon intentionally skipped" marker state. The plugin-side is fully IPC-dependent — any install that doesn't bring up the daemon will see every tool invocation fail loudly with a transport error, which is the correct UX signal.
- **43-09 (wrap-up / release):** can cut v1.15 with the daemon-authority architecture shipped end-to-end. The D-02 invariant is structurally enforced; the fragility CLAUDE.md flagged is gone; the 7-hook forward contract is locked behind `event-forwarding.test.ts`.
- **Future plugin phases:** the IPC envelope's `pluginId` field defaults to `"openclaw"` but is reserved for multi-plugin fan-out. Wiring a second plugin (slack, cli-plugin) is now purely additive — it registers its own DaemonIpcClient, its own spawn-poller with a different pluginId, and participates in the same tool-dispatch contract.

## Self-Check: PASSED

- `src/openclaw/adapter.ts` — EXISTS, 145 lines ✓
- `src/openclaw/status-proxy.ts` — EXISTS ✓
- `src/openclaw/dispatch-notification.ts` — EXISTS ✓
- `src/tools/project-management-tools.ts` — EXISTS ✓
- `src/tools/__tests__/project-management-tools.test.ts` — EXISTS ✓
- Commits:
  - `9c079d8` — Task 1 (project tools move) ✓
  - `412e776` — Task 2 (thin-bridge restructure) ✓
- Acceptance greps: all passing (see §Acceptance Criteria Verification above).
- Test results: 925/925 GREEN across `src/{daemon,dispatch,tools,openclaw,ipc}/__tests__/`.
- `npm run typecheck` — clean.
- `npx madge --circular --extensions ts src/` — no cycles.

---
*Phase: 43-thin-plugin-daemon-authority*
*Completed: 2026-04-17*
