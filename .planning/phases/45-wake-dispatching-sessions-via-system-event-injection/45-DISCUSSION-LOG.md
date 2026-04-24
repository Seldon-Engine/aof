# Phase 45: Wake dispatching sessions via system-event injection — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-24
**Phase:** 45-wake-dispatching-sessions-via-system-event-injection
**Areas discussed:** Channel orthogonality, Heartbeat request policy, Feature-detect fallback behavior, Dedup key strategy

---

## Channel orthogonality

| Option | Description | Selected |
|--------|-------------|----------|
| Both always | Every wake-up emits on BOTH channels. Chat = human observer audit trail; System-event = agent wake-up that resumes work. Simplest mental model. | ✓ |
| System-event primary, chat opt-in | System-event default; chat is opt-in per subscription. Less noise for agent-only workflows. | |
| Route by sessionKey kind | Inspect sessionKey — human channels get both, headless sessions get system-event only. Adds branching logic. | |
| System-event only, retire chat delivery | Delete Phase 44 chat-delivery entirely. Saves code but loses human-visible audit trail. | |

**User's choice:** Both always.
**Notes:** User added two sub-requirements not in the option set:
1. Tighten chat messaging to one-line only (current multi-line format is noisy)
2. Fix the `Agent: unknown` rendering bug in the current chat message template

These became D-45-MESSAGE-BREVITY and D-45-BUG-AGENT-UNKNOWN respectively.

---

## Heartbeat request policy

| Option | Description | Selected |
|--------|-------------|----------|
| Always request with coalesce | Every wake-up fires requestHeartbeatNow with a coalesce window (~500-1000ms). Multiple wake-ups within the window fold into one heartbeat turn. | ✓ |
| Always request, no coalesce | One heartbeat per wake-up, no folding. Simpler but wastes turns for close-together completions. | |
| Never request — rely on natural heartbeat | Enqueue only. Users tune their heartbeat.every config if they want low latency. | |
| Request only on terminal "done" | Skip requestHeartbeatNow for review/failed/cancelled. Adds complexity for marginal benefit. | |

**User's clarifying question (before answering):** "What's the current heartbeat interval? If it's 10sec, it's frequent enough to have lowish latency AND we can batch multiple notifications in one context payload."

**Investigation result (presented back to user):** User's own `main` agent has `heartbeat.every: "15m"` in openclaw.json — 15 minutes, far too slow for a dispatcher wake-up. Without `requestHeartbeatNow`, dispatcher wake-up latency would be 0-15 minutes depending on timing. `requestHeartbeatNow` has a `coalesceMs` parameter that provides the batching property the user was describing — multiple wake-ups within the coalesce window fold into a single heartbeat turn that drains all queued system events together.

**User's choice:** Always request with coalesce, with a forward-looking note that AOF should eventually have its own scheduler that batches affected-session heartbeats on a ~10s interval instead of firing requestHeartbeatNow per dispatch. Captured as a deferred idea, not Phase 45 scope.

---

## Feature-detect fallback behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Log-once + graceful degrade | Single startup warning (`wake-up.system-event-unavailable`), continue with chat-only delivery. | ✓ |
| Fail hard — refuse dispatch | Return error from aof_dispatch if runtime.system undefined. Too aggressive. | |
| Silent chat-only fallback | No log, quietly fall back. Hides a real capability gap. | |
| Feature-gate via workflow config | Add a config toggle. Contradicts no-flag-sprawl. | |

**User's choice:** Log-once + graceful degrade, PLUS the user-facing chat message includes an informative warning explaining the wake-up failure.

**Notes:** User's addition (the user-facing warning) became D-45-FALLBACK-WARNING. The warning makes the capability gap visible to the human using the agent (not only in the daemon log). Template-level wording to be locked during plan phase.

---

## Dedup key strategy

| Option | Description | Selected |
|--------|-------------|----------|
| task:{taskId}:{toStatus} | Separate events per task-transition. Review and done fire distinct events; retries of same transition merge. | ✓ |
| task:{taskId} | One event per task, last status wins. Loses intermediate signal. | |
| aof:{subscriptionId}:{toStatus} | Subscription-scoped dedup. Handles multi-subscriber case cleanly but less human-readable in logs. | |
| No contextKey | Every event lands; retries double up. Simplest but unsafe. | |

**User's clarifying question (before answering):** "I like the first option, but remember that we've introduced a setting at dispatch time (or at notification attach time) for the agent to pick what transitions should emit a notification. We need to respect that. The default is 'only notify on completion/failure', but that behavior is customizable."

**Response (presented back to user before locking):** Clarified that the dedup key operates INSIDE whatever is already admitted by the caller's `notifyOn` list (a Phase 44 concept). Added D-45-NOTIFYON-GATING as a sibling decision documenting that both channels (chat + system-event) share the SAME notifyOn list — no second per-channel opt-in. Also added D-45-DEDUP-INTERACTION-WITH-RECOVERY to document that using the same contextKey across the live-event path and the recovery pass lets OpenClaw's own dedup handle crash recovery cleanly, without AOF introducing a second dedup layer.

**User's choice:** Option 1 with the notifyOn gating relationship explicit.

---

## Claude's Discretion

Areas explicitly deferred to plan-phase research or implementation decisions:
- Exact chat message template wording (one-line shape locked; exact words flexible)
- Exact `coalesceMs` value for requestHeartbeatNow (500-1000ms range locked; exact value researched)
- Whether to add `deliveryContext` on enqueueSystemEvent and how to derive it
- Whether to persist the new `channel` telemetry dimension on the subscription record itself (optional field)

## Deferred Ideas

- AOF-side batched-heartbeat scheduler on a ~10s interval (future phase — optimization based on Phase 45 telemetry)
- Refactor pass to strip vestigial chat-delivery code (explicit non-goal for Phase 45 — wait for telemetry)
- Per-channel notifyOn overrides (hypothetical future need; don't build speculatively)
- Structured (non-text) system-event payloads (Phase 45 uses plain one-line text)
