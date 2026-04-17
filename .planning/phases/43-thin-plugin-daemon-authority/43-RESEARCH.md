# Phase 43: Thin-plugin architecture — daemon as single authority — Research

**Researched:** 2026-04-17
**Domain:** Node.js IPC over Unix domain sockets; long-polling control-plane protocols; adapter-pattern refactoring; migration framework
**Confidence:** HIGH (architecture + internal code), MEDIUM (long-poll keepalive calibration), LOW (none)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Phase 42 Reconciliation**
- **D-01** Installer **always** installs the `aof-daemon` service in plugin-mode. Phase 42 D-03 (auto-skip when plugin-mode detected) is reversed. New install-time decision is no longer mode-dependent.
- **D-02** The in-process `AOFService` path in the plugin is **removed entirely**. `schedulerService` singleton, `service.start()` self-bootstrap, and the `schedulerService ?? new AOFService(...)` branch in `registerAofPlugin` all go. Plugin `register()` connects to the daemon via IPC; it no longer instantiates or owns an `AOFService`.
- **D-03** Daemon launched as launchd (macOS) / systemd (Linux) user service — same supervision model as standalone today. Plugin `register()` only probes and connects over the socket; it never spawns `aof-daemon`.
- **D-04** Phase 42's `--force-daemon` flag becomes a no-op with a deprecation warning for one release cycle, then is removed. No `--no-daemon` inverse is introduced.

**IPC Transport & Protocol**
- **D-05** Transport is the existing Unix domain socket `daemon.sock` (hosted by `src/daemon/server.ts`). New routes extend the same server: `POST /v1/tool/invoke`, `POST /v1/event/session-end`, `POST /v1/event/agent-end`, `POST /v1/event/before-compaction`, `GET /v1/spawns/wait`, `POST /v1/spawns/{id}/result`. Existing `/healthz` and `/status` unchanged.
- **D-06** RPC shape is a **single `invokeTool` envelope**: `POST /v1/tool/invoke { name, params, actor, projectId, correlationId, toolCallId } → { result } | { error }`. Daemon dispatches against `tool-registry.ts`. Adding a new tool requires no new IPC route.
- **D-07** Session lifecycle events: **selective forwarding**. Only state-mutating hooks forward via IPC (`session_end`, `agent_end`, `before_compaction`). High-freq hooks (`before_tool_call`, `after_tool_call`, `message_received`, `message_sent`) stay local — they mutate no daemon-owned state. Captured route is attached as a parameter when `aof_dispatch` is invoked via IPC.
- **D-08** Auth = Unix socket filesystem permissions only. `daemon.sock` already `0600` owned by invoking user.

**Daemon → Plugin Spawn Callback**
- **D-09** Plugin **long-polls** the daemon: `GET /v1/spawns/wait` with ~30s keepalive. Daemon enqueues `SpawnRequest`, plugin invokes `runtime.agent.runEmbeddedPiAgent`, posts outcome to `POST /v1/spawns/{id}/result`. On timeout, plugin reconnects immediately. Unclaimed requests re-enqueue on plugin reconnect.
- **D-10** Daemon-side spawn adapter is a **new `PluginBridgeAdapter` implementing `GatewayAdapter`**. `StandaloneAdapter` retained for daemon-only installs. Adapter selection at dispatch time: if any plugin has active long-poll → `PluginBridgeAdapter`; else → `StandaloneAdapter`.
- **D-11** Plugin registration is **implicit via long-poll connection**. `availablePluginCount` = count of active long-polls. No separate register/unregister handshake.
- **D-12** When daemon has a task to dispatch but no plugin is attached, scheduler **holds the task in `ready/` and emits a structured diagnostic**. Task is **not** moved to deadletter and does **not** fall through to `StandaloneAdapter` (that fallback is only for daemon-only installs).

**Scope & Migration**
- **D-13** Phase 43 ships **openclaw-only**. IPC schemas reserve `pluginId` field (Zod-optional, defaulting to `"openclaw"`) so non-openclaw plugins can wire in later without schema bumps.
- **D-14** Migration is **automatic on upgrade via a new migration** under `src/packaging/migrations/` (next available number: `007`). Migration (a) installs the daemon service if absent, (b) removes any Phase-42-era "daemon intentionally skipped" marker state, (c) gated by migration framework's existing snapshot/rollback. Runs on `aof setup --auto --upgrade`.

### Claude's Discretion
- IPC error envelope shape (must cover Zod failure, store errors, permission denied, daemon-internal failures).
- Long-poll keepalive window (~30s is a hint, not a contract — calibrate against gateway keepalive and `socket.setTimeout` defaults).
- IPC client decomposition in plugin (single `DaemonIpcClient` vs split `tool-client.ts` + `spawn-poller.ts`).
- Zod validation placement (plugin-side fast-fail vs daemon-side only). `tool-registry.ts` schemas remain single source of truth.
- `PermissionAwareTaskStore` moves to daemon; `actor` is in IPC envelope.
- `resolveProjectStore` moves to daemon; plugin passes `projectId` through.
- `correlationId` propagation through envelope → spawn → result.
- Retry/timeout defaults. Plugin MUST NOT retry state-mutating calls on timeout without an idempotency key — surface the error.
- Removal of `StandaloneAdapter`'s gateway-port auto-detect when plugin registered: kept — still serves daemon-only installs.

### Deferred Ideas (OUT OF SCOPE)
- Non-OpenClaw plugins (slack bridge, `aof` CLI plugin, other gateways) — contract designed for them but wiring is a future phase.
- Remote daemon over HTTP/TCP — Unix socket only this phase.
- Per-plugin permission scopes / ACLs — security phase, opens after >1 plugin exists.
- Runtime `scheduler.mode` switch — mode determined at install time, no live swap.
- Second-plugin reference implementation — validates contract end-to-end but doubles scope.
- Plugin-side caching for pure-read tools — premature optimization; measure first.
- IPC observability / metrics — daemon-side metrics pipeline picks up tool execution natively.
- Daemon-to-plugin auth beyond socket perms.
</user_constraints>

<phase_requirements>
## Phase Requirements

No external REQUIREMENTS.md mapping exists for Phase 43 (architectural phase, not feature-driven). Requirements coverage maps to CONTEXT.md decision IDs D-01 through D-14. The planner must ensure every D-NN appears in at least one plan's requirements list.

| ID | Description | Research Support |
|----|-------------|------------------|
| D-01 | Installer always installs daemon | §Phase-42 Reversal, §Migration |
| D-02 | In-process `AOFService` removed from plugin | §Plugin Thin-Bridge Restructure, §Single-Writer Invariant |
| D-03 | Daemon launched as launchd/systemd service | §Environment Availability (unchanged from today) |
| D-04 | `--force-daemon` no-op deprecation | §Migration, §Installer Changes |
| D-05 | Unix socket + new routes | §IPC Transport, §Route Specification |
| D-06 | Single `invokeTool` envelope | §IPC Envelope Design |
| D-07 | Selective event forwarding | §Event Forwarding Strategy |
| D-08 | Socket 0600 auth | §Security Domain |
| D-09 | Plugin long-polls daemon | §Long-Poll Protocol |
| D-10 | `PluginBridgeAdapter` alongside `StandaloneAdapter` | §Adapter Selection |
| D-11 | Implicit plugin registration via long-poll | §Registration Model |
| D-12 | No-plugin-attached tasks held in `ready/` | §Hold-and-Resume Behavior |
| D-13 | openclaw-only, `pluginId` reserved | §Schema Design |
| D-14 | Migration 007 | §Migration Strategy |
</phase_requirements>

## Summary

Phase 43 inverts AOF's control plane: the daemon becomes the single writer and `AOFService` owner; the OpenClaw plugin becomes a thin bridge that (a) proxies tool calls to the daemon over Unix-socket HTTP, and (b) long-polls the daemon for spawn requests that must be executed inside the gateway process. The canonical architecture reference already exists in this codebase — Phase 42 solved the *runtime coexistence* problem (install-time mode-exclusivity); Phase 43 solves the *architectural* problem by eliminating the in-process `AOFService` code path entirely.

The core risk is NOT "can we build the IPC?" (Node's `http.createServer` on a Unix socket + `http.request({ socketPath })` already powers `/healthz` + `/status`; extending that server with streaming long-poll endpoints is straightforward). The core risks are:

1. **Long-poll lifecycle edge cases.** Plugin drops mid-poll → daemon must detect via `res.on('close')`, re-enqueue unclaimed requests, not leak timers or response handles. Reference patterns: GitHub Actions self-hosted runners, Buildkite agents, Ansible pull — all use this pattern, all document the same edge cases.
2. **OpenClaw per-session plugin reload.** The module-level `schedulerService` singleton (`src/openclaw/adapter.ts:56`) survives reload *by accident* because module scope persists across `register()` calls. Post-D-02, a `DaemonIpcClient` must do the same — it is a per-module singleton, not per-registration. Losing that structural property re-introduces the bug we're fixing.
3. **Daemon-down-at-plugin-register.** `register()` cannot silently fall back to in-process — the in-process code is gone. Bounded retry with health-probe is required, then fail-loud if the daemon is still unreachable (plugin logs a structured error, user sees it via OpenClaw logs).
4. **Dispatch adapter selection.** The current `GatewayAdapter` interface is already correctly shaped for this — `PluginBridgeAdapter` is just a third implementation. The selection logic must live in one place (likely in `startAofDaemon`, building both adapters and a selector) so the `scheduler.ts` → `task-dispatcher.ts` → `assign-executor.ts` chain (CLAUDE.md "fragile" list) is untouched.
5. **Migration idempotency.** The Phase-42 "daemon intentionally skipped" is NOT a persisted marker — it was a runtime `install.sh` branch. The D-14 migration only needs to install the daemon service if the plist/unit file is absent; there is no legacy *state* to remove. This is lighter than the CONTEXT.md wording implies and simplifies the migration considerably.

**Primary recommendation:** Ship this phase in 5 waves: (Wave 0) test harness — integration test covering all five scenarios from CONTEXT.md line 119, with Unix-socket fixtures that simulate daemon-restart and plugin-drop; (Wave 1) IPC envelope + `/v1/tool/invoke` route — daemon-side dispatch loop against `tool-registry.ts`, plugin-side `DaemonIpcClient.invokeTool()`, tool handlers unchanged; (Wave 2) long-poll `GET /v1/spawns/wait` + `POST /v1/spawns/{id}/result`, `PluginBridgeAdapter`, adapter selector in `startAofDaemon`, hold-in-ready behavior in scheduler; (Wave 3) selective event forwarding (`session_end`, `agent_end`, `before_compaction`) + plugin's thin-bridge restructure (remove `AOFService`, `schedulerService` singleton, `resolveProjectStore`, self-start block); (Wave 4) installer reversal + Migration 007 + `--force-daemon` deprecation warn.

## Architectural Responsibility Map

Phase 43 is an IPC / control-plane refactor — "tiers" here are process boundaries, not web-app tiers.

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Tool handler dispatch | Daemon process (HTTP server) | — | D-06: single authority. `tool-registry.ts` handlers run in the daemon. |
| Tool-call IPC client | Plugin process (inside OpenClaw gateway) | — | Plugin is a pure bridge; each `api.registerTool` proxies to daemon. |
| Agent spawn execution | Plugin process (`runtime.agent.runEmbeddedPiAgent`) | — | Only reachable from inside the OpenClaw gateway — can't be called from daemon. |
| Spawn request queue | Daemon process | — | D-09/D-11: daemon enqueues, plugin pulls. |
| Task store mutations | Daemon process | — | D-02: single writer. Structural invariant. |
| Permission enforcement (`PermissionAwareTaskStore`) | Daemon process | — | `actor` travels in IPC envelope; daemon holds org-chart. |
| Project store resolution (`resolveProjectStore`) | Daemon process | — | Plugin's `projectStores` map becomes vestigial — `projectId` in envelope. |
| Notification-recipient capture (`OpenClawToolInvocationContextStore`) | Plugin process | — | Per-session OpenClaw idiom (sessionKey/sessionId). Translated plugin-side before IPC send (same as today). |
| Session-lifecycle hooks: `session_end`, `agent_end`, `before_compaction` | Plugin process (capture) → Daemon process (state change) | — | D-07: plugin forwards via IPC. |
| Session-lifecycle hooks: `before_tool_call`, `after_tool_call`, `message_received`, `message_sent` | Plugin process only | — | D-07: high-freq, local-only, mutates no daemon state. |
| Health / status / socket listener | Daemon process | — | Existing `src/daemon/server.ts`. Phase 43 adds routes, not a second listener. |
| Migration runner | CLI (`aof setup --auto --upgrade`) → migration framework | — | D-14: existing v1.3 pattern. |

## Standard Stack

All packages below are already installed at the stated versions. Phase 43 adds **zero** new runtime dependencies. [VERIFIED: `package.json` at commit 49715dc]

### Core (existing, no version bump required)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `zod` | ^3.24.0 | IPC envelope schema (request + response) | Already the "schema source of truth" per CLAUDE.md; `tool-registry.ts` uses it. |
| `node:http` | built-in (Node ≥22) | HTTP server on Unix socket + client request | Already used by `src/daemon/server.ts` + `src/daemon/standalone-adapter.ts`. [CITED: Node docs — `http.createServer`, `http.request({ socketPath })`] |
| `pino` | ^9.14.0 | Structured logs on both sides | `createLogger('plugin-bridge')`, `createLogger('daemon-ipc')` per CLAUDE.md convention. |
| `commander` | ^14.0.3 | CLI flag surface (no new flags; `--force-daemon` demoted) | Existing `daemon install` command unchanged. |
| `better-sqlite3` | ^12.6.2 | Memory/FTS (unchanged) | N/A to this phase — daemon already owns memory.db; plugin no longer accesses it. |
| `vitest` | ^3.0.0 | Unit + integration + E2E | Existing. |

### Supporting (existing utilities)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:http::request({ socketPath })` | built-in | Plugin → daemon RPC client | Every `invokeTool`, every event forward, long-poll connect. |
| `AbortSignal.timeout()` | built-in (Node ≥22) | Per-call IPC timeout | Caller's `timeoutMs` for `aof_dispatch`; default 30s for pure-read tools. |
| `res.on('close')` | built-in | Server-side long-poll drop detection | Plugin disconnects mid-poll → re-enqueue spawn request. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Plain HTTP on Unix socket | JSON-RPC (e.g. `jsonrpc-lite`) | More ceremony, another dep, no gain — we're single-host same-uid. |
| Long-poll | WebSocket / server-sent events | `ws` adds a dep; SSE via HTTP works but tools don't need streaming frames. Long-poll is the simplest request/response model with one open connection. |
| JSON-over-HTTP body | `msgpack` / CBOR | ~microsecond wins on a same-host Unix socket; not worth the ser/de complexity. |
| Hand-rolled long-poll | `node-pg-listen`-style trigger | Overkill — we have one queue with one consumer class. |

**Installation:** None required. Phase 43 is a pure refactor + feature addition using existing deps.

**Version verification (2026-04-17):** `node --version` → v22.22.2 [VERIFIED: local]. `zod@^3.24.0` — latest at time of research is 3.25.x, minor stays compatible [VERIFIED: package.json]. No dep upgrades proposed this phase.

## IPC Transport — Detailed Design

### Route Specification (D-05)

All routes mount on the existing Unix-domain-socket HTTP server (`createHealthServer` in `src/daemon/server.ts`). Extend, don't duplicate.

| Method | Path | Purpose | Request body | Response |
|--------|------|---------|--------------|----------|
| GET | `/healthz` | Liveness (existing) | — | `{ status: "ok" }` |
| GET | `/status` | Full status (existing) | — | `HealthStatus` |
| POST | `/v1/tool/invoke` | Tool-call RPC (D-06) | `InvokeToolRequest` | `InvokeToolResponse` |
| POST | `/v1/event/session-end` | Session-end forward (D-07) | `SessionEndEvent` | `{ ok: true }` |
| POST | `/v1/event/agent-end` | Agent-end forward (D-07) | `AgentEndEvent` | `{ ok: true }` |
| POST | `/v1/event/before-compaction` | Before-compaction forward (D-07) | `BeforeCompactionEvent` | `{ ok: true }` |
| GET | `/v1/spawns/wait` | Long-poll for spawn request (D-09) | — | `SpawnRequest` (after 0..N seconds) or 204 on keepalive timeout |
| POST | `/v1/spawns/{id}/result` | Post spawn outcome (D-09) | `SpawnResult` | `{ ok: true }` |

### IPC Envelope Schema Sketch (D-06)

```ts
// src/ipc/schemas.ts (NEW — leaf module, imported by both plugin and daemon)
import { z } from "zod";

export const InvokeToolRequest = z.object({
  pluginId: z.string().default("openclaw"),  // D-13: reserved for multi-plugin fan-out
  name: z.string(),                           // e.g. "aof_dispatch"
  params: z.record(z.unknown()),              // passed to the registered Zod schema in tool-registry
  actor: z.string().optional(),               // → permission enforcement daemon-side
  projectId: z.string().optional(),           // → resolveProjectStore daemon-side
  correlationId: z.string().optional(),       // → v1.5 trace continuity
  toolCallId: z.string(),                     // plugin's OpenClaw tool-call id (for logging)
  callbackDepth: z.number().int().nonnegative().default(0),  // in-envelope, NOT via env (CLAUDE.md)
});
export type InvokeToolRequest = z.infer<typeof InvokeToolRequest>;

export const IpcErrorKind = z.enum([
  "validation",       // Zod parse failed (envelope or inner params)
  "not-found",        // tool name not in registry, task not found
  "permission",       // PermissionAwareTaskStore denied
  "timeout",          // daemon-internal timeout (not caller-imposed)
  "internal",         // unhandled exception in handler
  "unavailable",      // daemon shutting down / draining
]);
export type IpcErrorKind = z.infer<typeof IpcErrorKind>;

export const IpcError = z.object({
  kind: IpcErrorKind,
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

export const InvokeToolResponse = z.union([
  z.object({ result: z.unknown() }),
  z.object({ error: IpcError }),
]);
export type InvokeToolResponse = z.infer<typeof InvokeToolResponse>;

export const SpawnRequest = z.object({
  id: z.string(),                              // daemon-generated UUID
  taskId: z.string(),
  taskPath: z.string(),
  agent: z.string(),
  priority: z.string(),
  thinking: z.string().optional(),
  routing: z.object({
    role: z.string().optional(),
    team: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  projectId: z.string().optional(),
  projectRoot: z.string().optional(),
  taskRelpath: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
  correlationId: z.string().optional(),
});
export type SpawnRequest = z.infer<typeof SpawnRequest>;

export const SpawnResultPost = z.object({
  sessionId: z.string(),
  success: z.boolean(),
  aborted: z.boolean(),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
  durationMs: z.number().nonnegative(),
});
```

**Key property:** `InvokeToolRequest.params` is `z.record(z.unknown())` at the envelope layer; the **inner** validation against the tool-specific schema happens daemon-side via `toolRegistry[name].schema.safeParse(params)`. Plugin can optionally pre-validate using the same import for fast-fail (Claude's Discretion — leaning toward YES because it keeps today's error UX). Single source of truth remains `src/tools/tool-registry.ts`.

**Error envelope kinds** enumerated above cover:
- `validation` → Zod `.issues` attached via `details`
- `not-found` → registry miss or `store.get()` returned null
- `permission` → `PermissionAwareTaskStore` threw
- `timeout` → daemon-side handler exceeded internal budget (distinct from caller-imposed `timeoutMs` on `aof_dispatch`)
- `internal` → unhandled exception, logged with `err` field per CLAUDE.md
- `unavailable` → `setShuttingDown(true)` is active

**`callbackDepth` in-envelope:** Today `dispatch/callback-delivery.ts` sets `process.env.AOF_CALLBACK_DEPTH = String(...)` before invoking a subscriber callback, so the subscriber's `aof_dispatch` call in-process reads it via `parseInt(process.env.AOF_CALLBACK_DEPTH ?? "0", 10)` (src/mcp/shared.ts:95). Post-43 the subscriber's `aof_dispatch` goes through IPC — we carry `callbackDepth` in-envelope so the daemon doesn't need a new env mutation. CLAUDE.md explicitly forbids adding more env mutations. [VERIFIED: `src/dispatch/callback-delivery.ts:352,400`]

### Route Implementation Pattern

Follow the existing `createHealthServer` style exactly — `IncomingMessage`/`ServerResponse` callbacks per route, no Express / Fastify / Koa introduced. The server.ts module can either (a) get a helper function per route and loop, or (b) be extended inline; planner's discretion. Note that `createHealthServer` currently cascades through `if` statements — a `switch(req.url + req.method)` or a small route map is cleaner for 8 routes than a long if-chain.

```ts
// Sketch — daemon-side /v1/tool/invoke handler
// Source pattern: src/daemon/server.ts existing /healthz and /status handlers
async function handleInvokeTool(req: IncomingMessage, res: ServerResponse, deps: IpcDeps): Promise<void> {
  const body = await readBody(req);  // helper — accumulate chunks, JSON.parse, bounded size
  const envelope = InvokeToolRequest.safeParse(JSON.parse(body));
  if (!envelope.success) {
    return sendError(res, 400, { kind: "validation", message: "invalid envelope", details: { issues: envelope.error.issues } });
  }
  const { name, params, actor, projectId, correlationId, toolCallId, callbackDepth } = envelope.data;

  const def = toolRegistry[name];
  if (!def) return sendError(res, 404, { kind: "not-found", message: `tool "${name}" not registered` });

  const inner = def.schema.safeParse(params);
  if (!inner.success) {
    return sendError(res, 400, { kind: "validation", message: `invalid params for ${name}`, details: { issues: inner.error.issues } });
  }

  try {
    const store = await deps.resolveStoreForRequest({ actor, projectId });
    const ctx: ToolContext = { store, logger: deps.logger, projectId };
    const result = await def.handler(ctx, inner.data);
    sendJson(res, 200, { result });
  } catch (err) {
    deps.log.error({ err, name, toolCallId, correlationId }, "tool handler failed");
    sendError(res, 500, { kind: classifyError(err), message: errorMessage(err) });
  }
}
```

## Single-Writer Invariant Enforcement

**Today's problem:** The plugin has a module-level `let schedulerService: AOFService | null = null;` at `src/openclaw/adapter.ts:56`. On each per-session plugin reload, if `schedulerService` is null, a new one is created; if not, the existing one is reused. In standalone mode, `src/daemon/daemon.ts` creates its *own* `AOFService`. Both run `poll()` against the same filesystem (Phase 42's problem).

**Post-D-02:** The plugin contains **no** `AOFService` import, no `poll()` call, no task-store mutation code path. The dual-code-path fragility in CLAUDE.md's "Fragile — Tread Carefully" list disappears structurally — enforcement is not runtime, it's grep-able:

```bash
# After Wave 3 lands, this must return zero hits under src/openclaw/:
grep -rn "new AOFService" src/openclaw/   # must be empty
grep -rn "schedulerService" src/openclaw/  # must be empty
```

**Second plugin process (OpenClaw reload):** OpenClaw reloads the plugin on every agent session start. The module-level `DaemonIpcClient` (analogous to today's `schedulerService` singleton — same mechanism, different object) survives reload because Node module scope persists. If reload *does* replace the module instance (tests suggest it doesn't for memory plugins, but we should guard), the next `register()` creates a fresh client — idempotent: opening a second long-poll against the daemon just means the daemon sees two active plugin connections (D-11 implicit registration). Not wrong, just temporarily wasteful; one goes idle within ~30s.

**Daemon DOWN at plugin `register()`:** Plugin `register()` must NOT silently succeed in that state. Recommended flow:

1. Attempt `selfCheck(socketPath)` (already exists in `src/daemon/server.ts:70`) with short timeout (~2s).
2. If fail: log structured warning `log.warn({ socketPath, err }, "daemon unreachable on register, retrying")`, schedule retry with backoff (1s → 2s → 4s → 8s, cap 30s).
3. Plugin-side tool handlers registered synchronously but each `invokeTool` call blocks on "daemon reachable" state. If the daemon has been unreachable for > a budget (~60s default), return an `{ error: { kind: "unavailable", message: "daemon not reachable" } }` to the caller so the agent sees a loud error, not silence.
4. **Never** fall back to in-process — the code isn't there.

This is simpler than it sounds because `selfCheck` already exists and `daemon.sock` status is cheap to probe.

## Long-Poll Protocol — Implementation Detail

### Server side (daemon hosting `GET /v1/spawns/wait`)

```ts
// Sketch — daemon-side long-poll handler
// Key references:
//   - res.on('close') for drop detection — ref: nodejs docs http.ServerResponse
//   - server.keepAliveTimeout tuning — ref: nodejs docs Server class
async function handleSpawnWait(req: IncomingMessage, res: ServerResponse, queue: SpawnQueue): Promise<void> {
  const claimant = queue.claim();  // attempt to pop oldest unclaimed SpawnRequest
  if (claimant) {
    return sendJson(res, 200, claimant);
  }

  // No work available — hold the connection open.
  const keepAliveMs = 25_000;  // see §Keepalive Calibration
  const timer = setTimeout(() => {
    res.writeHead(204);   // no content — plugin reconnects immediately
    res.end();
  }, keepAliveMs);

  const onEnqueue = (sr: SpawnRequest) => {
    clearTimeout(timer);
    queue.off("enqueue", onEnqueue);
    // Claim this specific request — atomic with the pop.
    if (queue.tryClaim(sr.id)) {
      sendJson(res, 200, sr);
    } else {
      // Race: another long-poll claimed first. Re-register.
      registerWaiter();
    }
  };

  const onClose = () => {
    clearTimeout(timer);
    queue.off("enqueue", onEnqueue);
    // Plugin dropped before we had work — no unclaim needed.
  };

  res.on('close', onClose);
  queue.on("enqueue", onEnqueue);
}
```

### Plugin side (long-poll client)

```ts
// Sketch — plugin-side spawn-poller
// Reference patterns: GitHub Actions self-hosted runner, Buildkite agent
async function spawnPollerLoop(client: DaemonIpcClient, spawnHandler: (sr: SpawnRequest) => Promise<SpawnResultPost>): Promise<never> {
  while (true) {
    try {
      const sr = await client.waitForSpawn({ timeoutMs: 30_000 });   // returns undefined on 204
      if (!sr) continue;  // keepalive timeout — reconnect immediately, no backoff
      // Fire-and-forget: the spawn is async; we don't block the poll loop on runEmbeddedPiAgent.
      // Post result when spawn completes.
      void spawnHandler(sr)
        .then(result => client.postSpawnResult(sr.id, result))
        .catch(err => client.postSpawnResult(sr.id, {
          sessionId: "unknown", success: false, aborted: false,
          error: { kind: "spawn-exception", message: err?.message ?? String(err) },
          durationMs: 0,
        }));
      // Loop continues — next iteration reconnects for the NEXT request.
    } catch (err) {
      if (isAbortError(err)) continue;       // our own abort on shutdown
      if (isConnectionReset(err)) {
        await sleep(backoff.next());         // bounded: 1s → 2s → 4s → 8s, cap 30s
        continue;
      }
      log.warn({ err }, "unexpected spawn poll error, retrying");
      await sleep(1000);
    }
  }
}
```

### Keepalive Calibration

[CITED: Node docs — `server.keepAliveTimeout` defaults to 5000ms in Node 22; `server.headersTimeout` should be ~1s > keepAliveTimeout]
[CITED: Better Stack — "Target server HTTP keep-alive timeouts must always be greater than client timeouts"]

The ~30s window from CONTEXT.md D-09 is fine. Concrete recommendation:

- **Server-side keepalive hold:** 25_000 ms. Short enough to survive Node's default 5s `keepAliveTimeout` (we're holding the response body open, not relying on HTTP keepalive between requests). Long enough to avoid thrash.
- **Client-side request timeout:** 30_000 ms (AbortSignal.timeout). Must be > server-side hold or we'll abort good requests.
- **Server must bump `keepAliveTimeout`:** If `server.keepAliveTimeout` stays at 5s default, an idle TCP keepalive frame could close the connection mid-hold. Set to 60_000 for this server: `healthServer.keepAliveTimeout = 60_000; healthServer.headersTimeout = 61_000;`

**Edge case — plugin reconnects faster than 30s under high task rate:** That's fine. Each reconnect is a single `http.request` hit; no auth; no DB query on a hot empty queue. The only real cost is file descriptor churn, and `daemon.sock` is a local Unix socket — orders of magnitude faster than any socket churn concern.

### Plugin-drop-mid-long-poll Detection

[CITED: Node docs — `res.on('close')` fires when the underlying connection is destroyed]

Server uses `res.on('close')` (fires on client disconnect, not on `res.end()`) to detect plugin drop. On drop: remove the `enqueue` listener, cancel the keepalive timer. The spawn queue is **not mutated** — nothing was claimed. Next plugin reconnect, the same pending request is handed out.

**For claimed-but-not-yet-posted-result state** (plugin disconnected *after* receiving a spawn request but *before* posting the result): this is the "plugin crash mid-spawn" case. Options:

1. **Lease with TTL** on claimed requests — if plugin doesn't post result within N minutes, mark the spawn request as unclaimed and re-dispatch. Simplest to reason about. Recommended.
2. **Just wait for the AOF lease system to kick in** — the task itself has a lease (300s default). If the plugin crashes mid-spawn, lease expires, scheduler re-dispatches. This works today and costs zero new code.

**Recommendation: option 2.** The AOF lease system (`src/store/lease.ts`, `src/dispatch/lease-manager.ts`) already handles "agent took task but didn't complete" — a crashed plugin is just a special case of that. No new spawn-request-lease primitive needed.

### Reference Patterns from Other Systems

- **GitHub Actions self-hosted runner:** Long-polls `/_apis/distributedtask/pools/.../jobs` with ~30s timeout, POSTs result to `/_apis/distributedtask/jobs/{id}/...`. Same shape. [VERIFIED: published behavior, confirmed via community posts]
- **Buildkite agent:** Long-polls `/v3/agents/{id}/ping` with variable interval. Same reconnect-on-timeout-is-cheap property.
- **Ansible pull mode:** Client-initiated rather than server-push — same inversion justification (server can't initiate connection to client behind NAT/firewall).

Our justification maps directly: OpenClaw's plugin-sdk doesn't expose an inbound-socket listener for the daemon to push to. Plugin-as-client is the only shape.

## Adapter Selection & Dispatch

### Where selection happens (D-10)

Today in `src/daemon/daemon.ts::startAofDaemon` (line 73-75):

```ts
const executor = opts.dryRun
  ? undefined
  : new StandaloneAdapter({ gatewayUrl: opts.gatewayUrl, gatewayToken: opts.gatewayToken });
```

Post-43:

```ts
// Construct both; wrap in a selector that checks the plugin registry at spawn-time.
const pluginRegistry = new PluginRegistry();  // tracks active long-polls (D-11)
const standaloneAdapter = new StandaloneAdapter({ gatewayUrl: opts.gatewayUrl, gatewayToken: opts.gatewayToken });
const pluginBridgeAdapter = new PluginBridgeAdapter(pluginRegistry);

const executor = opts.dryRun ? undefined : new SelectingAdapter({
  primary: pluginBridgeAdapter,
  fallback: standaloneAdapter,
  holdWhenNoPrimary: true,       // D-12: held, not fallback-through
  logger,
});
```

`SelectingAdapter` implements `GatewayAdapter`; on `spawnSession` it checks `pluginRegistry.hasActivePlugin()`. If yes → `pluginBridgeAdapter.spawnSession()`. If no → D-12 behavior: return `{ success: false, error: "no-plugin-attached" }` with a special marker, and the scheduler's existing retry/backoff holds the task in `ready/`.

### Hold-in-ready (D-12) — interaction with existing retry logic

Today, spawn failures classify as "permanent" or "transient" (`src/dispatch/scheduler-helpers.ts::classifySpawnError`). Transient moves task to `blocked/` for backoff retry; permanent goes to deadletter.

**D-12 adds a third class: "hold" — neither retry-with-backoff-in-blocked nor deadletter.** Recommendation:

1. New sentinel error from `SelectingAdapter`: `{ success: false, error: "no-plugin-attached", errorClass: "hold" }`.
2. `classifySpawnError` extended to recognize `"hold"` → returns classification `"hold"`.
3. `assign-executor.ts::executeAssignAction` on `errorClass === "hold"`: **release the lease**, leave task in `ready/`, emit `log.info({ taskId, reason: "no-plugin-attached" }, "holding task")` + event `dispatch.held` (new event type).
4. Scheduler re-polls on next tick; if a plugin has attached, dispatch proceeds.
5. No retry count increment, no metadata pollution.

This mirrors the existing `platformLimit` capacity-exhaustion flow (releases lease, requeues to ready, no retry count) at `assign-executor.ts:224`.

### Standalone fallback preserved

Pure-standalone installs (daemon + external gateway via HTTP, no plugin) don't have a plugin ever connect. `SelectingAdapter` sees "no active plugin" permanently → what do we fall through to?

Two options for `holdWhenNoPrimary`:
- `true` (plugin-mode deployment): hold-in-ready forever until a plugin appears.
- `false` (daemon-only deployment): fall through to `StandaloneAdapter`.

**Mode is determined at daemon startup** from either:
- Explicit config flag (`config.daemon.mode: "plugin-bridge" | "standalone"`) — add this to the Zod schema in `src/config/registry.ts`.
- Auto-detection: within first N polls, if ≥1 plugin connects, lock into plugin-mode; otherwise standalone. Fragile — prefer explicit.

**Recommendation: explicit config flag** set by the installer based on plugin symlink presence. Phase 42's `plugin_mode_detected` helper in `install.sh` already classifies this — the installer writes `daemonMode: "plugin-bridge"` or `"standalone"` into a small config file (or `~/.aof/data/config.json`) that the daemon reads on startup via `getConfig()`.

## OpenClaw Plugin Reload Behavior

OpenClaw reloads `register()` on every agent session start. Today's module-level state:
- `schedulerService: AOFService | null` — persists across reloads (module scope).
- `invocationContextStore` — is constructed inside `registerAofPlugin` on each call, but only used by subsequent tool-call execution which happens between register calls.

Post-43:
- `DaemonIpcClient` (or split into `tool-client.ts` + `spawn-poller.ts`) — persists across reloads **if** declared at module scope. This is what we want.
- `invocationContextStore` — unchanged, stays plugin-local per CONTEXT.md.
- Long-poll connection — owned by the spawn-poller, which is module-level, so the connection is NOT torn down on plugin reload. The daemon sees one continuous connection.
- `api.registerTool` registrations — re-registered on each reload; harmless (OpenClaw dedupes by name).
- `api.on(...)` event handlers — re-registered each reload. Today 7 `api.on` calls; post-43, 3 of them forward via IPC (D-07), 4 stay local. Same `withCtx` helper.

**`registerGatewayMethod`:** [VERIFIED: `src/openclaw/types.ts:74`] `OpenClawApi.registerGatewayMethod?(method: string, handler: GatewayHandler): void` — optional, plugin-SDK-dependent. Today AOF does NOT call it; all tool registration is via `api.registerTool`. Phase 43 does not need it either — the spawn callback is plugin-initiated via long-poll, not a daemon-initiated gateway method call. `registerGatewayMethod` remains unused.

**`runtime.agent.runEmbeddedPiAgent`:** [VERIFIED: `src/openclaw/types.ts:44-58`, `src/openclaw/openclaw-executor.ts:169-183`] Async function returning `{ meta: { durationMs, aborted?, error? } }`. Called with a large params object (sessionId, sessionKey, sessionFile, workspaceDir, agentDir, config, prompt, agentId, timeoutMs, runId, lane, senderIsOwner, thinkLevel). All of these are either constructed plugin-side from `api.config` + `runtime.agent.resolveAgentDir()` helpers or flow from the `TaskContext`. This logic moves **verbatim** from `OpenClawAdapter.runAgentBackground` (src/openclaw/openclaw-executor.ts:149-239) into the plugin's spawn-poller handler — no semantic change, only the caller changes from in-process `spawnSession` to a long-poll-delivered `SpawnRequest`.

**Error modes from `runEmbeddedPiAgent`:**
- `meta.error: { kind: string; message: string }` — handled error.
- `meta.aborted: true` — agent aborted.
- Throws → caught by `runAgentBackground`'s outer try/catch and returned as `{ kind: "exception", message }`.

All three map cleanly into the `SpawnResultPost.error` field.

## Migration Strategy (D-14)

### What Phase-42 state needs tearing down?

**Answer: almost nothing.** Reviewing Phase 42's artifacts:

- Phase 42's install.sh behavior: if plugin-mode detected, `install_daemon()` skipped the install (D-03 of Phase 42) OR uninstalled a pre-existing daemon (D-05 of Phase 42). This left one of two possible host states:
  - (A) Pure plugin-mode install: plugin symlink exists, no launchd plist, no daemon running.
  - (B) Pre-Phase-42 dual-mode with `--force-daemon`: plugin symlink exists, daemon running. Plus the explicit override flag (forgotten mid-term).
- There is **no `.aof/state/phase-42-skipped` marker file** and **no config flag**. The "intentional skip" is purely runtime in `install.sh` — nothing persists.

**Therefore Migration 007's job is minimal:**

1. Detect whether the daemon launchd plist / systemd unit is installed.
2. If absent (state A from above): install it. Reuse the existing `installService` function from `src/daemon/service-file.ts`.
3. If present (state B): no-op — plist already there. Just ensure it's loaded and running (`launchctl kickstart -k` / `systemctl restart --user`).
4. Seed the daemon's `daemonMode: "plugin-bridge"` config flag (if `~/.openclaw/extensions/aof` present) or `"standalone"` (if not).

No "state tear-down" required. CONTEXT.md D-14's phrasing ("removes any Phase-42-era 'daemon intentionally skipped' marker state") was precautionary — research confirms there is no such marker.

### Migration 007 skeleton

```ts
// src/packaging/migrations/007-daemon-required.ts
// Source pattern: src/packaging/migrations/004-scaffold-repair.ts (canonical idempotent)
//                 src/packaging/migrations/006-data-code-separation.ts (config-update pattern)
import type { Migration, MigrationContext } from "../migrations.js";
import { installService } from "../../daemon/service-file.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const migration007: Migration = {
  id: "007-daemon-required",
  version: "1.15.0",  // ← planner: check package.json + latest git tag before locking this
  description: "Phase 43: install aof-daemon service as plugin IPC authority",

  up: async (ctx: MigrationContext): Promise<void> => {
    const plist = join(homedir(), "Library/LaunchAgents/ai.openclaw.aof.plist");   // macOS
    const unit = join(homedir(), ".config/systemd/user/ai.openclaw.aof.service");  // Linux

    if (existsSync(plist) || existsSync(unit)) {
      console.log("  \x1b[32m✓\x1b[0m 007 skipped (daemon service already installed)");
      return;
    }

    await installService({ dataDir: join(ctx.aofRoot, "data") });  // existing helper
    console.log("  \x1b[32m✓\x1b[0m 007 installed aof-daemon service");

    // Seed mode flag (optional — planner discretion).
    // If daemon config already set, leave alone.
  },
};
```

**Register in `src/packaging/migrations/index.ts`** (or equivalent barrel) alongside 001–006.

### Rollback path

If plugin fails to IPC-connect after the upgrade:
- Daemon is installed + running (migration 007 done).
- Plugin attempts `register()` → `selfCheck(daemonSocketPath)` → succeeds (daemon is up).
- Tool calls succeed; the agent sees no difference from pre-43 in-process behavior.
- If the daemon is broken for some reason (socket conflict, corrupt config), plugin tool calls return `{ error: { kind: "unavailable", message: "daemon not reachable" } }` and the user sees a loud error. Recovery: `aof daemon status` + `aof daemon install` or `launchctl kickstart`.

**Rollback of the migration itself:** Existing migration framework (`src/packaging/migrations.ts::runMigrations` with `direction: "down"`) requires a `down()` function. Recommend **no `down()`** for 007 — uninstalling the daemon would break the plugin (which has no in-process fallback post-D-02). The canonical rollback is "install an older AOF version"; migrations running on upgrade-only is consistent with 005/006 which also have no `down`.

## Event Forwarding Strategy (D-07)

### Hooks that forward (state-mutating)

| Hook | Today's behavior | Post-43 behavior |
|------|------------------|------------------|
| `session_end` | `invocationContextStore.clearSessionRoute(...)` + `service.handleSessionEnd()` | `invocationContextStore.clearSessionRoute(...)` (local) + `ipcClient.postSessionEnd(event)` |
| `agent_end` | `service.handleAgentEnd(withCtx(event, ctx))` | `ipcClient.postAgentEnd(event)` |
| `before_compaction` | `invocationContextStore.clearAll()` + `service.handleSessionEnd()` | `invocationContextStore.clearAll()` (local) + `ipcClient.postBeforeCompaction()` |

### Hooks that stay local (high-freq, no daemon state)

| Hook | Behavior |
|------|----------|
| `before_tool_call` | `invocationContextStore.captureToolCall(...)` — unchanged |
| `after_tool_call` | `invocationContextStore.clearToolCall(...)` — unchanged |
| `message_received` | `invocationContextStore.captureMessageRoute(...)` — unchanged (drop `service.handleMessageReceived` — that path is removed with D-02) |
| `message_sent` | `invocationContextStore.captureMessageRoute(...)` — unchanged |

**`service.handleMessageReceived`:** Today the plugin calls `service.handleMessageReceived(merged)` on `message_received`. Audit this: what does it do? If it mutates daemon-owned state (e.g. routes protocol messages to the router), it must be IPC-forwarded. If it's purely plugin-local bookkeeping, it stays local or is deleted with the rest of the service.

**Planner action item:** Read `src/service/aof-service.ts::handleMessageReceived` and classify. If it's just a local cache update, delete. If it triggers `protocol/router.ts` (which is daemon-side), we need a fourth forward route `POST /v1/event/message-received`. CONTEXT.md D-07 doesn't include this route — so the assumption is it's local. [ASSUMED: handleMessageReceived is local-only; needs 1-minute verification in planner read]

### Fire-and-forget vs awaited

Event forwards should be fire-and-forget (`void ipcClient.postAgentEnd(event)`) so plugin doesn't block the gateway's event loop on IPC latency. Error-log on failure (same pattern as today's `.catch(err => log.error(...))` blocks in `registerAofPlugin`).

## Plugin Thin-Bridge Restructure

### What `registerAofPlugin` becomes

Today's 394-line `src/openclaw/adapter.ts` becomes ~100 lines:

```ts
// Sketch — target shape
export function registerAofPlugin(api: OpenClawApi, opts: AOFPluginOptions): void {
  // 1. Build IPC client (module-level singleton — persists across reloads)
  const client = ensureDaemonIpcClient({ socketPath: daemonSocketPath(opts.dataDir), logger });

  // 2. Build invocation-context store (stays plugin-local, D-07)
  const invocationContextStore = new OpenClawToolInvocationContextStore();

  // 3. Wire session-route capture hooks (4 local, 3 forwarded)
  api.on("session_end", (ev, ctx) => {
    invocationContextStore.clearSessionRoute(withCtx(ev, ctx));
    void client.postSessionEnd(withCtx(ev, ctx));
  });
  api.on("agent_end", (ev, ctx) => void client.postAgentEnd(withCtx(ev, ctx)));
  api.on("before_compaction", () => {
    invocationContextStore.clearAll();
    void client.postBeforeCompaction();
  });
  api.on("message_received", (ev, ctx) => invocationContextStore.captureMessageRoute(withCtx(ev, ctx)));
  api.on("message_sent", (ev, ctx) => invocationContextStore.captureMessageRoute(withCtx(ev, ctx)));
  api.on("before_tool_call", (ev, ctx) => invocationContextStore.captureToolCall(withCtx(ev, ctx)));
  api.on("after_tool_call", (ev, ctx) => invocationContextStore.clearToolCall(withCtx(ev, ctx)));

  // 4. Register tools — each one proxies via IPC
  for (const [name, def] of Object.entries(toolRegistry)) {
    api.registerTool({
      name,
      description: def.description,
      parameters: zodToJsonSchema(def.schema) as any,
      execute: async (id, params) => {
        // Merge notification-recipient if applicable (plugin-local pre-send hook)
        const effectiveParams = name === "aof_dispatch"
          ? mergeDispatchNotificationRecipient(invocationContextStore, params, id)
          : params;
        // Ship via IPC
        const response = await client.invokeTool({
          name,
          params: effectiveParams,
          actor: effectiveParams.actor as string | undefined,
          projectId: effectiveParams.project as string | undefined,
          correlationId: randomUUID(),       // or extract from ctx
          toolCallId: id,
          callbackDepth: parseCallbackDepth(effectiveParams),
        });
        return formatToolResult(response);   // wrap in OpenClaw's content array
      },
    });
  }

  // 5. Project-management tools (aof_project_create, _list, _add_participant) — either also
  //    IPC-proxied (if registered in daemon's tool-registry) or stay plugin-local with
  //    a thin wrapper that reads/writes ~/.aof/data/Projects/. Current implementation calls
  //    dynamic imports (`import("../projects/create.js")`) which hit the filesystem, not the
  //    store. Planner decides: move to daemon (cleaner) vs keep as plugin-local filesystem ops.

  // 6. Start long-poll spawn listener (module-level — survives reload)
  startSpawnPollerOnce(client, opts);

  // 7. HTTP routes for /aof/metrics and /aof/status — TODAY these are registered on the
  //    gateway's HTTP server. Post-43: daemon already exposes /status; but the gateway's
  //    HTTP interface is still useful for users hitting http://localhost:{gateway}/aof/status.
  //    Planner decides: keep the gateway routes (they read daemon's /status via IPC) or drop.
}
```

**Removed from today's `registerAofPlugin`:**
- `FilesystemTaskStore` construction
- `EventLogger` construction
- `AOFMetrics` construction
- `NotificationPolicyEngine` construction
- `MatrixNotifier` construction
- `OpenClawChatDeliveryNotifier` wiring
- `AOFService` construction
- `resolveAdapter` + `OpenClawAdapter` construction
- `loadOrgChart` + `orgChartPromise`
- `PermissionAwareTaskStore` wrapping (moves to daemon)
- `resolveProjectStore` + `createProjectStore`
- `getStoreForActor` / `withPermissions` wrapper
- `schedulerService` module-level singleton
- `service.start()` self-start block
- `api.registerService({ id: "aof-scheduler", ... })`
- `logger.addOnEvent(...)` wiring (daemon owns the logger)

**`projectStores` map becomes vestigial** (CONTEXT.md Claude's Discretion) — delete with D-02.

## Security Domain

> Phase config: `security_enforcement` is not explicitly disabled in `.planning/config.json`. Treating as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Unix-socket filesystem perms 0600 (D-08). Existing: `daemon.sock` is created by `net.Server` listening on a path in `DATA_DIR` which is 0700 user-owned. |
| V3 Session Management | N/A | No web session — same-uid trust boundary. |
| V4 Access Control | yes | `PermissionAwareTaskStore` daemon-side; `actor` in IPC envelope. |
| V5 Input Validation | yes | Zod `InvokeToolRequest` envelope parse; inner `toolRegistry[name].schema` parse. Reject on validation error with `kind: "validation"`. |
| V6 Cryptography | N/A | No crypto this phase — same-host Unix socket. |

### Known Threat Patterns for the IPC surface

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Malicious same-uid process on host connects to `daemon.sock` | Elevation of Privilege | Accepted per D-08 — same-uid is the trust boundary for single-user OS accounts. CLAUDE.md single-machine v1 constraint. |
| Large / oversized IPC request body DoS | Denial of Service | Bound request body size in route handler (~1 MB). Reject with 413. |
| Parser confusion / envelope injection | Tampering | Zod-validated envelope rejects unknown fields (default) or ignores extra keys depending on `.strict()` / `.passthrough()` choice — **recommend `.strict()` on envelope, `.passthrough()` on inner `params` because tool schemas are the source of truth for inner validation**. |
| Plugin replays `toolCallId` | Tampering / logic | `toolCallId` is logged for correlation but NOT used for idempotency — repeated requests execute twice (no new idempotency primitive). Each tool handler's own semantics apply (most are idempotent reads; `aof_dispatch` creates a new task each call per current behavior). |
| Socket file leaks across user boundary | Information disclosure | Existing: socket path is under `~/.aof/data/` which is 0700. Unchanged by Phase 43. |
| Long-poll connection exhaustion | DoS | Bound max concurrent long-polls per pluginId (~4 default — way more than needed for a 1-plugin deployment). Reject 429 on overflow. |

## Common Pitfalls

### Pitfall 1: Leaking `keepAliveTimeout` default
**What goes wrong:** Daemon's long-poll response sits open for 25s waiting for work, but Node's `server.keepAliveTimeout` (default 5s) decides the *next* request on the same connection is idle and kills it.
**Why it happens:** `keepAliveTimeout` governs idle between *requests* on the same TCP connection, not duration of a single response. But it interacts oddly with pending-response state on some Node versions.
**How to avoid:** Set `healthServer.keepAliveTimeout = 60_000` and `healthServer.headersTimeout = 61_000` on the daemon's HTTP server, explicitly, at construction. Add a unit test verifying they're set.
**Warning signs:** Long-polls complete earlier than the configured hold window; plugin reconnects at 5s intervals instead of 25s.

### Pitfall 2: Leaked long-poll listeners
**What goes wrong:** Plugin drops mid-poll, `res.on('close')` fires, but the queue's `enqueue` listener is never detached. Each drop leaks one listener; Node warns at 10+.
**Why it happens:** Easy to forget the cleanup in the drop branch.
**How to avoid:** Single `cleanup()` function called from both the `timeout`, `enqueue`, and `close` handlers. Integration test: simulate 50 plugin drops; assert `queue.listenerCount("enqueue") === 0` after.

### Pitfall 3: Module-scope singleton lost on OpenClaw reload
**What goes wrong:** Module-level `let daemonIpcClient = null;` works across reloads today, but if OpenClaw switches to per-session module isolation (dynamic `import()` per register call), the client is reconstructed every session. Daemon sees connection churn.
**Why it happens:** Tight coupling to OpenClaw's plugin-loader implementation.
**How to avoid:** Write the module to survive either model — a `WeakRef` cache keyed on `api` would be paranoid; simpler is to gate `startSpawnPollerOnce` with an idempotency check (the pending long-poll req handle is its own singleton). Never rely on construction-time behavior being a one-shot.
**Warning signs:** Daemon log shows `plugin attached` repeatedly with no corresponding `plugin detached`.

### Pitfall 4: `AbortSignal.timeout` on Unix socket doesn't abort cleanly
**What goes wrong:** `fetch(..., { signal: AbortSignal.timeout(30_000) })` on a `socketPath` URL may not abort the underlying socket on Node < 20.4 — connection leak.
**Why it happens:** `fetch` on a Unix socket requires an undici agent with socketPath support; AbortSignal plumbing through undici → socket wasn't always clean.
**How to avoid:** **Use `node:http`'s `request({ socketPath })` directly, not `fetch`.** The existing `selfCheck` in `src/daemon/server.ts:70` uses this pattern; follow it. Node 22 [VERIFIED]. AbortSignal on `http.request` works correctly in Node 22 via `options.signal`.
**Warning signs:** Post-timeout, `netstat -an | grep daemon.sock` shows hung client sockets.

### Pitfall 5: Tool schemas imported twice with diverging Zod versions
**What goes wrong:** Plugin-side and daemon-side validation use different Zod instances — `safeParse` results subtly differ.
**Why it happens:** Monorepo-style duplicate imports, or tree-shaking quirks.
**How to avoid:** Phase 43 is one process tree (plugin spawns inside the gateway, daemon is a sibling process — but both ship from `~/.aof/node_modules/zod`). No risk in the current install layout. Add a regression check in the tarball verifier (scripts/build-tarball.mjs) if this becomes flaky.

### Pitfall 6: Fragile dispatch chain cascade
**What goes wrong:** Modifying `scheduler.ts` or `task-dispatcher.ts` to add "hold" classification accidentally breaks the `promote` / `expire-lease` / `deadletter` branches.
**Why it happens:** CLAUDE.md "Fragile — Tread Carefully" explicitly calls this out: "scheduler.ts → task-dispatcher.ts → action-executor.ts → assign-executor.ts: tightly coupled. Changes cascade."
**How to avoid:** Restrict D-12 implementation to `assign-executor.ts` and a new sentinel in `scheduler-helpers.ts::classifySpawnError`. Don't touch `task-dispatcher.ts` or `action-executor.ts`. Exhaustive regression: run all dispatch-pipeline integration tests before/after.

### Pitfall 7: "Held" tasks starving under high load
**What goes wrong:** All tasks perpetually hold waiting for a plugin that crashed and didn't restart. Backlog balloons, no deadletter.
**Why it happens:** D-12 explicitly says "never deadletter, only hold". Under a pathological crashed-plugin scenario, tasks accumulate.
**How to avoid:** This is BY DESIGN per CONTEXT.md D-12 (core value: tasks never dropped). Observability-based, not logic-based: `dispatch.held` event + a counter metric. If ops sees "100+ tasks held, 0 plugins attached for >N minutes" they page a human. Plan should include a Prometheus counter `aof_dispatch_held_total{reason="no-plugin-attached"}`.

## Code Examples

### Existing pattern: Unix-socket HTTP server (extend, don't duplicate)
```ts
// Source: src/daemon/server.ts (existing)
const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") { /* ... */ return; }
  if (req.method === "GET" && req.url === "/status")  { /* ... */ return; }
  // New routes appended here for Phase 43.
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});
server.listen(socketPath);  // Unix socket — 0600 by default on macOS/Linux
```

### Existing pattern: Unix-socket HTTP client
```ts
// Source: src/daemon/server.ts::selfCheck (existing)
const req = httpRequest({
  socketPath,
  path: "/healthz",
  method: "GET",
  timeout: 2000,
}, (res) => { res.resume(); resolve(res.statusCode === 200); });
req.on("error", () => resolve(false));
req.on("timeout", () => { req.destroy(); resolve(false); });
req.end();
```

### Existing pattern: Migration 006 (config-update + atomic-write + rollback)
```ts
// Source: src/packaging/migrations/006-data-code-separation.ts
// Key moves: (1) idempotency breadcrumb, (2) atomic-write via writeFileAtomic,
//            (3) pre-migration backup file, (4) narrated progress via say()/warn().
// Migration 007 reuses the installService helper and skips if plist/unit exists.
```

### Existing pattern: Tool-registry loop
```ts
// Source: src/openclaw/adapter.ts:297-310 (TO BE REPLACED)
for (const [name, def] of Object.entries(toolRegistry)) {
  const execute = withPermissions(def.handler, resolveProjectStore, getStoreForActor, logger, opts.orgChartPath);
  api.registerTool({ name, description: def.description, parameters: zodToJsonSchema(def.schema), execute });
}
// Phase 43: the loop stays, but `execute` is replaced by an IPC-proxy closure.
// `withPermissions` moves to the daemon side, wrapping the handler in the /v1/tool/invoke route.
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Phase 42: install-time mode-exclusivity (skip daemon if plugin-mode) | Phase 43: install-time always-daemon + thin plugin | This phase | Reverses Phase 42 D-03; `--force-daemon` no longer needed. |
| Plugin owns `AOFService` singleton | Daemon owns `AOFService`; plugin owns `DaemonIpcClient` | This phase | Eliminates dual-code-path fragility (CLAUDE.md). |
| `OpenClawAdapter` in-process | `PluginBridgeAdapter` in-daemon + long-poll to plugin | This phase | Preserves `runEmbeddedPiAgent` requirement (gateway-process only). |
| Env mutation `AOF_CALLBACK_DEPTH` for in-process call | `callbackDepth` in IPC envelope | This phase | Removes env mutation on the plugin side; env usage confined to callback-delivery.ts daemon-side (unchanged). |

**Deprecated/outdated:**
- Phase 42 D-03 (auto-skip daemon install when plugin-mode) — reversed by Phase 43 D-01.
- `OpenClawAdapter` in-process (src/openclaw/openclaw-executor.ts) — now called only from inside the plugin's spawn-poller, not from `AOFService`. Module survives; invocation shape changes.

## Runtime State Inventory

This phase is a refactor/migration — see the matrix:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None. AOF tasks under `~/.aof/data/tasks/` are read/written by whichever `AOFService` is running; Phase 43 moves ownership from plugin process to daemon process, not the filesystem layout. | None — no data migration. |
| Live service config | `plugins.entries.aof.config` in `~/.openclaw/openclaw.json` (existing) — continues to configure the plugin. Daemon config lives in `~/.aof/data/config.json` (if present, else Zod defaults); optionally a new `daemonMode: "plugin-bridge" \| "standalone"` field added. | Migration 007 seeds `daemonMode` if the flag doesn't exist. Plugin config unchanged. |
| OS-registered state | launchd plist `~/Library/LaunchAgents/ai.openclaw.aof.plist` (macOS) or systemd unit `~/.config/systemd/user/ai.openclaw.aof.service` (Linux). Phase 42 D-03 could have left this absent on plugin-mode installs. | Migration 007 calls `installService({ dataDir })` if absent (idempotent — existing helper). |
| Secrets/env vars | `AOF_CALLBACK_DEPTH` — remains (daemon-owned, same process as before, unchanged). No new env vars. `OPENCLAW_GATEWAY_URL` + `OPENCLAW_GATEWAY_TOKEN` — still used by `StandaloneAdapter` for standalone-only installs. | None. |
| Build artifacts | `~/.aof/dist/openclaw.plugin.json` (unchanged — plugin discovery by OpenClaw). `~/.aof/dist/daemon/*` (compiled daemon — always present, now actually used in plugin-mode too). | None — tarball shape unchanged; what was already built is now the single authority. |

**Nothing found in category "Stored data":** Verified by inspecting `.planning/phases/42-*` plans and the install.sh diff — Phase 42 introduced no state files, only runtime install-script branches.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js ≥22 | Daemon + plugin | ✓ | v22.22.2 | — |
| Unix domain socket support (`net.Server.listen(path)`) | IPC transport | ✓ | built-in | — |
| launchd (macOS) OR systemd --user (Linux) | Daemon supervision | ✓ | OS-native | User-foreground `aof daemon start --foreground` |
| OpenClaw ≥ 2026.2 (`runtime.agent.runEmbeddedPiAgent`) | Spawn executor | ✓ | in-tree assumption | Plugin errors loudly if older (src/openclaw/openclaw-executor.ts:57-62) |
| `better-sqlite3` (for daemon's memory.db) | Memory subsystem | ✓ | ^12.6.2 | — |
| `hnswlib-node` | Memory vector index | ✓ | existing | — |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:** None critical.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest ^3.0.0 |
| Config file | `vitest.config.ts` (unit) + `tests/integration/vitest.config.ts` (integration, 60s timeout, singleFork) + `tests/e2e/vitest.config.ts` (E2E, sequential) |
| Quick run command | `npx vitest run src/openclaw/__tests__/ src/dispatch/__tests__/ src/daemon/__tests__/` |
| Full suite command | `npm run typecheck && npm test && npm run test:integration:plugin && npm run test:e2e` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| D-01 | Installer always installs daemon | integration (bash) | `AOF_INTEGRATION=1 npx vitest run --config tests/integration/vitest.config.ts tests/integration/install-daemon-always.test.ts` | ❌ Wave 0 |
| D-02 | Plugin has no `AOFService` import | unit (grep) | `grep -rn "AOFService\|schedulerService\|new AOFService\|service\\.start()" src/openclaw/` returns empty | ❌ Wave 0 (grep-based invariant test) |
| D-03 | Daemon launchd/systemd install unchanged | unit | `npx vitest run src/daemon/__tests__/service-file.test.ts` | ✅ (existing) |
| D-04 | `--force-daemon` prints deprecation warning | integration (bash) | `AOF_INTEGRATION=1 npx vitest run tests/integration/install-deprecation-warn.test.ts` | ❌ Wave 0 |
| D-05 | All 8 routes respond correctly | integration | `npx vitest run tests/integration/daemon-ipc-routes.test.ts` | ❌ Wave 0 |
| D-06 | `/v1/tool/invoke` dispatches every registered tool | unit + integration | `npx vitest run src/ipc/__tests__/invoke-tool-handler.test.ts tests/integration/tool-invoke-roundtrip.test.ts` | ❌ Wave 0 |
| D-07 | Only 3 of 7 hooks forward | unit | `npx vitest run src/openclaw/__tests__/event-forwarding.test.ts` | ❌ Wave 0 |
| D-08 | `daemon.sock` is mode 0600 | unit | `npx vitest run src/daemon/__tests__/socket-perms.test.ts` | ❌ Wave 0 (or assert inside `daemon.test.ts`) |
| D-09 | Long-poll holds 25s, 204 on timeout, 200 with SpawnRequest on enqueue | integration | `npx vitest run tests/integration/long-poll-spawn.test.ts` | ❌ Wave 0 |
| D-10 | `SelectingAdapter` routes to plugin when attached, standalone when not | unit | `npx vitest run src/dispatch/__tests__/selecting-adapter.test.ts` | ❌ Wave 0 |
| D-11 | `hasActivePlugin()` reflects long-poll connection state | unit | `npx vitest run src/ipc/__tests__/plugin-registry.test.ts` | ❌ Wave 0 |
| D-12 | No-plugin-attached → task held in `ready/`, `dispatch.held` event emitted | integration | `npx vitest run tests/integration/hold-no-plugin.test.ts` | ❌ Wave 0 |
| D-13 | `pluginId` default `"openclaw"`, envelope Zod accepts non-default | unit | `npx vitest run src/ipc/__tests__/envelope.test.ts` | ❌ Wave 0 |
| D-14 | Migration 007 installs daemon if absent, no-ops if present | unit + integration | `npx vitest run src/packaging/migrations/__tests__/007-daemon-required.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm run typecheck && npx vitest run <targeted files from diff>` (< 10s)
- **Per wave merge:** `npm test` (full unit, ~10s) + `npm run test:integration:plugin` (~30-60s)
- **Phase gate:** `npm run typecheck && npm test && npm run test:integration:plugin && npm run test:e2e` all green before `/gsd-verify-work`

### Wave 0 Gaps

Create these test files in Wave 0 before any implementation:

- [ ] `tests/integration/helpers/daemon-harness.ts` — spin up a real daemon on a tmp socket, tear down between tests.
- [ ] `tests/integration/helpers/plugin-ipc-client.ts` — tiny client wrapping `http.request({ socketPath })` for invoke + waitSpawn.
- [ ] `tests/integration/tool-invoke-roundtrip.test.ts` — covers D-06 for each of the 13 registry tools (parameterized). Spec (a) from CONTEXT.md line 119.
- [ ] `tests/integration/long-poll-spawn.test.ts` — covers D-09. Spec (b) from CONTEXT.md line 119. Sub-cases: enqueue-before-poll, enqueue-after-poll, keepalive timeout → 204 → reconnect, plugin drops mid-poll → daemon detects + re-enqueue.
- [ ] `tests/integration/hold-no-plugin.test.ts` — covers D-12. Spec (c) from CONTEXT.md line 119. Dispatch with no plugin attached, verify task stays in ready/, attach plugin, verify dispatch proceeds.
- [ ] `tests/integration/daemon-restart-midpoll.test.ts` — covers spec (d) from CONTEXT.md line 119. Start daemon, connect plugin, kill daemon mid-poll, restart daemon, verify plugin reconnects and task re-dispatches.
- [ ] `tests/integration/plugin-session-boundaries.test.ts` — covers spec (e). Simulate OpenClaw reload by calling `registerAofPlugin` twice on same `api` mock; verify single long-poll (not two), verify tool registrations idempotent.
- [ ] `src/ipc/__tests__/envelope.test.ts` — Zod schemas for InvokeToolRequest/Response/SpawnRequest/SpawnResultPost, including pluginId default and passthrough-on-params.
- [ ] `src/ipc/__tests__/invoke-tool-handler.test.ts` — unit: handler resolves tool from registry, validates params, calls with resolved store, maps errors to IpcError.
- [ ] `src/ipc/__tests__/plugin-registry.test.ts` — unit: PluginRegistry tracks active long-polls, `hasActivePlugin()` returns true iff ≥1, cleanup on `res.on('close')`.
- [ ] `src/dispatch/__tests__/selecting-adapter.test.ts` — unit: SelectingAdapter routes to primary/fallback based on registry state; D-12 hold behavior returns sentinel error.
- [ ] `src/dispatch/__tests__/bug-dispatch-hold.test.ts` — regression test for D-12 wiring into `assign-executor.ts` (per CLAUDE.md regression naming convention).
- [ ] `src/openclaw/__tests__/event-forwarding.test.ts` — unit: of 7 hooks, exactly 3 trigger IPC calls; exactly 4 stay local.
- [ ] `src/packaging/migrations/__tests__/007-daemon-required.test.ts` — unit: migration idempotent (skip when plist exists, install when absent, no-op on rerun).
- [ ] Framework install: none — Vitest, zod, http, etc. are all present.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `service.handleMessageReceived` is plugin-local bookkeeping, not daemon-state mutation | §Event Forwarding Strategy | Small: if it's daemon-state, we need a 4th forward route `POST /v1/event/message-received`. 15-minute fix in planning. |
| A2 | OpenClaw reloads `register()` via same module instance (module-scope state persists) | §Plugin Thin-Bridge Restructure | Medium: if OpenClaw switches to per-session `import()`, `DaemonIpcClient` gets reconstructed each session → daemon sees connection churn. Mitigation: idempotency check in `startSpawnPollerOnce`. |
| A3 | Node 22's `http.request({ socketPath, signal })` aborts cleanly on AbortSignal | §Pitfall 4 | Low: Node ≥20.4 is correct. 22.22.2 is beyond that. Verify with one integration test. |
| A4 | `installService` from `src/daemon/service-file.ts` is idempotent enough to safely re-run | §Migration 007 | Low: Phase 42 landed `launchctl kickstart -k` for exactly this property. Existing unit tests cover it. |
| A5 | Plugin's `aof_project_create/list/add_participant` can move to `tool-registry.ts` or stay plugin-local | §Plugin Thin-Bridge Restructure | Low: current implementation is filesystem ops (no store mutations that need daemon serialization). Planner picks. |
| A6 | The version field for Migration 007 should be `1.15.0` — but check latest released version first per MEMORY.md | §Migration 007 skeleton | Low: cosmetic — wrong version label doesn't break the migration, just makes the history entry misleading. |

## Open Questions

1. **Daemon-mode config flag: where does it live, and who writes it?**
   - What we know: The `SelectingAdapter` needs to know whether "no plugin attached" means "hold" (plugin-mode) or "fall through to standalone" (daemon-only-mode).
   - What's unclear: Should this be a new key in `AofConfigSchema` (`daemon.mode`), a separate JSON file (`~/.aof/data/daemon-mode.json`), or inferred from the presence of `~/.openclaw/extensions/aof`?
   - Recommendation: New key `daemon.mode: z.enum(["plugin-bridge", "standalone"]).default("standalone")` in `AofConfigSchema`. Migration 007 sets it based on plugin symlink detection. Explicit > implicit. **Assign to planner for Wave 2.**

2. **`aof_project_create/list/add_participant` — IPC or plugin-local?**
   - What we know: These three tools are currently registered via `api.registerTool` directly in `adapter.ts` (bypassing the `toolRegistry` loop). They read/write `~/.aof/data/Projects/` via dynamic imports.
   - What's unclear: Whether they should move into `tool-registry.ts` (and thus get daemon-side implementations) or stay as plugin-side filesystem ops.
   - Recommendation: Move to `tool-registry.ts` — keeps all 16 tools consistent, single IPC envelope for everything, daemon owns project-state just like it owns task-state post-43. **Assign to planner for Wave 1.**

3. **`aof_context_load` — how do the `_contextRegistry` / `_skillsDir` fields travel across IPC?**
   - What we know: `tool-registry.ts:127-132` reads `(ctx as any)._contextRegistry` and `(ctx as any)._skillsDir` — adapter-provided extras not in the base ToolContext.
   - What's unclear: These are adapter-specific context extras; daemon-side, they need to be constructed fresh on each call (or cached).
   - Recommendation: Daemon constructs them inside the route handler using `getConfig()` + `paths.ts` helpers, populates the ToolContext before calling the handler. **Assign to planner for Wave 1.**

4. **HTTP routes `/aof/status` and `/aof/metrics` on the gateway — keep or drop?**
   - What we know: `adapter.ts:386-390` registers two HTTP routes on the gateway's HTTP server (not the daemon's). They call `createMetricsHandler` / `createStatusHandler` which today read plugin-local state.
   - What's unclear: Post-43, the plugin has no local state to report. The same data lives in daemon's `/status`. Users may or may not be scripting against the gateway URL.
   - Recommendation: Keep the gateway routes as thin proxies — they IPC-call the daemon's `/status`, unpack, and respond on the gateway port. Preserves URL compatibility. **Assign to planner for Wave 3.**

5. **`callbackDepth` plumbing end-to-end — which code path resets it?**
   - What we know: Today's flow sets `process.env.AOF_CALLBACK_DEPTH` before a subscriber callback runs, unsets after. The subscriber's in-process `aof_dispatch` reads it.
   - What's unclear: Post-43, the subscriber's `aof_dispatch` runs via IPC. Who sets `callbackDepth` in the IPC envelope? The callback-delivery code daemon-side needs to inject it into the SpawnRequest sent to the plugin, so the agent's (inside gateway) subsequent `aof_dispatch` IPC call carries it.
   - Recommendation: Add `callbackDepth` to `SpawnRequest`, plugin reads it from the SpawnRequest when formatting the prompt / invoking the agent, agent's tool-call flows through plugin `DaemonIpcClient.invokeTool` which auto-populates `callbackDepth` in the envelope from the spawn context. **Assign to planner for Wave 2 (critical for v1.5 trace continuity).**

6. **Correlation ID — regenerated per IPC hop or threaded through?**
   - What we know: `correlationId` is generated in `assign-executor.ts:59` today at dispatch time, stored in task metadata, passed into `spawnSession(context, { correlationId })`.
   - What's unclear: Post-43 the chain becomes: plugin tool-call has its own correlationId → daemon dispatch generates another → spawn request has one → spawn result carries one. If they're all different, tracing breaks.
   - Recommendation: Generate once at the originating IPC call (plugin's `invokeTool`), thread through envelope → daemon handler → (if `aof_dispatch`) task metadata → spawn request → spawn result. Reset only for orthogonal new dispatches. **Assign to planner for Wave 1.**

## Project Constraints (from CLAUDE.md)

These constraints bind every plan in Phase 43:

- **Config access:** Only `getConfig()` from `src/config/registry.ts`. No new `process.env` reads. `AOF_CALLBACK_DEPTH` is the documented exception; Phase 43 does not add more. (Note: plugin side continues to read `AOF_CALLBACK_DEPTH` via `src/mcp/shared.ts` for subscribers, but new callback-depth propagation goes through the IPC envelope, not env.)
- **Logging:** `createLogger('component')`. No `console.*` in core modules (CLI output in `src/cli/` is OK). Planner should use e.g. `createLogger('daemon-ipc')`, `createLogger('plugin-bridge')`, `createLogger('spawn-poller')`.
- **Store access:** `ITaskStore` methods only on the daemon side. The plugin no longer accesses any store directly (D-02).
- **Schemas:** Zod source of truth. Export `const Foo = z.object({...})` + `type Foo = z.infer<typeof Foo>`. IPC envelopes follow this exact pattern in `src/ipc/schemas.ts`.
- **Tools:** Register in `src/tools/tool-registry.ts`. Both adapters already consume it. Phase 43 changes WHO consumes it (daemon-side in route handler vs plugin-side in `registerAofPlugin`), not the pattern.
- **No circular deps:** `src/ipc/` must be a leaf — imports from `tools/`, `schemas/`, `store/` are fine; nothing above can import from `ipc/` except `openclaw/`, `daemon/`, `tests/`. Verify: `npx madge --circular --extensions ts src/`.
- **Naming:** `PascalCase` types (`InvokeToolRequest`), `camelCase` functions (`invokeTool`), `I` prefix for store interfaces (`ITaskStore` existing — no new one needed here). `.js` in import paths.
- **Barrels:** `src/ipc/index.ts` must be pure re-exports.
- **Fragile files:** `src/plugin.ts`, `src/openclaw/adapter.ts`, `src/daemon/daemon.ts` — Phase 43 IS the rewrite of `adapter.ts` and a light modification of `daemon.ts`. Tests for BOTH modes (plugin-mode, daemon-only-mode) are mandatory before either is touched.
- **Dispatch chain:** `scheduler.ts → task-dispatcher.ts → action-executor.ts → assign-executor.ts` stays. D-12 and adapter selection land at the **seam** (`assign-executor.ts` uses `executor.spawnSession`) — don't reshape the upstream chain.
- **Commits:** Small, atomic. No long-lived branches. Regression tests: `bug-NNN-description.test.ts` naming.
- **Vitest orphan workers:** After any aborted test run, `ps -eo pid,command | grep -E "node \\(vitest" | grep -v grep | awk '{print $1}' | xargs -r kill -9` before next run.

## Sources

### Primary (HIGH confidence)
- `src/openclaw/adapter.ts` — canonical seam [VERIFIED via Read]
- `src/daemon/server.ts`, `src/daemon/daemon.ts`, `src/daemon/standalone-adapter.ts` — existing IPC surface [VERIFIED via Read]
- `src/dispatch/executor.ts` — `GatewayAdapter` interface [VERIFIED via Read]
- `src/tools/tool-registry.ts` — single tool registry [VERIFIED via Read]
- `src/packaging/migrations/004-scaffold-repair.ts` + `006-data-code-separation.ts` — migration patterns [VERIFIED via Read]
- `src/openclaw/types.ts` — OpenClaw plugin API surface [VERIFIED via Read]
- `src/openclaw/openclaw-executor.ts` — current spawn logic (moves verbatim to plugin's spawn-poller) [VERIFIED via Read]
- `src/openclaw/tool-invocation-context.ts` — stays plugin-local [VERIFIED via Read]
- `src/dispatch/assign-executor.ts` — dispatch seam where D-12 hold lands [VERIFIED via Read]
- `src/dispatch/callback-delivery.ts` — `AOF_CALLBACK_DEPTH` handling [VERIFIED via Read]
- CLAUDE.md, CODE_MAP.md, `.planning/phases/42-installer-mode-exclusivity/42-CONTEXT.md`, `42-04-PLAN.md`, `.planning/phases/43-thin-plugin-daemon-authority/43-CONTEXT.md` [VERIFIED via Read]
- Node.js `http` + `net` API docs (via Context7/ctx7) [CITED: https://github.com/nodejs/node/blob/main/doc/api/http.md]

### Secondary (MEDIUM confidence)
- Node 22 `server.keepAliveTimeout` tuning — [CITED: Better Stack "A Complete Guide to Timeouts in Node.js" https://betterstack.com/community/guides/scaling-nodejs/nodejs-timeouts/]
- Node keep-alive + headers-timeout relationship — [CITED: ConnectReport https://connectreport.com/blog/tuning-http-keep-alive-in-node-js/]
- `socketPath` in `http.request` options — [CITED: nodejs.org/api/http.html]
- GitHub Actions self-hosted runner / Buildkite agent long-poll patterns — [CITED: community documentation, general industry knowledge]

### Tertiary (LOW confidence)
- None used in primary recommendations. All critical claims backed by source reads or official docs.

## Metadata

**Confidence breakdown:**
- Architecture (adapter seams, route list, envelope shape): **HIGH** — entirely reasoned from code reads of existing in-tree patterns.
- Long-poll server/client lifecycle: **HIGH** — Node `http` + `res.on('close')` behavior is well-documented and already used by `src/daemon/server.ts`.
- Keepalive calibration (25s hold, 60s keepAliveTimeout): **MEDIUM** — values are reasonable best-practice; exact numbers should be tuned against real OpenClaw reloads during Wave 2 integration testing. Not load-bearing for correctness.
- Migration 007 idempotency: **HIGH** — `installService` is already idempotent per Phase 42.
- OpenClaw reload-survival of module-level `DaemonIpcClient`: **MEDIUM** — behaves correctly with today's `schedulerService` singleton, same mechanism. Assumption A2 flagged.
- Event-forwarding classification (3 vs 4 hooks): **HIGH** — CONTEXT.md D-07 is explicit and the audit of `service.handleMessageReceived` is the only uncertainty (A1).
- Phase-42 state tear-down: **HIGH** — verified there's no marker state to remove; only launchd/systemd plist re-install.

**Research date:** 2026-04-17
**Valid until:** 2026-05-17 (30 days — stable domain, no fast-moving deps)

## RESEARCH COMPLETE
