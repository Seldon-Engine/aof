---
phase: 45
slug: wake-dispatching-sessions-via-system-event-injection
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-24
---

# Phase 45 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 1.x (existing) |
| **Config file** | `vitest.config.ts` (unit) + `vitest.config.e2e.ts` (E2E, sequential single-fork) |
| **Quick run command** | `npm test -- src/openclaw` |
| **Full suite command** | `npm run typecheck && npm test` |
| **Estimated runtime** | ~10 seconds for unit (`src/openclaw/__tests__/`); ~60 seconds for full unit; E2E ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- src/openclaw` (scoped to changed surface)
- **After every plan wave:** Run `npm run typecheck && npm test`
- **Before `/gsd-verify-work`:** `npm run typecheck && npm test && npm run test:e2e` must all be green; manual UAT (Telegram probe rerun) must succeed
- **Max feedback latency:** ~10 seconds for scoped unit; ~60 seconds for full unit suite

---

## Per-Task Verification Map

> Plan-phase will assign concrete task IDs. This skeleton enumerates the validation lanes the planner must wire each task into. The planner is responsible for filling task IDs once plans are written; the rows below describe the behavior-to-test mapping the planner must honor.

| Lane | Behavior under test | Source decision | Test layer | Test file | Automated command | Status |
|------|---------------------|-----------------|------------|-----------|-------------------|--------|
| L1 | `OpenClawApi.runtime.system` optional surface compiles | D-45-FEATURE-DETECT | typecheck | `src/openclaw/types.ts` (consumed by `src/openclaw/__tests__/*.test.ts`) | `npm run typecheck` | ⬜ pending |
| L2 | IPC envelope extension: `ChatDeliveryRequest` carries `systemEvent`/`heartbeat` fields; Zod schema accepts new shape | D-45-PRIMITIVE (daemon→plugin transport) | unit | `src/ipc/__tests__/schemas.test.ts` | `npm test -- src/ipc` | ⬜ pending |
| L3 | IPC envelope extension: `ChatDeliveryResultPost` reports per-channel ACK | D-45-CHANNEL-ORTHOGONALITY (per-channel result) | unit | `src/ipc/__tests__/schemas.test.ts` | `npm test -- src/ipc` | ⬜ pending |
| L4 | Plugin-side: `chat-message-sender` calls `enqueueSystemEvent` with `{ sessionKey, contextKey, deliveryContext }` when `systemEvent` field present | D-45-PRIMITIVE | unit | `src/openclaw/__tests__/chat-message-sender.test.ts` | `npm test -- src/openclaw/__tests__/chat-message-sender` | ⬜ pending |
| L5 | Plugin-side: `requestHeartbeatNow` called with `{ sessionKey, coalesceMs: 750, heartbeat: { target: "last" }, reason }` after enqueue | D-45-HEARTBEAT-POLICY + D-45-HEARTBEAT-TARGET | unit | `src/openclaw/__tests__/chat-message-sender.test.ts` | `npm test -- src/openclaw/__tests__/chat-message-sender` | ⬜ pending |
| L6 | Daemon-side: `OpenClawChatDeliveryNotifier.deliverOne` builds the IPC envelope with both channels populated (when both enabled) | D-45-CHANNEL-ORTHOGONALITY | unit | `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` | `npm test -- src/openclaw/__tests__/openclaw-chat-delivery` | ⬜ pending |
| L7 | `notifyOn` gating applied uniformly to chat + system-event channels | D-45-NOTIFYON-GATING | unit | `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` | `npm test -- src/openclaw/__tests__/openclaw-chat-delivery` | ⬜ pending |
| L8 | `contextKey = "task:{taskId}:{toStatus}"` flows through plugin call | D-45-DEDUP-KEY | unit | `src/openclaw/__tests__/chat-message-sender.test.ts` | `npm test -- src/openclaw/__tests__/chat-message-sender` | ⬜ pending |
| L9 | Feature-detect: capability-absent path emits `wake-up.system-event-unavailable` once, suppresses system-event fields, proceeds with chat-only | D-45-FEATURE-DETECT | unit | `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` | `npm test -- src/openclaw/__tests__/openclaw-chat-delivery` | ⬜ pending |
| L10 | Fallback warning: chat message includes inline warning text when system-event API absent | D-45-FALLBACK-WARNING | unit | `src/openclaw/__tests__/chat-message-sender.test.ts` | `npm test -- src/openclaw/__tests__/chat-message-sender` | ⬜ pending |
| L11 | One-line message format: `✓ TASK-NNN ({status}) — {title}` (success) and `⚠ TASK-NNN ({status}) — {title}` (failure/cancelled/deadletter); title truncated at 120 chars | D-45-MESSAGE-BREVITY | unit | `src/openclaw/__tests__/chat-message-sender.test.ts` | `npm test -- src/openclaw/__tests__/chat-message-sender` | ⬜ pending |
| L12 | Bug fix: `Agent: <id>` renders `delivery.dispatcherAgentId` (not `event.actor`); regression test covers the original failure mode | D-45-BUG-AGENT-UNKNOWN | unit (regression) | `src/openclaw/__tests__/bug-045-agent-unknown.test.ts` | `npm test -- src/openclaw/__tests__/bug-045-agent-unknown` | ⬜ pending |
| L13 | Telemetry: `wake-up.system-event-enqueued` emitted with `{subscriptionId, taskId, toStatus, sessionKey, dispatcherAgentId, contextKey}` | D-45-TELEMETRY | unit | `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` | `npm test -- src/openclaw/__tests__/openclaw-chat-delivery` | ⬜ pending |
| L14 | Telemetry: `wake-up.heartbeat-requested` emitted post-enqueue | D-45-TELEMETRY | unit | `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` | `npm test -- src/openclaw/__tests__/openclaw-chat-delivery` | ⬜ pending |
| L15 | Telemetry: `wake-up.system-event-failed` emitted with `kind` + `message`; chat delivery still proceeds (non-fatal) | D-45-TELEMETRY | unit | `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` | `npm test -- src/openclaw/__tests__/openclaw-chat-delivery` | ⬜ pending |
| L16 | Existing `wake-up.attempted` / `wake-up.delivered` carry `channel` field with value `chat` / `system-event` / `both` | D-45-TELEMETRY-DIMENSION | unit | `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` | `npm test -- src/openclaw/__tests__/openclaw-chat-delivery` | ⬜ pending |
| L17 | Recovery path: `replayUnnotifiedTerminals` automatically inherits new behavior because it routes through `deliverOne` | D-45-DEDUP-INTERACTION-WITH-RECOVERY | unit | `src/openclaw/__tests__/notifier-recovery-on-restart.test.ts` (extend existing Phase 44 coverage) | `npm test -- src/openclaw/__tests__/notifier-recovery-on-restart` | ⬜ pending |
| L18 | Recovery dedup: replaying a previously-attempted terminal does not re-queue the system event past OpenClaw's lastText dedup; AOF's `notifiedStatuses` ledger remains the load-bearing dedup | D-45-DEDUP-INTERACTION-WITH-RECOVERY | unit | `src/openclaw/__tests__/notifier-recovery-on-restart.test.ts` | `npm test -- src/openclaw/__tests__/notifier-recovery-on-restart` | ⬜ pending |
| L19 | Capability detection forwarding (plugin → daemon): `POST /v1/plugin/capability` (or equivalent — planner decides exact route) carries `systemEvent: true|false`; daemon caches per pluginId | D-45-FEATURE-DETECT (transport) | unit + integration | `src/daemon/__tests__/plugin-capability.test.ts` (new) | `npm test -- src/daemon/__tests__/plugin-capability` | ⬜ pending |
| L20 | E2E dispatch path: dispatch a task in a test harness, transition it to `done`, assert the IPC envelope sent to the plugin contains both channels | D-45-GOAL (mechanical) | E2E | `tests/e2e/wake-up-dispatcher.test.ts` (extend) | `npm run test:e2e -- wake-up-dispatcher` | ⬜ pending |

---

## Wave 0 Requirements

The first plan (Wave 0) MUST install RED test files before any production code is written. Per CLAUDE.md §Engineering Standards: "TDD: Failing test first."

- [ ] `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` — extend with new cases for L6, L7, L9, L13, L14, L15, L16 (RED)
- [ ] `src/openclaw/__tests__/chat-message-sender.test.ts` — extend with new cases for L4, L5, L8, L10, L11 (RED)
- [ ] `src/openclaw/__tests__/notifier-recovery-on-restart.test.ts` — extend with new cases for L17, L18 (RED)
- [ ] `src/openclaw/__tests__/bug-045-agent-unknown.test.ts` — create regression test for L12 (RED)
- [ ] `src/ipc/__tests__/schemas.test.ts` — extend with new cases for L2, L3 (RED)
- [ ] `src/daemon/__tests__/plugin-capability.test.ts` — create for L19 (RED)
- [ ] `tests/e2e/wake-up-dispatcher.test.ts` — extend for L20 (RED)

*Framework already installed (vitest). No new framework setup needed.*

---

## Manual-Only Verifications

| Behavior | Source decision | Why Manual | Test Instructions |
|----------|-----------------|------------|-------------------|
| Live agent reacts in chat to a real task completion without human poke (the actual D-45-GOAL semantic) | D-45-GOAL | Requires a live OpenClaw gateway, a live `main` agent session, a live Telegram channel, and an LLM in the loop. The agent's reaction is a model-driven behavior we cannot deterministically assert in unit tests. | 1. After deploy + dual launchctl kickstart per CLAUDE.md §Build & Release. 2. Verify no zombie `openclaw-agent` processes (Flavor 1) and no stale `openclaw` workers (Flavor 2). 3. From Telegram in the dispatcher topic (`agent:main:telegram:group:-1003844680528:topic:1`), instruct main to dispatch a probe task. 4. Walk away (no further interaction). 5. Wait for child task to reach a terminal state. 6. **Pass:** main agent posts an in-chat acknowledgement of the completion within ~15s of the transition, without any human prompting it to. **Fail:** chat shows only the AOF wake-up post; main agent stays silent until the next human turn. |
| Capability-absent fallback: older OpenClaw gateway gracefully degrades to chat-only with inline warning visible to the human | D-45-FEATURE-DETECT + D-45-FALLBACK-WARNING | Requires running against an older OpenClaw build that lacks `runtime.system.enqueueSystemEvent`. We don't carry historical OpenClaw versions in CI. | 1. Temporarily monkey-patch the registered runtime to delete `runtime.system.enqueueSystemEvent`. 2. Trigger a wake-up. 3. **Pass:** daemon logs `wake-up.system-event-unavailable` once, chat message arrives carrying the inline warning text, no exceptions thrown. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (L1–L20 mapped to Wave 0 RED files above)
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s (full unit suite)
- [ ] `nyquist_compliant: true` set in frontmatter (planner sets this once Wave 0 task IDs are concrete)

**Approval:** pending
