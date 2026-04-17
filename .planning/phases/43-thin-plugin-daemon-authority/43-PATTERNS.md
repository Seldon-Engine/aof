# Phase 43: Thin-plugin architecture — daemon as single authority — Pattern Map

**Mapped:** 2026-04-17
**Files analyzed:** 22 new / 6 modified (core)
**Analogs found:** 28 / 28

## File Classification

### New files

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/ipc/schemas.ts` | schema (leaf) | request-response | `src/schemas/run.ts` + envelope style in `src/schemas/subscription.ts` | exact |
| `src/ipc/types.ts` | types (leaf) | N/A | `src/dispatch/types.ts`, `src/tools/types.ts` | exact |
| `src/ipc/index.ts` | barrel | N/A | `src/daemon/index.ts`, `src/tools/index.ts` | exact |
| `src/ipc/routes/invoke-tool.ts` | route handler | request-response | `src/daemon/server.ts` `/status` branch | exact |
| `src/ipc/routes/session-events.ts` | route handler | event-driven (ingress) | `src/daemon/server.ts` `/healthz` branch | role-match |
| `src/ipc/routes/spawn-wait.ts` | route handler (streaming long-poll) | event-driven (long-poll server) | `src/daemon/server.ts` (no streaming analog today) — layout from `selfCheck` loop | partial |
| `src/ipc/routes/spawn-result.ts` | route handler | request-response | `src/daemon/server.ts` `/status` branch | exact |
| `src/ipc/spawn-queue.ts` | service (in-memory queue + event emitter) | pub-sub | `src/dispatch/lease-manager.ts` (in-process renewal singleton w/ timers) + `Node:EventEmitter` | role-match |
| `src/ipc/plugin-registry.ts` | service | event-driven (track active long-polls) | `src/dispatch/throttle.ts` (module-level in-memory registry w/ reset) | role-match |
| `src/ipc/server-attach.ts` | wiring | request-response | `src/daemon/server.ts::createHealthServer` | exact |
| `src/openclaw/daemon-ipc-client.ts` | service (plugin→daemon RPC client) | request-response | `src/daemon/server.ts::selfCheck` + `StandaloneAdapter` fetch patterns | role-match |
| `src/openclaw/spawn-poller.ts` | service (long-poll loop) | event-driven (long-poll client) | `StandaloneAdapter::pollForCompletion` (polling loop pattern) | role-match |
| `src/openclaw/plugin-bridge-tool-client.ts` (opt split) | utility | request-response | `StandaloneAdapter` header+fetch pattern, `selfCheck` socketPath pattern | role-match |
| `src/dispatch/plugin-bridge-adapter.ts` | adapter | event-driven + request-response | `src/openclaw/openclaw-executor.ts::OpenClawAdapter` (target contract) + `src/dispatch/executor.ts::MockAdapter` (shape) | exact |
| `src/dispatch/selecting-adapter.ts` | adapter (selector) | request-response | `src/dispatch/executor.ts::MockAdapter` (GatewayAdapter shape) + `src/openclaw/adapter.ts::resolveAdapter` (selection semantics) | role-match |
| `src/packaging/migrations/007-daemon-required.ts` | migration | batch (idempotent one-shot) | `src/packaging/migrations/004-scaffold-repair.ts` (canonical idempotent skeleton) + `src/packaging/migrations/006-data-code-separation.ts` (config-update pattern) | exact |
| `src/ipc/__tests__/envelope.test.ts` | test (unit) | N/A | `src/tools/__tests__/envelope.test.ts` (same name; look for Zod envelope patterns) + `src/packaging/__tests__/migrations.test.ts` | exact |
| `src/ipc/__tests__/invoke-tool-handler.test.ts` | test (unit) | request-response | `src/daemon/__tests__/server.test.ts` (fetchSocket helper + server lifecycle) | exact |
| `src/ipc/__tests__/plugin-registry.test.ts` | test (unit) | N/A | any module-singleton test; `src/dispatch/__tests__/throttle.test.ts` pattern | role-match |
| `src/dispatch/__tests__/selecting-adapter.test.ts` | test (unit) | N/A | `src/dispatch/__tests__/assign-executor.test.ts` (mocking GatewayAdapter) | exact |
| `src/dispatch/__tests__/bug-NNN-dispatch-hold.test.ts` | test (regression) | N/A | `src/dispatch/__tests__/bug-003-error-propagation.test.ts` | exact |
| `src/openclaw/__tests__/event-forwarding.test.ts` | test (unit) | N/A | `src/openclaw/__tests__/adapter.test.ts` (api mock + event handler trigger) | exact |
| `src/packaging/migrations/__tests__/007-daemon-required.test.ts` | test (unit) | N/A | `src/packaging/__tests__/006-data-code-separation.test.ts` | exact |
| `tests/integration/helpers/daemon-harness.ts` | helper | N/A | `tests/integration/helpers/sdlc-workflow-helpers.ts` (integration helper pattern) + `src/daemon/__tests__/server.test.ts` fetchSocket | role-match |
| `tests/integration/helpers/plugin-ipc-client.ts` | helper | request-response | `src/daemon/server.ts::selfCheck` (http.request socketPath) + same test's fetchSocket | exact |
| `tests/integration/tool-invoke-roundtrip.test.ts` | test (integration) | request-response | `tests/integration/dispatch-pipeline.test.ts` + `tests/integration/install-mode-exclusivity.test.ts` (AOF_INTEGRATION gate) | role-match |
| `tests/integration/long-poll-spawn.test.ts` | test (integration) | event-driven | `tests/integration/gateway-dispatch.test.ts` | role-match |
| `tests/integration/hold-no-plugin.test.ts` | test (integration) | N/A | `tests/integration/dispatch-pipeline.test.ts` | role-match |
| `tests/integration/daemon-restart-midpoll.test.ts` | test (integration) | N/A | `tests/integration/install-mode-exclusivity.test.ts` (sandboxed $HOME + AOF_INTEGRATION gate) | role-match |
| `tests/integration/plugin-session-boundaries.test.ts` | test (integration) | N/A | `src/openclaw/__tests__/plugin.unit.test.ts` (api mock + double-register) | role-match |

### Modified files

| Modified File | Scope of change |
|---------------|-----------------|
| `src/openclaw/adapter.ts` | Gut. Remove `schedulerService`, `AOFService` construction, `resolveProjectStore`, `getStoreForActor`, `PermissionAwareTaskStore`, `logger.addOnEvent` wiring, `api.registerService`, `service.start()` self-start block, `api.registerHttpRoute` routes, 4 of 7 `api.on` hooks (stay local — D-07), `OpenClawAdapter`/`MockAdapter` construction. Keep: `invocationContextStore`, `mergeDispatchNotificationRecipient`, tool-registry loop (execute body replaced by IPC proxy), `withCtx` helper, adapter-specific project tools (now thin IPC proxies per Research §Open Q2). |
| `src/plugin.ts` | Keep `resolvePluginConfig` / `normalizeDataDir`. Downstream `registerAofPlugin` no longer returns an `AOFService`. Update return type only. |
| `src/daemon/daemon.ts` | Construct `PluginRegistry`, `SpawnQueue`, `PluginBridgeAdapter`, `SelectingAdapter`. Attach new IPC routes via `attachIpcRoutes(healthServer, deps)`. Keep `StandaloneAdapter` as fallback. Add `daemon.mode` config flag handling. |
| `src/daemon/server.ts` | Either (a) extend the inline route dispatch switch with new routes, or (b) move to route-map pattern and mount via `attachIpcRoutes`. Set `server.keepAliveTimeout = 60_000` and `server.headersTimeout = 61_000` for long-poll safety. |
| `src/config/registry.ts` | Add `daemon.mode: z.enum(["plugin-bridge", "standalone"]).default("standalone")` to `AofConfigSchema`. Add `AOF_DAEMON_MODE` to `KNOWN_AOF_VARS` + `readEnvInput`. |
| `src/dispatch/scheduler-helpers.ts` | Extend `classifySpawnError` to recognize `"hold"` classification OR add companion `classifyHold` helper; follow existing `"permanent" \| "transient" \| "rate_limited"` union extension. |
| `src/dispatch/assign-executor.ts` | Add third branch in `else` of `if (result.success)`: when `result.error === "no-plugin-attached"` (or a sentinel marker), release lease + leave in ready + emit `dispatch.held` event + log. Mirrors the `platformLimit` branch at L196-227. |
| `scripts/install.sh` | Revert Phase 42 D-03 plugin-mode skip in `install_daemon()`. Demote `--force-daemon` to no-op with deprecation warning. |
| `src/cli/commands/setup.ts` | Register `migration007` in migration list (L84). |

## Pattern Assignments

---

### `src/ipc/schemas.ts` (schema, request-response)

**Analog:** `src/schemas/run.ts`

**Imports pattern** (Research §IPC Envelope Schema Sketch):
```typescript
import { z } from "zod";
```

**Schema export + type-inference pattern** (from `src/schemas/run.ts:9-27`):
```typescript
export const RunArtifact = z.object({
  taskId: z.string(),
  agentId: z.string(),
  // ... fields with defaults via .default(...)
});
export type RunArtifact = z.infer<typeof RunArtifact>;
```

**Apply to Phase 43** — exactly this shape for `InvokeToolRequest`, `InvokeToolResponse`, `IpcError`, `IpcErrorKind`, `SpawnRequest`, `SpawnResultPost`, `SessionEndEvent`, `AgentEndEvent`, `BeforeCompactionEvent`. Keep `z.record(z.string(), z.unknown())` for `params` (Research line 231 mandates passthrough on inner params; inner schema is tool-registry). Use `.strict()` on envelope, `.passthrough()` via `z.record(...)` for inner params.

**No new runtime deps** — use only `zod ^3.24.0` already in tree (Research §Standard Stack).

---

### `src/ipc/routes/invoke-tool.ts` (route handler, request-response)

**Analog:** `src/daemon/server.ts` (lines 29-60) — the `/status` handler is the closest existing example of "parse request → dispatch → JSON response → errors map to 503".

**Core route pattern** (copy structure from `src/daemon/server.ts:38-55`):
```typescript
if (req.method === "GET" && req.url === "/status") {
  try {
    const state = getState();
    const context = getContext?.();
    const health = await getHealthStatus(state, store, context);
    const httpStatus = health.status === "healthy" ? 200 : 503;
    res.writeHead(httpStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify(health));
  } catch (err) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "unhealthy", error: (err as Error).message }));
  }
  return;
}
```

**Inner dispatch pattern** (from `src/openclaw/adapter.ts:297-310` tool-registry loop):
```typescript
for (const [name, def] of Object.entries(toolRegistry)) {
  const execute = withPermissions(def.handler, resolveProjectStore, getStoreForActor, logger, opts.orgChartPath);
  api.registerTool({ name, description: def.description, parameters: zodToJsonSchema(def.schema), execute });
}
```

**Apply to Phase 43** — the handler:
1. Read body (bounded, ~1 MB cap per Research §Threat Patterns L700).
2. `InvokeToolRequest.safeParse(JSON.parse(body))` — on failure return `400 { error: { kind: "validation", details: { issues } } }`.
3. `toolRegistry[name]` lookup — on miss return `404 { error: { kind: "not-found", ... } }`.
4. `def.schema.safeParse(params)` — tool-specific schema is source of truth.
5. Resolve `store` via a daemon-side equivalent of `resolveProjectStore` + `getStoreForActor` (both migrate from `src/openclaw/adapter.ts:118-149`, Research §Plugin Thin-Bridge Restructure "Permission enforcement moves to daemon").
6. Build `ToolContext` matching `src/tools/types.ts:15-24`.
7. `def.handler(ctx, inner.data)` — in a try/catch; errors map to `IpcError` kinds.

**Error classification helper** — create `classifyError(err): IpcErrorKind` following the pattern of `src/dispatch/scheduler-helpers.ts::classifySpawnError` (line 164) — keyword match on lowercased message → one of `validation | not-found | permission | timeout | internal | unavailable`.

---

### `src/ipc/routes/spawn-wait.ts` (route handler, long-poll server)

**Analog (partial):** `src/daemon/server.ts` for the request-handler shape; `src/dispatch/lease-manager.ts` for long-running-handle lifecycle (though that's timer-based, not socket-based).

**No existing long-poll example in the codebase** — this is the one new network pattern. Follow the sketch from Research §Long-Poll Protocol L305-343:

**Server-side long-poll skeleton** (Research sketch, Node 22 `http`):
```typescript
async function handleSpawnWait(req: IncomingMessage, res: ServerResponse, deps: IpcDeps): Promise<void> {
  const queue = deps.spawnQueue;
  const registry = deps.pluginRegistry;

  const handle = registry.register(req, res);  // increments activePluginCount; auto-cleans on res.close

  try {
    const claimant = queue.claim();
    if (claimant) {
      sendJson(res, 200, claimant);
      return;
    }

    const keepAliveMs = 25_000;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      res.writeHead(204);
      res.end();
    }, keepAliveMs);

    const onEnqueue = (sr: SpawnRequest): void => {
      if (settled) return;
      if (!queue.tryClaim(sr.id)) return;  // another waiter got it
      settled = true;
      clearTimeout(timer);
      queue.off("enqueue", onEnqueue);
      sendJson(res, 200, sr);
    };

    res.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      queue.off("enqueue", onEnqueue);
      // Nothing was claimed — no cleanup on queue itself.
    });

    queue.on("enqueue", onEnqueue);
  } finally {
    handle.release();
  }
}
```

**Keepalive server tuning** (Research §Keepalive Calibration + Pitfall 1 L708):
```typescript
// In src/ipc/server-attach.ts (or wherever server is constructed)
healthServer.keepAliveTimeout = 60_000;
healthServer.headersTimeout = 61_000;
```

**Use only `node:http`** — Research §Pitfall 4 L725 mandates NOT using `fetch` for Unix-socket IPC. `AbortSignal.timeout` on `fetch({ socketPath })` is unreliable in some Node versions; `http.request({ socketPath, signal })` is clean in Node ≥ 20.4 (we're on 22.22.2).

---

### `src/ipc/spawn-queue.ts` (service, pub-sub)

**Analog:** No direct analog. Closest patterns:
- `src/dispatch/throttle.ts` — module-level in-memory state with reset-for-test semantics (use same shape).
- Node's built-in `EventEmitter` — extend for `enqueue`/`claim`/`release` events.

**Skeleton** (derived from Research §Long-Poll Protocol + §Threat Patterns L704 "Bound max concurrent long-polls"):
```typescript
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/index.js";
import type { SpawnRequest } from "./schemas.js";

const log = createLogger("spawn-queue");

export class SpawnQueue extends EventEmitter {
  private pending = new Map<string, SpawnRequest>();
  private claimed = new Set<string>();

  enqueue(sr: Omit<SpawnRequest, "id">): SpawnRequest {
    const full: SpawnRequest = { id: randomUUID(), ...sr };
    this.pending.set(full.id, full);
    this.emit("enqueue", full);
    return full;
  }

  claim(): SpawnRequest | undefined {
    // Pop oldest unclaimed
    for (const [id, sr] of this.pending) {
      if (!this.claimed.has(id)) {
        this.claimed.add(id);
        this.pending.delete(id);
        return sr;
      }
    }
    return undefined;
  }

  tryClaim(id: string): boolean {
    const sr = this.pending.get(id);
    if (!sr) return false;
    this.claimed.add(id);
    this.pending.delete(id);
    return true;
  }

  reset(): void { this.pending.clear(); this.claimed.clear(); this.removeAllListeners(); }
}
```

**No spawn-request-lease primitive needed** — Research §Long-Poll Protocol L402 confirms the existing AOF task-lease (`src/store/lease.ts`) handles "plugin crashed mid-spawn". Don't add another primitive.

---

### `src/ipc/plugin-registry.ts` (service, event-driven)

**Analog:** `src/dispatch/throttle.ts` — module-level registry with `resetThrottleState` for tests.

**Pattern from throttle.ts** — expose `get`/`register`/`unregister`/`reset` as module-scope state. Phase 43 variant tracks active long-polls:

```typescript
import type { ServerResponse, IncomingMessage } from "node:http";
import { createLogger } from "../logging/index.js";

const log = createLogger("plugin-registry");

export interface PluginHandle {
  pluginId: string;
  connectedAt: number;
  release(): void;
}

export class PluginRegistry {
  private active = new Map<string, PluginHandle>();

  register(req: IncomingMessage, res: ServerResponse, pluginId = "openclaw"): PluginHandle {
    const handleId = `${pluginId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const handle: PluginHandle = {
      pluginId,
      connectedAt: Date.now(),
      release: () => { this.active.delete(handleId); log.info({ pluginId }, "plugin detached"); },
    };
    this.active.set(handleId, handle);
    log.info({ pluginId }, "plugin attached");

    // Auto-release on connection drop (Research §Pitfall 2 L714 — single cleanup path)
    res.on("close", () => handle.release());

    return handle;
  }

  hasActivePlugin(pluginId = "openclaw"): boolean {
    for (const h of this.active.values()) if (h.pluginId === pluginId) return true;
    return false;
  }

  activeCount(): number { return this.active.size; }

  reset(): void { this.active.clear(); }  // test helper
}
```

---

### `src/ipc/server-attach.ts` (wiring, request-response)

**Analog:** `src/daemon/server.ts::createHealthServer` (lines 14-64).

**Pattern to follow** — accept the existing server + deps object, mount the new route handlers. Preferred: refactor `createHealthServer` to a route-map so extending with 6 new routes is trivial (Research §Route Implementation Pattern L245 "a `switch(req.url + req.method)` or a small route map is cleaner for 8 routes than a long if-chain").

```typescript
import type { Server } from "node:http";
import { SpawnQueue } from "./spawn-queue.js";
import { PluginRegistry } from "./plugin-registry.js";
import { handleInvokeTool } from "./routes/invoke-tool.js";
import { handleSpawnWait } from "./routes/spawn-wait.js";
// ... etc

export interface IpcDeps {
  toolRegistry: typeof import("../tools/tool-registry.js").toolRegistry;
  resolveStore: (opts: { actor?: string; projectId?: string }) => Promise<ITaskStore>;
  logger: EventLogger;
  spawnQueue: SpawnQueue;
  pluginRegistry: PluginRegistry;
  log: ReturnType<typeof createLogger>;
}

export function attachIpcRoutes(server: Server, deps: IpcDeps): void {
  // Set keepalive for long-poll safety (Research §Keepalive Calibration)
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 61_000;

  server.on("request", async (req, res) => {
    // Route only /v1/* — let existing /healthz and /status pass through
    if (!req.url?.startsWith("/v1/")) return;
    try {
      if (req.method === "POST" && req.url === "/v1/tool/invoke") return handleInvokeTool(req, res, deps);
      if (req.method === "POST" && req.url === "/v1/event/session-end") return handleSessionEnd(req, res, deps);
      // ... other routes
      res.writeHead(404); res.end();
    } catch (err) {
      deps.log.error({ err, url: req.url }, "IPC route threw");
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    }
  });
}
```

---

### `src/openclaw/daemon-ipc-client.ts` (service, request-response)

**Analog:**
- `src/daemon/server.ts::selfCheck` (lines 70-93) — **canonical** Unix-socket HTTP client pattern in this repo.
- `src/daemon/standalone-adapter.ts::spawnSession` (lines 101-158) — fetch-based shape (but Research §Pitfall 4 mandates `http.request`, not `fetch`, for Unix socket).

**Imports pattern** (from `src/daemon/server.ts:1-2`):
```typescript
import { request as httpRequest } from "node:http";
import { createLogger } from "../logging/index.js";
```

**selfCheck-shape request pattern** (from `src/daemon/server.ts:70-93`):
```typescript
export function selfCheck(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { socketPath, path: "/healthz", method: "GET", timeout: 2000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}
```

**Apply to Phase 43** — generalize this into a `postJson(path, body, timeoutMs)` method:
```typescript
export class DaemonIpcClient {
  private readonly log = createLogger("plugin-bridge");
  constructor(private readonly socketPath: string) {}

  async invokeTool(envelope: InvokeToolRequest, timeoutMs = 30_000): Promise<InvokeToolResponse> {
    return this.postJson("/v1/tool/invoke", envelope, timeoutMs);
  }

  async waitForSpawn(timeoutMs = 30_000): Promise<SpawnRequest | undefined> {
    const { statusCode, body } = await this.getRaw("/v1/spawns/wait", timeoutMs);
    if (statusCode === 204) return undefined;
    if (statusCode === 200) return SpawnRequest.parse(JSON.parse(body));
    throw new Error(`unexpected long-poll status ${statusCode}`);
  }

  async postSpawnResult(id: string, result: SpawnResultPost): Promise<void> {
    await this.postJson(`/v1/spawns/${encodeURIComponent(id)}/result`, result, 10_000);
  }

  // ... postSessionEnd / postAgentEnd / postBeforeCompaction

  private postJson<TReq, TRes>(path: string, body: TReq, timeoutMs: number): Promise<TRes> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = httpRequest(
        { socketPath: this.socketPath, path, method: "POST",
          timeout: timeoutMs,
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(new Error(`IPC timeout after ${timeoutMs}ms on ${path}`)); });
      req.write(payload);
      req.end();
    });
  }
}
```

**Module-level singleton pattern** (Research §Pitfall 3 L719 — "Module-scope singleton lost on OpenClaw reload"):
```typescript
let cachedClient: DaemonIpcClient | null = null;

export function ensureDaemonIpcClient(opts: { socketPath: string }): DaemonIpcClient {
  if (!cachedClient || cachedClient.socketPath !== opts.socketPath) {
    cachedClient = new DaemonIpcClient(opts.socketPath);
  }
  return cachedClient;
}
```

This mirrors how `schedulerService` survives OpenClaw per-session reloads today (`src/openclaw/adapter.ts:56` — the thing being removed).

---

### `src/openclaw/spawn-poller.ts` (service, event-driven long-poll client)

**Analog:**
- `src/daemon/standalone-adapter.ts::pollForCompletion` (lines 207-242) — polling loop shape with backoff.
- `src/openclaw/openclaw-executor.ts::OpenClawAdapter::runAgentBackground` (lines 148-239) — the `runEmbeddedPiAgent` call path that becomes the spawn-handler invoked per long-poll result.

**Poll-loop shape** (adapt from `standalone-adapter.ts:207-242`):
```typescript
async function pollForCompletion(...): Promise<void> {
  const startMs = Date.now();
  const maxPollMs = 30 * 60 * 1000;
  let intervalMs = 2000;
  while (Date.now() - startMs < maxPollMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    intervalMs = Math.min(intervalMs * 1.5, 15000);
    // ... do polling work
  }
}
```

**Apply to Phase 43** (Research §Long-Poll Protocol L348-376 plugin-side sketch):
```typescript
import { createLogger } from "../logging/index.js";
import type { DaemonIpcClient } from "./daemon-ipc-client.js";
import type { OpenClawApi } from "./types.js";
import type { SpawnRequest, SpawnResultPost } from "../ipc/schemas.js";
import { OpenClawAdapter } from "./openclaw-executor.js";  // reused for runAgentBackground logic

const log = createLogger("spawn-poller");

let spawnPollerStarted = false;  // module-level idempotency (Pitfall 3)

export function startSpawnPollerOnce(client: DaemonIpcClient, api: OpenClawApi): void {
  if (spawnPollerStarted) return;
  spawnPollerStarted = true;
  void runLoop(client, api).catch((err) => {
    log.error({ err }, "spawn poller loop terminated unexpectedly");
    spawnPollerStarted = false;  // allow re-start on next register()
  });
}

async function runLoop(client: DaemonIpcClient, api: OpenClawApi): Promise<never> {
  const adapter = new OpenClawAdapter(api);   // reuse verbatim — Research §OpenClaw Plugin Reload L486
  let backoffMs = 1000;

  while (true) {
    try {
      const sr = await client.waitForSpawn(30_000);
      if (!sr) { backoffMs = 1000; continue; }        // 204 keepalive — reconnect immediately

      // Fire-and-forget the spawn itself; post result when done.
      void handleSpawn(adapter, sr)
        .then((result) => client.postSpawnResult(sr.id, result).catch((err) =>
          log.error({ err, spawnId: sr.id }, "postSpawnResult failed")))
        .catch((err) => {
          log.error({ err, spawnId: sr.id }, "spawn handler threw");
          void client.postSpawnResult(sr.id, {
            sessionId: "unknown", success: false, aborted: false,
            error: { kind: "exception", message: err instanceof Error ? err.message : String(err) },
            durationMs: 0,
          });
        });

      backoffMs = 1000;   // success — reset backoff
    } catch (err) {
      log.warn({ err, backoffMs }, "spawn poll error");
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }
}

async function handleSpawn(adapter: OpenClawAdapter, sr: SpawnRequest): Promise<SpawnResultPost> {
  // Construct TaskContext from SpawnRequest fields; invoke adapter.spawnSession (reuses
  // runtime.agent.runEmbeddedPiAgent path — Research §OpenClaw Plugin Reload L486 "moves verbatim")
  // ...
}
```

**Runtime check on plugin connect** (Research §Daemon-down-at-plugin-register L292):
```typescript
// In registerAofPlugin — before startSpawnPollerOnce
const healthy = await selfCheck(daemonSocketPath(opts.dataDir));
if (!healthy) log.warn({ socketPath }, "daemon unreachable on register, retrying");
// ... bounded retry with exponential backoff 1s→2s→4s→8s cap 30s; then fail loud
```

---

### `src/dispatch/plugin-bridge-adapter.ts` (adapter, GatewayAdapter)

**Analog:** `src/dispatch/executor.ts::MockAdapter` (lines 140-278) — same interface target; same shape for `spawnSession`/`getSessionStatus`/`forceCompleteSession`. Also `src/openclaw/openclaw-executor.ts` for the real-spawn semantics being proxied.

**Imports pattern** (from `src/dispatch/executor.ts:1-10` for interface + `src/daemon/standalone-adapter.ts:1-21` for adapter style):
```typescript
import { createLogger } from "../logging/index.js";
import type { GatewayAdapter, TaskContext, SpawnResult, SessionStatus, AgentRunOutcome } from "./executor.js";
import type { SpawnQueue } from "../ipc/spawn-queue.js";
import type { PluginRegistry } from "../ipc/plugin-registry.js";

const log = createLogger("plugin-bridge-adapter");
```

**Class structure pattern** (from `src/dispatch/executor.ts::MockAdapter` L140+):
```typescript
export class PluginBridgeAdapter implements GatewayAdapter {
  private pendingByTask = new Map<string, (outcome: AgentRunOutcome) => void | Promise<void>>();

  constructor(
    private readonly queue: SpawnQueue,
    private readonly registry: PluginRegistry,
  ) {}

  async spawnSession(context: TaskContext, opts?: {
    timeoutMs?: number;
    correlationId?: string;
    onRunComplete?: (outcome: AgentRunOutcome) => void | Promise<void>;
  }): Promise<SpawnResult> {
    if (!this.registry.hasActivePlugin()) {
      // D-12: sentinel for SelectingAdapter or assign-executor to recognize
      return { success: false, error: "no-plugin-attached" };
    }

    const sr = this.queue.enqueue({
      taskId: context.taskId,
      taskPath: context.taskPath,
      agent: context.agent,
      priority: context.priority,
      routing: context.routing,
      projectId: context.projectId,
      projectRoot: context.projectRoot,
      timeoutMs: opts?.timeoutMs,
      correlationId: opts?.correlationId,
      // callbackDepth carried via context.metadata.callbackDepth — D-06 envelope, not env
    });

    if (opts?.onRunComplete) this.pendingByTask.set(context.taskId, opts.onRunComplete);
    return { success: true, sessionId: sr.id };   // sessionId = spawn-request id until plugin posts real one
  }

  /** Called by the /v1/spawns/{id}/result route handler to deliver spawn outcome. */
  async deliverResult(id: string, result: SpawnResultPost, taskId: string): Promise<void> {
    const cb = this.pendingByTask.get(taskId);
    this.pendingByTask.delete(taskId);
    if (!cb) return;
    await cb({ taskId, sessionId: result.sessionId, success: result.success,
               aborted: result.aborted, error: result.error, durationMs: result.durationMs });
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatus> { /* alive=true until result posted */ }
  async forceCompleteSession(sessionId: string): Promise<void> { /* drop from pendingByTask */ }
}
```

---

### `src/dispatch/selecting-adapter.ts` (adapter selector)

**Analog:** `src/openclaw/adapter.ts::resolveAdapter` (lines 61-70) — exactly the selection pattern, but at dispatch-time rather than construction-time.

**Existing resolveAdapter** (from `src/openclaw/adapter.ts:61-70`):
```typescript
function resolveAdapter(api: OpenClawApi, store: ITaskStore): GatewayAdapter {
  const config = api.config as Record<string, unknown> | undefined;
  const adapterType = (config?.executor as Record<string, unknown>)?.adapter;
  if (adapterType === "mock") return new MockAdapter();
  return new OpenClawAdapter(api, store);
}
```

**Apply to Phase 43** (Research §Adapter Selection L429):
```typescript
import type { GatewayAdapter, TaskContext, SpawnResult, SessionStatus, AgentRunOutcome } from "./executor.js";
import type { PluginRegistry } from "../ipc/plugin-registry.js";
import { createLogger } from "../logging/index.js";

const log = createLogger("selecting-adapter");

export interface SelectingAdapterOptions {
  primary: GatewayAdapter;     // PluginBridgeAdapter
  fallback: GatewayAdapter;    // StandaloneAdapter
  registry: PluginRegistry;
  mode: "plugin-bridge" | "standalone";   // D-12: mode determines fallback behavior
}

export class SelectingAdapter implements GatewayAdapter {
  constructor(private readonly opts: SelectingAdapterOptions) {}

  async spawnSession(context: TaskContext, spawnOpts?: Parameters<GatewayAdapter["spawnSession"]>[1]): Promise<SpawnResult> {
    if (this.opts.registry.hasActivePlugin()) {
      return this.opts.primary.spawnSession(context, spawnOpts);
    }
    if (this.opts.mode === "standalone") {
      return this.opts.fallback.spawnSession(context, spawnOpts);
    }
    // D-12: plugin-bridge mode + no plugin → hold-in-ready sentinel
    log.info({ taskId: context.taskId }, "holding task: no-plugin-attached");
    return { success: false, error: "no-plugin-attached" };
  }

  getSessionStatus(sessionId: string): Promise<SessionStatus> {
    // Route by sessionId prefix or pending map — implementation detail.
    return this.opts.registry.hasActivePlugin()
      ? this.opts.primary.getSessionStatus(sessionId)
      : this.opts.fallback.getSessionStatus(sessionId);
  }

  forceCompleteSession(sessionId: string): Promise<void> {
    return this.opts.registry.hasActivePlugin()
      ? this.opts.primary.forceCompleteSession(sessionId)
      : this.opts.fallback.forceCompleteSession(sessionId);
  }
}
```

---

### `src/dispatch/assign-executor.ts` (modified) — hold classification

**Analog pattern within this file:** `platformLimit` capacity-exhaustion branch (lines 196-227).

**Copy that pattern** — the hold-in-ready behavior (D-12) mirrors platformLimit verbatim (Research §Hold-in-ready L455 confirms this is the blueprint):

```typescript
} else {
  // Check if this is a platform concurrency limit error
  if (result.platformLimit !== undefined) {
    // ... existing logic — release lease, leave in ready, log, no retry count
    return { executed, failed };
  }

  // NEW (Phase 43 D-12): no-plugin-attached hold
  if (result.error === "no-plugin-attached") {
    log.info({ taskId: action.taskId, op: "hold" }, "holding task: no plugin attached");

    try {
      await releaseLease(store, action.taskId, action.agent!);
    } catch (releaseErr) {
      log.error({ err: releaseErr, taskId: action.taskId, op: "releaseLease" }, "failed to release lease");
    }

    try {
      await logger.log("dispatch.held", "scheduler", {
        taskId: action.taskId,
        payload: { reason: "no-plugin-attached", agent: action.agent, correlationId },
      });
    } catch (logErr) {
      log.warn({ err: logErr, taskId: action.taskId, op: "logDispatchHeld" }, "event logger write failed (best-effort)");
    }

    // No retry count increment — this is hold, not failure (Research §Hold-in-ready L451)
    return { executed, failed };   // executed=false, failed=false
  }

  // ... existing permanent/transient classification continues
}
```

**Constraint (CLAUDE.md Fragile):** Don't touch `scheduler.ts`, `task-dispatcher.ts`, or `action-executor.ts`. Change lands entirely in `assign-executor.ts` + optional helper in `scheduler-helpers.ts` (Research §Pitfall 6 L736).

---

### `src/packaging/migrations/007-daemon-required.ts` (migration)

**Analog:** `src/packaging/migrations/004-scaffold-repair.ts` (canonical idempotent skeleton, 30 lines) + `src/packaging/migrations/006-data-code-separation.ts` (idempotency breadcrumb pattern).

**Imports pattern** (from `004-scaffold-repair.ts:1-8`):
```typescript
import type { Migration, MigrationContext } from "../migrations.js";
import { ensureScaffold } from "../wizard.js";
```

**Migration export pattern** (from `004-scaffold-repair.ts:11-29`):
```typescript
export const migration004: Migration = {
  id: "004-scaffold-repair",
  version: "1.9.0",
  description: "Ensure scaffold directories and org chart exist",
  up: async (ctx: MigrationContext): Promise<void> => {
    const repaired = await ensureScaffold(ctx.aofRoot);
    if (repaired.length === 0) {
      console.log(`  \x1b[32m\u2713\x1b[0m 004-scaffold-repair skipped (scaffold intact)`);
    } else {
      console.log(`  \x1b[32m\u2713\x1b[0m 004-scaffold-repair applied (repaired: ${repaired.join(", ")})`);
    }
  },
};
```

**Apply to Phase 43** (Research §Migration 007 skeleton L519):
```typescript
import type { Migration, MigrationContext } from "../migrations.js";
import { installService } from "../../daemon/service-file.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const migration007: Migration = {
  id: "007-daemon-required",
  version: "1.15.0",   // planner: verify against `package.json` + `git tag --sort=-v:refname | head -5` (MEMORY.md)
  description: "Phase 43: install aof-daemon service as plugin IPC authority",

  up: async (ctx: MigrationContext): Promise<void> => {
    const plist = join(homedir(), "Library/LaunchAgents/ai.openclaw.aof.plist");
    const unit = join(homedir(), ".config/systemd/user/ai.openclaw.aof.service");

    if (existsSync(plist) || existsSync(unit)) {
      console.log(`  \x1b[32m\u2713\x1b[0m 007-daemon-required skipped (daemon service already installed)`);
      return;
    }

    await installService({ dataDir: join(ctx.aofRoot, "data") });
    console.log(`  \x1b[32m\u2713\x1b[0m 007-daemon-required installed aof-daemon service`);
  },
};
```

**Register:** Add `migration007` to the list in `src/cli/commands/setup.ts:84` (`return [migration001, migration003, migration004, migration005, migration006, migration007];`).

**No `down()`** — follow precedent from 004/005/006 (Research §Rollback path L560). Canonical rollback is "install older AOF version".

---

### `src/openclaw/adapter.ts` (modified) — thin-bridge restructure

**Analog:** itself (structure shell stays). Research §Plugin Thin-Bridge Restructure L595 gives the ~100-line target shape.

**Keep from current adapter.ts:**
- `invocationContextStore` construction (L80) — stays plugin-local (D-07).
- `mergeDispatchNotificationRecipient` helper (L208-239) — stays plugin-local; runs BEFORE IPC send.
- `withCtx` helper (L265-268) — still needed for event forwarding.
- Tool-registry `for...of Object.entries(toolRegistry)` loop (L297-310) — **structure stays**; `execute` body changes from `withPermissions(...)` to `client.invokeTool(...)`.
- `logger` imports and `createLogger('openclaw')` line (L2-5).

**Remove (D-02):**
- `FilesystemTaskStore` import + construction (L3, L75).
- `EventLogger` import + construction (L7, L78).
- `AOFMetrics` import + construction (L8, L79).
- `NotificationPolicyEngine`, `ConsoleNotifier`, `MatrixNotifier`, `OpenClawChatDeliveryNotifier` (L10-18, L151-179).
- `AOFService` import + construction (L9, L187-198).
- `OpenClawAdapter` import + `resolveAdapter` + `MockAdapter` construction (L13, L19-20, L61-70, L181-184).
- `loadOrgChart` + `orgChartPromise` + `PermissionAwareTaskStore` (L21-23, L101-113).
- `createProjectStore` + `resolveProjectStore` + `getStoreForActor` (L28, L118-149).
- `resolveStoreForTask` (L157-170).
- `logger.addOnEvent(...)` wiring (L172-179).
- Module-level `schedulerService` singleton (L56) + self-start block (L249-259).
- `api.registerService({ id: SERVICE_NAME, ... })` (L242-247).
- `api.registerHttpRoute(...)` for `/aof/metrics`, `/aof/status` (L387-390) — OR keep as IPC-proxy per Research §Open Q4; planner decides.
- Project-specific tools (`aof_project_create`, `aof_project_list`, `aof_project_add_participant`) at L312-384 — move into `src/tools/tool-registry.ts` and reach them via the IPC proxy loop (Research §Open Q2 recommendation).
- `withPermissions` import + usage (L27, L298).
- `zodToJsonSchema` import (L29) — KEEP; still needed for the proxy loop's `parameters`.

**Event hook selective forwarding** (D-07, Research §Event Forwarding L566 table):
```typescript
api.on("session_end", (event, ctx) => {
  invocationContextStore.clearSessionRoute(withCtx(event, ctx));
  void client.postSessionEnd(withCtx(event, ctx));
});
api.on("agent_end", (event, ctx) => { void client.postAgentEnd(withCtx(event, ctx)); });
api.on("before_compaction", () => {
  invocationContextStore.clearAll();
  void client.postBeforeCompaction();
});
// Local-only (no IPC):
api.on("message_received", (event, ctx) => invocationContextStore.captureMessageRoute(withCtx(event, ctx)));
api.on("message_sent", (event, ctx) => invocationContextStore.captureMessageRoute(withCtx(event, ctx)));
api.on("before_tool_call", (event, ctx) => invocationContextStore.captureToolCall(withCtx(event, ctx)));
api.on("after_tool_call", (event, ctx) => invocationContextStore.clearToolCall(withCtx(event, ctx)));
```

**Tool-registry proxy loop** (Research §Plugin Thin-Bridge Restructure sketch L620):
```typescript
for (const [name, def] of Object.entries(toolRegistry)) {
  api.registerTool({
    name,
    description: def.description,
    parameters: zodToJsonSchema(def.schema) as { type: string; properties?: Record<string, unknown>; required?: string[] },
    execute: async (id, params) => {
      const effectiveParams = name === "aof_dispatch"
        ? mergeDispatchNotificationRecipient(params, id)
        : params;
      const response = await client.invokeTool({
        pluginId: "openclaw",
        name,
        params: effectiveParams,
        actor: effectiveParams.actor as string | undefined,
        projectId: effectiveParams.project as string | undefined,
        correlationId: randomUUID(),  // or extract from tool ctx if available
        toolCallId: id,
        callbackDepth: parseCallbackDepth(effectiveParams),
      });
      if ("error" in response) {
        throw new Error(`${response.error.kind}: ${response.error.message}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(response.result, null, 2) }] };
    },
  });
}
```

---

### `src/daemon/daemon.ts` (modified) — adapter wiring

**Existing pattern to modify** (L72-93):
```typescript
const executor = opts.dryRun
  ? undefined
  : new StandaloneAdapter({ gatewayUrl: opts.gatewayUrl, gatewayToken: opts.gatewayToken });

const service = new AOFService(
  { store, logger, metrics: opts.metrics, poller: opts.poller, executor },
  { dataDir: opts.dataDir, dryRun: opts.dryRun, /* ... */ },
);
```

**Apply to Phase 43** (Research §Adapter Selection L426):
```typescript
import { PluginRegistry } from "../ipc/plugin-registry.js";
import { SpawnQueue } from "../ipc/spawn-queue.js";
import { PluginBridgeAdapter } from "../dispatch/plugin-bridge-adapter.js";
import { SelectingAdapter } from "../dispatch/selecting-adapter.js";
import { attachIpcRoutes } from "../ipc/server-attach.js";

// ... in startAofDaemon:
const pluginRegistry = new PluginRegistry();
const spawnQueue = new SpawnQueue();
const standaloneAdapter = new StandaloneAdapter({ gatewayUrl: opts.gatewayUrl, gatewayToken: opts.gatewayToken });
const pluginBridgeAdapter = new PluginBridgeAdapter(spawnQueue, pluginRegistry);
const daemonMode = getConfig().daemon.mode;  // D-12: "plugin-bridge" | "standalone"

const executor = opts.dryRun ? undefined : new SelectingAdapter({
  primary: pluginBridgeAdapter,
  fallback: standaloneAdapter,
  registry: pluginRegistry,
  mode: daemonMode,
});

// ... after createHealthServer:
attachIpcRoutes(healthServer, {
  toolRegistry,
  resolveStore: buildDaemonResolveStore({ dataDir: opts.dataDir, store }),
  logger,
  spawnQueue,
  pluginRegistry,
  log,
});
```

---

### `src/config/registry.ts` (modified) — daemon mode flag

**Existing pattern** (L37-42):
```typescript
daemon: z
  .object({
    pollIntervalMs: z.coerce.number().positive().default(30_000),
    socketPath: z.string().optional(),
  })
  .default({}),
```

**Apply to Phase 43:**
```typescript
daemon: z
  .object({
    pollIntervalMs: z.coerce.number().positive().default(30_000),
    socketPath: z.string().optional(),
    mode: z.enum(["plugin-bridge", "standalone"]).default("standalone"),  // D-12 adapter selection
  })
  .default({}),
```

**Also update** (L81-93): Add `"AOF_DAEMON_MODE"` to `KNOWN_AOF_VARS`. **Also update** `readEnvInput` (L110+) to propagate `env["AOF_DAEMON_MODE"]` into the `daemon.mode` slot.

---

### Tests

---

#### `src/daemon/__tests__/server.test.ts`-style — `src/ipc/__tests__/invoke-tool-handler.test.ts` (unit)

**Analog:** `src/daemon/__tests__/server.test.ts` lines 1-117.

**`fetchSocket` helper to copy verbatim** (from `src/daemon/__tests__/server.test.ts:12-28`):
```typescript
function fetchSocket(socketPath: string, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: "GET" }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => { try { resolve({ status: res.statusCode!, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode!, body: data }); }});
    });
    req.on("error", reject);
    req.end();
  });
}
```

**Phase 43 extension** — extend with a `postSocket(socketPath, path, body)` variant. Test lifecycle mirrors `beforeEach`/`afterEach` from L38-77.

---

#### `src/openclaw/__tests__/adapter.test.ts`-style — `src/openclaw/__tests__/event-forwarding.test.ts` (unit)

**Analog:** `src/openclaw/__tests__/adapter.test.ts:15-93`.

**API mock pattern to copy** (L17-29):
```typescript
const api: OpenClawApi = {
  registerService: (def) => services.push({ id: def.id }),
  registerTool: (def) => tools.push({ name: def.name }),
  registerHttpRoute: (def) => routes.push({ path: def.path }),
  on: (event, handler) => { events[event] = handler; },
};
```

**Event handler trigger pattern** (L86-92):
```typescript
events["session_end"]?.();
events["agent_end"]?.({ agent: "swe-backend" });
events["message_received"]?.({ from: "swe-backend" });
expect(service.handleSessionEnd).toHaveBeenCalled();
```

**Phase 43 apply** — mock `DaemonIpcClient`, fire each of 7 hooks, assert:
- `client.postSessionEnd` called exactly when `session_end` fires.
- `client.postAgentEnd` called exactly when `agent_end` fires.
- `client.postBeforeCompaction` called exactly when `before_compaction` fires.
- `client.post*` NOT called for `message_received`, `message_sent`, `before_tool_call`, `after_tool_call`.
- `invocationContextStore.captureMessageRoute` IS called for `message_received`/`message_sent` (local side-effect unchanged).

---

#### `src/packaging/__tests__/006-data-code-separation.test.ts`-style — `src/packaging/migrations/__tests__/007-daemon-required.test.ts` (unit)

**Analog:** `src/packaging/__tests__/006-data-code-separation.test.ts:1-70`.

**Test structure pattern** (L13-26):
```typescript
describe("Migration 006: data-code-separation", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-mig006-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tmpDir, { recursive: true, force: true });
  });
  // ... tests
});
```

**Phase 43 apply** — use same `process.env.HOME` override pattern. Test cases:
1. plist already exists → migration is no-op (verify breadcrumb log line).
2. unit already exists → migration is no-op.
3. Neither exists → `installService` is called with `dataDir = join(ctx.aofRoot, "data")`.
4. Rerun after case 3 → idempotent (no second `installService` call).

Mock `installService` with `vi.mock("../../daemon/service-file.js", ...)` to avoid actual launchd registration.

---

#### `src/dispatch/__tests__/bug-003-error-propagation.test.ts`-style — `src/dispatch/__tests__/bug-NNN-dispatch-hold.test.ts` (regression)

**Analog:** `src/dispatch/__tests__/bug-003-error-propagation.test.ts:1-70`.

**Regression naming (CLAUDE.md):** `bug-NNN-description.test.ts` — pick NNN from existing dispatch bug numbering; verify via `ls src/dispatch/__tests__/bug-*.test.ts`.

**Test skeleton to copy** (L26-43):
```typescript
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bug003-err-test-"));
  events = [];
  logger = new EventLogger(join(tmpDir, "events"), { onEvent: (event) => events.push(event) });
  store = new FilesystemTaskStore(tmpDir, { logger });
  await store.init();
  executor = new MockAdapter();
});
```

**Phase 43 apply** — drive `SelectingAdapter` with a `PluginRegistry` that has zero active plugins, feed it a ready task, poll, and assert:
- Task status remains `ready/` (not moved to blocked/deadletter).
- Lease is released.
- `dispatch.held` event emitted with `reason: "no-plugin-attached"`.
- `retryCount` is NOT incremented on task metadata.

---

#### `tests/integration/install-mode-exclusivity.test.ts`-style — Phase 43 integration tests

**Analog:** `tests/integration/install-mode-exclusivity.test.ts:64-120`.

**Skip gate pattern to copy verbatim** (L64-67):
```typescript
const SHOULD_RUN = process.platform === "darwin" && process.env.AOF_INTEGRATION === "1";
describe.skipIf(!SHOULD_RUN)("...", () => { /* ... */ });
```

**Sandbox $HOME pattern** (L85-96):
```typescript
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "aof-install-mode-"));
  fakeHome = join(sandbox, "home");
  prefix = join(fakeHome, ".aof");
  dataDir = join(fakeHome, ".aof-data");
  mkdirSync(fakeHome, { recursive: true });
});
afterEach(() => { rmSync(sandbox, { recursive: true, force: true }); });
```

**Phase 43 apply** — same sandbox pattern for each of:
- `tool-invoke-roundtrip.test.ts` — spin up daemon on tmp socket, POST `/v1/tool/invoke` for each of the 13 registry tools (parameterized).
- `long-poll-spawn.test.ts` — cover 4 sub-cases: enqueue-before-poll, enqueue-after-poll, 25s keepalive → 204 → reconnect, plugin drops mid-poll.
- `hold-no-plugin.test.ts` — poll with empty `PluginRegistry`, assert task still in `ready/`; register a long-poll listener, re-poll, assert dispatch proceeds.
- `daemon-restart-midpoll.test.ts` — start daemon → connect plugin → kill daemon → restart → assert plugin reconnects and task re-dispatches.
- `plugin-session-boundaries.test.ts` — call `registerAofPlugin(api, opts)` twice on same api mock; assert `startSpawnPollerOnce` idempotency (single long-poll, not two).

---

## Shared Patterns

### Logging
**Source:** `src/logging/index.ts::createLogger` + convention across all modules (e.g. `src/daemon/standalone-adapter.ts:21`, `src/dispatch/assign-executor.ts:23`).
**Apply to:** All new files in `src/ipc/`, `src/openclaw/daemon-ipc-client.ts`, `src/openclaw/spawn-poller.ts`, `src/dispatch/plugin-bridge-adapter.ts`, `src/dispatch/selecting-adapter.ts`.
```typescript
import { createLogger } from "../logging/index.js";
const log = createLogger("component-name");   // e.g. "daemon-ipc", "plugin-bridge", "spawn-poller"
```
**Never:** `console.log/info/warn/error` in any non-CLI module (CLAUDE.md). Migrations are the narrow exception (they use `console.log` for user-visible progress; see `src/packaging/migrations/004-scaffold-repair.ts:20`).

### Config access
**Source:** `src/config/registry.ts::getConfig`.
**Apply to:** Anywhere a non-trivial env/config value is read.
```typescript
import { getConfig } from "../config/registry.js";
const cfg = getConfig();
const mode = cfg.daemon.mode;
```
**Never:** `process.env.*` reads (CLAUDE.md — the one documented exception is `AOF_CALLBACK_DEPTH` in `src/dispatch/callback-delivery.ts:352,400`; Phase 43 DOES NOT add more, carrying `callbackDepth` in the IPC envelope instead per Research §IPC Envelope L241).

### Zod source of truth
**Source:** `src/schemas/run.ts:9-27` + all `src/schemas/*.ts`.
**Apply to:** All new IPC schemas in `src/ipc/schemas.ts`.
```typescript
export const Foo = z.object({ /* ... */ });
export type Foo = z.infer<typeof Foo>;
```
**Constraint:** Inner `params` in `InvokeToolRequest` uses `z.record(z.string(), z.unknown())` passthrough; tool-specific validation happens on the daemon side via `toolRegistry[name].schema.safeParse(params)` (Research §IPC Envelope L231).

### Store access
**Source:** `src/store/interfaces.ts::ITaskStore`.
**Apply to:** Daemon-side `/v1/tool/invoke` handler — always `store.get/save/transition/list` via `ITaskStore`, never `serializeTask + writeFileAtomic` directly (CLAUDE.md). Plugin side has no store access post-D-02.

### Tool registry + framework-agnostic handler
**Source:** `src/tools/tool-registry.ts::toolRegistry` (L59-146) + `src/tools/types.ts::ToolContext` (L15-24).
**Apply to:** `/v1/tool/invoke` daemon handler loops this registry; plugin-side `registerAofPlugin` also loops it but proxies via IPC. No duplication. Research §Open Q2 recommends moving `aof_project_create/list/add_participant` from adapter.ts L312-384 into this registry.

### Error-handling structure in route handlers
**Source:** `src/daemon/server.ts:38-53` `/status` try/catch.
**Apply to:** Every new `/v1/*` route handler. Wrap inner dispatch in `try`, catch all `Error`, map via `classifyError` to `IpcError`, set HTTP status from error kind (400 for validation, 404 for not-found, 403 for permission, 500 for internal, 503 for unavailable).

### Module-level singleton (surviving OpenClaw reload)
**Source:** `src/openclaw/adapter.ts:56` `let schedulerService: AOFService | null = null` — the pattern being **replaced** (not removed) by a new `DaemonIpcClient` singleton.
**Apply to:** `src/openclaw/daemon-ipc-client.ts::cachedClient` and `src/openclaw/spawn-poller.ts::spawnPollerStarted`. Research §Pitfall 3 L719 — "Never rely on construction-time behavior being a one-shot". Always guard with an idempotency check.

### `.js` in import paths (ESM)
**Source:** every `.ts` file in the repo (see `src/daemon/daemon.ts:1-14`).
**Apply to:** Every new file. `import { foo } from "../module.js"` — even though the source is `.ts`.

### Barrel files
**Source:** `src/daemon/index.ts`, `src/tools/index.ts`.
**Apply to:** `src/ipc/index.ts`. Pure re-exports only; no logic (CLAUDE.md).

### Integration test AOF_INTEGRATION gate
**Source:** `tests/integration/install-mode-exclusivity.test.ts:64-67`.
**Apply to:** Every file under `tests/integration/` that Phase 43 adds.
```typescript
const SHOULD_RUN = process.platform === "darwin" && process.env.AOF_INTEGRATION === "1";
describe.skipIf(!SHOULD_RUN)("...", () => { /* ... */ });
```
Note: tests that don't require macOS-specific launchd semantics should relax to just `process.env.AOF_INTEGRATION === "1"`.

### Regression test naming
**Source:** `src/dispatch/__tests__/bug-003-error-propagation.test.ts`.
**Apply to:** Any regression test Phase 43 lands (especially the hold-behavior regression). Format: `bug-NNN-description.test.ts` (CLAUDE.md).

---

## No Analog Found

Files with no close match in the codebase (planner should lean on RESEARCH.md + Node `http` docs):

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/ipc/routes/spawn-wait.ts` | streaming long-poll handler | event-driven | No existing streaming/long-held response in this repo. Pattern is Node-idiomatic (`res.on('close')`, kept `setTimeout`), sourced from Research §Long-Poll Protocol L305 + Node `http` docs. GitHub Actions runner / Buildkite agent are the reference pattern, per Research §Reference Patterns L407. |
| `src/ipc/spawn-queue.ts` | EventEmitter-based pending queue | pub-sub | AOF has no in-memory queue today (everything is filesystem-first). Closest is `src/dispatch/lease-manager.ts` timer bookkeeping — similar shape but different semantics. Skeleton in this PATTERNS.md is derived from Node's standard `EventEmitter` + the queue semantics specified in Research §Long-Poll Protocol L310-343. |

---

## Metadata

**Analog search scope:** `src/`, `tests/integration/`, `.planning/phases/{42,43}/`, `scripts/`
**Files scanned:** ~40 direct reads, ~15 grep sweeps
**Pattern extraction date:** 2026-04-17

**Key conventions confirmed from CLAUDE.md:**
- `getConfig()` only for env access (except `AOF_CALLBACK_DEPTH` legacy).
- `createLogger('component')` — no `console.*` outside CLI/migrations.
- `ITaskStore` methods only; no direct serialize+atomic-write.
- Zod schemas in `src/ipc/schemas.ts` (new leaf module) + `src/schemas/*.ts` (existing).
- `.js` import suffixes everywhere (ESM under Node ≥22).
- `src/ipc/` must be leaf — imports from `tools/`, `schemas/`, `store/` allowed; nothing above imports from `ipc/` except `openclaw/`, `daemon/`, `tests/` (Research §Project Constraints L943).
- Regression tests: `bug-NNN-description.test.ts`.
- Integration tests: `AOF_INTEGRATION=1` gate.
- Fragile dispatch chain: restrict D-12 changes to `assign-executor.ts` + `scheduler-helpers.ts`; don't touch `scheduler.ts`, `task-dispatcher.ts`, `action-executor.ts` (Research §Pitfall 6).

**Wave assignment hints (for planner) — from Research §Summary L91:**
- Wave 0: test harness + fixtures (all new `tests/integration/helpers/*` + empty test files as RED anchors).
- Wave 1: `src/ipc/schemas.ts`, `src/ipc/routes/invoke-tool.ts`, `src/ipc/server-attach.ts`, plugin-side `DaemonIpcClient.invokeTool`, tool-registry loop replacement in `adapter.ts`.
- Wave 2: `src/ipc/spawn-queue.ts`, `src/ipc/plugin-registry.ts`, `src/ipc/routes/spawn-wait.ts`, `src/ipc/routes/spawn-result.ts`, `src/dispatch/plugin-bridge-adapter.ts`, `src/dispatch/selecting-adapter.ts`, `src/openclaw/spawn-poller.ts`, assign-executor hold branch.
- Wave 3: event-forwarding routes + plugin-side `adapter.ts` thin-bridge gut (remove AOFService, schedulerService, resolveProjectStore, etc.).
- Wave 4: `migration007`, installer reversal in `scripts/install.sh`, `--force-daemon` deprecation warn.
