# Requirements: AOF v1.8 Task Notifications

**Defined:** 2026-03-09
**Core Value:** Tasks never get dropped — they survive gateway restarts, API failures, rate limits, and agent crashes, always resuming and completing end-to-end without human intervention.

## v1.8 Requirements

Requirements for task notification subscriptions and callback delivery.

### Subscription API

- [ ] **SUB-01**: Agent can subscribe to task outcomes at dispatch time via `notify` param on `aof_dispatch`
- [ ] **SUB-02**: Agent can subscribe to an existing task's outcomes via `aof_subscribe` tool
- [ ] **SUB-03**: Agent can cancel a subscription via `aof_unsubscribe` tool
- [ ] **SUB-04**: Subscription data persists in task frontmatter with Zod schema validation

### Callback Delivery

- [ ] **DLVR-01**: Scheduler delivers callbacks by spawning a new session to the subscriber agent with task results as context
- [ ] **DLVR-02**: Failed deliveries retry up to 3 times before marking subscription as failed
- [ ] **DLVR-03**: Callback sessions produce traces like normal dispatches
- [ ] **DLVR-04**: Delivery never blocks task state transitions (best-effort, non-blocking)

### Granularity

- [ ] **GRAN-01**: `"completion"` granularity fires on terminal states (done/cancelled/deadletter)
- [ ] **GRAN-02**: `"all"` granularity fires on every state transition, batched per poll cycle

### Agent Guidance

- [ ] **GUID-01**: SKILL.md documents callback behavior and idempotency expectations for agents

### Safety

- [ ] **SAFE-01**: Infinite callback loops prevented (depth counter or cross-cycle delivery)
- [ ] **SAFE-02**: Subscription delivery survives daemon restart (pending subscriptions re-evaluated on startup)

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
| SUB-01 | — | Pending |
| SUB-02 | — | Pending |
| SUB-03 | — | Pending |
| SUB-04 | — | Pending |
| DLVR-01 | — | Pending |
| DLVR-02 | — | Pending |
| DLVR-03 | — | Pending |
| DLVR-04 | — | Pending |
| GRAN-01 | — | Pending |
| GRAN-02 | — | Pending |
| GUID-01 | — | Pending |
| SAFE-01 | — | Pending |
| SAFE-02 | — | Pending |

**Coverage:**
- v1.8 requirements: 13 total
- Mapped to phases: 0
- Unmapped: 13 ⚠️

---
*Requirements defined: 2026-03-09*
*Last updated: 2026-03-09 after initial definition*
