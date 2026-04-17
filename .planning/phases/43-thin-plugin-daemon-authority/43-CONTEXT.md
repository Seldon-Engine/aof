# Phase 43: Thin-plugin architecture — daemon as single authority — Context

**Gathered:** 2026-04-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Invert the AOF control plane so `aof-daemon` owns the sole `AOFService` / scheduler / task-store authority, and the OpenClaw plugin (`src/openclaw/adapter.ts`) becomes a thin bridge:

1. Plugin tool handlers proxy to the daemon over IPC (Unix socket, extending the existing `daemon.sock`) — no local scheduler, no local store mutations.
2. Daemon delegates back to the plugin only for agent spawns that require `runtime.agent.runEmbeddedPiAgent` (an OpenClaw gateway method that cannot be reached from outside the gateway process).
3. The module-level `schedulerService` singleton in `src/openclaw/adapter.ts:56` and the in-process `AOFService` code path are removed. Daemon is the single writer.

Out of scope (explicit deferrals — see `<deferred>`):
- Non-OpenClaw plugins (slack, cli, other gateways) — IPC contract is designed to support them, only openclaw is wired this phase.
- Remote daemon over HTTP/TCP — Unix socket only.
- Per-plugin permission scopes / plugin ACLs.
- Runtime `scheduler.mode` switch (live-mode swap without reinstall).

</domain>

<decisions>
## Implementation Decisions

### Phase 42 Reconciliation (daemon lifecycle & installer)

- **D-01:** Installer **always** installs the `aof-daemon` service in plugin-mode. Phase 42 D-03 (`install.sh::install_daemon()` auto-skip when plugin-mode detected) is reversed by Phase 43. A new install-time decision is no longer mode-dependent.
  - Rationale: Phase 43 makes the daemon mandatory infrastructure — skipping it would leave the plugin with nothing to IPC to. One shape in production eliminates the dual-code-path fragility that CLAUDE.md flags.
- **D-02:** The in-process `AOFService` path in the plugin is **removed entirely**. `schedulerService` singleton, `service.start()` self-bootstrap, and the `schedulerService ?? new AOFService(...)` branch in `registerAofPlugin` all go. Plugin `register()` connects to the daemon via IPC; it no longer instantiates or owns an `AOFService`.
  - Rationale: structural enforcement of the "single authority" invariant, not runtime enforcement. CLAUDE.md's "Fragile — Tread Carefully" split on plugin/standalone executor wiring disappears with the dual path.
- **D-03:** Daemon is launched as a launchd (macOS) / systemd (Linux) user service — same supervision model as standalone today. Plugin `register()` only probes and connects over the socket; it never spawns `aof-daemon`.
  - Rationale: preserves OS-level crash recovery (v1.0 decision, PROJECT.md Key Decisions). Fights OpenClaw's per-session plugin lifecycle the least. Reuses `src/daemon/service-file.ts::installService` unchanged.
- **D-04:** Phase 42's `--force-daemon` flag becomes a no-op with a deprecation warning for one release cycle, then is removed. Phase 42 D-04 override is superseded by D-01 ("always install"). No `--no-daemon` inverse is introduced — the old in-process path does not exist post-D-02 to opt back into.
  - Rationale: clean linear evolution; flag surface shrinks rather than grows.

### IPC Transport & Protocol (plugin → daemon)

- **D-05:** Transport is the existing Unix domain socket `daemon.sock` (hosted by `src/daemon/server.ts`). New routes extend the same server: `POST /v1/tool/invoke`, `POST /v1/event/session-end`, `POST /v1/event/agent-end`, `POST /v1/event/before-compaction`, `GET /v1/spawns/wait`, `POST /v1/spawns/{id}/result`. Existing `/healthz` and `/status` unchanged.
  - Rationale: zero new ports, zero new auth surface, lowest latency, uses the same path `aof smoke` and health probes use today. Plugin is always same-host with OpenClaw.
- **D-06:** RPC shape is a **single `invokeTool` envelope**: `POST /v1/tool/invoke { name, params, actor, projectId, correlationId, toolCallId } → { result } | { error }`. Daemon dispatches against `tool-registry.ts`. Adding a new tool requires no new IPC route.
  - Rationale: mirrors the `toolRegistry` pattern that already unifies MCP/OpenClaw handlers (PROJECT.md Key Decision). Single schema, single auth path, single error envelope.
- **D-07:** Session lifecycle events: **selective forwarding**. Only state-mutating hooks forward via IPC: `session_end` → `POST /v1/event/session-end`, `agent_end` → `POST /v1/event/agent-end`, `before_compaction` → `POST /v1/event/before-compaction`. High-frequency capture hooks (`before_tool_call`, `after_tool_call`, `message_received`, `message_sent`) continue to update the in-plugin `OpenClawToolInvocationContextStore` locally — they mutate no daemon-owned state.
  - Rationale: minimizes IPC chatter on a busy gateway; keeps route/tool-call capture at ~0 cost; preserves the "daemon is single writer" invariant (all mutations still go through the daemon, the local cache is read-only from the daemon's perspective). The captured route is attached as a parameter when `aof_dispatch` is invoked via IPC, so the daemon never loses notification recipients.
- **D-08:** Auth model is **Unix socket filesystem permissions only**. `daemon.sock` is already `0600` owned by the invoking user — same-uid is the trust boundary. No token, no handshake, no rotation.
  - Rationale: matches existing AOF pattern (healthz, status), zero new configuration. Cross-host or multi-user scenarios are explicitly out of scope this phase.

### Daemon → Plugin Spawn Callback (the inversion)

- **D-09:** Plugin **long-polls** the daemon for spawn requests: `GET /v1/spawns/wait` with a ~30s keepalive window. Daemon enqueues a `SpawnRequest { id, taskId, agent, priority, routing, projectId, projectRoot, timeoutMs, correlationId }`; plugin pulls, invokes `runtime.agent.runEmbeddedPiAgent` inside the gateway, and posts the outcome back via `POST /v1/spawns/{id}/result { sessionId, success, aborted, error, durationMs }`. On timeout, plugin reconnects immediately.
  - Rationale: plugin is the active puller — daemon never needs to initiate a TCP/socket connection inbound to the gateway (which OpenClaw's plugin-sdk doesn't expose). Survives daemon restarts (plugin reconnects), plugin restarts (daemon re-enqueues unclaimed requests on next pull). Well-understood pattern (GitHub Actions runners, Ansible pull mode, Buildkite agents all use it).
- **D-10:** Daemon-side spawn adapter is a **new `PluginBridgeAdapter` implementing `GatewayAdapter`**. The existing `StandaloneAdapter` (HTTP to OpenClaw) is retained for daemon-only installs with no registered plugin. Adapter selection happens at dispatch time: if any plugin currently has an active long-poll, use `PluginBridgeAdapter`; otherwise fall through to `StandaloneAdapter`.
  - Rationale: cleanly preserves the two deploy shapes — plugin-mode (bridge) and standalone-only (HTTP). Avoids conditionals inside a unified adapter, which is exactly the fragility CLAUDE.md flagged.
- **D-11:** Plugin registration with the daemon is **implicit via the long-poll connection**. A connected `/v1/spawns/wait` listener IS a registered plugin. Daemon's `availablePluginCount` = count of active long-polls. No separate register/unregister handshake — survives OpenClaw's per-session plugin reload cycle naturally.
  - Rationale: state-free, reuses the same socket connection we already have, zero teardown races. Explicit registration is deferred to the multi-plugin fan-out phase.
- **D-12:** When the daemon has a task to dispatch but no plugin is attached, the scheduler **holds the task in `ready/` and emits a structured diagnostic** (e.g., `log.warn({ taskId, reason: "no-plugin-attached" })`). Dispatch retries on the next poll once a plugin reconnects. Task is **not** moved to deadletter and does **not** fall through to `StandaloneAdapter` (that fallback is only for daemon-only installs where no plugin is expected).
  - Rationale: upholds PROJECT.md's core-value invariant — "Tasks never get dropped." Gateway restarts briefly disconnect plugins; we must not punish the task for that. Mode is determined at scheduler boot (presence of a plugin within first N polls), so pure-standalone deployments still use HTTP dispatch.

### Scope & Migration

- **D-13:** Phase 43 ships **openclaw-only**: daemon-owned `AOFService`, `PluginBridgeAdapter`, Unix-socket IPC (all routes above), openclaw plugin as thin bridge with long-poll spawn callback. IPC schemas reserve a `pluginId` field (Zod-optional, defaulting to `"openclaw"`) so non-openclaw plugins can later wire in without schema bumps, but no non-openclaw plugin ships this phase.
  - Rationale: phase is already large (removes a singleton, adds IPC surface, inverts dispatch model, migrates every tool handler). A second plugin doubles tests and docs for validation of a contract we're not yet consuming. Contract design-forward; wiring deferred.
- **D-14:** Migration is **automatic on upgrade via a new migration** under `src/packaging/migrations/` (next available number). The migration: (a) installs the daemon service if absent, (b) removes any Phase-42-era "daemon intentionally skipped" marker state, (c) is gated by the migration framework's existing snapshot/rollback (v1.3). Runs on `aof setup --auto --upgrade`.
  - Rationale: preserves AOF's seamless-upgrade guarantee (v1.3 milestone). Users don't rerun `install.sh`; they run `aof setup --auto --upgrade` per UPGRADING.md. Rollback works because the migration framework already supports it.

### Claude's Discretion

- **IPC error envelope shape:** `{ error: { kind: "validation"|"not-found"|"permission"|"internal"|..., message, details? } }` — planner/researcher picks exact kinds. Must cover Zod failure, store errors, permission denied, and daemon-internal failures; beyond that, schema is discretionary.
- **Long-poll keepalive window:** ~30s is a hint, not a contract. Planner calibrates against gateway keepalive and `socket.setTimeout` defaults. Must be >> typical task poll interval so plugin isn't reconnect-thrashing.
- **IPC client location in the plugin:** whether `registerAofPlugin` gets a new `DaemonIpcClient` helper, or the client is split into `tool-client.ts` + `spawn-poller.ts`, is planner choice. Follow the existing `src/dispatch/` decomposition style.
- **Zod validation placement:** double-validation is fine (plugin-side for fast-fail, daemon-side as source of truth). Planner may simplify to daemon-side only if the extra latency is negligible. Either way, `tool-registry.ts` schemas remain the single source of truth — the plugin side imports them, doesn't duplicate.
- **Permission enforcement (`PermissionAwareTaskStore`):** moves to the daemon; `actor` is in the IPC envelope. Plugin no longer needs org-chart load. If research surfaces a reason to keep it plugin-side, that's OK but must be justified.
- **Project resolution (`resolveProjectStore`):** moves to daemon side. Plugin passes `projectId` through; daemon owns the project-store cache. Plugin's `projectStores` map becomes vestigial — delete with D-02 cleanup.
- **`correlationId` propagation:** planner threads it through the IPC envelope (already in the tool-call signature today). Must survive tool-call → daemon dispatch → spawn request → plugin spawn → session completion for v1.5 trace continuity.
- **Retry / timeout defaults for IPC calls:** planner picks; a reasonable default is ~30s per invoke, with the caller's `timeoutMs` flowing through for `aof_dispatch`. Plugin should NOT retry state-mutating calls on timeout without an idempotency key — prefer surfacing the error.
- **Removal of `StandaloneAdapter`'s gateway-port auto-detect code path** when plugin is registered: kept — it still serves daemon-only installs. Touch only if it gets in the way.
- **Wording of diagnostic logs** (`"plugin attached"`, `"holding task: no plugin"`): planner/executor discretion.
- **Exact socket route versioning** (`/v1/...` prefix assumed here): fine to rename if `src/daemon/server.ts` adopts a different convention during this phase.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase specs & prior decisions

- `.planning/ROADMAP.md` §Active Phases / Phase 43 — goal statement, scope-large classification, dependency on Phase 42.
- `.planning/phases/42-installer-mode-exclusivity/42-CONTEXT.md` — **directly superseded** by Phase 43 D-01 through D-04. Every decision there must be understood to understand what this phase reverses. D-01 (symlink detection signal) is still active and this phase builds on it.
- `.planning/phases/42-installer-mode-exclusivity/42-01-PLAN.md` through `42-04-PLAN.md` — the implementation plans Phase 43 must reverse / migrate away from (esp. 42-02-PLAN.md install_daemon gate and 42-04-PLAN.md upgrade convergence).
- `.planning/PROJECT.md` — "Core value: tasks never get dropped" constrains D-12 (no deadletter on no-plugin). `Key Decisions` table — tool registry pattern (D-06), OS supervisor for restart (D-03), correlation ID at dispatch time (D-09 spawn payload).

### Core code that this phase rewrites

- `src/openclaw/adapter.ts` — THE seam. `schedulerService` singleton at L56 (D-02 removes), `registerAofPlugin` function (wholesale restructure into thin bridge), all 18 `api.registerTool` registrations (D-06 converts each to an IPC proxy), all `api.on(...)` handlers (D-07 selective forward).
- `src/plugin.ts` — entry point; `resolvePluginConfig` and `normalizeDataDir` stay; the `registerAofPlugin` call downstream changes shape.
- `src/daemon/daemon.ts` — gains PluginBridgeAdapter selection (D-10) and enlarges the HTTP server surface (D-05).
- `src/daemon/server.ts` — currently only `/healthz`, `/status`. All new IPC routes (D-05) land here or in a new router module colocated.
- `src/daemon/standalone-adapter.ts` — retained (D-10) for daemon-only deployments; only touch if adapter selection lives in or near this file.
- `src/dispatch/executor.ts` — `GatewayAdapter` interface and `MockAdapter`. PluginBridgeAdapter implements this interface; tests should land alongside.
- `src/dispatch/scheduler.ts` — `poll()` dispatches via the selected adapter; the new "no-plugin-attached → hold" behavior (D-12) likely lives here or in `task-dispatcher.ts`.
- `src/tools/tool-registry.ts` + all `src/tools/*-tools.ts` — the handlers the daemon now dispatches. Plugin-side IPC client re-exports `toolRegistry` schemas; handlers themselves don't change.

### Installer & migration

- `scripts/install.sh` — `install_daemon()` gate (Phase 42 D-03) reversed per D-01. The `plugin_mode_detected && skip` branch removed; `--force-daemon` path becomes a no-op (D-04).
- `src/cli/commands/daemon.ts` — `daemonInstall` handler. Still the entry point; unchanged by D-03 launch model.
- `src/daemon/service-file.ts` — `installService`, `uninstallService`. Unchanged; D-03 reuses the existing launchd/systemd plist.
- `src/packaging/migrations/` — migration framework (v1.3). Phase 43 adds a new numbered migration per D-14. Reference: `src/packaging/migrations/004-scaffold-repair.ts` pattern (idempotent, rollback-aware).

### Tracing & observability constraints

- `src/dispatch/callback-delivery.ts` — hosts `AOF_CALLBACK_DEPTH` env bridge. CLAUDE.md: "Don't add more" env mutations. IPC envelope carries `callbackDepth` in-payload (D-06 envelope extension point), not via env.
- `src/events/logger.ts` — event logging. Still daemon-side (no change); plugin just emits diagnostic logs via `createLogger("plugin-bridge")` or similar.

### Testing harness

- `src/__tests__/` + colocated `__tests__/` — `createTestHarness()` pattern. Plan must cover: (a) plugin→daemon IPC round-trip for each tool, (b) spawn long-poll round-trip, (c) no-plugin-attached hold-and-resume, (d) daemon restart mid-long-poll, (e) plugin register/deregister across OpenClaw session boundaries.
- `tests/integration/` — Phase 42 landed integration tests here using `AOF_INTEGRATION=1` gate. Phase 43's migration test belongs alongside.

### Project-level constraints

- `CLAUDE.md` §"Fragile — Tread Carefully" — "Plugin/standalone executor wiring: Two separate code paths. Changes risk breaking one mode while testing the other." This phase is the rewrite; mode fragility is eliminated by D-02, not finessed.
- `CLAUDE.md` §"Dispatch chain" — "scheduler.ts → task-dispatcher.ts → action-executor.ts → assign-executor.ts: tightly coupled. Changes cascade." PluginBridgeAdapter fits at the `assign-executor.ts` / `GatewayAdapter` seam — don't reshape the upstream chain.
- `CLAUDE.md` §"Config" — `getConfig()` only; no new `process.env` reads for IPC configuration.
- `CLAUDE.md` §"Logging" — `createLogger('component')` only; no `console.*`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`src/daemon/server.ts::createHealthServer`** — already a Unix-socket HTTP server with route dispatch. New IPC routes (D-05) extend this same server rather than opening a second listener. The `selfCheck` helper is the template for how the plugin should probe daemon readiness on connect.
- **`src/tools/tool-registry.ts`** — the single tool registry is what enables D-06 (single invokeTool envelope). Daemon-side IPC handler loops over `toolRegistry` exactly the way `registerAofPlugin` does today; plugin side imports the same schemas for optional client-side validation.
- **`src/openclaw/tool-invocation-context.ts::OpenClawToolInvocationContextStore`** — per-session route capture for notify-on-completion. Stays in the plugin (D-07); captured route is attached to `aof_dispatch` params at IPC call time via the existing `mergeDispatchNotificationRecipient` helper, which moves verbatim into the thin-bridge's invoke path.
- **`src/packaging/migrations/`** — rollback-aware migration pattern is the D-14 vehicle. 004-scaffold-repair is the canonical idempotent example.
- **`src/dispatch/executor.ts::GatewayAdapter` interface + `MockAdapter`** — the contract PluginBridgeAdapter implements. `MockAdapter` stays as the test double for daemon-only suites.

### Established Patterns

- **Adapter abstraction for dispatch** (PROJECT.md Key Decision, v1.0) — PluginBridgeAdapter slots in as a third implementation alongside `OpenClawAdapter` (in-process, going away) and `StandaloneAdapter` (HTTP, retained for daemon-only). This phase has strong precedent; don't reinvent the contract.
- **Unix-socket-first** — `daemon.sock` for health/status, `daemon.pid` for liveness. IPC transport choice (D-05) is the same idiom extended.
- **Migration framework with snapshots** (v1.3) — D-14 rides existing rails. No new migration plumbing.
- **Tool registry central, thin adapters** (PROJECT.md Key Decision) — D-06 is the purest expression of this pattern: one adapter (plugin) becomes one function, `invokeTool(name, params) → daemon`.
- **Correlation ID threaded through dispatch** (PROJECT.md Key Decision) — IPC envelope must carry it; spawn-request payload must carry it; plugin spawn result must carry it back. v1.5 trace continuity depends on this.

### Integration Points

- **Plugin `register()` flow** (`src/openclaw/adapter.ts` L72 onward) — today does: build stores, build logger, build engine, instantiate AOFService, register service/tools/hooks/HTTP routes, self-start scheduler. Post-43: build in-plugin `DaemonIpcClient`, wait for daemon reachable (with bounded retry), register tools (each proxies to client), register hooks (3 of 7 forward; 4 stay local), skip service registration entirely (daemon runs its own), skip HTTP routes (daemon hosts `/aof/status` and `/aof/metrics` itself). Service lifecycle removed.
- **Daemon `startAofDaemon`** (`src/daemon/daemon.ts` L46) — today selects `StandaloneAdapter` unconditionally when not dry-run. Post-43: construct both adapters (or a selector); dispatch flow checks "plugin attached?" at spawn time. Single place to land the D-10/D-12 logic.
- **OpenClaw plugin lifecycle** — OpenClaw reloads the AOF plugin on every agent session start. In-process singleton existed because `startPluginServices` runs once at gateway boot, BEFORE the memory plugin loads; self-start in `registerAofPlugin` compensated. Post-43: plugin `register()` is idempotent, just ensures a live IPC client. Daemon owns the "runs once" invariant.
- **Tool call merge-dispatch-notification** (`registerAofPlugin::mergeDispatchNotificationRecipient`) — runs plugin-side BEFORE IPC send, because it uses in-plugin `invocationContextStore`. Stays in the plugin IPC client's pre-send hook.

</code_context>

<specifics>
## Specific Ideas

- **"Plugin long-polls daemon" is a deliberate inversion.** The original mental model (ROADMAP.md Phase 43 "Why") is exactly this: daemon as authority, plugin as bridge. Long-poll makes it implementable without OpenClaw giving us an inbound socket listener. Reference pattern: GitHub Actions self-hosted runners, Buildkite agents, Ansible pull mode — all are clients that pull work from an authoritative server.
- **Phase 42 is explicitly superseded, not extended.** Phase 42 was a runtime workaround ("both shouldn't run at once — skip the daemon install"). Phase 43 is the root-cause fix ("only one *can* run — daemon is the only authority"). The 42 decisions are documented so migration code knows exactly which state to tear down.
- **`PluginBridgeAdapter` alongside `StandaloneAdapter`, not replacing it.** Pure-standalone installs (daemon + gateway on different hosts, or on the same host but using the openclaw HTTP API instead of plugin embedding) remain supported exactly as today. Phase 43 adds a third way to dispatch, doesn't remove the second.
- **Multi-plugin fan-out is design-ready but not shipped.** `pluginId` in the IPC envelope + long-poll-based implicit registration + tool-registry centralization are all the pieces a future slack/cli plugin needs. This phase proves the contract with openclaw; a follow-up wires the second plugin.
- **Migration is seamless** — rides the v1.3 migration framework. Users `aof setup --auto --upgrade` on existing installs and the daemon appears, plugin becomes thin, tasks keep flowing.

</specifics>

<deferred>
## Deferred Ideas

- **Non-OpenClaw plugins** (slack bridge, `aof` CLI plugin, other gateway integrations) — IPC contract designed for them (pluginId in envelope, implicit registration scales), but wiring is a future phase per plugin. Belongs after Phase 43 proves the contract in production.
- **Remote daemon over HTTP/TCP** — PROJECT.md constrains AOF to single-machine for v1. A TCP transport with token auth reopens the multi-host question and is deferred to v2.
- **Per-plugin permission scopes / ACLs** — current model: any plugin connected via socket can invoke any tool. Per-plugin permissions (e.g., "slack can read task state but not aof_dispatch") is a security phase to open once >1 plugin exists.
- **Runtime `scheduler.mode` switch** — Phase 42's deferred idea. A booted daemon standing down live (without reinstall) would enable `aof mode switch` UX. Not needed for Phase 43 — mode is determined at install time.
- **Second-plugin reference implementation** (e.g., a minimal `aof` CLI that registers as a plugin and invokes tools). Would validate the contract end-to-end but doubles this phase's scope; belongs in the follow-up phase that wires the first non-openclaw plugin.
- **Plugin-side retry policy for idempotent reads** — today's in-process path returns instantly; IPC adds round-trip latency. A caching layer in the plugin for pure-read tools (`aof_task_get`, `aof_task_list`) could reduce chatter. Premature optimization; measure first.
- **IPC observability / metrics** — request/response counts, latency histograms, error rates per tool. Useful but out of scope; today's metrics pipeline (`src/metrics/exporter.ts`) runs daemon-side anyway and picks up the tool execution metrics natively.
- **Daemon-to-plugin auth beyond socket perms** — if we ever expose the socket to a non-same-uid process (container side-mount, etc.), we'll need tokens. Unix socket perms are sufficient for the shipped scope.

</deferred>

---

*Phase: 43-thin-plugin-daemon-authority*
*Context gathered: 2026-04-17*
