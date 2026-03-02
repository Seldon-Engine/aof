# Phase 3: Gateway Integration - Context

**Gathered:** 2026-02-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Tasks are dispatched to real agents via the OpenClaw gateway and tracked from spawn to completion. Covers the adapter interface, the OpenClaw adapter implementation, session lifecycle tracking with heartbeat-based timeout detection, correlation IDs linking tasks to sessions, and an integration test suite. Does not include automatic recovery/resurrection of failed tasks (Phase 4) or install experience (Phase 5).

</domain>

<decisions>
## Implementation Decisions

### Adapter contract
- Adapter interface exposes: `spawnSession(task)`, `getSessionStatus(sessionId)`, `forceCompleteSession(sessionId)`
- Each platform adapter knows how to spawn, poll status, and kill its own sessions
- Config-driven adapter selection: config specifies adapter name (e.g. `executor: { adapter: "openclaw" }`), resolved at startup
- Two adapters: OpenClaw (real) and mock (for testing/development)
- Mock adapter simulates spawn/completion with configurable delays, used by integration test suite

### Session lifecycle
- Heartbeat checking integrated into the existing poll cycle — each poll calls `getSessionStatus()` which returns `lastHeartbeatAt`
- If `now - lastHeartbeatAt > heartbeatTimeoutMs`, scheduler calls `forceCompleteSession()` and reclaims the task
- Default heartbeat timeout: 10 minutes (configurable) — generous for long-running research tasks
- No dedicated heartbeat monitor — reuses poll loop

### Correlation & tracing
- UUID v4 correlation ID generated when a task is dispatched
- Stored on task metadata, passed to adapter on `spawnSession()`, logged on all related events
- Links: task ID ↔ correlation ID ↔ agent session ID ↔ completion event

### Integration testing
- CI tests use the mock adapter (fast, reliable, no external dependencies)
- Real gateway tests available for manual/E2E runs but not required in CI
- Three mandatory scenarios: (1) dispatch-to-completion success, (2) heartbeat timeout triggers force-complete and task reclaim, (3) spawn failure is classified correctly per Phase 1 taxonomy

### Claude's Discretion
- Exact adapter interface types and method signatures
- How `getSessionStatus()` maps to OpenClaw gateway API calls
- Session state machine transitions
- Mock adapter delay configuration defaults
- How correlation ID is propagated through existing event system

</decisions>

<specifics>
## Specific Ideas

- Phase 1 already built failure classification (`classifySpawnError`) — integration tests should verify spawn failures flow through that taxonomy
- Phase 1's orphan reconciliation should work with dispatched sessions that were interrupted by a crash
- The mock adapter is critical for unblocking Phase 4 (self-healing) testing without a real gateway

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-gateway-integration*
*Context gathered: 2026-02-25*
