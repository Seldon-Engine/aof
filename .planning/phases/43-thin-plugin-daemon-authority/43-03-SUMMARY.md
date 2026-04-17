---
phase: 43
plan: 03
subsystem: ipc-daemon-wiring
tags: [ipc, daemon, zod, schemas, config, permissions, tool-registry, event-forwarding]
requires:
  - 43-CONTEXT.md (D-05, D-06, D-07 A1, D-08, D-13)
  - 43-RESEARCH.md §IPC Envelope Schema Sketch, §Long-Poll Protocol keepalive tuning, §Pitfalls 1+3
  - 43-PATTERNS.md §src/ipc/schemas.ts, §src/ipc/routes/invoke-tool.ts, §src/ipc/server-attach.ts, §src/daemon/daemon.ts modified
  - 43-VALIDATION.md §Wave 0 Requirements (envelope.test.ts, invoke-tool-handler.test.ts, socket-perms.test.ts)
provides:
  - daemon-side POST /v1/tool/invoke dispatching every toolRegistry entry
  - 4 session-event forwarding routes (session-end, agent-end, before-compaction, message-received per D-07 A1)
  - daemon.mode config flag (plugin-bridge | standalone, default standalone)
  - IPC envelope Zod schemas ready for plugin-side consumption (Wave 3)
  - daemon.sock mode 0600 enforced after listen() via explicit chmod
affects:
  - src/daemon/server.ts (no 404 for /v1/*; chmod 0600 on socket creation)
  - src/daemon/daemon.ts (wires attachIpcRoutes; new AOFDaemonOptions.orgChartPath)
  - src/config/registry.ts (daemon.mode + AOF_DAEMON_MODE)
tech-stack:
  added: []   # all runtime deps (zod, pino, node:http) already in tree
  patterns:
    - Zod .strict() + .refine() for discriminated-union result/error envelope
    - http.Server route-map dispatch inside `server.on("request", …)` attach pattern
    - per-daemon project store cache + WeakSet init tracking (lifted from adapter.ts)
key-files:
  created:
    - src/ipc/schemas.ts
    - src/ipc/types.ts
    - src/ipc/index.ts
    - src/ipc/http-utils.ts
    - src/ipc/store-resolver.ts
    - src/ipc/server-attach.ts
    - src/ipc/routes/invoke-tool.ts
    - src/ipc/routes/session-events.ts
    - src/ipc/__tests__/envelope.test.ts
    - src/ipc/__tests__/invoke-tool-handler.test.ts
    - src/daemon/__tests__/socket-perms.test.ts
    - src/daemon/__tests__/ipc-integration.test.ts
  modified:
    - src/config/registry.ts
    - src/daemon/daemon.ts
    - src/daemon/server.ts
decisions:
  - "InvokeToolResponse uses .strict() + .refine() on the result branch so the union actually discriminates — without the refinement, z.unknown() is satisfied by undefined and `{}` / error-envelope inputs would silently match the result branch."
  - "daemon.sock is chmodded to 0600 explicitly after listen() rather than relying on umask — plan text assumed Node defaults to 0600 but the actual default is 0o666 & umask, which on macOS/Linux yields 0o755."
  - "createHealthServer's request handler falls through (returns) for /v1/* URLs instead of sending 404, letting attachIpcRoutes's request listener respond. Both listeners fire on every request — without the fallthrough the built-in 404 would race the IPC handler."
  - "aof_context_load adapter-extras (_contextRegistry, _skillsDir) are constructed daemon-side: a per-process ContextInterfaceRegistry singleton plus `<dataDir>/skills` path. Open Q3 resolution."
  - "Route dispatch in server-attach.ts is keyed by URL only; method validation lives inside each handler so a GET on a POST-only route returns 405, not 404."
  - "callbackDepth is carried in both InvokeToolRequest and SpawnRequest envelopes as z.number().int().nonnegative().default(0). T-43-07 clamp sets min 0; no max imposed at the schema layer — existing callback-delivery.ts handles recursion bounds."
metrics:
  duration_seconds: ~600
  completed: 2026-04-17
  tasks_total: 3
  tasks_completed: 3
  files_created: 12
  files_modified: 3
  commits: 3
---

# Phase 43 Plan 03: IPC Module + daemon.sock Wiring Summary

Wave 1 plumbing landed. The daemon now owns `POST /v1/tool/invoke` dispatching every entry of the shared `toolRegistry`, plus four session-event forwarding routes (`session-end`, `agent-end`, `before-compaction`, `message-received`) all mounted on the existing `daemon.sock`. The `daemon.mode` config flag (`plugin-bridge` | `standalone`, default `standalone`) is live in `getConfig()`. Wave 2 will mount long-poll spawn routes on the same attached server; Wave 3 will flip the plugin to consume these routes.

## Exact Routes Mounted on daemon.sock

| Method | Path                               | Handler                                      | Status |
| ------ | ---------------------------------- | -------------------------------------------- | ------ |
| POST   | `/v1/tool/invoke`                  | `handleInvokeTool` → `toolRegistry[name]`    | live   |
| POST   | `/v1/event/session-end`            | `handleSessionEnd` → `service.handleSessionEnd()` | live   |
| POST   | `/v1/event/agent-end`              | `handleAgentEnd` → `service.handleAgentEnd()` | live   |
| POST   | `/v1/event/before-compaction`      | `handleBeforeCompaction` → `service.handleSessionEnd()` (piggyback) | live   |
| POST   | `/v1/event/message-received`       | `handleMessageReceived` → `service.handleMessageReceived()` (A1 resolution) | live   |
| GET    | `/v1/spawns/wait`                  | —                                            | Wave 2 |
| POST   | `/v1/spawns/{id}/result`           | —                                            | Wave 2 |

The existing `/healthz` + `/status` routes are untouched and continue to respond exactly as before (verified by `src/daemon/__tests__/server.test.ts` — 7/7 pass, no regressions).

## Open Q3 Resolution — `aof_context_load` Adapter-Extras

`aof_context_load` reads `(ctx as any)._contextRegistry` and `(ctx as any)._skillsDir` from the `ToolContext`. On the daemon side these are resolved by:

1. **`_contextRegistry`** — a lazily-instantiated module-level `ContextInterfaceRegistry` singleton inside `src/ipc/routes/invoke-tool.ts` (`getContextRegistry()`). Shared across all invocations within a daemon process.
2. **`_skillsDir`** — `join(getConfig().core.dataDir, "skills")` — pulled fresh from the config on every request. No env reads outside `getConfig()`.

The plugin no longer needs to construct or pass these extras; the daemon owns the registry and the skills path.

## Callback-Depth Zod Clamp (T-43-07)

Both `InvokeToolRequest.callbackDepth` and `SpawnRequest.callbackDepth` use:

```ts
callbackDepth: z.number().int().nonnegative().default(0)
```

- Min: 0 (integer, nonnegative).
- Max: none imposed at the schema layer. Existing `src/dispatch/callback-delivery.ts` owns the max-depth recursion guard (which was the only reason `AOF_CALLBACK_DEPTH` env mutation existed). T-43-07 accepted for now; bounded int16 or similar ceiling can land later if deeper cycles show up in telemetry.

## Behavioral Changes to Existing Endpoints

**`/healthz` + `/status`:** No behavior change. Existing `src/daemon/__tests__/server.test.ts` (7 tests) passes unchanged. Verified by the new `ipc-integration.test.ts` which also exercises `/healthz`/`/status` round-trip after IPC attach.

**`daemon.sock` permissions:** Now explicitly `0600` via `chmodSync(socketPath, 0o600)` inside `server.listen()`'s callback. The plan text said "Node defaults to 0600" which turned out to be wrong — Node applies the process umask to `0o666`, yielding `0o755` on macOS/Linux by default. Fix is defensive and idempotent.

**`createHealthServer` request handler:** Falls through (returns without writing a response) for any URL starting with `/v1/`. This lets the second `"request"` listener registered by `attachIpcRoutes` own those routes. Without the fallthrough, both listeners would fire per request and the built-in 404 would race the IPC handler.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] `InvokeToolResponse` union failed to discriminate**
- **Found during:** Task 1 envelope test run.
- **Issue:** `z.union([z.object({ result: z.unknown() }), z.object({ error: IpcError })])` accepted `{}` and `{ error: … }` as valid `result`-branch matches because `z.unknown()` is satisfied by `undefined`. Two envelope tests failed.
- **Fix:** Added `.strict()` on both branches and `.refine((v) => "result" in v, …)` on the result branch to require the key be physically present.
- **Files modified:** `src/ipc/schemas.ts`
- **Commit:** `d99d494`

**2. [Rule 1 — Bug] daemon.sock created with 0755, not 0600**
- **Found during:** Task 3 `socket-perms.test.ts` run.
- **Issue:** T-43-01 requires mode 0600; Node's `net.Server.listen(path)` defaults to the process umask applied to 0o666, yielding 0o755 on macOS/Linux. The plan text assumed 0600 was the Node default.
- **Fix:** Added explicit `chmodSync(socketPath, 0o600)` inside the `server.listen()` callback in `createHealthServer`. Matches what the threat register's mitigation plan calls for.
- **Files modified:** `src/daemon/server.ts`
- **Commit:** `ebe4d76`

**3. [Rule 1 — Bug] `/v1/*` routes returned 404 due to double-listener race**
- **Found during:** Task 3 `ipc-integration.test.ts` run — the invoke-tool test got 404 instead of 200.
- **Issue:** `createServer(handler)` registers `handler` as a `"request"` listener. `attachIpcRoutes` adds a second listener. Both fire per request; the first one (`createHealthServer`'s handler) wrote a 404 before the IPC handler could respond.
- **Fix:** `createHealthServer`'s handler now `return`s without writing a response for any `/v1/*` URL, letting the IPC listener handle it.
- **Files modified:** `src/daemon/server.ts`
- **Commit:** `ebe4d76`

**4. [Rule 2 — Missing] Method-mismatch returned 404 instead of 405**
- **Found during:** Task 2 `invoke-tool-handler.test.ts` run — GET on `/v1/tool/invoke` returned 404 from the default route-miss branch.
- **Issue:** Plan behavior spec calls for 405 on method mismatch; initial router dispatched only for method+URL matches, so GET on a known URL fell through to the 404 branch.
- **Fix:** Reorganized `server-attach.ts` to dispatch by URL first via a route map; each handler validates its own method and returns 405 with `Allow: POST` on mismatch.
- **Files modified:** `src/ipc/server-attach.ts`, `src/ipc/routes/invoke-tool.ts`, `src/ipc/routes/session-events.ts`
- **Commit:** `598db40`

### Not Fixed (Out of Scope)

Pre-existing failures in `src/commands/__tests__/memory-cli.test.ts` (11) and `src/commands/__tests__/org-drift-cli.test.ts` (6) — 17 total. Verified baseline via `git stash && npx vitest run …` before any 43-03 changes were in place. Tracked in `.planning/phases/43-thin-plugin-daemon-authority/deferred-items.md`. These tests spawn the CLI as a subprocess and fail for environmental reasons (stale build / missing binary) unrelated to the IPC surface.

## Auth Gates

None encountered — plan is pure local implementation.

## Verification Evidence

**Typecheck:** `npm run typecheck` — clean (0 errors).

**Circular deps:** `npx madge --circular --extensions ts src/` — 0 circular dependencies detected (545 files scanned).

**Targeted tests:**
```
npx vitest run src/ipc/ src/daemon/
Test Files  9 passed (9)
     Tests  130 passed (130)
Duration  1.11s
```

Specific Wave 0 anchors turned GREEN:
- `src/ipc/__tests__/envelope.test.ts` — 21/21 ✓
- `src/ipc/__tests__/invoke-tool-handler.test.ts` — 11/11 ✓
- `src/daemon/__tests__/socket-perms.test.ts` — 1/1 ✓
- `src/daemon/__tests__/ipc-integration.test.ts` — 4/4 ✓ (bonus — plan asked for this as a fresh regression guard)

**CLAUDE.md invariants:**
- `grep -rc "console\." src/ipc/` → 0 ✓
- `grep -rc "process\.env" src/ipc/` → 0 ✓
- `.js` import suffixes throughout ✓
- `createLogger("…")` used for all component loggers (`ipc-store-resolver`) ✓
- `src/ipc/index.ts` is pure re-exports (10 lines, no logic) ✓

## Threat Flags

No new security-relevant surface introduced beyond what was in the plan's threat register (T-43-01/-02/-03/-06/-07). The daemon.sock chmod fix strengthens T-43-01 mitigation rather than introducing a new threat.

## TDD Gate Compliance

This plan is `type=auto tdd=true` at the task level rather than `type=tdd` at the plan level. Each task's RED → GREEN gates were followed: `envelope.test.ts` landed before the schemas were tightened (Task 1), `invoke-tool-handler.test.ts` caught the 405/404 confusion (Task 2), `socket-perms.test.ts` + `ipc-integration.test.ts` caught the chmod gap + double-listener race (Task 3).

## Commits

| Task | Commit    | Message                                                                                     |
| ---- | --------- | ------------------------------------------------------------------------------------------- |
| 1    | `d99d494` | feat(43-03): IPC envelope schemas + daemon.mode config flag (D-05/D-06/D-07/D-13)           |
| 2    | `598db40` | feat(43-03): IPC routes invoke-tool + session-events + server-attach + store-resolver       |
| 3    | `ebe4d76` | feat(43-03): wire attachIpcRoutes into startAofDaemon (D-05 routes live on daemon.sock)     |

## Self-Check: PASSED

Verified every claim above in-tree:
- All created files exist at the paths listed in `key-files.created` ✓
- All modified files have diffs against the base commit ✓
- All three commits are present in `git log --oneline` on this worktree branch ✓
- `npm run typecheck` exits 0 ✓
- `npx vitest run src/ipc/ src/daemon/` — 130/130 pass ✓
