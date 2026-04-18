---
phase: 43-thin-plugin-daemon-authority
reviewed: 2026-04-17T23:59:59Z
depth: quick
files_reviewed: 51
files_reviewed_list:
  - scripts/install.sh
  - src/cli/commands/setup.ts
  - src/config/registry.ts
  - src/daemon/__tests__/daemon-selecting-adapter.test.ts
  - src/daemon/__tests__/ipc-integration.test.ts
  - src/daemon/__tests__/socket-perms.test.ts
  - src/daemon/daemon.ts
  - src/daemon/server.ts
  - src/dispatch/__tests__/bug-043-dispatch-hold.test.ts
  - src/dispatch/__tests__/plugin-bridge-adapter.test.ts
  - src/dispatch/__tests__/selecting-adapter.test.ts
  - src/dispatch/assign-executor.ts
  - src/dispatch/plugin-bridge-adapter.ts
  - src/dispatch/selecting-adapter.ts
  - src/ipc/__tests__/envelope.test.ts
  - src/ipc/__tests__/invoke-tool-handler.test.ts
  - src/ipc/__tests__/plugin-registry.test.ts
  - src/ipc/__tests__/spawn-queue.test.ts
  - src/ipc/http-utils.ts
  - src/ipc/index.ts
  - src/ipc/plugin-registry.ts
  - src/ipc/routes/invoke-tool.ts
  - src/ipc/routes/session-events.ts
  - src/ipc/routes/spawn-result.ts
  - src/ipc/routes/spawn-wait.ts
  - src/ipc/schemas.ts
  - src/ipc/server-attach.ts
  - src/ipc/spawn-queue.ts
  - src/ipc/store-resolver.ts
  - src/ipc/types.ts
  - src/openclaw/__tests__/adapter.test.ts
  - src/openclaw/__tests__/daemon-ipc-client.test.ts
  - src/openclaw/__tests__/event-forwarding.test.ts
  - src/openclaw/__tests__/plugin.unit.test.ts
  - src/openclaw/__tests__/spawn-poller.test.ts
  - src/openclaw/adapter.ts
  - src/openclaw/daemon-ipc-client.ts
  - src/openclaw/dispatch-notification.ts
  - src/openclaw/openclaw-executor.ts
  - src/openclaw/spawn-poller.ts
  - src/openclaw/status-proxy.ts
  - src/packaging/migrations/__tests__/007-daemon-required.test.ts
  - src/packaging/migrations/007-daemon-required.ts
  - src/plugin.ts
  - src/schemas/event.ts
  - src/tools/__tests__/project-management-tools.test.ts
  - src/tools/project-management-tools.ts
  - src/tools/tool-registry.ts
  - tests/integration/daemon-restart-midpoll.test.ts
  - tests/integration/helpers/daemon-harness.ts
  - tests/integration/helpers/plugin-ipc-client.ts
  - tests/integration/hold-no-plugin.test.ts
  - tests/integration/install-mode-exclusivity.test.ts
  - tests/integration/long-poll-spawn.test.ts
  - tests/integration/plugin-session-boundaries.test.ts
  - tests/integration/tool-invoke-roundtrip.test.ts
findings:
  critical: 0
  warning: 3
  info: 3
  total: 6
status: issues_found
---

# Phase 43: Code Review Report

**Reviewed:** 2026-04-17T23:59:59Z
**Depth:** quick
**Files Reviewed:** 51
**Status:** issues_found

## Summary

Phase 43 introduces the thin-plugin-daemon-authority architecture: a new `src/ipc/` module tree, a rewritten `openclaw/adapter.ts` (393→145 lines), `PluginBridgeAdapter`, `SelectingAdapter`, `SpawnQueue`, `PluginRegistry`, Migration 007, and the long-poll spawn-delivery protocol (D-09). The security-critical socket permission enforcement (T-43-01, 0600 chmod in `server.ts`), Zod validation at every IPC boundary, and the `AOF_CALLBACK_DEPTH` env-access exception are all correctly implemented. No hardcoded secrets, dangerous function calls, or `console.*` in core modules were found. The IPC trust boundary is enforced at the filesystem layer (socket 0600) — no token-auth layer is added, which is consistent with the same-uid trust model documented in the threat model.

Three warnings and three info findings are surfaced below.

## Warnings

### WR-01: `readBody` — chunks still accumulate after `PayloadTooLargeError` is thrown

**File:** `src/ipc/http-utils.ts:30`
**Issue:** When the running `size` crosses `maxBytes`, `req.destroy()` is called and the promise is rejected. However, any `"data"` events already buffered in Node's event queue before `destroy()` takes effect will still invoke the listener, executing `chunks.push(buf)` after the promise is settled. This is harmless for promise semantics (the resolved/rejected state is final) but the chunks array continues to grow in memory until the socket closes — a potential (minor) DoS amplifier if a malicious same-uid process sends a body just over the limit.

**Fix:** Add an early-return guard in the `"data"` handler once the size cap is breached:
```typescript
req.on("data", (chunk: Buffer | string) => {
  const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  size += buf.length;
  if (size > maxBytes) {
    if (!limitExceeded) {
      limitExceeded = true;
      req.destroy();
      reject(new PayloadTooLargeError(`request body exceeded ${maxBytes} bytes`));
    }
    return;   // <-- stop accumulating
  }
  chunks.push(buf);
});
```
Use a `let limitExceeded = false` flag alongside `size`.

---

### WR-02: `install.sh` equality guard uses `&&` instead of `||` — symlink bypass

**File:** `scripts/install.sh:175-176`
**Issue:** The guard preventing `--data-dir` from equalling `--prefix` uses:
```sh
if [ "$(cd "$INSTALL_DIR" 2>/dev/null && pwd)" = "$(cd "$DATA_DIR" 2>/dev/null && pwd)" ] \
   && [ "$INSTALL_DIR" = "$DATA_DIR" ]; then
```
The `&&` between the two conditions means the guard only fires when **both** the canonically-resolved paths AND the raw strings are equal. If a user supplies a symlink path for one argument (e.g. `--data-dir /sym/link` → resolves to same as `--prefix /real/path`), the canonical check is `true` but the raw-string check is `false`, so the guard is bypassed. The raw-string check is redundant and weakens the protection.

**Fix:** Drop the raw-string condition — the canonical form is sufficient:
```sh
if [ "$(cd "$INSTALL_DIR" 2>/dev/null && pwd)" = "$(cd "$DATA_DIR" 2>/dev/null && pwd)" ]; then
```

---

### WR-03: `SpawnQueue` — `enqueue()` casts `partial` with `as SpawnRequest` unsafely

**File:** `src/ipc/spawn-queue.ts:39`
**Issue:** `enqueue(partial: Omit<SpawnRequest, "id">)` constructs the full object with:
```typescript
const full = { id: randomUUID(), ...partial } as SpawnRequest;
```
The `as SpawnRequest` cast bypasses TypeScript's structural check for this assignment. If `SpawnRequest` ever gains a new required field beyond `id`, the spread would silently produce an object missing that field at runtime, but TypeScript would not flag the call sites that pass `Omit<SpawnRequest, "id">` (since `Omit` would be stale). This is a correctness time-bomb: adding a required field to `SpawnRequest` later would not generate a compile error here.

**Fix:** Use a typed intermediate or remove the cast and let TypeScript infer:
```typescript
const full: SpawnRequest = { id: randomUUID(), ...partial };
```
Without `as`, TypeScript will enforce that `{ id: string } & Omit<SpawnRequest, "id">` satisfies `SpawnRequest`.

---

## Info

### IN-01: `daemon.ts` — `providersConfigured` is hardcoded to `0`

**File:** `src/daemon/daemon.ts:141`
**Issue:** `providersConfigured: 0, // TODO: wire to actual provider count` — a TODO stub in production status output. This is benign (no crash risk) but could mislead operators reading `/status`.

**Fix:** Wire the actual count from `toolRegistry` or stub with a meaningful constant until the metric is tracked. Remove the TODO comment once resolved.

---

### IN-02: `migration007` uses `console.log` directly

**File:** `src/packaging/migrations/007-daemon-required.ts:44`
**Issue:** The `say()` helper calls `console.log(...)` directly rather than using the project's structured logger. Per `CLAUDE.md`: "No `console.*` in core modules (CLI output OK)." Migrations run inside `runSetup` which is invoked via the CLI (`aof setup`), so this is borderline CLI output — but it is inconsistent with how other migrations in the same file group surface messages (most delegate to the `say()` pattern in `setup.ts` which also uses `console.log`). Minor convention deviation rather than a bug.

**Fix:** Either accept it as CLI output (all migrations use this pattern) or thread a `log` callback from `MigrationContext` for uniformity. No immediate action required.

---

### IN-03: `local` keyword in `#!/bin/sh` script

**File:** `scripts/install.sh:610,630,636,646,655,718,852,877,891,973,981,990`
**Issue:** The script uses `#!/bin/sh` but relies on `local` for function-scoped variables. `local` is not part of POSIX `sh`; it is a bash/dash/ksh extension. On most Linux systems `/bin/sh` is `dash` which supports `local`, but on some minimal shells (e.g. BusyBox `sh` without `local` support, or older Solaris `sh`) this will fail at runtime with `local: not found`. The installation target environment (`Node >= 22` systems) is almost always Linux/macOS where `local` is available, making this a low-risk portability note.

**Fix:** Either change the shebang to `#!/bin/bash` to be explicit about the required shell, or document the minimum shell requirement. The current `curl | sh` invocation pattern makes portability relevant.

---

_Reviewed: 2026-04-17T23:59:59Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: quick_
