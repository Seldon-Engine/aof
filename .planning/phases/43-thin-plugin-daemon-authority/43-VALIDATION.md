---
phase: 43
slug: thin-plugin-daemon-authority
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-17
---

> **Frontmatter note (2026-04-17):** `nyquist_compliant: false` and `wave_0_complete: false` are pre-execution flags. They flip to `true` after Wave 0 (Plans 43-01 and 43-02) lands the 11 unit + 5 integration RED tests AND the sign-off checklist at the bottom of this file is completed during execution. Do not flip them during planning or revision — Wave 0 hasn't happened yet.

# Phase 43 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (unit) + vitest integration config (E2E, `AOF_INTEGRATION=1`) |
| **Config file** | `vitest.config.ts`, `vitest.integration.config.ts` |
| **Quick run command** | `npm run typecheck && npm test` |
| **Full suite command** | `npm run typecheck && npm test && npm run test:e2e` |
| **Estimated runtime** | ~10s unit, ~60s E2E (sequential, single fork) |

---

## Sampling Rate

- **After every task commit:** Run `npm run typecheck && npm test` (filter to touched files where possible)
- **After every plan wave:** Run `npm run test:e2e` (full integration)
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~10 seconds for unit feedback, ~60s before promoting to next wave
- **Orphan worker hygiene:** After any aborted run, kill leaked vitest workers per CLAUDE.md "Orphan vitest workers" section — required before the next run to avoid pool-contention flakes

---

## Per-Task Verification Map

*Populated by the planner. Each task row declares test type, automated command, and which existing/new file provides the assertion.*

| Task ID | Plan | Wave | Goal Element | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|--------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 43-XX-NN | TBD  | 0    | Test scaffolding | — | N/A | unit | `npx vitest run <file>` | ❌ W0 | ⬜ pending |

---

## Wave 0 Requirements

*Test infrastructure that must exist before Wave 1+ tasks can assert against it. Populated by planner; expected coverage areas:*

- [ ] `src/daemon/__tests__/ipc-invoke-tool.test.ts` — stub for `POST /v1/tool/invoke` envelope contract (D-06)
- [ ] `src/daemon/__tests__/ipc-events.test.ts` — stub for selective event forwarding (D-07)
- [ ] `src/daemon/__tests__/spawn-queue.test.ts` — stub for long-poll queue + unclaim-on-disconnect (D-09, D-11)
- [ ] `src/dispatch/__tests__/plugin-bridge-adapter.test.ts` — stub for `GatewayAdapter` conformance (D-10)
- [ ] `src/dispatch/__tests__/no-plugin-attached-hold.test.ts` — stub for task-held-not-dropped invariant (D-12)
- [ ] `src/openclaw/__tests__/daemon-ipc-client.test.ts` — stub for plugin-side IPC client retry/timeout
- [ ] `tests/integration/phase-43-ipc-round-trip.test.ts` — E2E scaffold, `AOF_INTEGRATION=1` gated
- [ ] `tests/integration/phase-43-daemon-restart-mid-longpoll.test.ts` — regression test scaffold
- [ ] `tests/integration/phase-43-plugin-reload-across-sessions.test.ts` — OpenClaw reload survival scaffold
- [ ] `src/packaging/migrations/__tests__/migration-007.test.ts` — migration idempotence + rollback

*If none: "Existing infrastructure covers all phase requirements." — NOT applicable here; Phase 43 introduces new seams.*

---

## Validation Architecture (Nyquist coverage of phase goal)

Each element of the phase goal MUST have at least one automated assertion.

| Phase Goal Element | Where It Lives | Validation Evidence |
|--------------------|----------------|---------------------|
| Daemon owns sole AOFService/scheduler authority (D-02 removes in-plugin singleton) | `src/openclaw/adapter.ts`, `src/plugin.ts` | Grep assertion: no `new AOFService(` in `src/openclaw/` or `src/plugin.ts` after Phase 43. Unit test boots plugin and asserts no AOFService module-level singleton leaks. |
| Installer always installs daemon in plugin-mode (D-01 reverses Phase 42 D-03) | `scripts/install.sh`, `src/cli/commands/daemon.ts` | E2E / shell test: `install.sh` run in plugin-mode detection path installs launchd/systemd service. No `skip daemon` branch reachable. |
| `--force-daemon` → deprecated no-op (D-04) | `scripts/install.sh` | Unit test on arg parsing: flag emits deprecation warning, does not alter flow. |
| Unix-socket IPC routes (D-05) | `src/daemon/server.ts` | Integration test: each route (`POST /v1/tool/invoke`, `POST /v1/event/session-end`, `POST /v1/event/agent-end`, `POST /v1/event/before-compaction`, `POST /v1/event/message-received`, `GET /v1/spawns/wait`, `POST /v1/spawns/{id}/result`) returns correct response envelope over `daemon.sock`. |
| Single `invokeTool` envelope dispatches against shared registry (D-06) | `src/daemon/server.ts`, `src/tools/tool-registry.ts` | Parametric test over every tool in registry: plugin-side IPC call → daemon handler → same result as in-process reference. Zod error envelope verified. |
| Selective event forwarding (D-07) | `src/openclaw/adapter.ts` | Unit test (A1 resolution applied — 4 forwarded hooks): `session_end`, `agent_end`, `before_compaction`, `message_received` hooks trigger IPC POSTs (the latter because `handleMessageReceived` calls `protocolRouter.route()`, mutating daemon state); `before_tool_call`, `after_tool_call`, `message_sent` do NOT forward. |
| Socket perm auth (D-08) | `src/daemon/server.ts` | Test asserts `daemon.sock` created with mode `0600`. |
| Long-poll spawn callback (D-09) | `src/daemon/server.ts`, plugin `spawn-poller.ts` | Integration test: daemon enqueues `SpawnRequest`, plugin receives via `GET /v1/spawns/wait`, posts result via `POST /v1/spawns/{id}/result`. Keepalive timeout triggers clean reconnect. |
| PluginBridgeAdapter + adapter selection (D-10) | `src/dispatch/plugin-bridge-adapter.ts`, `src/daemon/daemon.ts` | Unit test: selector returns `PluginBridgeAdapter` when plugin attached, `StandaloneAdapter` when none, both conform to `GatewayAdapter`. |
| Implicit registration via long-poll presence (D-11) | `src/daemon/server.ts` (plugin registry) | Unit test: first `GET /v1/spawns/wait` increments `availablePluginCount`; `res.on('close')` decrements. No explicit register endpoint. |
| No-plugin-attached tasks held, never dropped (D-12) | `src/dispatch/scheduler.ts` or `assign-executor.ts` | **Critical invariant test:** Scheduler sees ready task + zero plugins → task remains in `ready/`, emits `log.warn({reason:"no-plugin-attached"})`, rescheduled on next tick. Task NOT moved to deadletter. Plugin connects → task dispatched. |
| `pluginId` reserved in IPC schemas (D-13) | `src/schemas/ipc-*.ts` | Schema test: `pluginId` is Zod-optional, defaults to `"openclaw"`. Verified via `z.parse` on minimal payload. |
| Migration 007 runs on `aof setup --auto --upgrade` (D-14) | `src/packaging/migrations/007-*.ts` | Migration test: idempotent (run twice ≡ run once), rollback restores pre-state, installs service if absent, leaves plist unchanged if present. |
| CLAUDE.md invariants preserved | All touched files | Lint/grep assertions: no new `process.env` reads outside `getConfig()` (`AOF_CALLBACK_DEPTH` exception), no `console.*` in core modules, no circular deps (`npx madge --circular --extensions ts src/`). |

---

## Manual-Only Verifications

| Behavior | Goal Element | Why Manual | Test Instructions |
|----------|--------------|------------|-------------------|
| OpenClaw session-reload survival | D-11 / reload lifecycle | OpenClaw gateway runtime not available in Vitest — requires real gateway process | 1. `aof setup --auto --upgrade`. 2. Start OpenClaw gateway, open a session, dispatch a task, observe completion. 3. Trigger a second session (which reloads the plugin). 4. Dispatch another task — must flow through the same daemon (verify `daemon.log` shows continuous authority, no new AOFService). |
| launchd/systemd service survives daemon crash | D-03 | OS supervisor behavior is out-of-process | Kill daemon PID; observe launchd/systemd respawn within supervision window; plugin's long-poll reconnects automatically. |
| End-to-end `aof_dispatch` with real OpenClaw `runtime.agent.runEmbeddedPiAgent` | D-09 spawn path | Real agent runtime required | From an open OpenClaw session: invoke `aof_dispatch` with a test task, verify agent spawns via long-poll callback, task transitions `ready → in-progress → done`. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (IPC routes, long-poll queue, PluginBridgeAdapter, hold-no-drop, migration 007)
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s for unit, < 60s for integration promotion
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
