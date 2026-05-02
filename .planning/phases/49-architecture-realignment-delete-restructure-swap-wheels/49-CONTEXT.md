# Phase 49 Context — Architecture Realignment

## Origin

Conversation with user on 2026-05-01 surfacing two complementary observations:

1. **"For what this delivers, we should be at half the LOC."** Current: 50,361 source LOC for "OpenClaw agents dispatch tasks + completion notifications + DAG workflows + memory + multi-project." Realistic minimum: ~28-32k.
2. **"Look for wheels we've reinvented."** Audit found 8 hand-rolled subsystems with mature library replacements.

Phase 48 addresses the mechanical-cleanup half (defensive casts, god-functions, comment debt, file splits, three low-risk library drop-ins). **Phase 49 addresses the architectural half** — feature deletion, module restructure, heavyweight library swaps.

This phase is **architecturally invasive** in a way Phase 48 explicitly is not. Plans here change user-facing capability (deleting Murmur, Drift, snapshot/restore, update channels), move files into a new layout, and replace hand-rolled subsystems (DAG engine, migration framework, throttle, possibly memory backend). Every sub-plan ships an LADR (lightweight ADR) capturing the rationale so the "why does this exist?" question never has to be asked again.

## User-confirmed decisions (2026-05-01 conversation)

The user explicitly weighed in on each candidate during the audit. These are the LOCKED decisions for Phase 49:

| Subsystem | Decision | Rationale (user's own words, paraphrased) |
|---|---|---|
| Memory | **Keep, simplify** | Plans significant enhancements; wants clean, robust, extensible foundation. Implication: drop the tier system / reranker / multi-provider complexity, keep the seam for future enhancement. |
| DAG conditionality | **Keep, redesign with xstate** | Differentiator vs claude/openclaw/etc built-in orchestrations. Wants proper abstractions and state machines; specifically mentioned xstate's nested state machine support. |
| Murmur | **Delete** | "I don't even remember why we built it." Strong LADR signal — backfill the deletion rationale. |
| Drift detection | **Delete** | "Don't remember the mechanics either." |
| Multi-project | **Keep** | Required for kanban views and project-scoped analytics. |
| Notification policy engine | **Delete** | "What does the engine do? How does it work? That's a component I don't even remember asking for." Subscriptions cover the actual usage. |
| Setup wizard | **Keep, trim** | OpenClaw-plugin-only path is the 100% case today. Trim the standalone-installer wizard branch. |
| Trace | **Keep, shrink to ~150 LOC** | Read OpenClaw's session JSONL directly instead of duplicating capture infrastructure. |
| Snapshot/restore | **Delete** | "What even is that." Built for users who don't exist yet. |
| Update channels | **Delete** | Same as snapshot — no second user, no need for stable/beta/alpha tracks. |
| Views (kanban/mailbox) | **Keep, grow into observability/** | Big plans including web views — observability + analytics. |

## What ships in this phase

### 49A — Feature deletion (fastest LOC return)

| Plan | Target | LOC delta |
|---|---|---|
| 49A-1 | `events/notification-policy/` (engine + deduper + batcher + audience + severity + loader + rules + watcher + index) | −956 |
| 49A-2 | `murmur/` + `dispatch/murmur-integration.ts` | −1,276 |
| 49A-3 | `drift/` (detector + adapters) | ~−500 |
| 49A-4 | `packaging/snapshot.ts` + `packaging/channels.ts` | ~−350 |
| 49A-5 | Audit `dispatch/escalation.ts`; likely delete | ~−292 if deleted |
| **Subtotal** | | **~−3,400** |

Each gets an LADR explaining what was deleted, why, and what to consider before re-introducing.

### 49B — Module restructure (mechanical move + import-rewrite)

Move files into ports/adapters/services/inbound/observability/plumbing layout. **One atomic commit** so the move history stays clean. Updates CODE_MAP, regenerates Serena memories, refreshes import paths repo-wide.

Target structure:

```
src/
├── core/                       # Pure domain (no I/O, no async, no env)
│   ├── task.ts                 # Task entity + lifecycle FSM
│   ├── workflow.ts             # DAG entity (xstate machines, after 49C-1)
│   ├── condition.ts            # Pure condition-expression evaluator
│   ├── subscription.ts         # Subscription entity
│   └── events.ts               # Event Zod schemas (source of truth)
│
├── ports/                      # Interfaces only
│   ├── task-store.ts
│   ├── event-log.ts
│   ├── agent-runner.ts         # IAgentRunner — abstracts OpenClaw
│   ├── memory-store.ts
│   ├── notifier.ts
│   └── clock.ts
│
├── adapters/                   # Port implementations
│   ├── filesystem-task-store/  # current src/store/, mostly intact
│   ├── jsonl-event-log/        # current events/logger.ts
│   ├── openclaw-bridge/        # current src/openclaw/ collapsed
│   ├── hybrid-memory-store/    # simplified memory adapter
│   └── outbound-channels/      # the matrix/telegram notifier
│
├── services/                   # Domain logic, uses ports
│   ├── scheduler/
│   ├── workflow-engine/        # drives xstate machines (after 49C-1)
│   ├── subscription-router/    # on event → match subs → fire deliveries
│   ├── recovery/
│   └── memory/
│
├── inbound/                    # Entry points
│   ├── mcp/
│   ├── ipc/                    # Phase 43 IPC routes
│   ├── http/                   # NEW: REST/WS for web views (future)
│   ├── cli/                    # Commander commands
│   └── protocol/               # AOF/1 router (folds into ipc/)
│
├── projects/                   # Multi-project scoping (kept)
├── observability/              # Read side
│   ├── kanban/                 # current views/
│   ├── trace/                  # shrunk per user decision
│   └── analytics/              # NEW (future)
├── plumbing/                   # Cross-cutting
│   ├── config/
│   ├── logging/
│   ├── packaging/              # installer + migrations only (no snapshot/channels)
│   └── daemon/
└── plugin.ts                   # OpenClaw plugin entry, thin
```

### 49C — Heavyweight library swaps

| Plan | Swap | Replaces | LOC delta | Risk |
|---|---|---|---|---|
| 49C-1 | xstate v5 for DAG engine | `dispatch/dag-evaluator.ts` (588) + `dag-condition-evaluator.ts` (229) + `dag-transition-handler.ts` (460) + `dag-context-builder.ts` + `schemas/workflow-dag.ts` (538) ≈ 1,815 LOC | ~−1,400 (becomes ~400 LOC of machine defs) | High — touches workflow execution hot path |
| 49C-2 | umzug for migration framework | `packaging/migrations.ts` framework (~140 LOC) | ~−80 framework, migration files keep content but call new framework | Medium — coordinate with Phase 47 if release-engineering work is in flight |
| 49C-3 | bottleneck for `dispatch/throttle.ts` | 134 LOC of hand-rolled per-team rate limiting | ~−100 | Medium — semantics need careful mapping |
| 49C-4 | LanceDB **spike** (no production commit) | Investigation of collapsing `memory/` (5,859 LOC) onto LanceDB's serverless vector + FTS | 0 (spike doc only) | Zero — output is a go/no-go recommendation |

### 49E — Wake-notification architecture redesign

**Why:** 2026-05-01 production observation surfaced two structural defects in the embedded-run wake path (`src/openclaw/chat-delivery-poller.ts:wakeViaEmbeddedRun`). A short-term prompt-text mitigation shipped before this phase started (commit landing during Phase 48 / pre-49 work); the structural fix lands here.

**Defects observed (TASK-2026-05-02-NXWk9aHX, swe-architect dispatcher):**

1. **Wake injected as `role: "user"` content.** The wake message arrives in the dispatcher session's transcript looking identical to a real human turn. Agents are biased toward action when they see user input — the observed agent attempted to call `aof_task_complete` on the already-`done` task and was rejected by the daemon (`task is already done and cannot be re-transitioned`, daemon log 02:16:44Z). The "informational. Reply NO_REPLY..." text in the prefix wasn't load-bearing enough against the role-based action bias.
2. **No reply-routing convention propagated.** Agent generated a useful summary text ("Status is good: the preview/parity task is complete...") at 02:17:05Z, but it never reached the originating Telegram chat because OpenClaw's `[[reply_to_current]]` routing token was missing. From the user's perspective, "nothing happened" even though the wake fired correctly, the system event was injected, the embedded-run spawned, and the agent generated a coherent acknowledgment — the entire pipeline succeeded except the last 30 feet.

**Short-term fix (already in tree):** stronger anti-action framing + explicit `[[reply_to_current]]` instructions in `EMBEDDED_WAKE_PROMPT_PREFIX`. Buys correctness while we ship the structural fix below; revert when 49E lands.

**Structural fix scope:**

- 49E-1: **Inject wake events with the right semantic role.** Investigate OpenClaw's session-event API for a non-user injection path (likely `enqueueSystemEvent` is already correct for the heartbeat path; the embedded-run path is the offender because it's a `prompt:` argument, not a queued system event). Two candidates:
  - Use `runtime.system.enqueueSystemEvent` for ALL wake paths (heartbeat-enabled AND heartbeat-disabled agents), and use `runEmbeddedPiAgent` only as a wake trigger that drains the queue without putting the wake content in the prompt itself. Drains the queue as turn-context (system events), not as user input.
  - If OpenClaw doesn't expose a "trigger-only" run mode, file an upstream feature request and keep the prompt-text path as a documented exception with the Phase-49 anti-action prefix.
- 49E-2: **Route wake-triggered acknowledgments back to chat by default.** Either (a) the wake-trigger automatically wraps any non-NO_REPLY assistant text with the `[[reply_to_current]]` token before delivery, or (b) the AOF/1 protocol gains an explicit `system.notification` envelope type whose response handling is "if the agent emits text, route to the captured `originatingSessionId`." Option (b) is cleaner long-term — it makes the routing explicit at the protocol layer rather than implicit in OpenClaw conventions.
- 49E-3: **Distinguish actionable wakes from FYI wakes at the API.** Today `notifyOnCompletion` triggers a wake on every status transition without distinguishing "task you might need to do something about" (`blocked`, `deadletter`) from "task you can ack and move on" (`done`, `cancelled`, `review` after a known handoff). Introduce a `wakeIntent: "action-required" | "informational"` field on the subscription that the prompt template (or system-event role) can vary on. Lets agents skip the cost of processing FYI wakes during heavy work.
- 49E-4: **Backpressure & dedupe.** Today the in-flight `Set<sessionKey>` dedupe coalesces concurrent wakes for the same session, but a burst of wakes against the SAME dispatcher across DIFFERENT tasks (e.g. swe-architect dispatching 10 review subtasks that all complete around the same time) still produces 10 separate embedded runs. Investigate whether to coalesce wake events per-session within an N-second window into a single run that drains a batch of system events.

**Risk:** Medium. The system-event injection path is heartbeat-tied, and OpenClaw's heartbeat lifecycle is opaque from our side — there may be a semantic gap where `enqueueSystemEvent` without a heartbeat does nothing. Investigation first, structural change second.

**LADR:** 0012-wake-notification-injection-semantics (lands with 49E).

### 49D — LADR practice (cross-cutting)

Establishes `.planning/ladrs/` with backfill of historical decisions plus one LADR per new sub-plan in this phase.

Initial LADR set:

| ID | Title | Type |
|---|---|---|
| 0001 | event-jsonl-not-sqlite | backfill |
| 0002 | zod-source-of-truth | backfill |
| 0003 | thin-plugin-bridge-phase-43 | backfill |
| 0004 | subscriptions-replace-notification-engine | 49A-1 |
| 0005 | delete-murmur | 49A-2 |
| 0006 | delete-drift | 49A-3 |
| 0007 | ports-adapters-restructure | 49B |
| 0008 | xstate-for-workflows | 49C-1 |
| 0009 | umzug-for-migrations | 49C-2 |
| 0010 | bottleneck-for-throttle | 49C-3 |
| 0011 | lancedb-spike | 49C-4 outcome |
| 0012 | wake-notification-injection-semantics | 49E |

LADR template (1 page each):
- **Context** — what was the situation, what problem prompted the decision
- **Decision** — what we chose
- **Consequences** — what this commits us to (good and bad)
- **Alternatives** — what we rejected and briefly why
- **Date** — yyyy-mm-dd locked
- **Status** — Accepted / Superseded by NNNN / Deprecated

`.planning/ladrs/README.md` explains the format and the trigger criteria for writing one:
- Every architecturally-load-bearing decision (touching multiple modules)
- Every feature deletion (so the deletion rationale survives)
- Every library swap >100 LOC
- Every change to the trust/permission boundary
- Every introduction of a new external integration point

## Wave order (suggested)

1. **Wave 1 — 49A: Feature deletion.** Order within: 49A-1 (notification-policy) first (largest single drop, lowest risk), then 49A-2/3/4/5 in any order. Each is one commit + one LADR. Estimated: 1-2 days work.
2. **Wave 2 — 49B: Module restructure.** Single atomic commit. Pre-work: write the move script + import-rewrite tooling, dry-run, verify zero-diff in tsc output, then commit. Estimated: 1 day.
3. **Wave 3 — 49C-2 + 49C-3: Library swaps that don't touch the hot path.** Umzug + bottleneck. Each: own commit, own LADR. Estimated: 1 day total.
4. **Wave 4 — 49C-4: LanceDB spike.** Spike doc + perf comparison. NO production commit; outputs a go/no-go for a future "memory v2" phase. Estimated: 1-2 days.
5. **Wave 5 — 49C-1: xstate for DAG.** Risky, last. Own commit, own integration test pass, manual smoke. Estimated: 2-3 days.
6. **Wave 6 — 49E: Wake-notification redesign.** Investigation-first (49E-1 + 49E-2 are spike-then-implement), then 49E-3 and 49E-4. Coordinate with whoever is using `notifyOnCompletion` in production (currently swe-architect dispatching review subtasks). Estimated: 2-3 days. Lands with the short-term prompt-text mitigation reverted in the same commit so we don't carry both layers.

LADRs ship in the same commit as their associated sub-plan, not separately.

## Out of scope

- **Web-views implementation.** This phase only delivers the `observability/` directory shape. Web views are a separate phase once the structure exists.
- **Memory v2 enhancement.** This phase delivers a clean foundation (simplified `hybrid-memory-store/` adapter); the actual hybrid-search redesign + reranker plug points + tiering policy + curation rework are future work informed by 49C-4's spike output.
- **AOF/1 protocol replacement.** Custom domain protocol, not a wheel-reinvention case.
- **Replacing `node:http` with fastify/hono/etc.** Current usage is small (6 IPC routes + 2 health); doesn't pay off.
- **Multi-project deletion.** Explicitly kept per user decision (kanban + analytics depend on it).
- **Setup wizard rewrite.** Trim happens in Phase 48 (Plan 8 CLI splits include narrowing setup.ts to OpenClaw-plugin path); no further rework here.
- **Trace deletion.** User wants it kept and shrunk. The shrink (read OpenClaw session JSONL directly) lands in Phase 49B as part of the move from `trace/` to `observability/trace/`.

## Acceptance gates

Per atomic commit:
- `npm run typecheck` clean
- `npm test` green
- `npx madge --circular --extensions ts src/` reports 0 cycles
- Associated LADR ships in the same commit (49A-x and 49C-x plans)

Per sub-wave:
- `npm run test:integration:plugin` green
- `npm run test:e2e` green at end of wave (esp. after 49B and 49C-1)

Per phase end:
- Total `src/` LOC: **28,000-32,000** (currently ~50,000; net delta ~−18-22k from this phase + Phase 48's −3-4k)
- CODE_MAP.md fully rewritten for the new layout
- All 11 initial LADRs in place
- Serena memories regenerated for the new structure
- v1.21.0 **minor** release (architecture change warrants minor bump per semver intent) with hand-crafted release notes covering the layout shift, deleted features (with migration notes if any user touched them), and library swaps

## Risk profile

| Sub-wave | Risk | Mitigation |
|---|---|---|
| 49A — Deletions | Medium (irreversible without git revert) | LADR per deletion captures rationale; deletion happens in dedicated commits so revert is one `git revert <sha>` |
| 49B — Restructure | Low semantic, high visual diff | One atomic commit; tooling-driven move-and-rewrite; tsc + tests green before commit |
| 49C-1 — xstate | High (workflow hot path) | Goes last; full integration test pass; manual smoke against running daemon; ships separately from 49B so a regression bisects to one commit |
| 49C-2 — umzug | Medium | Coordinate with Phase 47 if release-engineering work in flight; migrations are easy to rollback (just stop calling the new runner) |
| 49C-3 — bottleneck | Medium | Semantics mapping needs explicit test of the team-throttle path; no integration tests cover this today (gap to fill) |
| 49C-4 — LanceDB spike | Zero | No production commit |
| 49D — LADRs | Zero | Documentation only |

## Open questions to resolve during /gsd-discuss-phase 49

1. **49A-5 escalation.ts deletion** — confirm overlap with blocked → deadletter flow before deleting. Read the file, identify what fires it, verify nothing critical depends on it.
2. **49C-2 umzug coordination with Phase 47** — if Phase 47 is mid-flight when Phase 49 starts, defer 49C-2 until Phase 47 ships so we don't have two competing migration-framework changes in flight.
3. **49C-1 xstate version pinning** — xstate v5 is the target (significantly different from v4); confirm before locking.
4. **49B move tooling** — `tsc --listFiles` + `madge` + a script to rewrite imports. Worth investing in tooling if we anticipate future large moves; otherwise a one-shot bash script is fine.
5. **LADR storage** — `.planning/ladrs/` is the current proposal; confirm this is the right location vs `.planning/decisions/` or `docs/architecture/`.
6. **49E-1 OpenClaw API survey** — does `runtime.system.enqueueSystemEvent` work standalone (without an active heartbeat) when paired with a separate trigger? If not, we need an upstream feature request OR we keep the prompt-text path with the Phase-49 anti-action prefix as the permanent design. Check `~/Projects/openclaw/src/plugins/types.ts` and the `pi-embedded-runner/run.ts` source before committing to a direction.
7. **49E-3 wakeIntent default** — should `done` default to `"informational"` and `blocked`/`deadletter` to `"action-required"`? Or should the dispatching agent choose at `aof_dispatch` time? Defer to /gsd-discuss-phase 49.

## Tools and references

- Audit working notes (this conversation, not preserved as standalone doc): wheel-reinvention audit performed 2026-05-01 found 8 hand-rolled subsystems with library replacements — 3 low-risk drop-ins went into Phase 48 (Plans 10-12), 5 architectural ones land here.
- v1.10 milestone (Phases 34-40, shipped 2026-03-16) is the closest precedent for a code-cleanup milestone, but v1.10 was behavior-preserving; Phase 49 is intentionally not.
- Phase 43 architecture (thin-plugin-daemon-authority) sets the precedent for big atomic restructure commits — the daemon gut-and-rebuild was similar in shape to Phase 49B.

## What this phase does NOT lock in

This is the audit-driven scope. /gsd-discuss-phase 49 may surface additional candidates or push back on specific deletions. The scope here is the working draft, not the locked plan.
