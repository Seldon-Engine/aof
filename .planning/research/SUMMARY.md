# Project Research Summary

**Project:** AOF v1.8 Task Notification Subscriptions & Callback Delivery
**Domain:** Agent orchestration -- subscription-triggered session dispatch
**Researched:** 2026-03-09
**Confidence:** HIGH

## Executive Summary

AOF v1.8 adds the ability for agents to subscribe to task outcomes and receive callback sessions when those tasks complete or fail. The fundamental insight across all four research streams is that "notification delivery" in AOF means "spawn a new agent session with the outcome as context" -- there is no push channel, no WebSocket, no HTTP callback. This keeps the design squarely within AOF's existing patterns: filesystem persistence, scheduler-driven dispatch, deterministic control plane, and the OpenClaw constraint of no nested sessions. No new runtime dependencies are required; every capability needed (atomic writes, session dispatch, event logging, schema validation) is already in the installed stack.

The recommended approach is to store subscriptions as co-located JSON files alongside task artifacts (e.g., `TASK-xxx/subscriptions.json`), register subscriptions primarily through a `subscribe` parameter on `aof_dispatch` (solving the race condition where tasks complete before a separate subscribe call), and deliver callbacks via `GatewayAdapter.spawnSession()` from the `onRunComplete` hook -- the same mechanism used for DAG hop dispatch. The delivery system must be named "callbacks" or "watchers" to avoid confusion with two existing systems that already use the words "notification" and "subscription" for unrelated purposes (system alerts and MCP resource updates, respectively).

The primary risks are: infinite callback loops (callback creates task, task triggers another callback), lost notifications on daemon restart (the dual-write problem between task state transition and notification delivery), and notification storms from DAG workflows with "all" granularity subscriptions. All three have well-understood mitigations: cross-cycle delivery with depth counters, a write-ahead notification log with startup reconciliation, and per-task batching/coalescing. These mitigations must be designed into the first implementation, not bolted on later.

## Key Findings

### Recommended Stack

No new dependencies. The existing stack covers all v1.8 requirements completely. This is the second consecutive milestone (after v1.5) requiring zero new runtime dependencies -- a strong signal that the architecture is well-suited for feature expansion.

**Core technologies (all already installed):**
- **write-file-atomic (7.x):** Atomic subscription file writes and delivery state updates
- **zod (3.24.x):** Subscription schema validation, callback context shape
- **yaml / gray-matter:** Task frontmatter parsing (subscriptions stored in separate co-located files)
- **@modelcontextprotocol/sdk (1.26.x):** `aof_task_subscribe` tool registration, `subscribe` param on `aof_dispatch`
- **Node.js 22 built-ins:** `crypto.randomUUID()` for subscription IDs, `fs/promises` for storage

The stack research explicitly rejected: message queues (bullmq), WebSockets, cron schedulers, email/chat delivery, pub/sub libraries, and reactive frameworks. All are unnecessary given AOF's single-process, filesystem-based, poll-driven architecture.

### Expected Features

**Must have (table stakes):**
- Subscribe-on-dispatch (`subscribe` param on `aof_dispatch`) -- eliminates race with fast tasks
- Subscription schema with `TaskSubscription` Zod type
- Completion granularity (`done | deadletter | cancelled`) -- the 90% use case
- Callback delivery via `GatewayAdapter.spawnSession()` with rich notification context
- At-least-once delivery with filesystem-persisted subscription state
- Subscription cleanup (delivered subs marked, failed subs tracked, audit trail preserved)

**Should have (differentiators):**
- `aof_task_subscribe` standalone tool -- for subscribing to tasks not created by the current agent
- All-transitions granularity with batching -- aggregate per poll cycle, not per-transition
- Callback retry with backoff (reuse `failure-tracker.ts` pattern)
- Notification delivery trace (via existing `captureTrace` infrastructure)
- Unsubscribe tool

**Defer (v2+):**
- Filtered subscriptions (notify only on failure)
- Batch coalescing across multiple tasks to same subscriber
- Query-based subscriptions ("notify me when ANY task tagged X completes") -- fundamentally different model
- Cross-task subscription index

### Architecture Approach

The system is a subscription-triggered dispatch pipeline with four new components and hooks into three existing systems. Subscriptions are stored as co-located JSON files in task artifact directories (not in task frontmatter metadata, which avoids schema migration and write contention). The `NotificationDispatcher` evaluates subscriptions when tasks reach terminal states, builds callback `TaskContext` payloads, and dispatches via `spawnSession()`. Delivery happens from the `onRunComplete` callback (same as DAG hop dispatch) with a separate concurrency budget to avoid blocking regular task dispatch.

**Major components:**
1. **SubscriptionSchema** (`src/schemas/subscription.ts`) -- Zod schema for `TaskSubscription` records
2. **SubscriptionStore** (`src/store/subscription-store.ts`) -- CRUD for co-located `subscriptions.json` files
3. **NotificationDispatcher** (`src/dispatch/notification-dispatcher.ts`) -- evaluate subscriptions, build context, spawn callback sessions
4. **MCP tools** -- `subscribe` param on `aof_dispatch`, standalone `aof_task_subscribe` tool

**Key patterns to follow:**
- Filesystem co-location (subscriptions move with task on status transitions)
- Scheduler action types (add `notify_subscriber` as fallback action)
- Best-effort delivery (never block task state transitions)
- Schema-first with Zod

### Critical Pitfalls

1. **Callback-creates-task infinite loop** -- Prevent with cross-cycle delivery (never deliver in same poll as triggering completion), depth counter on callback-spawned tasks (max 3 levels), and per-subscriber rate limit (max 2 per poll cycle).

2. **Lost notifications on daemon restart** -- Prevent with write-ahead notification log (`state/notifications/pending/`), startup reconciliation pass scanning active subscriptions against terminal tasks, and idempotent delivery with `notificationId` in callback context.

3. **Race between dispatch and subscribe** -- Prevent by making `subscribe` a parameter on `aof_dispatch` (atomic creation), plus catch-up-on-subscribe (if task already terminal when subscription is created, deliver immediately).

4. **DAG notification storm** -- Prevent with per-task per-cycle batching (one callback with aggregated transitions, not N separate callbacks), debounce intermediate states, and cap of 3 notification deliveries per task per poll cycle.

5. **Naming confusion with existing systems** -- Use "callback" terminology, not "notification." Create a separate module (`src/callbacks/` or `src/watchers/`), not a subfolder of `events/` or `mcp/`. Document the taxonomy.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Schema, Storage, and Module Foundation

**Rationale:** Everything depends on the subscription data model and storage mechanism. The schema determines what information flows through the entire system. Module naming and separation must be established before any code is written to avoid confusion with existing notification/subscription systems.
**Delivers:** `TaskSubscription` Zod schema, `SubscriptionStore` with CRUD operations, co-located `subscriptions.json` storage, new event types in `EventType` enum, module structure decision.
**Addresses:** Subscription schema (table stakes), storage persistence, subscription cleanup tracking.
**Avoids:** Metadata bag abuse (Pitfall 9), naming confusion (Pitfall 8), orphaned subscriptions (Pitfall 5 -- by defining terminal state coverage from the start).

### Phase 2: Subscribe-on-Dispatch and Subscription API

**Rationale:** The primary entry point for creating subscriptions must exist before delivery can be tested end-to-end. Subscribe-on-dispatch solves the critical race condition (Pitfall 3) and is the 90% use case.
**Delivers:** `subscribe` parameter on `aof_dispatch`, standalone `aof_task_subscribe` MCP tool, catch-up-on-subscribe (immediate delivery if task already terminal).
**Addresses:** Subscribe-on-dispatch (table stakes), `aof_task_subscribe` (differentiator), race prevention.
**Avoids:** Race between dispatch and subscribe (Pitfall 3).

### Phase 3: Notification Dispatcher and Callback Delivery

**Rationale:** The core engine. Once subscriptions can be created and persisted, this phase builds the evaluation and delivery pipeline. This is where the most critical pitfalls (infinite loops, restart durability, scheduler blocking) must be addressed.
**Delivers:** `NotificationDispatcher` with evaluate/deliver pipeline, rich callback `TaskContext` with outcome/summary/outputs, `onRunComplete` hook integration, write-ahead notification log, delivery failure tracking, separate notification concurrency budget.
**Addresses:** Callback delivery (table stakes), at-least-once delivery (table stakes), delivery trace (differentiator).
**Avoids:** Infinite loops (Pitfall 1 -- cross-cycle delivery, depth counter), lost notifications (Pitfall 2 -- write-ahead log), scheduler blocking (Pitfall 7 -- separate budget), lacking callback context (Pitfall 6 -- rich payload schema).

### Phase 4: DAG Workflow Integration and All-Granularity

**Rationale:** DAG notification semantics are more complex (hop-level vs DAG-level events) and require the core delivery pipeline from Phase 3 to be stable. The "all" granularity amplifies the notification storm risk and requires batching.
**Delivers:** DAG completion callbacks, hop-level notifications for `all` subscribers with per-cycle batching, DAG-specific callback context (hop outcomes, ready hops).
**Addresses:** All-transitions granularity (differentiator), DAG observability.
**Avoids:** DAG notification storm (Pitfall 4 -- batching, coalescing, debounce).

### Phase 5: Hardening, SKILL.md, and Edge Cases

**Rationale:** Polish phase. Concurrency gates, depth limiting, startup reconciliation, CLI diagnostics, and agent-facing documentation. These are important for production reliability but do not block the core feature from working.
**Delivers:** Concurrency-aware dispatch gating, callback chain depth limiting, daemon startup reconciliation, `aof subscriptions <task-id>` CLI command, SKILL.md update with callback guidance, subscription TTL/expiry.
**Addresses:** Subscription cleanup (table stakes -- final hardening), unsubscribe tool (differentiator).
**Avoids:** Unbounded callback chains (Anti-pattern 4), completion enforcement firing on callback sessions.

### Phase Ordering Rationale

- **Schema before API before engine:** Each layer depends on the one below it. The subscription schema is the foundation; the API produces subscriptions; the engine consumes them.
- **Subscribe-on-dispatch before standalone subscribe:** The dispatch-time subscription eliminates the most dangerous race condition and covers the primary use case. Standalone subscribe is additive.
- **Simple completion before DAG all-granularity:** Completion callbacks are simpler (one delivery per subscription) and cover 90% of use cases. DAG all-granularity adds complexity (batching, coalescing) that should build on a stable delivery pipeline.
- **Hardening last:** Depth limiting, TTL, and startup reconciliation are defensive measures that refine an already-working system.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3 (Delivery Engine):** The interaction between `onRunComplete` hooks, concurrency limits, and write-ahead logging is the most integration-heavy work. The three-way interaction between DAG hop dispatch, notification dispatch, and regular task dispatch sharing `maxConcurrentDispatches` needs careful design.
- **Phase 4 (DAG Integration):** The batching/coalescing strategy for "all" granularity notifications during rapid hop transitions needs prototype validation.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Schema + Storage):** Well-established Zod schema patterns, filesystem co-location follows existing trace/artifact conventions.
- **Phase 2 (Subscribe API):** Follows exact pattern of `aof_task_dep_add`/`aof_task_dep_remove` tool registration.
- **Phase 5 (Hardening):** Mirrors existing patterns (failure tracker, smoke tests, SKILL.md updates).

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All capabilities verified against installed packages; zero new dependencies needed |
| Features | HIGH | All findings from direct codebase analysis; clear precedent in DAG hop dispatch pattern |
| Architecture | HIGH | Component boundaries map cleanly to existing module structure; all integration points identified with file-level references |
| Pitfalls | HIGH | All pitfalls derived from direct code inspection; prevention strategies reference specific existing patterns (failure tracker, trace capture, DAG evaluator) |

**Overall confidence:** HIGH

### Gaps to Address

- **Storage location decision:** STACK.md recommends task frontmatter metadata bag; ARCHITECTURE.md and PITFALLS.md both argue against this (write contention, no schema validation). The co-located `subscriptions.json` file approach from ARCHITECTURE.md is the stronger recommendation. This tension should be resolved definitively in Phase 1 requirements.
- **Callback vs notification terminology:** Research recommends "callback" or "watcher" naming but the files themselves use mixed terminology. The final naming convention should be locked before Phase 1 implementation.
- **Retry policy:** ARCHITECTURE.md says best-effort with no retry; FEATURES.md says retry up to 3 times matching `maxDispatchRetries`. Recommend retry with bounded attempts (3), matching existing dispatch failure patterns.
- **Completion enforcement for callback sessions:** Callback sessions spawned to notify agents should NOT be subject to completion enforcement (they have no task to "complete"). This edge case needs explicit handling in Phase 5 but should be designed for in Phase 3.

## Sources

### Primary (HIGH confidence)
- AOF codebase: `src/dispatch/scheduler.ts`, `src/dispatch/dag-transition-handler.ts`, `src/dispatch/assign-executor.ts`, `src/dispatch/action-executor.ts` -- scheduler and dispatch architecture
- AOF codebase: `src/schemas/task.ts`, `src/schemas/event.ts`, `src/schemas/workflow-dag.ts` -- data models and state machines
- AOF codebase: `src/dispatch/executor.ts` -- `GatewayAdapter` contract, `spawnSession()` interface
- AOF codebase: `src/store/task-store.ts` -- filesystem store, atomic transitions
- AOF codebase: `src/mcp/tools.ts` -- MCP tool registration patterns
- AOF codebase: `src/events/notifier.ts`, `src/mcp/subscriptions.ts` -- existing notification/subscription systems (confirmed as separate concerns)

### Secondary (MEDIUM confidence)
- [At-Least-Once Delivery patterns](https://www.cloudcomputingpatterns.org/at_least_once_delivery/) -- delivery guarantee design
- [Outbox/Inbox Patterns](https://event-driven.io/en/outbox_inbox_patterns_and_delivery_guarantees_explained/) -- write-ahead log pattern
- [You Cannot Have Exactly-Once Delivery](https://bravenewgeek.com/you-cannot-have-exactly-once-delivery/) -- rationale for at-least-once
- [Event Notification Pattern (Fowler)](https://martinfowler.com/articles/201701-event-driven.html) -- event notification vs event-carried state transfer

---
*Research completed: 2026-03-09*
*Ready for roadmap: yes*
