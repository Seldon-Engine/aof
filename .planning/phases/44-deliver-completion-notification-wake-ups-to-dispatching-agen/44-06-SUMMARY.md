---
phase: 44
plan: 06
subsystem: openclaw/chat-delivery
tags: [phase-44, wake-up, agent-callback-fallback, no-platform-error, notifier]
requirements: [D-44-AGENT-CALLBACK-FALLBACK, D-44-PRIMITIVE]
dependency-graph:
  requires:
    - src/openclaw/chat-message-sender.ts (sendChatDelivery throw site pre-existing)
    - src/openclaw/openclaw-chat-delivery.ts (deliverOne catch branch pre-existing)
    - src/openclaw/__tests__/openclaw-chat-delivery.test.ts (Plan 02 Task 2 RED test)
  provides:
    - NoPlatformError typed error class (exported from chat-message-sender.ts)
    - agent-callback-fallback audit-trail kind (written by notifier catch branch)
  affects:
    - src/openclaw/__tests__/openclaw-chat-delivery.test.ts (Plan 02 Task 2 RED → GREEN)
tech-stack:
  added: []
  patterns:
    - "error-kind tagging (readonly kind = 'no-platform' as const on Error subclass)"
    - "duck-typed err.kind propagation via the notifier's existing catch branch"
    - "kind-rewrite pattern: detect upstream kind, substitute domain-specific kind before appendAttempt"
key-files:
  created: []
  modified:
    - src/openclaw/chat-message-sender.ts
    - src/openclaw/openclaw-chat-delivery.ts
decisions:
  - "Only the no-platform throw site gets a typed class; other throws remain plain Error (per plan + 44-PATTERNS.md §chat-message-sender.ts)"
  - "Single appendAttempt on fallback (not two) — no real agent-callback send happens in this phase"
  - "log.warn (not log.error) for the fallback path — it's documented expected behavior, not a failure"
  - "Subscription stays active (NOT flipped to 'delivered') so future phases can resume the wake-up"
metrics:
  duration: "~4 minutes"
  completed: "2026-04-24T15:25:58Z"
  tasks: 2
  files_modified: 2
  insertions: 47
  deletions: 6
---

# Phase 44 Plan 06: NoPlatformError → agent-callback-fallback Summary

Typed `NoPlatformError` in the plugin-side sender plus a notifier catch branch that rewrites `error.kind` to `agent-callback-fallback` makes subagent sessionKey wake-up failures observable on the subscription audit trail instead of silently dropped.

## What Shipped

### Task 1 — `src/openclaw/chat-message-sender.ts`

- **New export:** `class NoPlatformError extends Error` with `readonly kind = "no-platform" as const` and a constructor that accepts the (possibly `undefined`) sessionKey and produces the exact legacy message string `cannot resolve platform for delivery (sessionKey=<key>, channel=<none>)`.
- **Throw site converted (lines 101–107 in the pre-edit file):** `throw new Error(...)` → `throw new NoPlatformError(req.delivery.sessionKey)`. This is the only throw site that gets the typed class — the other four throws are plain `Error` (see table below).
- **`parseSessionKey` invariant preserved:** the 5-part requirement at line 68 is load-bearing (44-PATTERNS.md §360) and was not touched. A 4-part subagent key still returns `undefined` and falls through to the `NoPlatformError` throw.

**Throw sites inventory (post-Task 1):**

| Line (post-edit) | Throw type       | Kind              | Reason |
|------------------|------------------|-------------------|--------|
| 118              | `Error`          | (none, untyped)   | `api.runtime.channel not available — plugin-sdk version mismatch` — unchanged |
| **124**          | **`NoPlatformError`** | **`no-platform`** | **Converted this plan** |
| 129              | `Error`          | (none, untyped)   | `cannot resolve target for delivery <id>` — unchanged |
| 152              | `Error`          | (none, untyped)   | `runtime.channel.outbound.loadAdapter not available` — unchanged |
| 165              | `Error`          | (none, untyped)   | `outbound adapter for "<platform>" does not expose sendText` — unchanged |

Pre-edit count of `throw new Error(...)` was **5**; post-edit count is **4**. Only the no-platform path gets the typed class because it is the only one Phase 44's notifier fallback needs to introspect.

### Task 2 — `src/openclaw/openclaw-chat-delivery.ts`

Enhanced the catch branch in `deliverOne`:

- Detect `originalKind === "no-platform"` via the existing duck-typed extraction.
- When matched, rewrite `error.kind` → `"agent-callback-fallback"` and prefix `error.message` with `"agent-callback fallback (wake-up observably lost): "` so the original diagnostic remains visible in `subscriptions.json`.
- The fallback branch does NOT flip the subscription to `status: "delivered"` — that remains inside the success branch (line 113, unchanged, inside `if (TERMINAL_STATUSES.has(toStatus))`).
- Single `appendAttempt` call covers the fallback; no second attempt record. This diverges from 44-PATTERNS.md's speculative "two-entry" sketch because no real agent-callback send happens in Phase 44 — the attempt captures the fallback decision only.
- Log verb flipped from `log.error` → `log.warn` for the fallback path (expected documented behavior). Non-fallback failures still emit `log.error`.

## Verification Results

- **Plan 02 Task 2 RED test (`records agent-callback-fallback attempt when delivery sessionKey is a subagent (4-part) key`) is GREEN.** Confirmed by targeted run: `npx vitest run src/openclaw/__tests__/openclaw-chat-delivery.test.ts` — 9/9 pass.
- **The 8 pre-existing tests in `openclaw-chat-delivery.test.ts` remain GREEN** — NON-no-platform errors (`messageTool.send rejects` test in particular) still propagate their original kind or `undefined` unchanged. The catch branch's handling of non-no-platform errors is byte-identical to pre-edit modulo the `originalKind` rename.
- **`npm run typecheck` exits 0.**
- **`git diff --stat dda779b..HEAD` shows exactly 2 files touched** (47 insertions, 6 deletions).
- `grep -q 'export class NoPlatformError'` / `'readonly kind = "no-platform"'` / `'throw new NoPlatformError'` / `'agent-callback-fallback'` / `'originalKind === "no-platform"'` / `'log.warn'` all succeed.

## Adjustments to Tests

**None.** No test file needed editing for this plan. The Plan 02 Task 2 RED test was already asserting the exact contract this plan implements (rewriting `error.kind` to `"agent-callback-fallback"` and keeping `status` off `"delivered"`). It simply transitioned RED → GREEN.

## Deviations from Plan

None — plan executed exactly as written. No auto-fixes (Rules 1–3) needed; no architectural questions (Rule 4) triggered.

## Non-no-platform Error Propagation (verified)

The catch branch still treats any `err` whose `.kind` is not `"no-platform"` identically to pre-edit code:

- `isNoPlatform === false` ⇒ `kind === originalKind` (preserved, including `undefined`).
- `message === failureMessage` (no prefix added).
- `log.error(...)` emitted (not `log.warn`).
- `appendAttempt` payload is byte-identical to pre-edit (conditional spread of `kind` when defined, `message` passed through verbatim).

The 8 pre-existing tests covering timeout-kind errors, generic send-failed errors, and non-openclaw-chat subscriptions all continue to pass without modification — this is the proof that non-fallback paths are untouched.

## Out-of-scope Pre-existing Failures (not caused by this plan)

`npm test` surfaces 18 failing tests that reproduce at base commit `dda779b` (confirmed by temporarily restoring base files and re-running). They are out of scope for Plan 06:

- **`src/commands/__tests__/org-drift-cli.test.ts`** — 6 failures in `aof org drift` CLI tests.
- **`src/commands/__tests__/memory-cli.test.ts`** — 11 failures in `aof memory generate/audit` CLI tests.
- **`src/daemon/__tests__/notifier-recovery-on-restart.test.ts`** — 1 failure expecting `replayUnnotifiedTerminals` method (Phase 44 D-44-RECOVERY — slated for a later plan in this phase, not Plan 06).

None of these exercise `chat-message-sender.ts` or `openclaw-chat-delivery.ts`. Per the scope boundary rule, they are logged here and not touched.

## Commits

| Task | Commit  | Scope |
|------|---------|-------|
| 1    | `fcafdb3` | `feat(44-06): introduce NoPlatformError in chat-message-sender` |
| 2    | `999e7f1` | `feat(44-06): record agent-callback-fallback attempt for no-platform errors` |

## Downstream Impact

- Subagent dispatchers (`runEmbeddedPiAgent` children with `agent:<id>:subagent:<sid>` sessionKeys) no longer silently lose their wake-ups. Operators can grep `subscriptions.json` for `"kind":"agent-callback-fallback"` to find all such lost wake-ups.
- Future phase (e.g. Plan 07/08) can reuse the `isNoPlatform` branch point to actually invoke an agent-callback send — the plumbing is now in place; today it only emits the audit entry.
- `NoPlatformError` crosses the plugin → daemon IPC boundary as a `{ kind: "no-platform", message: "…" }` tuple (class identity lost at IPC, kind string survives via `chat-delivery-queue.ts:104-107`). Behavior verified by the Plan 02 Task 2 test which simulates the post-IPC shape exactly.

## Self-Check: PASSED

- `[x]` `src/openclaw/chat-message-sender.ts` contains `export class NoPlatformError` with `readonly kind = "no-platform"` (verified via rg).
- `[x]` `src/openclaw/chat-message-sender.ts` throw site uses `throw new NoPlatformError(req.delivery.sessionKey)` (verified via rg).
- `[x]` `src/openclaw/openclaw-chat-delivery.ts` contains `originalKind === "no-platform"`, `"agent-callback-fallback"`, and `log.warn` (verified via rg).
- `[x]` Commit `fcafdb3` present in `git log --oneline`.
- `[x]` Commit `999e7f1` present in `git log --oneline`.
- `[x]` `npx vitest run src/openclaw/__tests__/openclaw-chat-delivery.test.ts` — 9/9 tests pass (8 pre-existing + Plan 02 Task 2 RED-turned-GREEN).
- `[x]` `npm run typecheck` exits 0.
- `[x]` `git diff --stat dda779b..HEAD` shows exactly 2 files modified.
