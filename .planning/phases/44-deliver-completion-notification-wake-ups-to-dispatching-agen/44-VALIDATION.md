---
phase: 44
slug: deliver-completion-notification-wake-ups-to-dispatching-agen
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-24
---

# Phase 44 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (TypeScript ESM, Node >=22) |
| **Config file** | `vitest.config.ts` (unit) + `vitest.integration.config.ts` + `vitest.e2e.config.ts` |
| **Quick run command** | `npx vitest run <file-or-pattern> --no-coverage` |
| **Full suite command** | `npm run typecheck && npm test` |
| **Estimated runtime** | ~10s unit / ~60s E2E (single-fork, sequential) |

---

## Sampling Rate

- **After every task commit:** Run the targeted vitest file(s) touched by the task (`npx vitest run <path>`)
- **After every plan wave:** Run `npm run typecheck && npm test` (unit sweep, ~10s)
- **Before `/gsd-verify-work`:** `npm run typecheck && npm test && npm run test:e2e` all green
- **Max feedback latency:** 15 seconds (per-task unit feedback)

---

## Per-Task Verification Map

*The planner fills this table as plans land. Seed rows below come from RESEARCH.md §Test Surfaces and §Phase Boundary.*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 44-01-01 | 01 | 0 | D-44-GAP (RED test for observed wake-up failure) | — | Dispatcher session receives a wake-up when child task completes; current code fails | integration | `npx vitest run src/daemon/__tests__/bug-NNN-dispatcher-wake-up-on-completion.test.ts` | ❌ W0 | ⬜ pending |
| 44-01-02 | 01 | 0 | D-44-SCHEMA (RED test for full-fidelity dispatcher identity on subscription) | — | Subscription record carries actor + capturedAt + pluginId in addition to sessionKey/sessionId/channel/threadId/target | unit | `npx vitest run src/dispatch/__tests__/dispatch-subscription-shape.test.ts` | ❌ W0 | ⬜ pending |
| 44-02-01 | 02 | 1 | D-44-SCHEMA | — | `mergeDispatchNotificationRecipient` preserves full identity envelope | unit | `npx vitest run src/dispatch/__tests__/merge-dispatch-notification-recipient.test.ts` | ✅ | ⬜ pending |
| 44-02-02 | 02 | 1 | D-44-TTL | — | Invocation-context TTL extended or removed for dispatch-originated entries | unit | `npx vitest run src/openclaw/__tests__/invocation-context-store.test.ts` | ✅ | ⬜ pending |
| 44-03-01 | 03 | 2 | D-44-DELIVERY | — | `ChatDeliveryQueue.enqueueAndAwait` respects a bounded timeout and surfaces timeout as a non-fatal log | unit | `npx vitest run src/daemon/__tests__/chat-delivery-queue-timeout.test.ts` | ❌ W0 | ⬜ pending |
| 44-03-02 | 03 | 2 | D-44-DELIVERY | — | Telegram wake-up path: transition → notifier → OpenClawChatDeliveryNotifier → queue → /v1/deliveries/wait → sendMessageTelegram ACK, end-to-end | integration | `npx vitest run src/daemon/__tests__/chat-delivery-e2e.test.ts` | ✅ | ⬜ pending |
| 44-04-01 | 04 | 3 | D-44-RECOVERY (if locked in) | — | Notifier startup recovery pass replays unnotified terminal subscriptions after daemon crash | integration | `npx vitest run src/daemon/__tests__/notifier-recovery-on-restart.test.ts` | ❌ W0 | ⬜ pending |
| 44-04-02 | 04 | 3 | D-44-OBSERVABILITY | — | Structured log events for wake-up attempted / delivered / timed-out / skipped with subscriptionId + taskId + sessionKey | unit | `npx vitest run src/dispatch/__tests__/wake-up-telemetry.test.ts` | ❌ W0 | ⬜ pending |
| 44-05-01 | 05 | 4 | D-44-E2E | — | End-to-end: orchestrator agent calls aof_dispatch, child task transitions to done, orchestrator receives wake-up message on its channel | E2E | `AOF_INTEGRATION=1 npx vitest run src/daemon/__tests__/dispatcher-wake-up-e2e.test.ts --config vitest.e2e.config.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/daemon/__tests__/bug-NNN-dispatcher-wake-up-on-completion.test.ts` — failing regression for the observed wake-up gap (`NNN` assigned from the BUG registry once the specific failure is locked during planning)
- [ ] `src/dispatch/__tests__/dispatch-subscription-shape.test.ts` — locks the persistent subscription schema
- [ ] `src/daemon/__tests__/chat-delivery-queue-timeout.test.ts` — locks the `enqueueAndAwait` timeout contract
- [ ] `src/daemon/__tests__/notifier-recovery-on-restart.test.ts` — locks the daemon-crash recovery contract (conditional on D-44-RECOVERY decision)
- [ ] `src/dispatch/__tests__/wake-up-telemetry.test.ts` — locks the observability contract
- [ ] `src/daemon/__tests__/dispatcher-wake-up-e2e.test.ts` — locks the E2E acceptance shape

*Existing test infrastructure (`createTestHarness()`, `createMockStore()`, `createMockLogger()`) covers everything else — no new harness utilities expected.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real Telegram-bound orchestrator wakes up end-to-end via OpenClaw gateway | D-44-E2E-HUMAN | Requires a running OpenClaw gateway + Telegram bot token + live `main` agent session; cannot run in CI | From a live `main` session on Telegram, call `aof_dispatch` with a short child task; confirm the orchestrator session receives the wake-up message once the child transitions to done. Capture the session transcript line from `~/.openclaw/agents/main/sessions/<sid>.jsonl`. |
| Stretch: wake-up reaches a non-Telegram session kind (if scope pulls it in) | D-44-STRETCH | Same as above for whatever surface lands | TBD — determined by which stretch path the planner locks |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
