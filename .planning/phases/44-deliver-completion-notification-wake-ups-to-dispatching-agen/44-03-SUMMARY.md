---
phase: 44
plan: 03
subsystem: openclaw-plugin-schema
tags: [phase-44, wake-up, schema, identity, zod, dispatch-notification]
requires: [44-01]
provides:
  - OpenClawChatDelivery Zod schema (first-class, .passthrough()-compatible)
  - OpenClawChatDeliveryType inferred TypeScript type
  - Enriched dispatcher-identity envelope (dispatcherAgentId/capturedAt/pluginId) on auto-capture path
  - Single source of truth for OPENCLAW_CHAT_DELIVERY_KIND
affects:
  - src/openclaw/openclaw-chat-delivery.ts (re-export + typed delivery cast)
  - src/openclaw/dispatch-notification.ts (identity plumbing)
  - src/openclaw/index.ts (barrel re-exports)
tech-stack:
  added: []
  patterns:
    - "Zod schema + .passthrough() + .describe() per field (mirrors src/schemas/subscription.ts)"
    - "Single source of truth for plugin constant with re-export (CLAUDE.md §Conventions)"
    - "Auto-capture path vs explicit-caller path precedence (identity enrichment only on auto path)"
key-files:
  created:
    - src/openclaw/subscription-delivery.ts
  modified:
    - src/openclaw/openclaw-chat-delivery.ts
    - src/openclaw/dispatch-notification.ts
    - src/openclaw/index.ts
decisions:
  - "Phase 44 identity fields (dispatcherAgentId/capturedAt/pluginId) are injected ONLY on the pure auto-capture path (no explicit caller object). When the caller passes an explicit notifyOnCompletion object, the explicit shape wins without Phase 44 overlay — preserves Plan 01 Task 1 test 3 precedence contract."
  - "pluginId is typed as z.string().default('openclaw') on the schema — a non-optional field with default, matching plan notes and the `.describe()` that states it is 'Always present at runtime'."
  - "OPENCLAW_CHAT_DELIVERY_KIND definition lives in subscription-delivery.ts; openclaw-chat-delivery.ts re-exports it so downstream consumers (tests, daemon.ts, dispatch-notification.ts) need no changes."
metrics:
  duration: "~20 minutes"
  completed: "2026-04-24"
  tasks-completed: 3
  tests-turned-green: 4
---

# Phase 44 Plan 03: Schema + Identity Enrichment Summary

**One-liner:** Promoted `OpenClawChatDelivery` from a plugin-local TypeScript interface to a first-class Zod schema colocated at `src/openclaw/subscription-delivery.ts`, enriched `mergeDispatchNotificationRecipient` to plumb `dispatcherAgentId` / `capturedAt` / `pluginId` onto the auto-capture path, and consolidated `OPENCLAW_CHAT_DELIVERY_KIND` to a single source of truth with a re-export for backwards compatibility. Turns the four Plan 01 Task 1 RED tests in `dispatch-notification.test.ts` GREEN and unblocks Plan 02 Task 1's delivery.dispatcherAgentId assertion.

## Tasks Executed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Create `OpenClawChatDelivery` Zod schema and barrel-export it | `3bc842a` | `src/openclaw/subscription-delivery.ts` (new), `src/openclaw/openclaw-chat-delivery.ts`, `src/openclaw/index.ts` |
| 2 | Enrich `mergeDispatchNotificationRecipient` with dispatcher identity | `cca9e0e` | `src/openclaw/dispatch-notification.ts` |
| 3 | Wire typed schema into `openclaw-chat-delivery.ts` (replace local interface) | `dd50362` | `src/openclaw/openclaw-chat-delivery.ts` |

## Wave-0 Tests Now Green

All four Phase-44 RED tests in `src/openclaw/__tests__/dispatch-notification.test.ts` are GREEN after this plan:

1. `"enriches delivery with dispatcherAgentId, capturedAt, pluginId from captured route"` — GREEN
2. `"omits dispatcherAgentId when captured route has no agentId (undefined-stripping preserved)"` — GREEN
3. `"explicit notifyOnCompletion object overrides captured enrichment (precedence preserved)"` — GREEN
4. `"returns params unchanged when notifyOnCompletion is false (short-circuit preserved)"` — GREEN

Run evidence:
```
Test Files  1 passed (1)
Tests       4 passed (4)
Duration    380ms
```

## Call-Site Usages of Old Local Interface

Only one — the cast at `src/openclaw/openclaw-chat-delivery.ts` inside `deliverOne`:

```ts
// BEFORE
const delivery = sub.delivery as OpenClawChatDelivery | undefined;
// AFTER
const delivery = sub.delivery as OpenClawChatDeliveryType | undefined;
```

A grep across `src/` for `OpenClawChatDelivery\b` now shows three legitimate sites (schema value export, type export, barrel re-export) — zero stale references to the deleted local interface.

## Subscriptions.json Fixture Migration

None. The schema retains `.passthrough()`, so existing `subscriptions.json` files with the old delivery shape still parse. Unknown / legacy fields flow through untouched, preserving 999.4 forward-compat.

## Deviations from Plan

**1. [Rule 1 — Bug-precedence fix] Explicit-caller branch suppresses Phase-44 identity enrichment**

- **Found during:** Task 2 — while running `dispatch-notification.test.ts`, test 3 ("explicit notifyOnCompletion object overrides captured enrichment") failed even after following the plan's literal enrichment snippet. The plan's rationale assumed "when raw is an explicit object, captured is undefined", but the actual code at lines 27-28 always runs `store.consumeToolCall(toolCallId)` first, so `captured` can co-exist with `explicit`. With `pluginId: "openclaw"` injected inside the captured branch, it leaked through to explicit-caller deliveries.
- **Issue:** `pluginId` appeared in the merged delivery when the caller passed an explicit object that didn't set `pluginId`, violating Plan 01 Task 1 test 3's invariant.
- **Fix:** Nest the Phase-44 identity triplet (`dispatcherAgentId` / `capturedAt` / `pluginId`) inside `...(explicit ? {} : { ... })` inside the captured branch. Pre-Phase-44 fields (`target` / `sessionKey` / `sessionId` / `channel` / `threadId`) remain additive from captured beneath `explicitRest` for back-compat.
- **Files modified:** `src/openclaw/dispatch-notification.ts`
- **Commit:** `cca9e0e`
- The plan explicitly flags this as an acceptable handling path: "If the implementation detail differs from the assumption above (e.g., explicit + captured co-exist), handle the precedence by injecting `pluginId: 'openclaw'` ONLY inside the `captured ? ...` branch." I took it one step further — also gating `dispatcherAgentId` and `capturedAt` the same way, because Plan 01 Task 1 test 3 asserts only `sessionKey` and `dispatcherAgentId` from the explicit object survive (neither captured's `dispatcherAgentId: "main"` nor `capturedAt` leak through).

No other deviations. Tasks 1 and 3 matched the plan literally.

## Authentication Gates

None.

## Verification Results

- `npm run typecheck` — exit 0
- `npm run build` — exit 0 (openclaw.plugin.json already at 1.16.3)
- `npx vitest run src/openclaw/__tests__/dispatch-notification.test.ts` — 4/4 pass
- `npx vitest run src/openclaw/__tests__/openclaw-chat-delivery.test.ts` — 8 pre-existing pass; 1 Plan 02 Task 2 RED test (`agent-callback-fallback`) stays RED (Plan 07 territory, per Plan 03 acceptance)
- `npx vitest run src/daemon/__tests__/` — 108 pass, 1 Phase-44 D-44-RECOVERY RED test (`notifier-recovery-on-restart.test.ts`) stays RED (another plan's responsibility)
- `git diff --stat HEAD~3..HEAD` shows exactly 4 files touched (subscription-delivery.ts new + 3 modified)
- Schema smoke test via dist/: parses a realistic payload and auto-injects `pluginId: "openclaw"` default

## Files Modified Summary

```
 src/openclaw/dispatch-notification.ts  | 13 ++++++++
 src/openclaw/index.ts                  |  2 ++
 src/openclaw/openclaw-chat-delivery.ts | 15 +++------
 src/openclaw/subscription-delivery.ts  | 56 ++++++++++++++++++++++++++++++++++
 4 files changed, 75 insertions(+), 11 deletions(-)
```

## Self-Check: PASSED

- `src/openclaw/subscription-delivery.ts` exists (created this plan)
- All three commits present in `git log`:
  - `3bc842a` (Task 1)
  - `cca9e0e` (Task 2)
  - `dd50362` (Task 3)
- Typecheck exit 0
- All 4 Plan 01 Task 1 target tests green
- `OPENCLAW_CHAT_DELIVERY_KIND` has exactly one value-definition site (`subscription-delivery.ts:13`); `openclaw-chat-delivery.ts` holds only a re-export.
- No `_SCHEMA` alias in the barrel.
- `.passthrough()` preserved on the new schema (999.4 compat intact).
