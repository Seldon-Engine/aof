# Phase 43: Thin-plugin architecture — daemon as single authority — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-17
**Phase:** 43-thin-plugin-daemon-authority
**Areas discussed:** Phase 42 reconciliation, IPC transport + protocol, Daemon→plugin spawn callback, Scope cut

---

## Gray Area Selection

| Option | Description | Selected |
|--------|-------------|----------|
| Phase 42 reconciliation | Resolve install-skip conflict; daemon lifecycle under plugin-mode | ✓ |
| IPC transport + protocol | Socket vs HTTP, single envelope vs per-tool, auth, event forwarding | ✓ |
| Daemon→plugin spawn callback | Inversion mechanism for runEmbeddedPiAgent | ✓ |
| Scope cut for this phase | openclaw-only vs multi-plugin; migration path | ✓ |

**User's choice:** All four selected.

---

## Phase 42 Reconciliation

### Q1: Daemon install policy in plugin-mode post-Phase-43

| Option | Description | Selected |
|--------|-------------|----------|
| Always install daemon | Reverse Phase 42's skip; `--force-daemon` no-op | ✓ |
| Plugin auto-spawns daemon as subprocess | Gateway-supervised child; no launchd install in plugin-mode | |
| Feature-flagged rollout | Keep Phase 42 as v1.x default; scheduler.mode flag opts in | |

**User's choice:** Always install daemon (Recommended).
**Notes:** One shape in production; eliminates dual-code-path fragility CLAUDE.md flags.

### Q2: In-process AOFService path after this phase

| Option | Description | Selected |
|--------|-------------|----------|
| Remove entirely | Delete schedulerService singleton; plugin only speaks IPC | ✓ |
| Keep as offline/fallback mode | Fall back to embedded AOFService if daemon unreachable | |
| Keep behind dev/test-only flag | AOF_EMBEDDED_SERVICE=1 for tests; production single-authority | |

**User's choice:** Remove entirely (Recommended).
**Notes:** Structural enforcement of single-authority invariant.

### Q3: Daemon launch model

| Option | Description | Selected |
|--------|-------------|----------|
| launchd/systemd service | OS supervision; plugin register() only probes/connects | ✓ |
| Plugin-supervised child process | Plugin forks aof-daemon on register() | |
| Lazy on-demand spawn | Daemon starts on first IPC call, self-registers with launchd | |

**User's choice:** launchd/systemd service (Recommended).
**Notes:** Preserves v1.0 OS-level crash recovery decision.

### Q4: Phase 42 flag evolution

| Option | Description | Selected |
|--------|-------------|----------|
| --force-daemon no-op, auto-skip removed | Deprecation warning one release, then remove | ✓ |
| Invert: add --no-daemon for legacy | Requires keeping in-process path alive | |
| Leave Phase 42 wiring untouched | Thin-plugin strictly opt-in via --force-daemon | |

**User's choice:** --force-daemon no-op, auto-skip removed (Recommended).

---

## IPC Transport + Protocol

### Q1: Transport

| Option | Description | Selected |
|--------|-------------|----------|
| Unix socket, extend daemon.sock | Reuse existing /healthz+/status server; add /v1/tool/*, /v1/event/*, /v1/spawns/* | ✓ |
| HTTP on localhost (new TCP port) | Separate server on configurable port | |
| Hybrid: socket + HTTP | Both for openclaw vs future non-local plugins | |

**User's choice:** Unix socket, extend daemon.sock (Recommended).

### Q2: RPC shape

| Option | Description | Selected |
|--------|-------------|----------|
| Single invokeTool envelope | POST /v1/tool/invoke { name, params, ... } | ✓ |
| Route per tool | /v1/tools/aof_dispatch, /v1/tools/aof_task_complete, ... | |
| JSON-RPC 2.0 | Standard spec; streaming-friendly | |

**User's choice:** Single invokeTool envelope (Recommended).
**Notes:** Mirrors unified tool registry pattern (PROJECT.md Key Decision).

### Q3: Session/lifecycle event forwarding

| Option | Description | Selected |
|--------|-------------|----------|
| Forward handleSessionEnd only; keep invocationContextStore in-plugin | Selective: state-mutating hooks forward; capture hooks stay local | ✓ |
| Forward every event via IPC | Truly thin plugin; no in-memory caches | |
| Daemon polls plugin for events | Batched pull instead of push | |

**User's choice:** Selective forwarding (Recommended).
**Notes:** Minimizes IPC chatter; route capture stays fast and local.

### Q4: Auth model

| Option | Description | Selected |
|--------|-------------|----------|
| Unix socket filesystem perms only | 0600 same-uid is trust boundary | ✓ |
| Shared secret token | Daemon writes token file; plugin reads | |
| Plugin registration handshake | Daemon issues session token on connect | |

**User's choice:** Unix socket filesystem perms only (Recommended).

---

## Daemon→Plugin Spawn Callback

### Q1: How daemon triggers runEmbeddedPiAgent

| Option | Description | Selected |
|--------|-------------|----------|
| Plugin long-polls daemon for spawn requests | GET /v1/spawns/wait; POST /v1/spawns/{id}/result | ✓ |
| Daemon opens a second socket that plugin hosts | ~/.aof/data/plugin.sock; daemon POSTs synchronously | |
| Bidirectional stream over daemon.sock | Duplex framed protocol on existing connection | |

**User's choice:** Plugin long-polls daemon (Recommended).
**Notes:** Plugin as active puller — no inbound-to-gateway socket needed.

### Q2: Daemon-side adapter when plugin registered

| Option | Description | Selected |
|--------|-------------|----------|
| New PluginBridgeAdapter; StandaloneAdapter stays for daemon-only | Select at dispatch time based on plugin-attached | ✓ |
| PluginBridgeAdapter replaces StandaloneAdapter entirely | Daemon-only installs fail without plugin | |
| Unified adapter with runtime branch | One class, if(pluginConnected) internal | |

**User's choice:** New PluginBridgeAdapter, StandaloneAdapter retained (Recommended).

### Q3: Plugin registration mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Implicit via active long-poll | Connected /v1/spawns/wait = registered plugin | ✓ |
| Explicit register/unregister handshake | POST /v1/plugins/register with pluginId/capabilities | |
| File marker | Plugin writes state/plugin-active | |

**User's choice:** Implicit via active long-poll (Recommended).
**Notes:** State-free; survives OpenClaw per-session plugin reload.

### Q4: No-plugin-attached fallback

| Option | Description | Selected |
|--------|-------------|----------|
| Queue with timeout, emit diagnostic | Hold task in ready/; resume on reconnect | ✓ |
| Fail fast to deadletter | Immediate failure with reason "no-plugin" | |
| Fall back to StandaloneAdapter HTTP | Belt-and-suspenders preserving old behavior | |

**User's choice:** Queue with timeout, emit diagnostic (Recommended).
**Notes:** Upholds PROJECT.md core value: tasks never get dropped.

---

## Scope Cut

### Q1: Phase-43 delivery bounds

| Option | Description | Selected |
|--------|-------------|----------|
| openclaw-only cleanup; design for fan-out but don't wire it | pluginId in envelope; only openclaw client | ✓ |
| openclaw + reference second plugin (CLI) | Prove fan-out contract now | |
| Just carve out PluginBridgeAdapter + IPC contract; keep plugin fat | Smallest diff; plugin stays holding schedulerService | |

**User's choice:** openclaw-only cleanup; design for fan-out (Recommended).

### Q2: Migration story

| Option | Description | Selected |
|--------|-------------|----------|
| Automatic on upgrade; migration 00N handles it | Rides v1.3 migration framework with snapshot rollback | ✓ |
| Manual: release notes direct users to reinstall | UPGRADING.md documents steps | |
| Major version bump (v2.0) + feature flag | scheduler.mode flag; default flipped in v2.0 | |

**User's choice:** Automatic on upgrade via migration (Recommended).

### Q3: Explicitly out of scope (multi-select)

| Option | Description | Selected |
|--------|-------------|----------|
| Slack/CLI/other non-openclaw plugins | Contract designed, wiring deferred | ✓ |
| Remote daemon (HTTP transport) | Unix socket only; TCP/remote deferred to v2 | ✓ |
| Per-plugin permission scopes | Any connected plugin can invoke any tool | ✓ |
| scheduler.mode runtime switch | Install-time mode only | ✓ |

**User's choice:** All four deferred (Recommended).

---

## Claude's Discretion

- IPC error envelope shape (kinds covered; exact schema)
- Long-poll keepalive window (~30s hint)
- IPC client module layout in the plugin
- Zod validation placement (plugin + daemon vs daemon-only)
- Permission enforcement location (moves to daemon, planner may justify keeping local)
- Project resolution (moves to daemon)
- correlationId propagation path (must survive full round-trip)
- IPC retry / timeout defaults
- Diagnostic log wording
- Socket route versioning convention

## Deferred Ideas

- Non-OpenClaw plugins (slack, cli, other gateways)
- Remote daemon over HTTP/TCP
- Per-plugin permission scopes / ACLs
- Runtime scheduler.mode switch
- Second-plugin reference implementation
- Plugin-side read caching
- IPC observability metrics
- Token-based auth beyond socket perms

## Meta

- Continuation prompt answered: "Ready for context" (all follow-up items are planner/researcher-resolvable implementation details).
