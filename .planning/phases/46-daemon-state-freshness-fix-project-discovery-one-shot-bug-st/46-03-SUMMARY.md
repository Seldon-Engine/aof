---
phase: 46
plan: 03
subsystem: service
tags: [bug-046b, project-discovery, freshness, self-healing, rediscovery]
requires:
  - src/service/aof-service.ts:initializeProjects()  # construction template mirrored
  - src/service/aof-service.ts:pollQueue             # serialization reused, no new lock
  - src/projects/registry.ts:discoverProjects        # already idempotent for _inbox
  - src/store/task-store.ts:FilesystemTaskStore      # constructor + init()
  - src/service/__tests__/multi-project-polling.test.ts  # test scaffolding analog
provides:
  - src/service/aof-service.ts:rediscoverProjects()  # private, idempotent, called per-poll
  - "runPoll() now self-heals projectStores Map every poll cycle"
affects:
  - src/service/aof-service.ts                       # +66 lines, no signature changes
  - src/service/__tests__/bug-046b-project-rediscovery.test.ts  # +274 lines (new)
tech_stack_added: []
tech_stack_patterns:
  - "Diff-against-snapshot rediscovery — one readdir + one readFile per project.yaml"
  - "Reuse of existing pollQueue serialization (no new locks, no fs watcher)"
  - "Idempotent registration via projectStores.has(id) check"
key_files_created:
  - src/service/__tests__/bug-046b-project-rediscovery.test.ts
key_files_modified:
  - src/service/aof-service.ts
decisions:
  - "No fs watcher — per CONTEXT.md, simpler poll-time scan wins until profiling shows otherwise"
  - "No test-only public method on AOFService — cast to access private triggerPoll() in test (less production surface)"
  - "Skip projects with manifest errors (mirrors initializeProjects) — vanished-project removal is unconditional"
  - "Vanished-project in-flight tasks handled by existing reconcileOrphans() — no new cleanup logic"
metrics:
  duration: 3m 25s
  completed: 2026-04-25T15:55:46Z
  commits: 2
---

# Phase 46 Plan 03: Project Discovery Freshness (BUG-046b) Summary

Self-healing project registry — `AOFService.runPoll()` now diffs `<vaultRoot>/Projects/` against `this.projectStores` on every poll cycle, registering newly-created project directories and deregistering vanished ones, all inside the existing `pollQueue` serialization. A project created post-boot becomes live within one poll cycle (default 30s).

## Bug Closed

**BUG-046b — Project discovery freshness** (one-shot frozen registry).

Pre-fix behavior:
- `AOFService.initializeProjects()` ran once at boot, populating `this.projectStores` with a frozen snapshot.
- Every subsequent `poll()` iterated that snapshot.
- A project directory created AFTER boot was invisible until daemon restart.

Field incident (2026-04-24):
- Daemon restarted at 16:43.
- The `event-calendar-2026` project was created at 20:36.
- Zero log entries exist for any of its 5 task IDs over the next 21 minutes.
- The dispatching agent eventually gave up and did the work itself.

Post-fix behavior:
- A project created post-boot is registered on the next `runPoll()` invocation.
- Its tasks dispatch within one poll cycle (default 30s).
- A vanished project is removed from `projectStores`; in-flight tasks surface via existing `reconcileOrphans` on next startup.

## Final Shape of `rediscoverProjects()`

```typescript
private async rediscoverProjects(): Promise<void> {
  if (!this.vaultRoot) return;

  const discovered = await discoverProjects(this.vaultRoot);
  const discoveredIds = new Set(discovered.map((p) => p.id));

  // Add new projects (skip those with manifest errors — same as init).
  for (const project of discovered) {
    if (this.projectStores.has(project.id) || project.error) continue;

    const store = new FilesystemTaskStore(project.path, {
      projectId: project.id,
      hooks: this.createStoreHooks(project.path),
      logger: this.logger,
    });
    await store.init(); // Phase 46 / Plan 02 reconcileDrift runs here too
    this.projectStores.set(project.id, store);
    svcLog.info(
      { projectId: project.id, op: "rediscover" },
      "registered new project",
    );
  }

  // Remove vanished projects. In-flight tasks under a removed project
  // surface during their next per-task operation as "task not found";
  // the lease/orphan reconciliation in reconcileOrphans() handles
  // cleanup. No new lock needed — pollQueue serialization covers the
  // "iterating this.projectStores mid-poll" race.
  for (const id of this.projectStores.keys()) {
    if (!discoveredIds.has(id)) {
      this.projectStores.delete(id);
      svcLog.info(
        { projectId: id, op: "rediscover" },
        "deregistered vanished project",
      );
    }
  }
}
```

## Wiring Insertion Point

`runPoll()` (`src/service/aof-service.ts:450-499`):

```typescript
private async runPoll(): Promise<void> {
  const start = performance.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), this.pollTimeoutMs);

  try {
    // Phase 46 / Bug 2A: catch projects created after boot. Must run
    // inside runPoll() (serialized via pollQueue) so rediscovery
    // happens-before the same invocation's pollAllProjects().
    await this.rediscoverProjects();

    const pollPromise = this.vaultRoot && this.projectStores.size > 0
      ? this.pollAllProjects()
      : this.poller(this.store, this.logger, this.schedulerConfig);
    // ...
```

The `this.projectStores.size > 0` check is evaluated AFTER rediscovery, so a post-init-created first project flips the runtime mode from unscoped-root-poll to multi-project-poll automatically.

## Concurrency Model — Reuse of `pollQueue`

`AOFService` already serializes all polls through `this.pollQueue: Promise<void>`:

```typescript
private async triggerPoll(_reason: string): Promise<void> {
  if (!this.running) return;
  this.pollQueue = this.pollQueue.then(() => this.runPoll());
  return this.pollQueue;
}
```

Because `rediscoverProjects()` runs as the first awaited call inside `runPoll()`:
- It happens-before the same invocation's `pollAllProjects()` (single-threaded JS event loop, awaited sequentially).
- It never overlaps with another poll (chained through pollQueue).
- It cannot race with the per-task lock manager (rediscovery doesn't touch leases).

No new lock, no fs watcher, no debounce timer. Per CONTEXT.md guidance: *"If poll-time scan cost ever shows up in profiling, an fs watcher can be added later as an optimization. Until then, simpler code wins."*

## 21-Minute Silent-Dispatch Scenario — Now Structurally Prevented

| Event | Pre-Phase-46 | Post-Phase-46 |
|---|---|---|
| Daemon boots, `initializeProjects()` runs | `projectStores = {existing-projs}` snapshot | Same |
| User creates `event-calendar-2026/` project directory | Filesystem only — daemon unaware | Filesystem only — daemon unaware |
| Agent dispatches task into the new project | Task file written to `Projects/event-calendar-2026/tasks/ready/` | Same |
| Next `runPoll()` fires (30s default) | Iterates frozen `projectStores` Map → new project not present → task invisible | `rediscoverProjects()` runs first → registers new project → `pollAllProjects()` includes it → task dispatches |
| Time-to-dispatch | **Until daemon restart** (21 min in the field; could be hours/days) | **≤ pollIntervalMs** (default 30s) |
| Forensics on the silent failure | Zero log entries for the task IDs | One `info` log per registration: `op: "rediscover"`, `msg: "registered new project"` |

The pollQueue ordering means a project created mid-poll-cycle is picked up by the *next* poll, not the in-flight one — no race window where rediscovery sees the new directory but `pollAllProjects` missed it. Test case 3 (`rediscovery + pollAllProjects share pollQueue serialization`) exercises this invariant directly.

## Test Coverage

`src/service/__tests__/bug-046b-project-rediscovery.test.ts` — 3 cases, all GREEN:

1. **"a project created after init() is polled on the next runPoll()"** — primary invariant. Boots service with `initial-proj`, creates `post-init-proj` after `service.start()` returns, drops a task into it, calls `triggerPoll` once. Asserts the task was spawned with `projectId === "post-init-proj"`. RED before the fix; GREEN after.

2. **"a vanished project is removed from projectStores"** — boots with two projects, drops a task into `proj-b`, then `rm -rf` the `proj-b` directory before triggering the next poll. Asserts no spawn for `projectId: "proj-b"`. Indirect assertion (Store I/O is broken once the directory is gone) but proves no regression.

3. **"rediscovery + pollAllProjects share pollQueue serialization"** — first triggerPoll observes one project; a second project + task are created between the two triggerPoll calls; second triggerPoll deterministically picks them up. Proves the pollQueue ordering invariant. RED before the fix; GREEN after.

## Verification

| Check | Result |
|---|---|
| `bug-046b-project-rediscovery.test.ts` | 3/3 PASS |
| `multi-project-polling.test.ts` (regression canary) | 6/6 PASS |
| `aof-service.test.ts` (regression canary) | 18/18 PASS |
| `src/projects/__tests__/` (registry behavior unchanged) | 74/74 PASS |
| `npm run typecheck` | clean |
| `npx madge --circular --extensions ts src/` | "No circular dependency found!" |

## Threat Surface Scan

No new threat surface. Rediscovery walks `<vaultRoot>/Projects/` only — same boundary as the existing `discoverProjects()` call inside `initializeProjects()`. STRIDE register entries T-46-03-01 through T-46-03-04 from PLAN.md remain accurate; no new mitigations required.

## Deviations from Plan

None — plan executed exactly as written.

The plan suggested an optional `__triggerPollForTests` escape-hatch method on `AOFService` if `triggerPoll` was inaccessible. We instead used a `(service as any).triggerPoll("test")` cast in the test file — keeps the production surface minimal and is acceptable since the test file is the only consumer.

## Commits

| Hash | Type | Description |
|---|---|---|
| 46757d6 | test | RED — integration test for post-init project rediscovery |
| 769c4bf | fix | GREEN — `rediscoverProjects()` + wire into `runPoll()` |

## TDD Gate Compliance

- RED gate: `test(46-03)` commit `46757d6` — 2 of 3 cases failed before the fix (cases 1 and 3, the primary invariants).
- GREEN gate: `fix(46-03)` commit `769c4bf` — all 3 cases pass.
- REFACTOR gate: not needed; code is already minimal.

## Self-Check: PASSED

- [x] `src/service/__tests__/bug-046b-project-rediscovery.test.ts` exists
- [x] `src/service/aof-service.ts` contains `private async rediscoverProjects(): Promise<void>` (line 304)
- [x] `runPoll()` calls `await this.rediscoverProjects();` BEFORE `this.pollAllProjects()` (lines 459 < 462)
- [x] `rediscoverProjects` body contains `if (this.projectStores.has(project.id) || project.error) continue;`
- [x] `rediscoverProjects` body contains `this.projectStores.delete` (vanished-project removal)
- [x] No `fs.watch` or `chokidar` references introduced
- [x] Commits `46757d6` and `769c4bf` exist in `git log --oneline`
- [x] Bug-046b regression file uses TestExecutor + createProject pattern from multi-project-polling.test.ts
- [x] All acceptance criteria from PLAN.md Task 1 + Task 2 satisfied
