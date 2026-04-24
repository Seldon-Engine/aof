---
phase: 44
plan: 07
subsystem: [openclaw, daemon, observability, recovery]
tags: [phase-44, wake-up, recovery, telemetry, notifier, d-44-recovery, d-44-observability]
requirements: [D-44-RECOVERY, D-44-OBSERVABILITY]

dependency-graph:
  requires:
    - 44-03-PLAN (OpenClawChatDelivery schema — reads sessionKey/dispatcherAgentId off delivery)
    - 44-05-PLAN (ChatDeliveryQueue 60s timeout — bounds the replay so a broken plugin cannot stall boot)
    - 44-06-PLAN (NoPlatformError kind surfacing — wake-up.fallback routes off err.kind === "no-platform")
  provides:
    - OpenClawChatDeliveryNotifier.replayUnnotifiedTerminals(store) public method
    - Structured wake-up.* telemetry events on every delivery lifecycle transition
    - Boot-time replay invocation enumerated across baseStore + all discovered project stores
  affects:
    - 44-02-PLAN Task 3 (notifier-recovery-on-restart.test.ts Test 1) — turns RED → GREEN in this plan
    - 44-02-PLAN Task 1 (AOF_INTEGRATION=1 dispatcher wake-up) — delivered-status + attempts[].success assertions now supportable

tech-stack:
  added: []
  patterns:
    - Mirrors retryPendingDeliveries (src/dispatch/callback-delivery.ts) — terminal-status gate + active-sub filter + ledger-aware dedupe
    - Fire-and-forget IIFE bootstrap so recovery cannot block daemon IPC startup (T-44-10 mitigation)
    - Per-project try/catch isolation — one corrupt project cannot starve the others

key-files:
  created: []
  modified:
    - path: src/openclaw/openclaw-chat-delivery.ts
      change: "Added replayUnnotifiedTerminals() + wakeLog channel + source-aware deliverOne threading 8 wake-up.* events"
    - path: src/daemon/daemon.ts
      change: "Added fire-and-forget recovery pass after logger.addOnEvent, enumerating baseStore + discoverProjects()"

decisions:
  - "Iterate terminal statuses individually (store.list({status}) per terminal) rather than scanning every task — matches retryPendingDeliveries shape and avoids reading backlog/ready/in-progress files on every boot."
  - "Threaded `source: \"event\" | \"recovery\"` through deliverOne rather than duplicating the send+attempt+markNotified block — one code path, two log event names."
  - "Synthetic actor \"system:recovery\" on recovery-path renderMessage invocations so the plugin-side delivery still carries a recognizable provenance marker; no event.actor is available on boot (there is no originating transition event)."
  - "No skip path: discoverProjects + createProjectStore are already load-bearing for buildResolveStoreForTask, so their absence would already have broken the daemon before boot — a wake-up.recovery-pass-skipped branch would be dead code."

metrics:
  duration: ~9 minutes wall clock (includes test runs, RED baseline verification, acceptance gate scripting)
  completed: 2026-04-24T15:39:22Z
  tasks: 2 / 2
  files-modified: 2
  commits:
    - 3210b51 feat(44-07): add replayUnnotifiedTerminals + wake-up.* telemetry
    - bde9e15 feat(44-07): wire replayUnnotifiedTerminals into daemon bootstrap
---

# Phase 44 Plan 07: Recovery + Observability Summary

Daemon-crash-between-transition-and-plugin-ACK no longer silently loses wake-ups: `OpenClawChatDeliveryNotifier.replayUnnotifiedTerminals(store)` re-fires openclaw-chat wake-ups for active subscriptions on terminal tasks whose `notifiedStatuses` ledger does not yet record the terminal status, wired into daemon bootstrap as a fire-and-forget pass over the unscoped base store plus every discovered per-project store; structured `wake-up.*` telemetry lands alongside so operators (and Phase 999.4 cross-project fan-out) can grep every lifecycle transition.

## Tasks

| Task | Name                                                                   | Commit  |
| ---- | ---------------------------------------------------------------------- | ------- |
| 1    | Add replayUnnotifiedTerminals + wake-up.* telemetry                    | 3210b51 |
| 2    | Invoke replayUnnotifiedTerminals on daemon bootstrap                   | bde9e15 |

## Enumeration shape (Task 2)

Matches `src/daemon/resolve-store-for-task.ts:84-97` exactly — if realtime resolution can find a store, recovery sees it too.

```ts
(async () => {
  try {
    // (1) Unscoped base store first — vault-root tasks (projectId: null).
    await chatNotifier.replayUnnotifiedTerminals(store);
    // (2) Every discovered project.
    const projects = await discoverProjects(opts.dataDir);
    for (const rec of projects) {
      try {
        const { store: projectStore } = await createProjectStore({
          projectId: rec.id, vaultRoot: opts.dataDir, logger,
        });
        await chatNotifier.replayUnnotifiedTerminals(projectStore);
      } catch (err) {
        log.warn({ err, projectId: rec.id }, "wake-up recovery pass failed for project (non-fatal)");
      }
    }
  } catch (err) {
    log.warn({ err }, "wake-up recovery pass failed on startup (non-fatal)");
  }
})().catch((err) => {
  log.warn({ err }, "wake-up recovery pass IIFE rejection");
});
```

Lines touched in daemon.ts: added 2 imports (discoverProjects, createProjectStore) and a single 42-line block immediately after `logger.addOnEvent((event) => chatNotifier.handleEvent(event))`. No existing daemon bootstrap code was moved or deleted.

## wake-up.* event names (final)

All emitted via `createLogger("wake-up-delivery")` (alias `wakeLog`) so operators can filter by `component=wake-up-delivery` regardless of event name.

| Event                            | Level | Source path | Trigger                                                                                                  |
| -------------------------------- | ----- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `wake-up.attempted`              | info  | deliverOne  | Before messageTool.send() on the realtime event path                                                     |
| `wake-up.recovery-replay`        | info  | deliverOne  | Before messageTool.send() when source === "recovery" (boot-time replay)                                  |
| `wake-up.delivered`              | info  | deliverOne  | After appendAttempt(success=true) + markStatusNotified — terminal or non-terminal                        |
| `wake-up.skipped-no-route`       | debug | deliverOne  | Active subscription with neither `delivery.target` nor `sessionKey` nor `sessionId` — nothing to send    |
| `wake-up.timed-out`              | warn  | deliverOne  | caught err.kind === "timeout" (Plan 05 queue timeout fires here)                                         |
| `wake-up.fallback`               | warn  | deliverOne  | caught err.kind === "no-platform" (Plan 06 NoPlatformError path)                                         |
| `wake-up.failed`                 | warn  | deliverOne  | any other caught error                                                                                   |
| `wake-up.recovery-pass-complete` | info  | replay      | End of replayUnnotifiedTerminals — carries `{ replayed: <count> }`                                       |

Each event payload carries `{ subscriptionId, taskId, toStatus, source }` and when present `sessionKey`, `dispatcherAgentId`. Failure events additionally carry `{ kind, message }` where `kind` is the ORIGINAL thrown-error kind (timeout / no-platform / undefined), NOT the delivery kind.

## deliverOne extraction — behavior preservation

The `deliverOne` private method was already extracted from `handleEvent` in Plan 06. Plan 07 adds a single `source: "event" | "recovery"` parameter and threads it through to drive the telemetry event names. The realtime path continues to call `deliverOne({..., source: "event"})` — identical control flow and identical downstream effects (appendAttempt, markStatusNotified, terminal-status delivered-marker). All 9 pre-existing `openclaw-chat-delivery.test.ts` tests still pass without modification, which is the behavior-preservation proof.

New telemetry events are ADDITIVE — they sit alongside the existing `log.error({...}, "messageTool.send failed")` / `log.warn({...}, "wake-up fell back to agent-callback ...")` lines, not replacing them. Existing CLAUDE.md guidance ("structured log via createLogger") is honored.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Type] Simpler TaskStatus cast for `store.list({status})` argument**
- **Found during:** Task 1 typecheck
- **Issue:** The plan suggested `terminalStatus as Parameters<ITaskStore["list"]>[0] extends { status?: infer S } ? S : never` to cast a `Set<string>` element to the `TaskStatus` union. That nested conditional type is awkward and doesn't actually help the type-checker (the inferred `S` is just `TaskStatus`).
- **Fix:** Imported `TaskStatus` from `../schemas/task.js` and cast directly: `status: terminalStatus as TaskStatus`. Clearer and equivalent.
- **Files modified:** src/openclaw/openclaw-chat-delivery.ts (import + cast)
- **Commit:** 3210b51 (included in Task 1)

**2. [Rule 2 - Missing critical functionality] `wake-up.failed` event for the generic error case**
- **Found during:** Task 1 implementation
- **Issue:** The plan's `telemetryEvent` expression only distinguished `timeout` vs `no-platform` vs a fallthrough. The fallthrough needed a named event too, otherwise a generic delivery failure (e.g. "gateway 403", "send-failed") would emit under an unnamed/default event string.
- **Fix:** Fallthrough emits `"wake-up.failed"`. Confirmed live by the chat-delivery-e2e test log output showing `{"component":"wake-up-delivery",..."msg":"wake-up.failed"}` for the `send-failed` kind.
- **Files modified:** src/openclaw/openclaw-chat-delivery.ts
- **Commit:** 3210b51 (included in Task 1)

## Deferred Issues (pre-existing, out of scope)

`npm test` reports 17 failures in `src/commands/__tests__/org-drift-cli.test.ts` and `src/commands/__tests__/memory-cli.test.ts`. **Verified pre-existing on the base commit (c1fe171)** by stashing Plan 07 changes — same 17 failures reproduce. They are CLI-side (`aof org drift`, `aof memory generate/audit`) and have zero overlap with the openclaw/ or daemon/ code paths this plan touches. Not regressed by this plan; not fixed by this plan.

All 839 tests in the impacted areas (`src/openclaw/`, `src/daemon/`, `src/dispatch/`, `src/ipc/`) pass.

## Verification

- `npm run typecheck` — exit 0.
- `npx vitest run src/daemon/__tests__/notifier-recovery-on-restart.test.ts` — 3/3 GREEN (was 1 RED + 2 GREEN at Plan 02 landing; Test 1 RED → GREEN is exactly what D-44-RECOVERY requires).
- `npx vitest run src/openclaw/__tests__/openclaw-chat-delivery.test.ts` — 9/9 GREEN (no regression in pre-existing behavior).
- `npx vitest run src/daemon/__tests__/` — 109/109 GREEN (all daemon bootstrap paths still work with the added IIFE).
- `npx vitest run src/openclaw/ src/daemon/ src/dispatch/ src/ipc/` — 839/839 GREEN.

## Acceptance gates (from plan)

| # | Gate | Result |
|---|------|--------|
| 1 | `grep -q 'async replayUnnotifiedTerminals' src/openclaw/openclaw-chat-delivery.ts` | PASS |
| 2 | `grep -q 'createLogger("wake-up-delivery")' src/openclaw/openclaw-chat-delivery.ts` | PASS |
| 3 | `grep -c '"wake-up\.' src/openclaw/openclaw-chat-delivery.ts >= 4` | PASS (count=7) |
| 4 | `grep -q 'wake-up.delivered' src/openclaw/openclaw-chat-delivery.ts` | PASS |
| 5 | `grep -q 'wake-up.recovery-replay\|wake-up.recovery-pass-complete' src/openclaw/openclaw-chat-delivery.ts` | PASS (both present) |
| 6 | `grep -q 'this.createSubscriptionStore' src/openclaw/openclaw-chat-delivery.ts` | PASS |
| 7 | `grep -q 'replayUnnotifiedTerminals' src/daemon/daemon.ts` | PASS |
| 8 | `grep -q 'discoverProjects\b' src/daemon/daemon.ts` | PASS |
| 9 | `grep -q 'createProjectStore\b' src/daemon/daemon.ts` | PASS |
| 10 | `grep -q 'recovery pass failed on startup' src/daemon/daemon.ts` | PASS |
| 11 | `! rg 'wake-up\.recovery-pass-skipped' src/` | PASS (zero matches) |
| 12 | `npm run typecheck` exits 0 | PASS |
| 13 | Plan 02 Task 3 Test 1 PASS | PASS |
| 14 | 9 pre-existing openclaw-chat-delivery tests PASS | PASS |
| 15 | All daemon tests PASS | PASS (109/109) |

## Threat surface scan

No new external trust-boundary surface introduced. Recovery reads existing on-disk `subscriptions.json` entries; no new network endpoints, no new schema fields, no change to auth. T-44-10 (DoS via corrupt subscriptions.json) mitigation landed exactly as planned — the IIFE is not awaited by startAofDaemon.

## Known Stubs

None. No placeholder values, no TODO strings, no unwired data flows.

## Self-Check: PASSED

- src/openclaw/openclaw-chat-delivery.ts — FOUND
- src/daemon/daemon.ts — FOUND
- Commit 3210b51 — FOUND in git log (worktree branch worktree-agent-a8423d78)
- Commit bde9e15 — FOUND in git log (worktree branch worktree-agent-a8423d78)
- Plan 02 Task 3 Test 1 — confirmed GREEN under `npx vitest run src/daemon/__tests__/notifier-recovery-on-restart.test.ts`

All plan artifacts are present, all commits exist, and the load-bearing behavioral gate (Plan 02 Task 3 Test 1 RED → GREEN) is observably achieved.
