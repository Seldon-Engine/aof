---
phase: 46-daemon-state-freshness-fix-project-discovery-one-shot-bug-st
plan: 06
subsystem: ipc
tags: [ipc, openclaw, dispatch, actor, createdBy, traceability, defense-in-depth]

# Dependency graph
requires:
  - phase: 44
    provides: captured.actor field (agentId from before_tool_call) populated in OpenClawToolInvocationContextStore
provides:
  - Daemon-side envelope.actor → inner.data.actor injection at /v1/tool/invoke
  - Plugin-side defense-in-depth params.actor fallback from captured.actor
  - Reordered mergeDispatchNotificationRecipient so consumeToolCall fires before notifyOnCompletion=false early-return
  - Bug-046e regression coverage (3 daemon cases + 4 plugin cases)
affects: [phase 47+, any future plan touching IPC envelope handling, dispatch tooling, or createdBy propagation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-pronged actor propagation (RESEARCH.md Pattern 6): primary daemon-side IPC fix + plugin-side defense-in-depth, both with explicit precedence rules"

key-files:
  created:
    - src/ipc/__tests__/bug-046e-actor-injection.test.ts
    - src/openclaw/__tests__/bug-046e-dispatch-notification-actor.test.ts
  modified:
    - src/ipc/routes/invoke-tool.ts
    - src/openclaw/dispatch-notification.ts

key-decisions:
  - "Daemon-side enrichment uses ternary spread on inner.data with `as typeof inner.data` cast (matches existing ToolContext-assembly pattern at lines 148-162)"
  - "Plugin-side reorder of consumeToolCall ahead of notifyOnCompletion=false early-return (preferred over adapter-side hook to keep actor-injection colocated with the one function that knows about captured.actor)"
  - "Precedence: explicit params.actor > envelope.actor > captured.actor > undefined (handler ?? \"unknown\" fallback)"

patterns-established:
  - "Envelope-derived field injection at the IPC boundary: when an envelope-level field has a corresponding optional params field, inject from envelope only when params field is undefined"
  - "Pre-IPC plugin transforms own field-level enrichment for fields the daemon side cannot reconstruct (captured.actor lives only in plugin-local store)"

requirements-completed:
  - BUG-046-2C

# Metrics
duration: ~22 min
completed: 2026-04-25
---

# Phase 46 Plan 06: Bug 2C Summary

**Two-pronged actor propagation fix — daemon-side envelope.actor injection at /v1/tool/invoke + plugin-side captured.actor fallback in mergeDispatchNotificationRecipient — restoring forensic traceability on plugin-originated tasks.**

## Performance

- **Duration:** ~22 min
- **Started:** 2026-04-25T15:54:00Z (worktree base reset)
- **Completed:** 2026-04-25T16:01:00Z
- **Tasks:** 3 (RED, GREEN-daemon, GREEN-plugin)
- **Files modified:** 2 source + 2 test (1 deferred-items.md tracking note)

## Accomplishments

- **Daemon-side primary fix** (`src/ipc/routes/invoke-tool.ts`): when the IPC envelope carries `actor` and `inner.data.actor` is undefined, the route now passes an `enrichedParams` object with the envelope actor merged in to `def.handler(ctx, enrichedParams)`. Caller-supplied `params.actor` still wins (explicit precedence preserved).
- **Plugin-side defense-in-depth** (`src/openclaw/dispatch-notification.ts`): `mergeDispatchNotificationRecipient` now consumes the captured invocation context BEFORE the `notifyOnCompletion === false` early-return, then injects `params.actor` from `captured.actor` (the gateway-attested agentId from `before_tool_call`) when params has no actor.
- **Regression coverage** (7 new tests): 3 daemon-side cases pin envelope-injects-when-absent / explicit-wins / undefined-preserved invariants. 4 plugin-side cases pin the captured-fallback / explicit-wins / no-fallback-when-no-source / actor-injection-survives-notifyOff invariants.
- **Forensic traceability restored:** the 5 `createdBy: "unknown"` tasks from the 2026-04-25 incident would be correctly attributed to the calling agent's id under post-Phase-46 behavior. Both the primary path (envelope-bearing IPC) and the defense-in-depth path (plugin captured context) are wired.

## Task Commits

Each task committed atomically:

1. **Task 1: RED regression tests** — `fa7bae4` (test)
2. **Task 2: Daemon-side envelope actor injection** — `b17a153` (fix)
3. **Task 3: Plugin-side captured.actor fallback** — `f96d27c` (fix)

## Files Created/Modified

- `src/ipc/routes/invoke-tool.ts` — Phase 46 / Bug 2C enrichment block between ToolContext assembly and `def.handler` call. The `enrichedParams` ternary spreads envelope `actor` into a copy of `inner.data` only when `inner.data.actor` is undefined.
- `src/openclaw/dispatch-notification.ts` — `consumeToolCall` moved ahead of `if (raw === false) return params` early-return. New `existingActor` / `enriched` block injects captured.actor when params has none. All downstream branches now work from `enriched` (incl. the `notifyOnCompletion: false` short-circuit, which now returns the enriched object rather than the raw params input).
- `src/ipc/__tests__/bug-046e-actor-injection.test.ts` (NEW) — 3 cases under `describe("Phase 46 / Bug 2C — envelope actor injection")` exercising the IPC handler via the same UDS-server scaffolding as `invoke-tool-handler.test.ts`.
- `src/openclaw/__tests__/bug-046e-dispatch-notification-actor.test.ts` (NEW) — 4 cases pinning the plugin-side fallback shape, including a `buildStoredRecipient` factory mirroring the `OpenClawNotificationRecipient` interface for typed mock construction.
- `.planning/phases/46-.../deferred-items.md` (NEW) — documents pre-existing CLI test failures (memory-cli, org-drift-cli) that depend on a built `dist/` and are out of scope for plan 46-06.

## Daemon-side enrichment shape

```typescript
const enrichedParams: typeof inner.data =
  actor && (inner.data as { actor?: string }).actor === undefined
    ? ({ ...(inner.data as Record<string, unknown>), actor } as typeof inner.data)
    : inner.data;
```

Same-shape alias when neither condition holds (no allocation cost on the hot path); fresh object only when injection is needed. Cast through `Record<string, unknown>` and back to `typeof inner.data` matches the existing project pattern in this file (ToolContext assembly cast at lines 148-162). MCP path is unaffected because MCP supplies its own envelope.actor of `"mcp"` via `mcp/tools.ts`.

## Plugin-side reorder

Pre-Phase-46 flow:

```typescript
const raw = params.notifyOnCompletion;
if (raw === false) return params;       // ← short-circuit BEFORE consume
const captured = store.consumeToolCall(toolCallId);
```

Post-Phase-46 flow:

```typescript
const captured = store.consumeToolCall(toolCallId);     // ← always fires
const existingActor = typeof params.actor === "string" && params.actor.length > 0
  ? params.actor : undefined;
const enriched = !existingActor && captured?.actor
  ? { ...params, actor: captured.actor } : params;
const raw = params.notifyOnCompletion;
if (raw === false) return enriched;     // ← short-circuit returns enriched
```

Behavioral implications of the reorder (documented in module docstring + inline comments):

1. `consumeToolCall` now fires on every `aof_dispatch`, regardless of `notifyOnCompletion` setting. Previously only fired on the non-`false` paths. The store entry is consumed-and-deleted in either case (no other caller reads the same toolCallId, so no shared-state hazard).
2. The `notifyOnCompletion: false` early-return now returns the actor-enriched params object. Referential identity with the input is preserved ONLY when no actor injection was needed (no captured.actor OR params already had a non-empty actor) — the existing `dispatch-notification.test.ts:83-86` test's `toBe(params)` assertion still passes because that test fixture never captures a route, so `enriched === params`.

## Decisions Made

- **Inline ternary cast over helper function** — the daemon-side enrichment is two lines and reads cleanly; extracting it would obscure the precedence logic.
- **Plugin-side reorder over adapter-side hook** (PATTERNS.md option 1 over option 2) — keeps actor-injection colocated with the one module that knows about `captured.actor`. An adapter-side hook would duplicate context-store knowledge across two modules.
- **`existingActor` as separate const** — makes the precedence rule readable at a glance: "if explicit, use that; else fall back to captured."

## Deviations from Plan

None — plan executed exactly as written. The plan's RED tests, GREEN tasks, and acceptance criteria all matched the resulting code shape on first attempt.

## Issues Encountered

- **17 unrelated test failures in full unit suite** — `src/commands/__tests__/memory-cli.test.ts` (11) and `src/commands/__tests__/org-drift-cli.test.ts` (6) `spawnSync` the built `dist/cli/index.js` and assert on exit code 0. The fresh worktree has no `dist/`, so these subprocess tests fail with non-zero exit codes. Out of scope per deviation rules SCOPE BOUNDARY clause; documented in `deferred-items.md`. Verified the IPC suite (60 tests) and openclaw suite (83 tests) — both touched by this plan — are 100% green.

## User Setup Required

None.

## Forensic traceability check

The 5 `createdBy: "unknown"` tasks from the 2026-04-25 incident were dispatched by the OpenClaw `main` agent through the gateway plugin without explicit `params.actor`. Under post-Phase-46 behavior:

- The plugin's `OpenClawToolInvocationContextStore.captureToolCall` already fired on `before_tool_call` (Phase 44), populating `captured.actor = "main"` indexed by `toolCallId`.
- `mergeDispatchNotificationRecipient` would now consume that capture and inject `params.actor = "main"` into the params before they're forwarded to the IPC envelope.
- The adapter at `src/openclaw/adapter.ts:119` would then set `envelope.actor = "main"` (sourced from `p.actor`).
- The daemon-side `/v1/tool/invoke` handler would propagate `envelope.actor` into `inner.data.actor` (since the agent did not supply one explicitly).
- `aofDispatch.handler` would then resolve `const actor = input.actor ?? "unknown"` to `"main"`, stamping `createdBy: "main"` on the resulting task.

Both the primary fix (daemon-side, covers any plugin or non-plugin caller that sets envelope.actor) and the defense-in-depth fix (plugin-side, covers the case where the agent doesn't pass actor explicitly even with envelope-level injection) are independently sufficient for this scenario; together they form a belt-and-suspenders propagation chain.

## Self-Check: PASSED

Verification:
- `src/ipc/routes/invoke-tool.ts` exists, contains `Phase 46 / Bug 2C` and `enrichedParams`
- `src/openclaw/dispatch-notification.ts` exists, contains `Phase 46 / Bug 2C` and `captured?.actor`
- `src/ipc/__tests__/bug-046e-actor-injection.test.ts` exists (3 GREEN tests)
- `src/openclaw/__tests__/bug-046e-dispatch-notification-actor.test.ts` exists (4 GREEN tests)
- Commit `fa7bae4` (RED) present in `git log --oneline`
- Commit `b17a153` (GREEN-daemon) present
- Commit `f96d27c` (GREEN-plugin) present
- IPC suite: 60/60 GREEN
- Openclaw suite: 83/83 GREEN
- Existing `dispatch-notification.test.ts`: 4/4 GREEN (no regression)
- `npm run typecheck` clean
- `npx madge --circular --extensions ts src/` reports no new cycles

## Next Phase Readiness

Bug 2C closed. Forensic traceability for plugin-originated tasks is restored. Both the daemon-side primary path (`/v1/tool/invoke` envelope injection) and the plugin-side defense-in-depth path (`mergeDispatchNotificationRecipient` captured.actor fallback) are exercised by regression tests. Future phases that introduce new IPC routes should follow the same envelope-derived field injection pattern when applicable.

---
*Phase: 46-daemon-state-freshness-fix-project-discovery-one-shot-bug-st*
*Plan: 06*
*Completed: 2026-04-25*
