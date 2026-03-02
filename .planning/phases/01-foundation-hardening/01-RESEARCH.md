# Phase 1: Foundation Hardening - Research

**Researched:** 2026-02-25
**Domain:** Scheduler lifecycle reliability, crash recovery, failure taxonomy
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Default poll timeout: 30 seconds (configurable)
- On timeout: cancel the hanging promise, log a warning, start next poll cycle
- Any half-finished transitions are rolled back or retried next cycle
- Per-task transition timeouts in addition to the global poll timeout (e.g. 10s per task so one slow task doesn't burn the whole poll budget)
- Timeout events emitted through the existing event system (e.g. `poll.timeout`) plus warning log -- health endpoint and future alerting can react
- Drain timeout: 10 seconds after receiving stop signal
- On stop signal: stop the poll loop immediately, no new polls, only finish transitions already started
- If tasks still in-flight when drain timeout expires: force exit, leave tasks in current state -- the startup reconciler (FOUND-03) reclaims them on next boot
- Countdown progress logs during drain (e.g. "3 tasks still draining...", "1 task remaining...")
- Immediate reclaim on startup -- no cooldown delay
- Build on existing lease/ownership pattern already in the codebase
- Orphaned tasks reset to their previous state (e.g. if mid-transition from `ready` to `dispatched`, reset to `ready`). Next poll cycle picks them up naturally.
- Note: "orphaned" in Phase 1 means interrupted state transitions, not long-running dispatched work
- Startup reconciler logs each reclaimed task individually (ID, previous state, what happened) plus a summary line
- Unknown/unexpected errors default to transient (retry with backoff)
- Rate limit errors: transient (retry with backoff)
- Missing agent errors: permanent (dead-letter immediately)
- Max retry attempts: 3 (original + 2 retries) before dead-lettering
- Backoff strategy: exponential with jitter (prevents thundering herd)
- Dead-letter events emitted (`task.deadlettered`) with task ID, error history, and attempt count
- Full failure chain logged on dead-letter

### Claude's Discretion
- Exact per-task timeout value (suggested ~10s but Claude can adjust based on codebase)
- Backoff base interval and jitter range
- How existing lease pattern is extended for the timeout guard
- Internal data structures for retry tracking

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| FOUND-01 | Scheduler poll loop has configurable timeout guard preventing infinite hangs | `AbortController` + `Promise.race` pattern on `poll()` in `aof-service.ts`. See Architecture Pattern 1. Existing `poll()` is a single async function returning `PollResult` -- wrap with timeout guard in `runPoll()`. |
| FOUND-02 | Daemon performs graceful drain on shutdown, completing in-flight task transitions | Signal handlers in `daemon.ts` currently call `process.exit(0)` immediately. Replace with drain protocol in `AOFService.stop()`. See Architecture Pattern 2. |
| FOUND-03 | On startup, scheduler reconciles orphaned leases and reclaims abandoned tasks | Existing `expireLeases()` in `store/lease.ts` handles expired leases. New `reconcileOnStartup()` function in service layer scans for in-progress tasks without active leases. See Architecture Pattern 3. |
| FOUND-04 | Failures classified as transient (retry with backoff) vs permanent (deadletter immediately) | `classifySpawnError()` and `shouldAllowSpawnFailedRequeue()` already exist in `scheduler-helpers.ts`. Gap: no rate-limit classification, no jitter, backoff base is 60s not configurable. See Architecture Pattern 4. |
</phase_requirements>

## Summary

Phase 1 targets the reliability foundation of AOF's scheduler: timeout guards, graceful shutdown, crash recovery, and failure classification. The codebase already has substantial infrastructure -- lease management, failure tracking, dead-lettering, and exponential backoff -- so this phase is primarily about closing specific gaps rather than building from scratch.

The four requirements map cleanly to four modification areas: (1) wrapping the poll cycle with `AbortController`-based timeouts in `AOFService.runPoll()`, (2) replacing the daemon's immediate-exit signal handlers with a drain protocol that awaits in-flight work, (3) adding a startup reconciliation step that reclaims orphaned tasks before the first poll, and (4) extending the existing `classifySpawnError()` with rate-limit patterns and adding jitter to the backoff calculation.

**Primary recommendation:** Implement changes within the existing module structure (`aof-service.ts`, `daemon.ts`, `scheduler-helpers.ts`) rather than introducing new files. The codebase's patterns are well-established and the existing test infrastructure (vitest, `FilesystemTaskStore` in tmpdir, `MockExecutor`) supports fast verification.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js built-in `AbortController` | Node 22+ | Timeout cancellation for poll promises | Native API, no dependency, works with `Promise.race` |
| `write-file-atomic` | ^7.0.0 | Atomic file writes for state transitions | Already used throughout -- prevents half-written state on crash |
| `vitest` | ^3.0.0 | Test runner | Already the project's test framework with solid coverage |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Node.js `timers/promises` | Node 22+ | `setTimeout` as promise for drain countdown | Only for drain timeout implementation |
| Node.js `events` | Node 22+ | EventEmitter for drain coordination | If service needs to signal poll completion to daemon |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `AbortController` for timeout | `p-timeout` npm package | Extra dependency; `AbortController` is native and sufficient for this use case |
| Manual jitter calculation | `cockatiel` circuit breaker | Cockatiel is planned for Phase 4 (HEAL-03); premature to add now for simple jitter |
| Custom drain logic | `stoppable` npm package | Designed for HTTP servers, not polling loops; custom drain is simpler and more precise |

**Installation:**
No new dependencies required. All patterns use Node.js built-ins and existing project dependencies.

## Architecture Patterns

### Recommended Change Structure
```
src/
├── service/
│   └── aof-service.ts      # FOUND-01: timeout guard in runPoll()
│                            # FOUND-02: drain protocol in stop()
│                            # FOUND-03: reconcileOnStartup() in start()
├── daemon/
│   └── daemon.ts            # FOUND-02: signal handlers call service.stop() with drain
│   └── index.ts             # FOUND-02: signal handlers delegate to daemon.ts
├── dispatch/
│   └── scheduler-helpers.ts # FOUND-04: rate-limit classification, jitter
│   └── scheduler.ts         # FOUND-01: per-task timeout support (if needed)
└── store/
    └── lease.ts             # FOUND-03: reconciliation query helper
```

### Pattern 1: Poll Timeout Guard (FOUND-01)

**What:** Wrap the poll call with `AbortController` + `Promise.race` to enforce a configurable timeout on each poll cycle.

**Where:** `AOFService.runPoll()` (lines 212-238 of `aof-service.ts`)

**Current behavior:** `runPoll()` calls `this.poller(store, logger, config)` with no timeout. If `poll()` hangs (e.g., filesystem I/O freeze, deadlocked promise), the scheduler stops processing forever.

**Design:**
```typescript
// In AOFService constructor: add pollTimeoutMs config
private readonly pollTimeoutMs: number;

// In runPoll():
private async runPoll(): Promise<void> {
  const start = performance.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), this.pollTimeoutMs);

  try {
    const result = await Promise.race([
      this.poller(this.store, this.logger, this.schedulerConfig),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new Error(`Poll timeout after ${this.pollTimeoutMs}ms`));
        });
      }),
    ]);
    // ... existing success handling ...
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("Poll timeout")) {
      // Log timeout event through existing event system
      await this.logger.log("poll.timeout", "scheduler", {
        payload: { timeoutMs: this.pollTimeoutMs, durationMs: performance.now() - start },
      });
      console.warn(`[AOF] Poll timed out after ${this.pollTimeoutMs}ms — skipping to next cycle`);
    }
    this.lastError = message;
  } finally {
    clearTimeout(timeoutId);
    this.lastPollDurationMs = Math.round(performance.now() - start);
  }
}
```

**Per-task timeout:** The current `poll()` function processes tasks sequentially within a single async call. Per-task timeouts can be implemented at the `executeActions()` level -- wrapping each action execution with its own `AbortController`. The suggested 10s per-task timeout is reasonable given that individual task transitions involve filesystem I/O (typically <100ms) plus optional executor spawn (~30s with its own timeout). A 10s per-action timeout provides safety without interfering with the existing 30s spawn timeout. The per-task timeout should abort the current task's action and allow the loop to continue with the next action.

**Config addition to `SchedulerConfig`:**
```typescript
/** Maximum time for a single poll cycle in ms (default: 30_000). */
pollTimeoutMs?: number;
/** Maximum time for a single task action in ms (default: 10_000). */
taskActionTimeoutMs?: number;
```

**Confidence:** HIGH -- `AbortController` and `Promise.race` are standard Node.js patterns. The poll function is a pure async function that returns a promise, making it straightforward to race against a timeout.

### Pattern 2: Graceful Drain Protocol (FOUND-02)

**What:** On stop signal, stop the poll loop and wait for any in-flight poll to complete, with a 10s deadline.

**Current behavior:**
- `daemon.ts` SIGTERM/SIGINT handlers delete the PID file and call `process.exit(0)` immediately
- `daemon/index.ts` calls `service.stop()` which just clears the interval timer
- `AOFService.stop()` sets `running = false` and clears `pollTimer`
- No waiting for in-flight polls. If a poll is mid-execution during SIGTERM, it's abandoned.

**Design:**

The key insight is that `AOFService` already has a `pollQueue` promise chain. The drain protocol needs to:
1. Stop scheduling new polls (clear the interval)
2. Wait for `pollQueue` to settle (in-flight poll completes)
3. Enforce a 10s deadline

```typescript
// In AOFService:
async stop(): Promise<void> {
  if (!this.running) return;
  this.running = false;

  // 1. Stop scheduling new polls
  if (this.pollTimer) clearInterval(this.pollTimer);
  this.pollTimer = undefined;

  // 2. Wait for in-flight poll with drain timeout
  const drainTimeoutMs = 10_000;
  const drainStart = Date.now();

  // Log drain start
  console.info("[AOF] Drain started — waiting for in-flight transitions...");
  await this.logger.logSystem("system.shutdown", {
    drainTimeoutMs,
    reason: "stop_signal",
  });

  try {
    await Promise.race([
      this.pollQueue,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("drain_timeout")), drainTimeoutMs)
      ),
    ]);
    console.info(`[AOF] Drain complete — all transitions finished (${Date.now() - drainStart}ms)`);
  } catch (err) {
    if ((err as Error).message === "drain_timeout") {
      console.warn(`[AOF] Drain timeout after ${drainTimeoutMs}ms — forcing exit`);
      console.warn("[AOF] Orphaned tasks will be reclaimed on next startup");
    } else {
      console.error(`[AOF] Drain error: ${(err as Error).message}`);
    }
  }
}
```

**Signal handler updates in `daemon.ts`:**
```typescript
// Replace immediate process.exit with drain-aware shutdown
process.on("SIGTERM", async () => {
  await service.stop(); // Now includes drain
  if (existsSync(lockFile)) unlinkSync(lockFile);
  process.exit(0);
});
```

**Countdown progress:** During drain, the poll itself logs progress. For additional visibility, the drain can poll the service status:

```typescript
// Optional: countdown logging during drain wait
const countdownTimer = setInterval(() => {
  const elapsed = Math.round((Date.now() - drainStart) / 1000);
  const remaining = Math.round((drainTimeoutMs - (Date.now() - drainStart)) / 1000);
  console.info(`[AOF] Drain in progress... ${remaining}s remaining`);
}, 2000);
// Clear in finally block
```

**Confidence:** HIGH -- `pollQueue` is already a sequential promise chain. Racing it against a timeout is a well-understood pattern. The drain timeout value of 10s is generous for filesystem-only transitions.

### Pattern 3: Startup Reconciliation (FOUND-03)

**What:** On startup, before the first poll, scan for tasks that were mid-transition during a crash (SIGKILL) and reclaim them.

**Current behavior:**
- `AOFService.start()` calls `store.init()` then `triggerPoll("startup")` -- the first poll already handles expired leases via `checkExpiredLeases()`, but this only catches leases that have actually expired (time-based)
- After a hard kill, tasks may be in `in-progress` with no process running to renew leases, but the lease TTL may not have elapsed yet (default 10min)
- The decision says "immediate reclaim" -- no waiting for lease expiry

**Design:**

Add a `reconcileOrphans()` method to `AOFService` called during `start()`:

```typescript
// In AOFService.start():
async start(): Promise<void> {
  if (this.running) return;
  await this.store.init();

  // Reconcile orphaned tasks from prior crash
  await this.reconcileOrphans();

  this.running = true;
  await this.logger.logSystem("system.startup");
  await this.triggerPoll("startup");
  // ... existing interval setup ...
}

private async reconcileOrphans(): Promise<void> {
  const inProgress = await this.store.list({ status: "in-progress" });
  let reclaimed = 0;

  for (const task of inProgress) {
    const lease = task.frontmatter.lease;

    // If lease holder process is dead, reclaim immediately
    // "Orphaned" = has a lease but no process to service it
    // Phase 1 scope: interrupted state transitions only
    // We can detect this by checking if the lease's agent process is running,
    // but simpler: on startup, ALL in-progress tasks are orphaned
    // (because the daemon that owned them just restarted)

    // Reset to previous state (ready) for next poll cycle
    task.frontmatter.lease = undefined;
    await this.store.transition(task.frontmatter.id, "ready", {
      reason: "startup_reconciliation",
    });

    console.info(
      `[AOF] Reclaimed orphaned task ${task.frontmatter.id} ` +
      `(was in-progress, leased to ${lease?.agent ?? "unknown"}) → ready`
    );

    await this.logger.log("task.reclaimed", "system", {
      taskId: task.frontmatter.id,
      payload: {
        previousStatus: "in-progress",
        previousAgent: lease?.agent,
        reason: "startup_reconciliation",
      },
    });

    reclaimed++;
  }

  if (reclaimed > 0) {
    console.info(`[AOF] Startup reconciliation: ${reclaimed} task(s) reclaimed`);
    await this.logger.logSystem("system.recovery", {
      tasksReclaimed: reclaimed,
      reason: "startup_reconciliation",
    });
  } else {
    console.info("[AOF] Startup reconciliation: no orphaned tasks found");
  }
}
```

**Important nuance:** The decision specifies "orphaned in Phase 1 means interrupted state transitions, not long-running dispatched work." This means we reclaim tasks that were mid-transition (the scheduler was processing them) but NOT tasks that were successfully dispatched to an agent and running. However, on daemon restart, we cannot distinguish these cases reliably -- the daemon process is the one holding all leases. The safest approach is:
1. Reclaim all in-progress tasks to ready (the decision says reset to previous state)
2. The next poll cycle will re-evaluate and re-dispatch them
3. Long-running dispatched work is Phase 3/4 scope

**Confidence:** HIGH -- the existing `expireLeases()` provides the pattern. The new code is a simpler version that doesn't check time-based expiry, just assumes all in-progress tasks are orphaned after restart.

### Pattern 4: Failure Taxonomy Enhancement (FOUND-04)

**What:** Extend error classification to distinguish rate-limit errors, add jitter to backoff.

**Current state (already implemented):**
- `classifySpawnError()` in `scheduler-helpers.ts` classifies errors as "transient" or "permanent"
- Permanent patterns: "agent not found", "agent_not_found", "no such agent", "agent deregistered", "permission denied", "forbidden", "unauthorized"
- `shouldAllowSpawnFailedRequeue()` enforces max retries (3) and exponential backoff
- `computeRetryBackoffMs()` uses `min(60s * 3^retryCount, 15min)` -- no jitter
- `transitionToDeadletter()` in `failure-tracker.ts` handles dead-lettering
- Dead-letter events logged with `task.deadletter` type

**Gaps to close:**
1. Rate-limit errors not explicitly classified (they fall through to "transient" which is correct, but should be explicitly recognized for future observability)
2. No jitter in backoff -- risk of thundering herd when multiple tasks retry simultaneously
3. Backoff base interval (60s) is hardcoded, not configurable
4. Dead-letter event type is `task.deadletter` but decision says `task.deadlettered` -- minor naming gap
5. Failure chain not logged on dead-letter (individual failures tracked but full chain not assembled)

**Design for jitter:**
```typescript
// Enhanced computeRetryBackoffMs with jitter
export function computeRetryBackoffMs(retryCount: number, opts?: {
  baseMs?: number;
  ceilingMs?: number;
  jitterFactor?: number; // 0-1, proportion of delay to randomize
}): number {
  const baseMs = opts?.baseMs ?? 60_000;
  const ceilingMs = opts?.ceilingMs ?? 15 * 60_000;
  const jitterFactor = opts?.jitterFactor ?? 0.25;

  const delay = Math.min(baseMs * Math.pow(3, retryCount), ceilingMs);
  const jitter = delay * jitterFactor * (Math.random() * 2 - 1); // +/- jitterFactor
  return Math.max(0, Math.round(delay + jitter));
}
```

**Design for rate-limit classification:**
```typescript
// Add to PERMANENT_ERROR_PATTERNS in scheduler-helpers.ts:
// (No change -- rate limits are transient, which is the default)

// Add explicit RATE_LIMIT_PATTERNS for observability:
const RATE_LIMIT_PATTERNS = [
  "rate limit",
  "rate_limit",
  "too many requests",
  "429",
  "throttled",
  "quota exceeded",
];

export function classifySpawnError(error: string): "transient" | "permanent" | "rate_limited" {
  const lower = error.toLowerCase();
  for (const pattern of PERMANENT_ERROR_PATTERNS) {
    if (lower.includes(pattern)) return "permanent";
  }
  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (lower.includes(pattern)) return "rate_limited";
  }
  return "transient";
}
```

Note: `rate_limited` is treated the same as `transient` for retry logic, but enables separate event logging and future circuit-breaker integration (Phase 4).

**Design for failure chain logging:**
```typescript
// In transitionToDeadletter, assemble and log the full failure chain:
export async function transitionToDeadletter(
  store: ITaskStore,
  eventLogger: EventLogger,
  taskId: string,
  lastFailureReason: string,
): Promise<void> {
  const task = await store.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const failureCount = (task.frontmatter.metadata.dispatchFailures as number | undefined) ?? 0;
  const retryCount = (task.frontmatter.metadata.retryCount as number | undefined) ?? 0;
  const errorClass = task.frontmatter.metadata.errorClass as string | undefined;
  const agent = task.frontmatter.routing?.agent;

  await store.transition(taskId, "deadletter");

  // Emit dead-letter event with full failure chain
  await eventLogger.log("task.deadlettered", "system", {
    taskId,
    payload: {
      reason: errorClass === "permanent" ? "permanent_error" : "max_dispatch_failures",
      failureCount,
      retryCount,
      lastFailureReason,
      errorClass,
      agent,
      // Full chain from metadata
      failureHistory: {
        dispatchFailures: failureCount,
        retryCount,
        lastError: task.frontmatter.metadata.lastError,
        lastBlockedAt: task.frontmatter.metadata.lastBlockedAt,
        lastDispatchFailureAt: task.frontmatter.metadata.lastDispatchFailureAt,
      },
    },
  });

  // Console alerting (existing pattern)
  console.error(`[AOF] DEADLETTER: Task ${taskId} (${task.frontmatter.title})`);
  console.error(`[AOF] DEADLETTER:   Failure count: ${failureCount}, Retries: ${retryCount}`);
  console.error(`[AOF] DEADLETTER:   Error class: ${errorClass ?? "unknown"}`);
  console.error(`[AOF] DEADLETTER:   Last failure: ${lastFailureReason}`);
  console.error(`[AOF] DEADLETTER:   Agent: ${agent ?? "unassigned"}`);
}
```

**Confidence:** HIGH -- extends existing, well-tested patterns. The error classification and backoff logic are already implemented; changes are additive (jitter, rate-limit recognition, fuller logging).

### Anti-Patterns to Avoid
- **Aborting mid-filesystem-write:** The timeout guard must NOT abort a `write-file-atomic` call mid-operation. `write-file-atomic` uses temp-file-then-rename, which is atomic at the OS level. The timeout should abort at the poll level, not at the individual I/O level. Any in-flight atomic writes will complete (or fail atomically) regardless of the timeout.
- **Draining with new polls:** During drain, `this.running` must be `false` before awaiting `pollQueue`. The existing `triggerPoll()` already checks `if (!this.running) return;` so this is safe.
- **Reclaiming tasks that aren't orphaned:** In multi-project mode, `reconcileOrphans` must iterate all project stores, not just the primary one. The `pollAllProjects()` pattern shows how to iterate.
- **Breaking the poll queue chain:** `pollQueue` is a sequential chain (`this.pollQueue = this.pollQueue.then(...)`). The timeout must NOT break this chain -- it should race the current poll promise, not replace the queue.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic file writes | Custom rename-after-write | `write-file-atomic` (already used) | Handles edge cases (permissions, cross-device, Windows) |
| Promise timeout | Custom timer tracking | `AbortController` + `Promise.race` | Native, no dependencies, cancellation-aware |
| Process signal handling | Custom signal multiplexer | Node.js `process.on("SIGTERM")` | Already used; keep it simple |
| Exponential backoff with jitter | Full retry library | Simple math in `computeRetryBackoffMs` | Only need delay calculation, not retry orchestration |

**Key insight:** The existing codebase already uses the right primitives (`write-file-atomic`, filesystem-based state, lease patterns). Phase 1 work is about composing these primitives into more robust lifecycle patterns, not replacing them.

## Common Pitfalls

### Pitfall 1: Timeout Doesn't Actually Cancel Work
**What goes wrong:** `Promise.race` resolves/rejects when the timeout fires, but the original poll promise continues executing in the background. If the next poll starts while the previous one is still running, you get concurrent filesystem mutations.
**Why it happens:** `Promise.race` doesn't abort the losing promise -- it just ignores its result.
**How to avoid:** Use `this.running` flag as a guard. When timeout fires, set a `pollAborted` flag that `executeActions()` checks before each action. The poll will naturally short-circuit. Also, the `pollQueue` serialization already prevents concurrent polls.
**Warning signs:** Two `scheduler.poll` events logged with overlapping timestamps.

### Pitfall 2: Drain Deadlock
**What goes wrong:** The drain waits for `pollQueue`, but the poll is itself waiting for something that depends on the daemon being alive (circular dependency).
**Why it happens:** If poll() calls external services that expect the daemon health endpoint to be alive.
**How to avoid:** Keep the health server alive during drain (shut it down after `pollQueue` settles). The existing health server is independent of the poll loop.
**Warning signs:** Daemon hangs on SIGTERM, never exits.

### Pitfall 3: Orphan Reclaim Races with Active Agents
**What goes wrong:** After a daemon restart, reclaim sets tasks back to "ready." If an agent from the previous session is still running (e.g., the daemon crashed but agents survived), the agent may still be writing results for a task that's been reclaimed and re-dispatched.
**Why it happens:** Phase 1 scope is scheduler transitions only, not long-running dispatched work. But agent sessions spawned before the crash may still be alive.
**How to avoid:** This is explicitly out of Phase 1 scope (the decision doc says "orphaned in Phase 1 means interrupted state transitions, not long-running dispatched work"). Document this as a known limitation for Phase 3/4 to address with session tracking.
**Warning signs:** Duplicate completion reports for the same task.

### Pitfall 4: Jitter Breaks Test Determinism
**What goes wrong:** Adding `Math.random()` to backoff makes tests flaky because delay values are unpredictable.
**Why it happens:** Random jitter produces different values each test run.
**How to avoid:** Accept a `jitterFn` parameter in backoff calculation that defaults to `Math.random()` but can be replaced with a deterministic function in tests.
**Warning signs:** `computeRetryBackoffMs` tests pass sometimes, fail others.

### Pitfall 5: Event Type Mismatch
**What goes wrong:** Code emits `task.deadletter` but consumer listens for `task.deadlettered` (or vice versa). Events silently drop.
**Why it happens:** The existing code uses `task.deadletter`; the CONTEXT.md decision says `task.deadlettered`. The `EventType` schema in `schemas/event.ts` must accept whichever is chosen.
**How to avoid:** Pick one name (`task.deadlettered` per the decision), update the `EventType` enum, and update all emission sites.
**Warning signs:** Dead-letter events not appearing in event queries.

## Code Examples

### Timeout Guard Integration Point
```typescript
// Source: aof-service.ts lines 212-238 (current runPoll)
// This is the exact method that needs modification for FOUND-01

private async runPoll(): Promise<void> {
  const start = performance.now();
  try {
    let result: PollResult;

    if (this.vaultRoot && this.projectStores.size > 0) {
      result = await this.pollAllProjects();
    } else {
      result = await this.poller(this.store, this.logger, this.schedulerConfig);
    }

    this.lastPollResult = result;
    this.lastPollAt = new Date().toISOString();
    this.lastError = undefined;
    // ... metrics ...
  } catch (err) {
    // Currently only catches runtime errors, not timeouts
    const message = (err as Error).message;
    this.lastError = message;
    // ... metrics ...
  } finally {
    this.lastPollDurationMs = Math.round(performance.now() - start);
  }
}
```

### Signal Handler Integration Point
```typescript
// Source: daemon.ts lines 84-96 (current signal handlers)
// These need to be replaced with drain-aware versions

// CURRENT (immediate exit):
process.on("SIGTERM", () => {
  if (existsSync(lockFile)) unlinkSync(lockFile);
  process.exit(0);
});

// NEEDED (drain-aware):
process.on("SIGTERM", async () => {
  await service.stop(); // stop() now includes drain
  if (existsSync(lockFile)) unlinkSync(lockFile);
  process.exit(0);
});
```

### Existing Backoff Calculation
```typescript
// Source: scheduler-helpers.ts lines 161-165
// Current implementation (no jitter)
export function computeRetryBackoffMs(retryCount: number): number {
  const baseMs = 60_000; // 1 minute
  const ceilingMs = 15 * 60_000; // 15 minutes
  return Math.min(baseMs * Math.pow(3, retryCount), ceilingMs);
}
// Produces: 60s, 180s, 540s, 900s (cap)
```

### Existing Error Classification
```typescript
// Source: scheduler-helpers.ts lines 133-154
// Current permanent error patterns -- rate limit patterns need to be added
const PERMANENT_ERROR_PATTERNS = [
  "agent not found",
  "agent_not_found",
  "no such agent",
  "agent deregistered",
  "permission denied",
  "forbidden",
  "unauthorized",
];
```

### Existing Failure Tracker
```typescript
// Source: failure-tracker.ts (full file)
// Already handles: tracking dispatch failures, deadletter transitions, reset
// Gap: event type is "task.deadletter" (should be "task.deadlettered"),
//      no failure chain assembly in dead-letter event payload
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No poll timeout | Poll can hang indefinitely | Current state | FOUND-01 fixes this |
| Immediate process.exit on signal | Planned: drain protocol | This phase | FOUND-02 adds this |
| Lease-based expiry only | Planned: startup reconciliation | This phase | FOUND-03 adds this |
| Binary transient/permanent | Planned: transient/permanent/rate_limited | This phase | FOUND-04 extends this |
| Fixed exponential backoff | Planned: exponential + jitter | This phase | FOUND-04 adds jitter |

**Already implemented (not deprecated):**
- `write-file-atomic` for atomic state transitions -- correct pattern, keep using
- Lease management in `store/lease.ts` -- solid foundation, extend don't replace
- `classifySpawnError` and `shouldAllowSpawnFailedRequeue` -- working, extend for rate limits
- `EventLogger` JSONL logging -- append-only, correct pattern
- `MockExecutor` for testing -- useful for FOUND-01/02/04 tests

## Open Questions

1. **Per-task timeout vs per-action timeout**
   - What we know: The decision says "per-task transition timeouts in addition to the global poll timeout." The poll function processes actions sequentially in `executeActions()`.
   - What's unclear: Should the timeout wrap each call inside the `for (const action of actions)` loop, or should it wrap the entire `executeActions()` call? Per-action is more granular but adds complexity.
   - Recommendation: Per-action timeout in `executeActions()`. Wrap each `switch` case body with its own `Promise.race` timeout. This matches the decision's "per-task" language (each action corresponds to a task transition). Suggested value: 10s per the decision.

2. **Multi-project reconciliation on startup**
   - What we know: `AOFService` supports multi-project mode via `vaultRoot` and `projectStores`.
   - What's unclear: Should `reconcileOrphans()` iterate all project stores?
   - Recommendation: Yes. Follow the same pattern as `pollAllProjects()` -- iterate `this.projectStores` and reconcile each.

3. **Event type name: `task.deadletter` vs `task.deadlettered`**
   - What we know: Existing code uses `task.deadletter`. Decision says `task.deadlettered`.
   - What's unclear: Is the `EventType` enum strict (would adding a new type require schema changes)?
   - Recommendation: Check `schemas/event.ts` for the `EventType` definition. Use `task.deadlettered` per the decision. If the enum is strict, add it. Maintain backward compatibility by accepting both in queries.

## Sources

### Primary (HIGH confidence)
- AOF source code: `src/dispatch/scheduler.ts`, `src/service/aof-service.ts`, `src/daemon/daemon.ts`, `src/store/lease.ts`, `src/dispatch/scheduler-helpers.ts`, `src/dispatch/failure-tracker.ts` -- directly read and analyzed
- AOF test suite: `src/dispatch/__tests__/spawn-failure-recovery.test.ts`, `src/dispatch/__tests__/scheduler.test.ts`, `src/service/__tests__/aof-service.test.ts` -- confirms testing patterns
- Node.js `AbortController` docs -- native API for promise cancellation (stable since Node 16)

### Secondary (MEDIUM confidence)
- `write-file-atomic` npm behavior -- temp-file-then-rename pattern (verified by usage throughout codebase)
- vitest configuration -- `vitest.config.ts` read directly

### Tertiary (LOW confidence)
- None -- all findings are from direct codebase analysis

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies needed, all patterns use existing codebase primitives
- Architecture: HIGH -- changes are localized to known files with clear integration points
- Pitfalls: HIGH -- identified from direct code reading, not hypothetical

**Research date:** 2026-02-25
**Valid until:** 2026-03-25 (stable domain, no external dependency version concerns)
