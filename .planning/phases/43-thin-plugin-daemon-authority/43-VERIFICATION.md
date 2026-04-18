---
phase: 43-thin-plugin-daemon-authority
verified: 2026-04-18T00:07:00Z
status: human_needed
score: 14/14
overrides_applied: 0
human_verification:
  - test: "Test A — tool invoke round-trip via plugin against live OpenClaw session"
    expected: "aof_status_report call via agent returns correct response; daemon log shows /v1/tool/invoke request; DaemonIpcClient singleton initialized once"
    why_human: "Requires running OpenClaw gateway process — cannot exercise runtime.agent or per-session plugin lifecycle from Vitest. Per 43-09-SUMMARY.md, user chose Skip checkpoint."
  - test: "Test B — full dispatch + spawn round-trip via long-poll"
    expected: "aof_dispatch task flows daemon -> /v1/spawns/wait -> runEmbeddedPiAgent -> result post -> task transitions ready->in-progress->done"
    why_human: "Requires real runtime.agent.runEmbeddedPiAgent inside OpenClaw gateway. Long-poll integration tests (tests/integration/long-poll-spawn.test.ts) cover seams; end-to-end requires real gateway."
  - test: "Test C — OpenClaw per-session plugin reload survives DaemonIpcClient singleton"
    expected: "Second session after reload dispatches through same daemon process (daemon.pid unchanged); no duplicate client instances; no duplicate long-poll connections"
    why_human: "OpenClaw per-session lifecycle cannot be simulated in Vitest. Unit test for ensureDaemonIpcClient singleton exists (src/openclaw/__tests__/daemon-ipc-client.test.ts) but real reload survival requires gateway."
  - test: "Test D — daemon crash + launchd/systemd respawn + plugin reconnect"
    expected: "kill -9 daemon PID; supervisor respawns within ~5s; spawn-poller reconnects within ~30s exponential backoff; subsequent dispatch completes"
    why_human: "OS supervisor behavior (launchd/systemd) is out-of-process. Cannot verify plist/unit file correctness without real supervisor. D-03 verified structurally via Migration 007 + installService; runtime not exercisable from tests."
  - test: "Test E — --force-daemon deprecation warning on sh install.sh --force-daemon"
    expected: "Output contains '--force-daemon is DEPRECATED as of v1.15...' on stderr; daemon still installs; no behavioral difference"
    why_human: "Requires tarball rebuild (aof-<version>.tar.gz) which is not auto-invalidated when install.sh changes. grep/bash-n syntax checks pass; runtime text confirmed in source (scripts/install.sh:700) but install.sh integration test (tests/integration/install-mode-exclusivity.test.ts) requires AOF_INTEGRATION=1 + tarball."
---

# Phase 43: Thin-Plugin Daemon Authority — Verification Report

**Phase Goal:** Restructure so the aof-daemon owns the single scheduler / task store authority, and the openclaw plugin becomes a thin bridge (tool host + agent-spawn callback). Plugin IPC-calls daemon; daemon IPC-calls plugin back for spawns that need `runtime.agent.runEmbeddedPiAgent`. Single-writer model enables multi-platform plugin fan-out (openclaw, slack, cli, other gateways) all dispatching through one daemon.

**Verified:** 2026-04-18T00:07:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths (derived from D-01 through D-14 per CONTEXT.md, VALIDATION.md, and per-plan must_haves)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| D-02 | `new AOFService(` and `schedulerService` are absent from `src/openclaw/` and `src/plugin.ts` — daemon is sole authority | VERIFIED | `grep -rn "new AOFService(" src/openclaw src/plugin.ts` → 0 matches; `grep -rn "schedulerService" src/openclaw/adapter.ts src/plugin.ts` → 0 matches; adapter.ts reduced from 393 to 145 lines |
| D-01 | `install.sh` always installs daemon in plugin-mode; Phase 42 D-03 skip-gate removed | VERIFIED | `grep -c "plugin_mode_detected.*FORCE_DAEMON"` → 0; "skipping standalone daemon" → 0; "removing redundant standalone daemon" → 0 |
| D-04 | `--force-daemon` flag is a deprecated no-op | VERIFIED | `grep -c "DEPRECATED\|deprecated" scripts/install.sh` → 3 matches; line 700 emits the deprecation warn; `bash -n` + `sh -n` exit 0 |
| D-05 | Daemon exposes all 7 IPC routes over daemon.sock | VERIFIED | `src/ipc/server-attach.ts` mounts 6 keyed routes + 1 regex route: `/v1/tool/invoke`, `/v1/event/session-end`, `/v1/event/agent-end`, `/v1/event/before-compaction`, `/v1/event/message-received`, `/v1/spawns/wait`, `/v1/spawns/{id}/result` (regex `^\/v1\/spawns\/[^/]+\/result$`) |
| D-06 | Single `invokeTool` envelope dispatches against shared `toolRegistry` | VERIFIED | `src/ipc/routes/invoke-tool.ts` dispatches via `deps.toolRegistry[name].handler`; IPC integration test passes 4/4 |
| D-07 A1 | 4 forwarded hooks: `session_end`, `agent_end`, `before_compaction`, `message_received`; 3 local hooks: `before_tool_call`, `after_tool_call`, `message_sent` | VERIFIED | `grep -c "client.postSessionEnd\|client.postAgentEnd\|client.postBeforeCompaction\|client.postMessageReceived" src/openclaw/adapter.ts` → 4; event-forwarding.test.ts 9/9 PASS |
| D-08 | daemon.sock created with mode 0600 | VERIFIED | `src/daemon/server.ts:80` calls `chmodSync(socketPath, 0o600)`; socket-perms.test.ts 1/1 PASS |
| D-09 | Long-poll spawn callback: daemon enqueues SpawnRequest; plugin receives via `/v1/spawns/wait`; plugin posts result via `/v1/spawns/{id}/result`; 25s keepalive → 204 | VERIFIED | `src/ipc/routes/spawn-wait.ts` (98 lines), `src/ipc/routes/spawn-result.ts` (108 lines), `src/openclaw/spawn-poller.ts` (138 lines) all substantive; spawn-poller.test.ts 5/5 PASS; long-poll-spawn.test.ts exists (AOF_INTEGRATION=1 gated) |
| D-10 | PluginBridgeAdapter and SelectingAdapter exist; adapter selection routes by registry presence and mode | VERIFIED | `src/dispatch/plugin-bridge-adapter.ts` (161 lines, implements GatewayAdapter); `src/dispatch/selecting-adapter.ts` (84 lines, routes based on `hasActivePlugin()` + mode); plugin-bridge-adapter.test.ts 5/5, selecting-adapter.test.ts 7/7 PASS |
| D-11 | Implicit plugin registration via long-poll presence; `availablePluginCount` = active long-polls; auto-release on `res.close` | VERIFIED | `src/ipc/plugin-registry.ts` (82 lines); plugin-registry.test.ts 7/7 PASS; `src/daemon/daemon.ts` constructs `new PluginRegistry()` |
| D-12 | No-plugin-attached tasks held in `ready/`, never dropped; `dispatch.held` event emitted; no retryCount increment | VERIFIED | `src/dispatch/assign-executor.ts:234` checks `result.error === "no-plugin-attached"`; `src/schemas/event.ts:50` has `"dispatch.held"`; bug-043-dispatch-hold.test.ts 6/6 PASS |
| D-13 | `pluginId` field Zod-optional, defaults to `"openclaw"` in IPC schemas | VERIFIED | `src/ipc/schemas.ts:12` has `.default("openclaw")`; `grep -c ".default(\"openclaw\")" src/ipc/schemas.ts` → 2; envelope.test.ts passes D-13 assertions |
| D-14 | Migration 007 installed in `src/packaging/migrations/007-daemon-required.ts`; registered in `src/cli/commands/setup.ts` | VERIFIED | File exists; `grep -c "migration007" src/cli/commands/setup.ts` → 2 (import + getAllMigrations); 007-daemon-required.test.ts 5/5 PASS |
| CLAUDE.md invariants | No `console.*` in new core modules; no new `process.env` reads (except AOF_CALLBACK_DEPTH); no circular deps in `src/ipc/` | VERIFIED | `grep console.* src/ipc/*.ts src/ipc/routes/*.ts src/openclaw/adapter.ts ...` → 0; `grep process.env` (excluding CALLBACK_DEPTH) → 0; `npx madge --circular --extensions ts src/ipc/` → "Processed 125 files" (no cycles) |

**Score:** 14/14 truths verified

---

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `src/ipc/schemas.ts` | VERIFIED | 160 lines; 10 Zod schema exports + matching type exports; `pluginId` defaults `"openclaw"`, `callbackDepth` defaults `0`, `.strict()` on envelope |
| `src/ipc/types.ts` | VERIFIED | `IpcDeps` interface + `RouteHandler` type; optional Wave-2 fields for spawnQueue/pluginRegistry |
| `src/ipc/index.ts` | VERIFIED | Pure barrel re-exports |
| `src/ipc/routes/invoke-tool.ts` | VERIFIED | Dispatches against toolRegistry; Zod validation; error classification (validation/not-found/permission/internal) |
| `src/ipc/routes/session-events.ts` | VERIFIED | 4 handlers: `handleSessionEnd`, `handleAgentEnd`, `handleBeforeCompaction`, `handleMessageReceived` |
| `src/ipc/routes/spawn-wait.ts` | VERIFIED | 98 lines; long-poll with 25s keepalive → 204; atomic claim |
| `src/ipc/routes/spawn-result.ts` | VERIFIED | 108 lines; path regex match; `deliverSpawnResult` invocation |
| `src/ipc/server-attach.ts` | VERIFIED | Mounts all 7 IPC routes; `keepAliveTimeout = 60_000`; `headersTimeout = 61_000` |
| `src/ipc/store-resolver.ts` | VERIFIED | `buildDaemonResolveStore` lifted from adapter.ts; `PermissionAwareTaskStore` + `createProjectStore` wired |
| `src/ipc/spawn-queue.ts` | VERIFIED | 89 lines; EventEmitter-based; `enqueue`, `claim`, `tryClaim`, `reset` |
| `src/ipc/plugin-registry.ts` | VERIFIED | 82 lines; `hasActivePlugin()`, `register()` → `PluginHandle`, auto-release on `res.close` |
| `src/dispatch/plugin-bridge-adapter.ts` | VERIFIED | 161 lines; implements `GatewayAdapter`; `spawnSession` enqueues; `deliverResult` fires `onRunComplete` |
| `src/dispatch/selecting-adapter.ts` | VERIFIED | 84 lines; mode-aware routing; `no-plugin-attached` sentinel in `plugin-bridge` mode |
| `src/dispatch/assign-executor.ts` | VERIFIED | Hold-in-ready branch at L229-249; mirrors `platformLimit` flow; `dispatch.held` event emitted |
| `src/openclaw/adapter.ts` | VERIFIED | 145 lines (was 393); thin bridge; no AOFService/schedulerService/store construction |
| `src/openclaw/daemon-ipc-client.ts` | VERIFIED | 283 lines; `DaemonIpcClient` + `ensureDaemonIpcClient` singleton; all 7 IPC methods; uses `http.request({ socketPath })` not `fetch` |
| `src/openclaw/spawn-poller.ts` | VERIFIED | 138 lines; `startSpawnPollerOnce` idempotent (module-scope gate); `runAgentFromSpawnRequest` from `openclaw-executor.ts`; exponential backoff |
| `src/openclaw/openclaw-executor.ts` | VERIFIED | `runAgentFromSpawnRequest` function factored out; `OpenClawAdapter` retained; dispatch chain upstream of assign-executor untouched |
| `src/packaging/migrations/007-daemon-required.ts` | VERIFIED | Idempotent (existsSync breadcrumb); calls `installService`; no `down()`; version `1.15.0` |
| `src/plugin.ts` | VERIFIED | No AOFService; delegates to `registerAofPlugin`; return type updated (thin bridge status, not AOFService) |
| `src/tools/project-management-tools.ts` | VERIFIED | aof_project_create/list/add_participant moved to shared toolRegistry (Open Q2 resolution) |
| `scripts/install.sh` | VERIFIED | Phase 42 skip-gate removed; `--force-daemon` emits deprecation warn; `bash -n` + `sh -n` pass |
| `tests/integration/helpers/daemon-harness.ts` | VERIFIED | Exists; exports `startTestDaemon`, `stopTestDaemon`, `TestDaemon` |
| `tests/integration/helpers/plugin-ipc-client.ts` | VERIFIED | Exists; uses `http.request({ socketPath })` not `fetch`; exports `invokeTool`, `waitForSpawn`, `postSpawnResult`, `postEvent` |
| 5 integration test scaffolds | VERIFIED | `tool-invoke-roundtrip.test.ts`, `long-poll-spawn.test.ts`, `hold-no-plugin.test.ts`, `daemon-restart-midpoll.test.ts`, `plugin-session-boundaries.test.ts` — all exist, all `AOF_INTEGRATION=1`-gated, all skip cleanly in unit run |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/daemon/server.ts` | `src/ipc/server-attach.ts` | `attachIpcRoutes(server, deps)` | WIRED | `daemon.ts:17` imports `attachIpcRoutes`; called at L168 after `createHealthServer` |
| `src/ipc/routes/invoke-tool.ts` | `src/tools/tool-registry.ts` | `deps.toolRegistry[name].handler` | WIRED | Pattern `deps.toolRegistry[` confirmed in file |
| `src/ipc/store-resolver.ts` | `PermissionAwareTaskStore` + `createProjectStore` | project-store cache + org-chart wrap | WIRED | Both imports confirmed; `buildDaemonResolveStore` callable |
| `src/daemon/daemon.ts` | `SelectingAdapter` + `PluginBridgeAdapter` + `SpawnQueue` + `PluginRegistry` | `new` construction + wired into `AOFService` | WIRED | `daemon.ts:91-98` — all 4 constructed; passed to `startAofDaemon` as executor |
| `src/dispatch/assign-executor.ts` | `SelectingAdapter.spawnSession` result | `result.error === "no-plugin-attached"` hold branch | WIRED | L229-249 confirmed; `dispatch.held` event logged |
| `src/openclaw/adapter.ts` | `src/openclaw/daemon-ipc-client.ts` + `src/openclaw/spawn-poller.ts` | `ensureDaemonIpcClient` + `startSpawnPollerOnce` | WIRED | L16-17 imports; L50 client instantiated; L143 poller started |
| Tool-registry execute closure | daemon `/v1/tool/invoke` | `client.invokeTool({ name, params, toolCallId, ... })` | WIRED | adapter.ts tool-loop proxies each tool via `client.invokeTool(...)` |
| 4 event hook handlers | daemon `/v1/event/*` | `client.postSessionEnd / postAgentEnd / postBeforeCompaction / postMessageReceived` | WIRED | adapter.ts L73/76/80/85 — all 4 forwarding calls confirmed |
| `src/openclaw/spawn-poller.ts` | `src/openclaw/openclaw-executor.ts::runAgentFromSpawnRequest` | import + invocation | WIRED | `spawn-poller.ts:34` imports; `:101` calls `runAgentFromSpawnRequest(api, sr)` |
| Migration 007 | `src/daemon/service-file.ts::installService` | direct call when plist/unit absent | WIRED | `007-daemon-required.ts` calls `installService({ dataDir: ctx.aofRoot })` |
| `src/cli/commands/setup.ts` | `migration007` | `getAllMigrations()` return array | WIRED | `grep -c "migration007" setup.ts` → 2 (import + array) |

---

### Data-Flow Trace (Level 4)

Not applicable: Phase 43 is an architectural plumbing phase — all new artifacts are route handlers, adapters, IPC clients, and migration code. None render dynamic data to a UI. Data flows are verified via unit tests and wiring checks above.

---

### Behavioral Spot-Checks

| Behavior | Evidence | Status |
|----------|----------|--------|
| Typecheck passes | `npm run typecheck` → exit 0 (clean, no errors) | PASS |
| Full unit suite passes | `npm test` → 3200 passed, 28 skipped (AOF_INTEGRATION gated), 3 todo; 0 failed | PASS |
| Migration 007 test 5/5 | `npx vitest run src/packaging/migrations/__tests__/007-daemon-required.test.ts` → 5 PASS | PASS |
| bug-043-dispatch-hold.test.ts 6/6 | `npx vitest run src/dispatch/__tests__/bug-043-dispatch-hold.test.ts` → 6 PASS | PASS |
| event-forwarding.test.ts 9/9 | `npx vitest run src/openclaw/__tests__/event-forwarding.test.ts` → 9 PASS | PASS |
| socket-perms.test.ts 1/1 | `npx vitest run src/daemon/__tests__/socket-perms.test.ts` → 1 PASS | PASS |
| ipc-integration.test.ts 4/4 | `npx vitest run src/daemon/__tests__/ipc-integration.test.ts` → 4 PASS (full daemon boot + /v1/tool/invoke) | PASS |
| selecting-adapter + plugin-bridge-adapter 12/12 | Both test files → 12 PASS | PASS |
| IPC unit suite 46 tests | envelope + invoke-tool-handler + spawn-queue + plugin-registry → 46 PASS | PASS |
| daemon-ipc-client.test.ts 8/8 | Singleton logic + invokeTool + waitForSpawn + postSpawnResult → 8 PASS | PASS |
| spawn-poller.test.ts 5/5 | Idempotency + exponential backoff + exception posting → 5 PASS | PASS |
| No circular deps in src/ipc/ | `npx madge --circular --extensions ts src/ipc/` → "Processed 125 files" (no circular deps listed) | PASS |

---

### Requirements Coverage

Phase 43 has no formal REQUIREMENTS.md entries. Coverage is verified against the 14 locked decisions (D-01 through D-14) declared in 43-CONTEXT.md and cross-mapped to per-plan `must_haves`. All 14 decisions are satisfied — see Observable Truths table.

---

### Code Review Summary (Advisory Only — Non-Blocking)

Code review (43-REVIEW.md) found 0 critical, 3 warnings, 3 info findings. None block the phase goal.

| ID | Severity | File | Issue | Impact |
|----|----------|------|-------|--------|
| WR-01 | Warning | `src/ipc/http-utils.ts:30` | `readBody`: chunks accumulate after `PayloadTooLargeError` until socket closes — minor DoS amplifier | Non-blocking; same-uid trust boundary limits attacker surface |
| WR-02 | Warning | `scripts/install.sh:175-176` | Equality guard uses `&&` instead of `\|\|` — symlink bypass of install-dir == data-dir check | Non-blocking; cosmetic security fix |
| WR-03 | Warning | `src/ipc/spawn-queue.ts:39` | `as SpawnRequest` cast bypasses structural check in `enqueue()` — correctness time-bomb if new required fields added | Non-blocking; fix is one-line (`const full: SpawnRequest = ...`) |
| IN-01 | Info | `src/daemon/daemon.ts:141` | `providersConfigured: 0` TODO stub in status output | Non-blocking; operator UX only |
| IN-02 | Info | `src/packaging/migrations/007-daemon-required.ts:44` | `console.log` in migration — narrow CLAUDE.md exception for migrations | Non-blocking; consistent with 004/006 pattern |
| IN-03 | Info | `scripts/install.sh:610+` | `local` keyword in `#!/bin/sh` script — POSIX portability note | Non-blocking; macOS/Linux targets all support `local` |

---

### Anti-Patterns Found

| File | Pattern | Severity | Assessment |
|------|---------|----------|------------|
| `src/daemon/daemon.ts:141` | `providersConfigured: 0, // TODO` | Info | IN-01 above; no rendering of dynamic data blocked |
| `src/ipc/spawn-queue.ts:39` | `as SpawnRequest` type cast | Warning | WR-03 above; type-safety hole, not a runtime stub |
| `src/ipc/http-utils.ts:30` | Chunks accumulate post-limit | Warning | WR-01 above; memory concern only |

No placeholder components, empty API handlers, hardcoded empty arrays, or orphaned stubs were found in Phase 43 code. All new implementations are substantive (minimum lines: schemas 160, daemon-ipc-client 283, plugin-bridge-adapter 161, invoke-tool route with full error classification).

---

### Human Verification Required

The following 5 tests from `43-09-PLAN.md` were **deferred** when the user chose "Skip checkpoint" during `/gsd-execute-phase 43` execution (recorded in `43-09-SUMMARY.md`). These are blocking `status: human_needed` — the automated suite is comprehensive but cannot exercise the OpenClaw gateway runtime, per-session plugin reload lifecycle, or OS-level supervisor behavior.

#### Test A — Tool invoke round-trip via plugin

**Test:** Open an OpenClaw session. Invoke `aof_status_report` tool via the agent. Observe daemon log (`~/.aof/data/logs/daemon.log`) shows a `/v1/tool/invoke` request. Confirm `DaemonIpcClient singleton initialized` appears once in plugin log (not per session).
**Expected:** Response renders correctly; daemon received and processed the IPC call; singleton not duplicated.
**Why human:** Requires live OpenClaw gateway process — `runtime.agent` is unavailable in Vitest.

#### Test B — Dispatch + spawn round-trip

**Test:** From an OpenClaw session, call `aof_dispatch` with a simple test task. Observe: daemon enqueues, plugin receives via `/v1/spawns/wait`, invokes `runEmbeddedPiAgent`, posts result. Task transitions `ready → in-progress → done`.
**Expected:** Full round-trip completes; daemon log shows `spawn enqueued for plugin` then `spawn result received`.
**Why human:** `runtime.agent.runEmbeddedPiAgent` requires a live OpenClaw gateway. Integration test `tests/integration/long-poll-spawn.test.ts` covers the IPC mechanics; this test closes the gateway-spawn gap.

#### Test C — OpenClaw per-session plugin reload

**Test:** Close and reopen an OpenClaw session (triggering plugin reload). Dispatch a second task. Observe: daemon.pid unchanged; no `plugin detached` + `plugin attached` churn in daemon log (singleton survived reload); task dispatched normally.
**Expected:** Module-level `ensureDaemonIpcClient` singleton survives the per-session reload cycle (D-11). One continuous long-poll connection.
**Why human:** OpenClaw per-session plugin lifecycle is not reproducible under Vitest. Unit test for `ensureDaemonIpcClient` singleton exists; real reload survival cannot be verified without gateway.

#### Test D — Daemon crash + launchd/systemd respawn

**Test:** `kill -9 $(cat ~/.aof/data/daemon.pid)`. Wait ~5s. Verify `launchctl list | grep ai.openclaw.aof` shows service re-appeared. Verify `aof daemon status` reports running again with new PID. Dispatch a task — confirms plugin's spawn-poller reconnected (exponential backoff).
**Expected:** OS supervisor respawns daemon within supervision window; plugin reconnects within ~30s; dispatch resumes.
**Why human:** launchd/systemd behavior is out-of-process. Plist/unit file correctness verified via `installService` (D-03) but supervisor runtime cannot be exercised from tests.

#### Test E — `--force-daemon` deprecation on install

**Test:** From a fresh tarball: `sh install.sh --force-daemon`. Observe stderr contains the deprecation warning message. Confirm daemon still installs (no behavior change).
**Expected:** `scripts/install.sh:700` deprecation warn text rendered; install succeeds; no `Dual-polling will occur` (that message was removed in 43-08).
**Why human:** Requires tarball rebuild (`aof-<version>.tar.gz`) which is not auto-invalidated when `install.sh` changes. grep + bash-n syntax checks confirm the code; runtime tarball invocation requires `AOF_INTEGRATION=1` + rebuild step documented in 43-08-SUMMARY.md as a deferred issue.

---

### Gaps Summary

No automated gaps found. All 14 phase-goal elements (D-01 through D-14) are structurally implemented, wired, and covered by passing unit tests. The unit test suite grew from the pre-phase baseline to 3200 passing tests (28 skipped integration tests gated on `AOF_INTEGRATION=1`, 3 todos — all expected).

The `human_needed` status reflects the 5 manual verification tests (A–E) from `43-09-PLAN.md` that were deferred by the user at checkpoint time. Per `43-09-SUMMARY.md`: "Before cutting a release tag for Phase 43, run the A–E matrix manually and update this SUMMARY to `status: verified` with per-test PASS results."

To resolve: execute Tests A–E on a real Mac (or Linux box) with the OpenClaw gateway and update `43-09-SUMMARY.md`. If all PASS, re-run verification to promote `status: human_needed` → `status: passed`.

---

_Verified: 2026-04-18T00:07:00Z_
_Verifier: Claude (gsd-verifier)_
