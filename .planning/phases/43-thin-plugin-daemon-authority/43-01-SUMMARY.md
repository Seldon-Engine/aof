---
phase: 43
plan: 01
subsystem: ipc,dispatch,openclaw,packaging
tags: [wave-0, red-tests, tdd-scaffolding, nyquist]
requires: []
provides:
  - RED unit-test scaffolding covering 11 Phase 43 seams
  - D-13 pluginId default + D-06 envelope RED anchor
  - D-06 invoke-tool handler RED anchor
  - D-09 SpawnQueue RED anchor
  - D-11 PluginRegistry RED anchor
  - D-08 0600 socket perms RED anchor
  - D-10 SelectingAdapter + PluginBridgeAdapter RED anchors
  - D-12 no-plugin-attached hold regression (bug-043)
  - D-07 (A1-amended, FOUR forwarded hooks) event-forwarding RED anchor
  - D-05/D-06/D-09 DaemonIpcClient RED anchor + Pitfall 3 singleton
  - D-14 migration 007 idempotence RED anchor
affects:
  - Wave 1 implementation contract (src/ipc/schemas.ts, src/ipc/routes/invoke-tool.ts)
  - Wave 2 implementation contract (src/ipc/spawn-queue.ts, src/ipc/plugin-registry.ts, src/dispatch/{selecting,plugin-bridge}-adapter.ts, assign-executor hold branch)
  - Wave 3 implementation contract (src/openclaw/daemon-ipc-client.ts + selective forwarding wiring in adapter.ts)
  - Wave 4 implementation contract (src/packaging/migrations/007-daemon-required.ts)
tech-stack:
  added: []
  patterns:
    - vitest unit tests colocated in __tests__/
    - Unix-socket HTTP stub via node:http for IPC contract tests
    - EventEmitter stand-ins for IncomingMessage/ServerResponse in registry tests
    - vi.mock for daemon/service-file.js in migration tests
    - bug-NNN-description.test.ts regression naming
key-files:
  created:
    - src/ipc/__tests__/envelope.test.ts
    - src/ipc/__tests__/invoke-tool-handler.test.ts
    - src/ipc/__tests__/spawn-queue.test.ts
    - src/ipc/__tests__/plugin-registry.test.ts
    - src/daemon/__tests__/socket-perms.test.ts
    - src/dispatch/__tests__/selecting-adapter.test.ts
    - src/dispatch/__tests__/plugin-bridge-adapter.test.ts
    - src/dispatch/__tests__/bug-043-dispatch-hold.test.ts
    - src/openclaw/__tests__/event-forwarding.test.ts
    - src/openclaw/__tests__/daemon-ipc-client.test.ts
    - src/packaging/migrations/__tests__/007-daemon-required.test.ts
  modified: []
decisions:
  - "A1 RESOLVED: message_received forwards via DaemonIpcClient.postMessageReceived — handleMessageReceived calls protocolRouter.route() at src/service/aof-service.ts:227-234, which mutates daemon-owned session routing state. D-07 is therefore four forwarded hooks, not three. Baked into event-forwarding.test.ts."
  - "Regression test number 043 selected for dispatch-hold (existing dispatch bug suite covers 001-005; 043 scoped to Phase 43 avoids collision and signals phase provenance)."
  - "HoldAdapter (test-local stub) used for bug-043 instead of MockAdapter because MockAdapter.setShouldFail cannot emit the D-12 sentinel verbatim; the test must drive assign-executor with error === 'no-plugin-attached' exactly."
  - "socket-perms.test.ts deliberately imports an EXISTING module (createHealthServer) rather than a missing one — RED state manifests as assertion failure (current mode 0755, expected 0600). Plan success_criteria allows this pattern."
  - "Plan requirements metadata lists D-02, D-05..D-14 (11 decisions) but Wave 0 is scaffolding-only. No requirements can be MARKED COMPLETE in this plan — orchestrator should not pass any req IDs to requirements mark-complete. Requirements close in Waves 1-4 as implementations land."
metrics:
  duration: 7m11s
  completed: 2026-04-17
---

# Phase 43 Plan 01: Wave 0 RED Test Scaffolding Summary

Landed 11 intentionally-failing unit test files anchoring the Nyquist coverage contract for every Phase 43 seam (IPC envelope schemas, /v1/tool/invoke handler, spawn queue, plugin registry, socket permissions, adapter selection, plugin-bridge adapter, dispatch-hold invariant, selective event forwarding, plugin-side IPC client, and migration 007). Each file imports from a `.js` path that has no corresponding `.ts` source (or asserts a behavior the current implementation does not satisfy), producing a deterministic RED→GREEN contract Wave 1+ must close before typecheck can pass.

## Tasks Completed

| Task | Name | Commit |
|------|------|--------|
| 1    | IPC core RED tests (envelope, invoke-tool handler, spawn queue, plugin registry, socket perms) | `dfb8b18` |
| 2    | Dispatch + plugin-side + migration RED tests (selecting/plugin-bridge adapters, bug-043 hold, event forwarding, daemon IPC client, migration 007) | `55d2cb2` |

## RED-State Evidence

Running the 11 test files produces **9 "Cannot find module" compilation errors** (spanning 9 of the 11 test files) plus **8 assertion failures** (2 in socket-perms against 0o600 vs 0o755 default, 6 in bug-043 against the missing hold branch in `assign-executor.ts`). Every failure name-checks the exact module path or behavior Wave 1+ must land:

| Test file | RED manifestation |
|-----------|-------------------|
| `src/ipc/__tests__/envelope.test.ts` | `Cannot find module '../schemas.js'` |
| `src/ipc/__tests__/invoke-tool-handler.test.ts` | `Cannot find module '../routes/invoke-tool.js'` |
| `src/ipc/__tests__/spawn-queue.test.ts` | `Cannot find module '../spawn-queue.js'` |
| `src/ipc/__tests__/plugin-registry.test.ts` | `Cannot find module '../plugin-registry.js'` |
| `src/daemon/__tests__/socket-perms.test.ts` | Assertion failure: `expected 493 (0o755) to be 384 (0o600)` |
| `src/dispatch/__tests__/selecting-adapter.test.ts` | `Cannot find module '../selecting-adapter.js'` |
| `src/dispatch/__tests__/plugin-bridge-adapter.test.ts` | `Cannot find module '../plugin-bridge-adapter.js'` |
| `src/dispatch/__tests__/bug-043-dispatch-hold.test.ts` | Six assertion failures (status='blocked' instead of 'ready', dispatch.held event missing, retryCount incremented, etc.) — the D-12 hold branch does not yet exist in `assign-executor.ts` |
| `src/openclaw/__tests__/event-forwarding.test.ts` | `Cannot find module '../daemon-ipc-client.js'` |
| `src/openclaw/__tests__/daemon-ipc-client.test.ts` | `Cannot find module '../daemon-ipc-client.js'` |
| `src/packaging/migrations/__tests__/007-daemon-required.test.ts` | `Cannot find module '../007-daemon-required.js'` |

## A1 Resolution — message_received forwarding

**Status: CONFIRMED via code inspection** (already baked into CONTEXT.md D-07 as the A1 amendment dated 2026-04-17; re-verified during Wave 0).

`src/service/aof-service.ts:227-234` defines `handleMessageReceived(event)` which calls `parseProtocolMessage(event, this.logger)` and, when the envelope parses, invokes `await this.protocolRouter.route(envelope)`. `protocolRouter.route` mutates daemon-owned session routing state (the whole point of the protocol router). Therefore `message_received` **MUST** forward via IPC — exactly like `session_end`, `agent_end`, and `before_compaction`.

**Concrete impact on Wave 3 plan (43-06):**

- The IPC client surface includes a fourth post method: `DaemonIpcClient.postMessageReceived(envelope)`.
- The IPC route surface includes a fourth event route: `POST /v1/event/message-received`.
- The selective-forward wiring in `src/openclaw/adapter.ts` forwards FOUR hooks, not three; `message_received` is unique in that it also preserves the local `invocationContextStore.captureMessageRoute(...)` side-effect (the plugin continues to capture chat-recipient routing for `aof_dispatch`).
- `message_sent`, `before_tool_call`, `after_tool_call` remain LOCAL-ONLY (capture into `invocationContextStore`, no IPC).

`src/openclaw/__tests__/event-forwarding.test.ts` encodes this contract exactly — it fires all 7 hooks and asserts `postMessageReceived.toHaveBeenCalledTimes(1)`. If Wave 3 implements only three forwarders (pre-A1 spec), this test fails loudly.

## Pattern-Map Alignment

PATTERNS.md called for `bug-NNN-dispatch-hold.test.ts` with NNN selected from the existing dispatch bug numbering. Existing dispatch bug tests span **001-005**. Selected **043** — scoped to Phase 43, no collision, signals phase provenance in the filename. Verified via `ls src/dispatch/__tests__/bug-*.test.ts` before writing.

No other module-path mismatches discovered. PATTERNS.md §"Files with no close match" correctly flagged `src/ipc/routes/spawn-wait.ts` and `src/ipc/spawn-queue.ts` as novel — but Wave 0 tests these via in-test stubs and Node's `EventEmitter`, both of which are standard primitives with no repo-analog needed.

## Tool-Registry Proxy Tests (forward-looking note)

The invoke-tool-handler test ships with a **mock** `toolRegistry` rather than the shared production registry. Rationale: Wave 1's daemon handler signature is still provisional (exact `ToolContext` shape, `resolveStore` interface). Using a minimal mock registry lets Wave 0 lock the envelope/validation/error-kind contract without coupling to implementation details Wave 1 may still change. When Wave 1 lands, the mock can be swapped for the real registry in a follow-up integration test (`tests/integration/tool-invoke-roundtrip.test.ts` is the placeholder per VALIDATION.md).

## Wave 0 RED test count

**Target:** 11 files · **Delivered:** 11 files · All RED confirmed via `npx vitest run`.

## Deviations from Plan

None. Plan executed exactly as written — two atomic commits, eleven test files, RED-state verified per the `<verify>` automated commands in both tasks.

## CLAUDE.md Compliance

- No `console.*` in any new file (tests use vitest's `expect`, not `console`).
- No `process.env.*` reads outside the existing pattern (006-data-code-separation analog, scoped to `HOME` override for migration-007 test).
- All imports use `.js` suffix (ESM) — e.g., `from "../schemas.js"`, `from "../../daemon/service-file.js"`.
- All new files live under colocated `__tests__/` per conventions.
- bug-043 uses the `bug-NNN-description.test.ts` regression-naming pattern.
- No circular deps introduced (tests import only from parent module paths that do not yet exist → no forward references to validate until Wave 1 lands).

## Self-Check: PASSED

- [x] All 11 test files exist on disk (ls verified)
- [x] All 8 target production modules do NOT exist (ls confirmed "No such file or directory")
- [x] Both commits (`dfb8b18`, `55d2cb2`) present in `git log`
- [x] RED state verified via `npx vitest run` producing 9 "Cannot find module" errors + 8 assertion failures across the 11 files
- [x] Every test file references at least one D-## decision (min 3 per file, range 3-17)
- [x] A1 resolution documented (message_received forwards — protocolRouter.route mutates daemon state)
- [x] No shared orchestrator files modified (STATE.md, ROADMAP.md untouched)
