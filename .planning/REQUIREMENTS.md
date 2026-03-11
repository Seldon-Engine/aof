# Requirements: AOF v1.8 Task Notifications

**Defined:** 2026-03-09
**Core Value:** Tasks never get dropped -- they survive gateway restarts, API failures, rate limits, and agent crashes, always resuming and completing end-to-end without human intervention.

## v1.8 Requirements

Requirements for task notification subscriptions and callback delivery.

### Subscription API

- [x] **SUB-01**: Agent can subscribe to task outcomes at dispatch time via `notify` param on `aof_dispatch`
- [x] **SUB-02**: Agent can subscribe to an existing task's outcomes via `aof_subscribe` tool
- [x] **SUB-03**: Agent can cancel a subscription via `aof_unsubscribe` tool
- [x] **SUB-04**: Subscription data persists in task frontmatter with Zod schema validation

### Callback Delivery

- [x] **DLVR-01**: Scheduler delivers callbacks by spawning a new session to the subscriber agent with task results as context
- [x] **DLVR-02**: Failed deliveries retry up to 3 times before marking subscription as failed
- [x] **DLVR-03**: Callback sessions produce traces like normal dispatches
- [x] **DLVR-04**: Delivery never blocks task state transitions (best-effort, non-blocking)

### Granularity

- [x] **GRAN-01**: `"completion"` granularity fires on terminal states (done/cancelled/deadletter)
- [x] **GRAN-02**: `"all"` granularity fires on every state transition, batched per poll cycle

### Agent Guidance

- [x] **GUID-01**: SKILL.md documents callback behavior and idempotency expectations for agents

### Safety

- [x] **SAFE-01**: Infinite callback loops prevented (depth counter or cross-cycle delivery)
- [x] **SAFE-02**: Subscription delivery survives daemon restart (pending subscriptions re-evaluated on startup)

## Future Requirements

### Filtered Subscriptions

- **FILT-01**: Agent can filter subscriptions to specific outcomes (e.g., failure-only)

### Batch Coalescing

- **BATCH-01**: Multiple task completions for same subscriber coalesced into single callback session

### Query-Based Subscriptions

- **QUERY-01**: Agent can subscribe to all tasks matching a query (e.g., tagged `deploy`)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Webhook/HTTP callback endpoints | AOF is filesystem-based, single-machine — no HTTP server for callbacks |
| Real-time push (WebSocket/SSE) | Agents are spawned sessions, not persistent processes |
| LLM-driven notification routing | Violates deterministic control plane constraint |
| Email/Slack delivery for callbacks | Existing NotificationService handles operator alerts — callbacks are agent-to-agent |
| Separate subscription database | Violates filesystem-only constraint |
| Exactly-once delivery | Impossible without distributed transactions — at-least-once is sufficient |
| Nested session callbacks | OpenClaw does not support nested agent sessions |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SUB-01 | Phase 29 | Complete |
| SUB-02 | Phase 29 | Complete |
| SUB-03 | Phase 29 | Complete |
| SUB-04 | Phase 28 | Complete |
| DLVR-01 | Phase 30 | Complete |
| DLVR-02 | Phase 30 | Complete |
| DLVR-03 | Phase 30 | Complete |
| DLVR-04 | Phase 30 | Complete |
| GRAN-01 | Phase 30 | Complete |
| GRAN-02 | Phase 31 | Complete |
| GUID-01 | Phase 32 | Complete |
| SAFE-01 | Phase 31 | Complete |
| SAFE-02 | Phase 31 | Complete |

**Coverage:**
- v1.8 requirements: 13 total
- Mapped to phases: 13
- Unmapped: 0

---
*Requirements defined: 2026-03-09*
*Last updated: 2026-03-09 after roadmap creation*
