# Phase 45: Wake dispatching sessions via system-event injection — Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

When a dispatched task reaches a terminal state that matches the caller's `notifyOn` list, the dispatching agent session's NEXT TURN receives the completion as injected turn-context AND the session's heartbeat is triggered to fire so the agent actually wakes up and reacts — not just "a message appears in Telegram that a human can point at." Closes the `aof_dispatch → walk-away → task finishes → orchestrator resumes work` loop that Phase 44 delivered only to the chat-notification layer.

In scope:
- `runtime.system.enqueueSystemEvent` + `runtime.system.requestHeartbeatNow` integration in `OpenClawChatDeliveryNotifier`
- Chat-delivery message format refinement (one-line, correct agent id)
- Feature-detect fallback + user-facing warning
- Telemetry for the new path

Out of scope (deferred):
- AOF-side batched-heartbeat scheduler (future phase)
- Refactor/remove of the now-observer-only chat-delivery chain (wait for Phase 45 telemetry before deciding what's vestigial)
- Project-wide subscription (backlog 999.4)
- Stale-OpenClaw-worker detection (backlog 999.5)

</domain>

<decisions>
## Implementation Decisions

### Goal

- **D-45-GOAL:** Dispatcher's next turn receives the completion as **turn-context and reacts to it**, not just "a chat message exists." The test that replaces Phase 44's UAT Scenario A: dispatch a probe task from Telegram, walk away, child task completes — the orchestrator responds in the chat about the completion without any human poke, because the completion event was injected into its next turn's prompt context.

### Primitive + channel orthogonality

- **D-45-PRIMITIVE:** Use `runtime.system.enqueueSystemEvent(text, { sessionKey, contextKey, deliveryContext })` + `runtime.system.requestHeartbeatNow({ sessionKey, coalesceMs, heartbeat: { target: "last" }, reason })`. This is the same pattern OpenClaw's own cron service uses internally in `task-registry-BJCE3lhL.js` — proof-of-pattern confirmed. No OpenClaw upstream changes needed.

- **D-45-CHANNEL-ORTHOGONALITY:** Both chat delivery AND system-event injection fire on every wake-up (subject to D-45-NOTIFYON-GATING). Chat = human-visible observer/audit notification (Phase 44's existing path, reclassified). System-event = the actual agent wake-up that makes the orchestrator resume. One of these alone is insufficient: chat-only leaves agents unresponsive; system-event-only loses the human audit trail in group chats.

### Message formatting

- **D-45-MESSAGE-BREVITY:** Chat wake-up message MUST be one line. Today's multi-line format ("Task complete: … / Agent: … / Reason: …") is overkill for an audit log and noisy when multiple tasks fire close together. Exact one-line template to be locked in plan phase but approximately: `✓ TASK-NNN ({status}) — {title}` (for completion) or `⚠ TASK-NNN ({status}) — {title}` (for failure/cancelled/deadletter).

- **D-45-BUG-AGENT-UNKNOWN:** Bug fix in scope. Today's chat message renders `Agent: unknown` when it should render the actual agent ID (`main`, `researcher`, etc.). Likely cause: `renderMessage` (or equivalent) in `src/openclaw/openclaw-chat-delivery.ts` / chat-message-sender receives `agentId = undefined` even though it's available on the task frontmatter + on the subscription's `dispatcherAgentId` field added in Phase 44. Fix during the D-45-MESSAGE-BREVITY work since we're touching the same rendering path.

### Heartbeat policy

- **D-45-HEARTBEAT-POLICY:** Always call `requestHeartbeatNow` after `enqueueSystemEvent` with a coalesce window (`coalesceMs` parameter). Rationale: user's own `main` agent has `heartbeat.every: "15m"` in openclaw.json — without an explicit heartbeat request, dispatcher wake-up latency would be 0-15 minutes. The coalesce window (exact value researched during plan phase, likely 500-1000ms) lets multiple wake-ups fired within the window fold into a single heartbeat turn that drains all queued system events together — low latency + batched context.

- **D-45-HEARTBEAT-TARGET:** Always pass `heartbeat: { target: "last" }` on the requestHeartbeatNow call — forces delivery to the session's last active channel (matches cron pattern). Without this, OpenClaw's default `target: "none"` would suppress the heartbeat.

### Feature detection + graceful degradation

- **D-45-FEATURE-DETECT:** Extend `OpenClawApi` in `src/openclaw/types.ts` with optional `runtime?.system?.enqueueSystemEvent` / `requestHeartbeatNow`. At notifier construction time, check whether the runtime provides these. If absent (older OpenClaw gateway), emit a single startup log `wake-up.system-event-unavailable` and continue with chat-only delivery (Phase 44 behavior preserved). No dispatch refusal; no config toggle — just degrade.

- **D-45-FALLBACK-WARNING:** When the system-event path is unavailable AND AOF is falling back to chat-only, the chat-delivered message MUST include an inline warning visible to the human user: "⚠ Session-context wake-up not delivered (gateway system-event API unavailable). Upgrade OpenClaw gateway to receive automatic wake-ups on task completion." This makes the capability gap visible where the user will see it, not only in the daemon log.

### Dedup + recovery interaction

- **D-45-DEDUP-KEY:** `contextKey = "task:{taskId}:{toStatus}"` on every `enqueueSystemEvent` call. Each distinct transition gets its own dedup scope → retries of the same transition merge (OpenClaw collapses same-key events), distinct transitions stay separate.

- **D-45-NOTIFYON-GATING:** The decision to emit a wake-up at all is gated by the caller's existing Phase 44 `notifyOn` list (default: completion/failure statuses; customizable per-dispatch via aof_dispatch input). Both channels (chat + system-event) follow the SAME notifyOn list — no second per-channel opt-in. If `notifyOn` is `['done']`, a `review` transition emits nothing on either channel. If `notifyOn` is `['review', 'done']`, both transitions fire both channels.

- **D-45-DEDUP-INTERACTION-WITH-RECOVERY:** Same `contextKey` is passed across both the live-event delivery path AND the `replayUnnotifiedTerminals` boot-recovery pass. OpenClaw's own system-event dedup guarantees the agent sees exactly one event per `(taskId, toStatus)` tuple even when the daemon crashes between enqueue and heartbeat-ack. **Do NOT introduce a second dedup layer in AOF** — the `notifiedStatuses` ledger on the subscription is for delivery-attempt tracking, not for system-event dedup.

### Telemetry

- **D-45-TELEMETRY:** Add four new structured log events via the existing `wakeLog = createLogger("wake-up-delivery")` channel:
  - `wake-up.system-event-enqueued` — system event successfully placed on the session's queue
  - `wake-up.heartbeat-requested` — requestHeartbeatNow invoked
  - `wake-up.system-event-unavailable` — feature-detect hit; fallback to chat-only engaged
  - `wake-up.system-event-failed` — enqueueSystemEvent or requestHeartbeatNow threw; non-fatal, chat delivery still proceeds
  Each event carries `subscriptionId`, `taskId`, `toStatus`, `sessionKey`, `dispatcherAgentId`, `contextKey`, and (for `.failed`) `kind` + `message`.

- **D-45-TELEMETRY-DIMENSION:** Existing `wake-up.attempted` and `wake-up.delivered` gain a `channel` field with value `"chat"` | `"system-event"` | `"both"`. Enables post-ship audit of which delivery paths are actually carrying load — key input for the deferred refactor that removes vestigial chat-delivery code once the observer-only classification is validated by telemetry.

### Claude's Discretion

- Exact chat message template wording (only the structural shape is locked)
- Exact `coalesceMs` value for `requestHeartbeatNow` (research during plan phase)
- Whether to add a `deliveryContext` parameter on `enqueueSystemEvent` and how to derive it from the sessionKey (mimic OpenClaw cron's `requesterOrigin` pattern if the plan research confirms it's helpful; otherwise omit)
- Whether to expose an optional override on the subscription shape for "heartbeat coalesce override per-subscription" — probably no, but decide during planning if there's a clear use case

### Folded Todos

None — no pending todos matched Phase 45.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 44 artifacts (direct predecessor — all load-bearing for Phase 45)
- `.planning/phases/44-deliver-completion-notification-wake-ups-to-dispatching-agen/44-RESEARCH.md` — notifier architecture, subscription shape, failure modes enumeration
- `.planning/phases/44-deliver-completion-notification-wake-ups-to-dispatching-agen/44-SUMMARY.md` family (44-01 through 44-08) — what's in each file today, behaviors Phase 45 extends
- `.planning/phases/44-deliver-completion-notification-wake-ups-to-dispatching-agen/44-BLOCKERS.md` — the failing UAT evidence + the "chat delivery worked; context injection did not" finding that motivated Phase 45
- `.planning/phases/44-deliver-completion-notification-wake-ups-to-dispatching-agen/44-PATTERNS.md` — pattern-map for the Phase 44 files Phase 45 will touch

### AOF source files Phase 45 will modify (primary targets)
- `src/openclaw/types.ts` — extend `OpenClawApi` with optional `runtime.system` surface
- `src/openclaw/openclaw-chat-delivery.ts` — add `enqueueSystemEvent` + `requestHeartbeatNow` calls in `deliverOne`, add telemetry, fix `Agent: unknown` rendering bug
- `src/openclaw/chat-message-sender.ts` — one-line message format + correct agent id passthrough
- `src/openclaw/subscription-delivery.ts` — (maybe) add `channel` dimension to the delivery schema if we want it persisted
- `src/daemon/daemon.ts` — potentially update bootstrap wiring if new telemetry requires it

### OpenClaw reference surfaces (read-only — installed package)
- `/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/infra/system-events.d.ts` — `enqueueSystemEvent` contract + `SystemEvent` type
- `/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/infra/heartbeat-wake.d.ts` — `requestHeartbeatNow` contract + `HeartbeatWakeRequest` type
- `/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/plugins/runtime/types-core.d.ts` — PluginRuntimeCore surface (defines `system.*`)
- OpenClaw's cron reference call-site (chunk hash may change across upgrades): search the installed dist for `enqueueSystemEvent(` in a file named `task-registry-*.js` to find the canonical example

### Project-level references
- `CLAUDE.md` — especially §Fragile (chat-delivery chain fragility), §Conventions (no console.*, no process.env outside config/registry), §Build & Release (dual-launchctl-kickstart + zombie worker caveats surfaced during Phase 44 UAT)
- `.planning/PROJECT.md` — core value: "Tasks never get dropped — they survive gateway restarts, API failures, rate limits, and agent crashes, always resuming and completing end-to-end without human intervention." Phase 45 is the piece that makes "resuming and completing" actually happen for orchestrator workflows.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets (from Phase 44)
- `OpenClawChatDeliveryNotifier.deliverOne` — the hook point where the chat delivery fires. Phase 45 adds `enqueueSystemEvent` + `requestHeartbeatNow` calls to this method AFTER or IN PARALLEL WITH the existing chat delivery.
- `wakeLog = createLogger("wake-up-delivery")` — already wired in Phase 44, reuse for the new telemetry events.
- `replayUnnotifiedTerminals` — already calls the private `deliverOne` path; extending `deliverOne` means recovery path automatically gets the new behavior.
- Subscription persistence schema (`dispatcherAgentId`, `capturedAt`, `pluginId`, `sessionKey`) — all Phase 44 fields that Phase 45 reads to construct the `enqueueSystemEvent` call.

### Established Patterns
- Error-kind duck-type tagging (`(err as Error & { kind?: string }).kind = "..."`) — Phase 45's new failure modes use the same contract. New kinds: `"system-event-failed"`, `"heartbeat-request-failed"`.
- Graceful-degrade + log-once pattern — used elsewhere in AOF for feature flags; reuse the idiom for D-45-FEATURE-DETECT.
- Zod schemas as source of truth — if we add a `channel` field to delivery payload, it goes through `src/openclaw/subscription-delivery.ts` with `.describe()` for docs.

### Integration Points
- `registerAofPlugin(api, opts)` in `src/openclaw/adapter.ts` — the notifier is constructed here. Feature-detect happens at construction time: inspect `api.runtime?.system?.enqueueSystemEvent` and pass a capability-flag into the notifier ctor.
- Daemon bootstrap IIFE (`src/daemon/daemon.ts`) — existing post-Wave-3 code wires `replayUnnotifiedTerminals`. No new wiring needed for Phase 45 (the new behavior is inside `deliverOne`).
- No new IPC routes. No new queue. No new subscription schema field beyond optional `channel` dimension if we choose to persist it.

</code_context>

<specifics>
## Specific Ideas

- **Reference the OpenClaw cron call-site literally** during plan research: the canonical example of the `enqueueSystemEvent + requestHeartbeatNow` pattern is OpenClaw's own cron in `/opt/homebrew/lib/node_modules/openclaw/dist/task-registry-*.js`. Mirror the shape (contextKey, deliveryContext handling) so our use matches their proven semantics.

- **UAT acceptance criterion**: rerun the same Telegram probe that ended Phase 44's UAT. Success = the main agent responds IN CHAT about the completion WITHOUT the user having to ask. The agent's turn must be triggered by the heartbeat, and the completion text must be in the turn context. Same sessionKey topic as before (`agent:main:telegram:group:-1003844680528:topic:1`).

- **Don't replace the chat path prematurely.** Phase 45 adds system-event emission IN ADDITION TO chat delivery. A later refactor phase (out of scope) will use Phase 45 telemetry data to decide what chat-delivery code is vestigial. Premature cleanup here would risk losing working audit-trail behavior before we have evidence.

</specifics>

<deferred>
## Deferred Ideas

- **AOF-side batched-heartbeat scheduler** — instead of firing `requestHeartbeatNow` per dispatch, have AOF's own scheduler accumulate affected sessionKeys over a ~10s window and issue one coalesced heartbeat per batch. Reduces load on the heartbeat subsystem when many tasks complete in a short window. Optimization — Phase 45 does per-dispatch heartbeat-with-coalesce first, then we revisit if telemetry shows heartbeat-request load is a problem.

- **Refactor pass to strip vestigial chat-delivery code** — once Phase 45 ships and telemetry confirms the chat-delivery chain is genuinely only serving the observer use case, audit what parts of `OpenClawChatDeliveryNotifier` / `ChatDeliveryQueue` / `/v1/deliveries/wait` / `sendChatDelivery` / `chat-message-sender.ts` are still earning their complexity vs reclassify-and-strip. Explicit non-goal for Phase 45; do not pre-optimize without telemetry.

- **Per-channel notifyOn overrides** — hypothetical user need: "notify chat on completion, but system-event on review AND completion." Adds shape to the subscription; contradicts single-list simplicity. Keep in mind as a backlog idea if real-world use surfaces it; don't build speculatively.

- **System-event payload structure beyond plain text** — OpenClaw's `enqueueSystemEvent` takes a `text` string. If we want to pass structured data (e.g., JSON the agent could parse to decide its reaction), we'd need to serialize into the text. Defer — Phase 45 uses human-readable one-line format for now.

</deferred>

---

*Phase: 45-wake-dispatching-sessions-via-system-event-injection*
*Context gathered: 2026-04-24*
