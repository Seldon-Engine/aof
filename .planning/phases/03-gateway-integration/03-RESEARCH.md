# Phase 3: Gateway Integration - Research

**Researched:** 2026-02-25
**Domain:** Task dispatch lifecycle, adapter pattern, session tracking, correlation tracing
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Adapter interface exposes: `spawnSession(task)`, `getSessionStatus(sessionId)`, `forceCompleteSession(sessionId)`
- Each platform adapter knows how to spawn, poll status, and kill its own sessions
- Config-driven adapter selection: config specifies adapter name (e.g. `executor: { adapter: "openclaw" }`), resolved at startup
- Two adapters: OpenClaw (real) and mock (for testing/development)
- Mock adapter simulates spawn/completion with configurable delays, used by integration test suite
- Heartbeat checking integrated into the existing poll cycle — each poll calls `getSessionStatus()` which returns `lastHeartbeatAt`
- If `now - lastHeartbeatAt > heartbeatTimeoutMs`, scheduler calls `forceCompleteSession()` and reclaims the task
- Default heartbeat timeout: 10 minutes (configurable) — generous for long-running research tasks
- No dedicated heartbeat monitor — reuses poll loop
- UUID v4 correlation ID generated when a task is dispatched
- Stored on task metadata, passed to adapter on `spawnSession()`, logged on all related events
- Links: task ID <-> correlation ID <-> agent session ID <-> completion event
- CI tests use the mock adapter (fast, reliable, no external dependencies)
- Real gateway tests available for manual/E2E runs but not required in CI
- Three mandatory scenarios: (1) dispatch-to-completion success, (2) heartbeat timeout triggers force-complete and task reclaim, (3) spawn failure is classified correctly per Phase 1 taxonomy

### Claude's Discretion
- Exact adapter interface types and method signatures
- How `getSessionStatus()` maps to OpenClaw gateway API calls
- Session state machine transitions
- Mock adapter delay configuration defaults
- How correlation ID is propagated through existing event system

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| GATE-01 | `GatewayExecutor` dispatches tasks to agents via plugin-sdk adapter interface | Existing `DispatchExecutor.spawn()` must evolve into the broader adapter interface (`spawnSession`, `getSessionStatus`, `forceCompleteSession`). The `OpenClawExecutor` already dispatches via gateway extensionAPI — refactor to fit the new adapter contract. |
| GATE-02 | Adapter interface abstracts platform-specific integration (OpenClaw first, portable later) | Create a `GatewayAdapter` interface with the three methods. `OpenClawExecutor` becomes `OpenClawAdapter`. `MockExecutor` becomes `MockAdapter`. Config-driven selection resolves adapter at startup. |
| GATE-03 | Dispatched sessions tracked from spawn to completion with correlation | Add `correlationId` (UUID v4) to task metadata at dispatch time, pass to adapter, include in all event log entries. Link: taskId <-> correlationId <-> sessionId <-> completion event. |
| GATE-04 | Stuck agent sessions force-completed after configurable timeout | Heartbeat infrastructure already exists (`RunHeartbeat`, `checkStaleHeartbeats`, stale heartbeat handling in poll loop). Wire `getSessionStatus()` into the poll cycle and call `forceCompleteSession()` when heartbeat expires. Default timeout: 10 minutes. |
| GATE-05 | Integration test suite validates dispatch-to-completion E2E | Three mandatory scenarios using mock adapter: success path, heartbeat timeout, spawn failure classification. CI-friendly via mock adapter. |
</phase_requirements>

## Summary

Phase 3 transforms AOF's task dispatch from a fire-and-forget spawn model into a tracked, lifecycle-managed gateway integration with proper session monitoring. The codebase already has significant infrastructure in place: the `DispatchExecutor` interface with `spawn()`, the `OpenClawExecutor` implementation that dispatches via the gateway's `extensionAPI`, a complete heartbeat system (`RunHeartbeat` schema, `writeHeartbeat`/`readHeartbeat`/`checkStaleHeartbeats`), stale heartbeat handling in the scheduler's poll loop, and a failure classification taxonomy (`classifySpawnError`). The work is primarily refactoring existing code into a cleaner adapter abstraction and adding the missing pieces: session status polling, force-completion, and correlation IDs.

The main architectural change is evolving the single-method `DispatchExecutor` interface into a three-method `GatewayAdapter` interface (`spawnSession`, `getSessionStatus`, `forceCompleteSession`). The existing `OpenClawExecutor` already implements the spawn path correctly (including fire-and-forget embedded agent execution) and will be refactored into `OpenClawAdapter`. The `MockExecutor` will become `MockAdapter` with configurable completion delays for testing. The heartbeat timeout detection already works in the poll loop — it just needs to be wired through the new `getSessionStatus()` method rather than reading heartbeat files directly.

**Primary recommendation:** Refactor the existing `DispatchExecutor` → `GatewayAdapter` interface, add correlation IDs to the dispatch path, wire `getSessionStatus()` into the existing stale-heartbeat poll cycle, and build three integration test scenarios using the mock adapter.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:crypto` | Node 22+ | `randomUUID()` for correlation IDs | Already used throughout codebase; zero-dependency |
| `vitest` | (project version) | Unit and integration tests | Already the project test framework |
| `zod` | (project version) | Schema validation for session status, adapter config | Already used for `RunHeartbeat`, task schemas |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:timers` | Node 22+ | `setTimeout`/`setInterval` for mock adapter delays | Mock adapter completion simulation |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Direct `randomUUID()` | `nanoid` | No benefit — `randomUUID` is already the project standard |
| Zod schemas | TypeScript interfaces only | Lose runtime validation — Zod is already established |

**Installation:**
No new dependencies required. All functionality uses existing project dependencies plus Node.js built-ins.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── dispatch/
│   ├── executor.ts           # REFACTOR: DispatchExecutor → GatewayAdapter interface
│   ├── action-executor.ts    # MODIFY: Use adapter.spawnSession() + correlationId
│   ├── scheduler.ts          # MODIFY: Use adapter.getSessionStatus() in poll loop
│   └── ...                   # Existing files unchanged
├── openclaw/
│   ├── openclaw-executor.ts  # REFACTOR: OpenClawExecutor → OpenClawAdapter
│   ├── adapter.ts            # MODIFY: Wire OpenClawAdapter into plugin registration
│   └── ...                   # Existing files unchanged
├── recovery/
│   └── run-artifacts.ts      # MINOR: checkStaleHeartbeats may delegate to adapter
└── schemas/
    └── run.ts                # MINOR: Add correlationId to relevant schemas if needed
```

### Pattern 1: GatewayAdapter Interface (Adapter Pattern)
**What:** A three-method interface that abstracts platform-specific agent session management.
**When to use:** All dispatch-related code interacts with the adapter interface, never with platform-specific implementations directly.
**Example:**
```typescript
// New interface replacing DispatchExecutor
export interface GatewayAdapter {
  /** Spawn an agent session for a task. */
  spawnSession(
    context: TaskContext,
    opts?: { timeoutMs?: number; correlationId?: string }
  ): Promise<SpawnResult>;

  /** Poll session status (heartbeat liveness check). */
  getSessionStatus(sessionId: string): Promise<SessionStatus>;

  /** Force-complete a stuck session. */
  forceCompleteSession(sessionId: string): Promise<void>;
}

export interface SpawnResult {
  success: boolean;
  sessionId?: string;
  error?: string;
  platformLimit?: number;
}

export interface SessionStatus {
  sessionId: string;
  alive: boolean;
  lastHeartbeatAt?: string;
  completedAt?: string;
}
```

### Pattern 2: Correlation ID Propagation
**What:** A UUID v4 generated at dispatch time, stored on task metadata, passed to the adapter, and included in all related event log entries.
**When to use:** Every dispatch event, session event, and completion event includes the correlation ID.
**Example:**
```typescript
// In action-executor.ts, during assign action
import { randomUUID } from "node:crypto";

const correlationId = randomUUID();

// Store on task metadata
task.frontmatter.metadata = {
  ...task.frontmatter.metadata,
  correlationId,
};

// Pass to adapter
const result = await adapter.spawnSession(context, {
  timeoutMs: config.spawnTimeoutMs,
  correlationId,
});

// Include in event logs
await logger.logDispatch("dispatch.matched", "scheduler", action.taskId, {
  agent: action.agent,
  sessionId: result.sessionId,
  correlationId,
});
```

### Pattern 3: Config-Driven Adapter Selection
**What:** Adapter is selected at startup based on configuration, not hardcoded.
**When to use:** Service initialization reads config to determine which adapter to instantiate.
**Example:**
```typescript
// In adapter registration / service startup
function resolveAdapter(config: ExecutorConfig, api?: OpenClawApi): GatewayAdapter {
  switch (config.adapter) {
    case "openclaw":
      if (!api) throw new Error("OpenClaw API required for openclaw adapter");
      return new OpenClawAdapter(api);
    case "mock":
      return new MockAdapter(config.mockOptions);
    default:
      throw new Error(`Unknown adapter: ${config.adapter}`);
  }
}
```

### Pattern 4: Mock Adapter with Configurable Delays
**What:** A test adapter that simulates spawn, status polling, and completion with configurable timing.
**When to use:** All integration tests; development without a real gateway.
**Example:**
```typescript
export class MockAdapter implements GatewayAdapter {
  private sessions = new Map<string, MockSession>();

  constructor(private opts: MockAdapterOptions = {}) {}

  async spawnSession(context: TaskContext, opts?: { correlationId?: string }): Promise<SpawnResult> {
    if (this.shouldFail) {
      return { success: false, error: this.failureError };
    }

    const sessionId = `mock-session-${context.taskId}`;
    this.sessions.set(sessionId, {
      sessionId,
      correlationId: opts?.correlationId,
      startedAt: Date.now(),
      completionDelayMs: this.opts.completionDelayMs ?? 100,
    });

    // Schedule auto-completion after delay
    if (this.opts.autoComplete !== false) {
      setTimeout(() => this.completeSession(sessionId), this.opts.completionDelayMs ?? 100);
    }

    return { success: true, sessionId };
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    const session = this.sessions.get(sessionId);
    if (!session) return { sessionId, alive: false };
    return {
      sessionId,
      alive: !session.completed,
      lastHeartbeatAt: new Date(session.lastHeartbeat ?? session.startedAt).toISOString(),
      completedAt: session.completedAt,
    };
  }

  async forceCompleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.completed = true;
      session.completedAt = new Date().toISOString();
    }
  }
}
```

### Anti-Patterns to Avoid
- **Leaking platform details through the adapter interface:** The `GatewayAdapter` methods must not expose OpenClaw-specific concepts (extensionAPI, workspace dirs, agent dirs). Those are implementation details of `OpenClawAdapter`.
- **Polling heartbeats outside the poll loop:** The user decision explicitly states "no dedicated heartbeat monitor — reuses poll loop." Do not create a separate timer or interval for heartbeat checking.
- **Blocking the poll loop on session status checks:** `getSessionStatus()` must be fast (read a local heartbeat file, not make an HTTP call that might time out). The existing `readHeartbeat()` approach (reading `run_heartbeat.json` from disk) is correct.
- **Generating correlation IDs in the adapter:** Correlation IDs must be generated by the dispatcher (action-executor) and passed to the adapter, ensuring the ID is known before the spawn call and can be logged immediately.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| UUID generation | Custom ID scheme | `randomUUID()` from `node:crypto` | Cryptographic quality, zero dependencies, already project standard |
| Heartbeat file I/O | Custom file read/write | Existing `readHeartbeat()`/`writeHeartbeat()` from `src/recovery/run-artifacts.ts` | Already handles atomic writes, Zod validation, error recovery |
| Stale heartbeat detection | New heartbeat monitor | Existing `checkStaleHeartbeats()` from `src/recovery/run-artifacts.ts` | Already integrated into poll loop, handles TTL calculation |
| Task serialization | Manual frontmatter writing | Existing `serializeTask()` + `writeFileAtomic()` | Preserves frontmatter format, atomic writes prevent corruption |
| Failure classification | New error categorization | Existing `classifySpawnError()` from `src/dispatch/scheduler-helpers.ts` | Already handles permanent/transient/rate_limited classification |
| Lease management | Custom lease logic | Existing `acquireLease()`/`releaseLease()` from `src/store/lease.ts` | Already handles TTL, conflicts, run artifact writing |

**Key insight:** The heartbeat and session lifecycle infrastructure already exists. Phase 3 is primarily a refactoring and wiring exercise, not a greenfield build.

## Common Pitfalls

### Pitfall 1: Breaking the Existing Spawn Path During Refactoring
**What goes wrong:** Renaming `DispatchExecutor` to `GatewayAdapter` breaks all call sites and tests simultaneously, making it impossible to verify each step.
**Why it happens:** The interface is used in 15+ files across dispatch, service, tests, and the OpenClaw adapter.
**How to avoid:** Incremental migration. Either: (a) make `GatewayAdapter` extend `DispatchExecutor` initially (backward compatible), then remove `DispatchExecutor` after all consumers migrate; or (b) create `GatewayAdapter` as the new interface and update `DispatchExecutor` to be an alias/wrapper temporarily.
**Warning signs:** More than 5 test files failing at once after a rename.

### Pitfall 2: Conflating Session Status with Heartbeat Status
**What goes wrong:** `getSessionStatus()` does expensive operations (HTTP calls to gateway) when it should just read the local heartbeat file.
**Why it happens:** The name "getSessionStatus" implies querying the platform, but for OpenClaw the heartbeat file (`run_heartbeat.json`) written by `acquireLease()` is the source of truth.
**How to avoid:** For `OpenClawAdapter`, `getSessionStatus()` reads the local `run_heartbeat.json` file — the same thing `checkStaleHeartbeats()` already does. The heartbeat is updated by the agent itself during execution (via the run artifact protocol). No HTTP call needed.
**Warning signs:** Poll cycle duration increasing after adding session status checks.

### Pitfall 3: Heartbeat Timeout Too Aggressive
**What goes wrong:** Tasks are force-completed during legitimate long operations (e.g., Opus 4.6 compaction takes 4-7 minutes, large builds).
**Why it happens:** Default timeout set too low, or heartbeat TTL not renewed during long operations.
**How to avoid:** Default 10 minutes (user decision). Ensure `acquireLease()` sets heartbeat TTL to match. The existing `startLeaseRenewal()` already renews leases periodically — verify heartbeats are renewed alongside leases.
**Warning signs:** Tasks reclaimed during normal agent operation.

### Pitfall 4: Mock Adapter Too Simple for Meaningful Tests
**What goes wrong:** Mock adapter completes instantly, so tests pass but never exercise the heartbeat timeout path or the multi-poll-cycle lifecycle.
**Why it happens:** Mock adapter only simulates success path.
**How to avoid:** Mock adapter must support: (a) configurable completion delay, (b) simulated heartbeat staleness (stop updating heartbeat), (c) spawn failure simulation (already exists in `MockExecutor`). Mandatory test scenario #2 (heartbeat timeout) requires the mock to simulate a stuck session.
**Warning signs:** All three mandatory integration tests pass but none take more than 10ms.

### Pitfall 5: Correlation ID Not Propagated to Completion Events
**What goes wrong:** Correlation ID is logged on dispatch but missing from completion/reclaim events, breaking end-to-end tracing.
**Why it happens:** Completion events are triggered by the `aof_task_complete` tool call (agent-initiated) or by heartbeat timeout (scheduler-initiated). Both paths need to read the correlation ID from task metadata.
**How to avoid:** Store correlation ID in `task.frontmatter.metadata.correlationId` at dispatch time. Read it back in: (a) `aof_task_complete` tool handler, (b) stale heartbeat handler in `action-executor.ts`, (c) any force-complete path.
**Warning signs:** Events with `correlationId: undefined` in `events.jsonl`.

## Code Examples

### Example 1: Refactored GatewayAdapter Interface
```typescript
// src/dispatch/executor.ts — refactored

import type { TaskContext } from "./executor.js";

export interface SpawnResult {
  success: boolean;
  sessionId?: string;
  error?: string;
  platformLimit?: number;
}

export interface SessionStatus {
  sessionId: string;
  alive: boolean;
  lastHeartbeatAt?: string;
  completedAt?: string;
}

export interface GatewayAdapter {
  spawnSession(
    context: TaskContext,
    opts?: { timeoutMs?: number; correlationId?: string }
  ): Promise<SpawnResult>;

  getSessionStatus(sessionId: string): Promise<SessionStatus>;

  forceCompleteSession(sessionId: string): Promise<void>;
}

// Backward compatibility: DispatchExecutor is now an alias
// Can be removed once all consumers are migrated
export type DispatchExecutor = Pick<GatewayAdapter, "spawnSession"> & {
  spawn: GatewayAdapter["spawnSession"];
};
```

### Example 2: OpenClawAdapter getSessionStatus Implementation
```typescript
// In OpenClawAdapter — reads local heartbeat file

async getSessionStatus(sessionId: string): Promise<SessionStatus> {
  // The sessionId maps to a task via the sessions map maintained at spawn time
  const taskId = this.sessionToTask.get(sessionId);
  if (!taskId) {
    return { sessionId, alive: false };
  }

  const heartbeat = await readHeartbeat(this.store, taskId);
  if (!heartbeat) {
    return { sessionId, alive: false };
  }

  const expiresAt = heartbeat.expiresAt
    ? new Date(heartbeat.expiresAt).getTime()
    : 0;

  return {
    sessionId,
    alive: expiresAt > Date.now(),
    lastHeartbeatAt: heartbeat.lastHeartbeat,
  };
}
```

### Example 3: Poll Loop Integration with getSessionStatus
```typescript
// In scheduler.ts poll() — replaces direct checkStaleHeartbeats call

// Instead of:
//   const staleHeartbeats = await checkStaleHeartbeats(store, heartbeatTtl);
// Use adapter-aware session status:

if (config.executor) {
  const inProgress = allTasks.filter(t => t.frontmatter.status === "in-progress");
  for (const task of inProgress) {
    const sessionId = task.frontmatter.metadata?.sessionId as string | undefined;
    if (!sessionId) continue;

    const status = await config.executor.getSessionStatus(sessionId);
    if (!status.alive) {
      actions.push({
        type: "stale_heartbeat",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        agent: task.frontmatter.lease?.agent ?? "unknown",
        reason: `Session ${sessionId} no longer alive (last heartbeat: ${status.lastHeartbeatAt ?? "never"})`,
      });
    }
  }
}
```

### Example 4: Integration Test — Dispatch to Completion (Mock Adapter)
```typescript
// tests/integration/gateway-dispatch.test.ts
import { describe, it, expect, beforeEach } from "vitest";

describe("Gateway dispatch integration", () => {
  let store: ITaskStore;
  let logger: EventLogger;
  let adapter: MockAdapter;

  beforeEach(async () => {
    store = new FilesystemTaskStore(tmpDir);
    logger = new EventLogger(join(tmpDir, "events"));
    adapter = new MockAdapter({ completionDelayMs: 50 });
    await store.init();
  });

  it("dispatch-to-completion success", async () => {
    // Create a ready task
    await store.create({ title: "Test task", agent: "test-agent", status: "ready" });
    const tasks = await store.list({ status: "ready" });
    const task = tasks[0];

    // Run poll with adapter
    const config: SchedulerConfig = {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60_000,
      executor: adapter,
    };
    const result = await poll(store, logger, config);

    // Verify dispatch occurred
    expect(result.actions.some(a => a.type === "assign")).toBe(true);

    // Verify correlation ID was set
    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.metadata?.correlationId).toBeDefined();

    // Verify session was spawned
    expect(adapter.spawnedSessions.length).toBe(1);
    expect(adapter.spawnedSessions[0].correlationId).toBe(
      updated?.frontmatter.metadata?.correlationId
    );
  });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `DispatchExecutor` with single `spawn()` method | `GatewayAdapter` with `spawnSession` + `getSessionStatus` + `forceCompleteSession` | Phase 3 (this phase) | Enables session lifecycle tracking and heartbeat-based timeout |
| No correlation IDs | UUID v4 correlation ID per dispatch | Phase 3 (this phase) | End-to-end tracing from dispatch to completion |
| Direct heartbeat file reads in scheduler | Adapter-mediated session status via `getSessionStatus()` | Phase 3 (this phase) | Platform-agnostic session liveness checking |

**Important codebase context:**
- The `OpenClawExecutor` already works — it spawns embedded agents via the gateway's `extensionAPI` (`runEmbeddedPiAgent`) using fire-and-forget. This is NOT being replaced, just wrapped in the new adapter interface.
- Heartbeat infrastructure is complete: `RunHeartbeat` Zod schema, `writeHeartbeat()`, `readHeartbeat()`, `checkStaleHeartbeats()`, and stale heartbeat handling in the poll loop's action executor.
- `acquireLease()` already writes run artifacts including heartbeats as part of the P2.3 resume protocol.
- `startLeaseRenewal()` already renews leases periodically — heartbeat renewal should follow the same pattern.
- The `classifySpawnError()` function already categorizes errors as `permanent`, `transient`, or `rate_limited`.

## Existing Code Inventory

Critical files that will be modified (planner should scope tasks around these):

| File | Current Role | Phase 3 Change |
|------|-------------|----------------|
| `src/dispatch/executor.ts` | Defines `DispatchExecutor` interface, `MockExecutor`, `TaskContext`, `ExecutorResult` | Evolve to `GatewayAdapter` interface with three methods; `MockExecutor` becomes `MockAdapter` |
| `src/dispatch/action-executor.ts` | Executes assign actions: `executeAssignAction()` calls `executor.spawn()` | Add correlation ID generation, use `adapter.spawnSession()`, store correlationId in metadata |
| `src/dispatch/scheduler.ts` | Poll loop with `checkStaleHeartbeats()` | Replace direct heartbeat checks with `adapter.getSessionStatus()` for in-progress tasks |
| `src/openclaw/openclaw-executor.ts` | `OpenClawExecutor` implements `DispatchExecutor.spawn()` | Refactor to `OpenClawAdapter` implementing full `GatewayAdapter` interface |
| `src/openclaw/adapter.ts` | `registerAofPlugin()` wires `OpenClawExecutor` | Wire `OpenClawAdapter` instead; add config-driven adapter selection |
| `src/service/aof-service.ts` | `AOFService` holds executor reference as `SchedulerConfig.executor` | Update type from `DispatchExecutor` to `GatewayAdapter` |
| `src/recovery/run-artifacts.ts` | `checkStaleHeartbeats()`, `readHeartbeat()` | May be used internally by `OpenClawAdapter.getSessionStatus()` |

Files with many test references to `MockExecutor` / `DispatchExecutor`:
- `src/dispatch/__tests__/scheduler.test.ts`
- `src/dispatch/__tests__/aof-dispatch.test.ts`
- `src/dispatch/__tests__/spawn-failure-recovery.test.ts`
- `src/openclaw/__tests__/executor.test.ts`
- `src/openclaw/__tests__/openclaw-executor-http.test.ts`
- `tests/integration/dispatch-pipeline.test.ts`

## Open Questions

1. **How does `OpenClawAdapter.getSessionStatus()` map to real gateway state?**
   - What we know: The current implementation uses local `run_heartbeat.json` files written by `acquireLease()`. The agent updates heartbeats during execution.
   - What's unclear: Whether the gateway extensionAPI exposes any session status query API, or if local heartbeat files are the only mechanism.
   - Recommendation: Use local heartbeat files for now (already works). If the gateway later exposes a session query API, `OpenClawAdapter.getSessionStatus()` can be updated without changing the interface.

2. **How does `OpenClawAdapter.forceCompleteSession()` terminate a running agent?**
   - What we know: The gateway's extensionAPI has `runEmbeddedPiAgent()` but the current `OpenClawExecutor` does not store any handle to cancel a running agent.
   - What's unclear: Whether the extensionAPI exposes an abort/cancel mechanism for running agents.
   - Recommendation: For v1, `forceCompleteSession()` should: (a) mark the run artifact as expired (`markRunArtifactExpired()` already exists), (b) clear the heartbeat file, (c) log a force-complete event. The actual agent process may continue running but the task will be reclaimed. True process termination can be added when the extensionAPI supports it.

3. **Should `SchedulerConfig.executor` type change from `DispatchExecutor` to `GatewayAdapter`?**
   - What we know: `SchedulerConfig.executor` is typed as `DispatchExecutor` and used in ~10 files.
   - What's unclear: Whether a gradual migration (keeping both types temporarily) is worth the complexity.
   - Recommendation: Rename directly. The interface change is additive (two new methods). Tests use `MockExecutor` which will become `MockAdapter` implementing all three methods. A single-commit rename with find-and-replace is cleaner than maintaining two types.

4. **Heartbeat renewal and lease renewal alignment**
   - What we know: `startLeaseRenewal()` renews leases on a timer. `writeHeartbeat()` is called once during `acquireLease()`.
   - What's unclear: Whether heartbeats are currently renewed alongside leases, or only written once at dispatch time.
   - Recommendation: Verify in `lease-manager.ts`. If heartbeats are not renewed alongside leases, add heartbeat renewal to the lease renewal timer. Otherwise the 10-minute heartbeat timeout will always fire for tasks running longer than 10 minutes.

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis of `src/dispatch/executor.ts` — DispatchExecutor interface, MockExecutor, TaskContext, ExecutorResult
- Direct codebase analysis of `src/openclaw/openclaw-executor.ts` — OpenClawExecutor implementation with extensionAPI integration
- Direct codebase analysis of `src/dispatch/action-executor.ts` — executeAssignAction with spawn, lease, and failure handling
- Direct codebase analysis of `src/dispatch/scheduler.ts` — poll loop with stale heartbeat checks, SchedulerConfig
- Direct codebase analysis of `src/recovery/run-artifacts.ts` — RunHeartbeat, writeHeartbeat, readHeartbeat, checkStaleHeartbeats
- Direct codebase analysis of `src/openclaw/adapter.ts` — registerAofPlugin with OpenClawExecutor wiring
- Direct codebase analysis of `src/store/lease.ts` — acquireLease with heartbeat writing
- Direct codebase analysis of `src/schemas/run.ts` — RunHeartbeat Zod schema

### Secondary (MEDIUM confidence)
- CONTEXT.md user decisions — adapter contract, session lifecycle, correlation tracing, integration testing requirements
- Serena project memory `project_overview` — project structure and tech stack confirmation

### Tertiary (LOW confidence)
- OpenClaw extensionAPI capabilities for session abort/cancel — could not verify if API supports termination of running agents (no external docs available)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies, all built on existing codebase patterns
- Architecture: HIGH — adapter pattern is well-understood, existing code provides clear refactoring path
- Pitfalls: HIGH — identified from direct codebase analysis of existing heartbeat, dispatch, and polling code
- Open questions: MEDIUM — gateway extensionAPI abort capabilities unverified, but workaround (artifact expiration) already exists

**Research date:** 2026-02-25
**Valid until:** 2026-03-25 (stable — internal refactoring, no external API dependencies)
