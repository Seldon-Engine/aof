# Phase 46: Daemon state freshness — Context

**Gathered:** 2026-04-24
**Status:** Ready for planning
**Source:** Direct authoring from debug investigation (`.planning/debug/2026-04-24-daemon-state-and-resource-hygiene.md`) + user decisions in conversation

<domain>
## Phase Boundary

Phase 46 fixes **Tier A** of a bug cluster identified across two
incidents on 2026-04-24:

- **Incident 1** (spin-loop + 172 MB log): the daemon kept evaluating
  ghost tasks because `frontmatter.status` and on-disk directory location
  drifted out of sync, with no reconciliation cycle to catch it. Logs
  grew unbounded.
- **Incident 2** (growth-lead silent dispatch): a project created
  *after* daemon startup was invisible to the scheduler — `discoverProjects`
  is one-shot at boot, and the project-store map is a frozen snapshot.
  Plus 5 tasks accepted into `ready/` with no routing target,
  guaranteeing they would never dispatch even if the project had been
  visible.

Phase 46 does these things and only these things:

1. Project discovery rediscovers on each scheduler poll so newly-created
   projects become live without a daemon restart.
2. `transitionToDeadletter` (and any analogous transition path) becomes
   atomic, AND a startup reconciliation pass walks every status
   directory and corrects files whose `frontmatter.status` doesn't match
   their location.
3. Bundled log rotation via `pino-roll` (50 MB per file, 5 files
   retained, gzip on rotation).
4. `aof_task_create` rejects tasks with no routing target at creation
   time, with optional defaulting from project owner. The calling
   agent's identity is captured into `createdBy`.

**Out of scope for Phase 46** (held for Phase 47, per user direction):

- Per-poll log verbosity reduction (Bug 1D)
- Auth-precondition fail-fast (Bug 1E)

**Out of scope entirely** (per user direction):

- Project-manifest / `.aofignore` opt-out for bug-repro fixtures
  (handle via test hygiene, not config layer)
- Wake-up subscription TTL (defer, avoid added complexity)

</domain>

<decisions>
## Implementation Decisions (LOCKED)

### Bug 2A — Project discovery freshness

**Decision:** Rediscover projects on every scheduler poll. Do NOT add
an fs watcher.

**Rationale:** `discoverProjects(vaultRoot)` is a directory scan —
microseconds even with dozens of projects. Adding an fs watcher is
more code, more state, more failure modes. If poll-time scan cost ever
shows up in profiling, an fs watcher can be added later as an
optimization. Until then, simpler code wins.

**Mechanic:** Inside `AOFService.poll()` (or its caller chain in
`src/service/aof-service.ts`), call `discoverProjects(this.vaultRoot)`,
diff against the current `this.projectStores` Map:
- New project found → construct `FilesystemTaskStore`, run `init()`,
  add to map.
- Existing project still present → no-op.
- Project no longer present → remove from map (handle in-flight tasks
  gracefully — likely already covered by the lease/reconciliation
  paths, but verify).

The same `projectStores` Map continues to drive the rest of the
scheduler, so this change is localized.

### Bug 1A — Status/location drift

**Decision (two-pronged):**

1. **Atomic `save+transition` in `FilesystemTaskStore`.** Do not allow
   a partially-applied state where the file's frontmatter status has
   been updated but the file has not been moved to the matching status
   directory. The transition path in
   `src/dispatch/failure-tracker.ts:transitionToDeadletter` and any
   other similar paths must be one logical operation from the store's
   perspective.

2. **Startup reconciliation pass.** At
   `FilesystemTaskStore.init()` (or equivalent boot point), walk every
   `tasks/<status>/*.md` file. For each file whose
   `frontmatter.status` does not match its directory, **move the file
   to the directory matching its frontmatter status**. Filesystem is
   the source of truth for *location*; frontmatter is the source of
   truth for *which status it should have*. The reconciliation
   resolves disagreement in favor of the frontmatter status (since
   that is what the application code sets) and corrects the on-disk
   layout.

   Edge case: if the directory matching the status doesn't exist (e.g.
   typo in frontmatter), log a warning and leave the file in place —
   do not delete or guess.

   Run reconciliation once per project store at `init()`, not on every
   poll. It's a self-heal pass for past drift, not a continuous
   correction loop.

**Rationale:** (1) prevents future drift from being created; (2) heals
any drift that's already been created (including the 5 ghost tasks I
moved by hand on 2026-04-24, and any similar that may exist in
the wild for other users). Together they make the filesystem layout
*self-correcting* — single source of truth, no two-view-sync problem.

### Bug 1C — Log rotation

**Decision:** Add `pino-roll` (or equivalent) as an AOF dependency.
Default config: 50 MB per file, 5 files retained, gzip on rotation.

**Rationale:** User confirmed shipping log rotation as part of AOF
(npm dep, not a system-installed thing) is the right model — same
ship vehicle as everything else AOF installs. The 50 MB × 5 default
caps log disk use at ~250 MB worst-case, which is safe even under
pathological churn.

**Mechanic:** Wire into the existing pino setup at
`src/logging/index.ts` (the `createLogger(component)` factory). Use
the `transport` option so the rotation runs in a worker thread and
doesn't block hot paths. Defaults configurable via `AOFConfig`
(`getConfig()` from `src/config/registry.ts`) but the defaults must
be set such that no user has to opt in.

### Bug 2B + 2C — `aof_task_create` routing validation + `createdBy` capture

**Decision (combined):**

- `aof_task_create` MUST reject tasks where `routing.agent`,
  `routing.role`, AND `routing.team` are all unset/empty. The
  rejection should be a clear error returned to the caller, not a
  silent acceptance + future deadletter.

- **Optional defaulting:** if the project has an `owner.team` or
  `owner.lead` in `project.yaml`, the create handler MAY default
  `routing.team` (or `routing.agent` for `owner.lead`) from those
  fields. This is a quality-of-life convenience — agents creating
  tasks in their own project's namespace shouldn't have to repeat the
  routing every time.

- The calling agent's identity (from the dispatch / tool invocation
  context) MUST be recorded into `createdBy`. Today it's
  `"unknown"` for all 5 tasks in the incident. Trace where the
  identity gets dropped between the OpenClaw invocation envelope and
  the task store's `create()` path.

**Rationale:** Prevents the silent-dispatch failure mode at its source.
If the daemon/scheduler can't see a task to dispatch (Bug 2A) OR if
the task has no routing target (Bug 2B), neither bug causes a 21-min
silent wait if create-time validation rejects up front. Bug 2C
(`createdBy: unknown`) is a debuggability fix — without it, future
incidents lose forensic traceability.

### Claude's Discretion

The exact ORM-style API for the atomic `save+transition` is left to
the planner — there are several reasonable shapes (a single
`store.transition(taskId, newStatus, opts)` that handles both the
file-move and the frontmatter-rewrite atomically; or a save callback
that takes a status; or a write-then-rename + post-condition check).
The planner should pick the one that fits the existing
`ITaskStore` contract with the least disruption to call sites.

The exact log-rotation library (`pino-roll`, `sonic-boom` rotation,
`pino-pretty` rotation, etc.) is left to the planner — pick whichever
has the smallest dependency footprint, no native deps, and active
maintenance.

The shape of the create-time error returned by `aof_task_create` for
empty-routing tasks is left to the planner — should match existing
error patterns in `src/tools/*-tools.ts`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Bug investigation (the why)
- `.planning/debug/2026-04-24-daemon-state-and-resource-hygiene.md` —
  full post-mortem of both incidents, including timeline, evidence,
  and recommended fix approach for each bug.

### Code paths implicated (verified during investigation)
- `src/dispatch/failure-tracker.ts:61-123` — `transitionToDeadletter`,
  the call site where save+transition currently are not atomic.
- `src/store/task-store.ts` — `transition()`, `save()` — the storage
  primitives that need to become atomic.
- `src/store/interfaces.ts` — `ITaskStore` contract, will need the
  atomic-transition API addition.
- `src/projects/registry.ts:44` — `discoverProjects()` — the function
  to call from inside the poll loop.
- `src/service/aof-service.ts:257-280, 298, 395, 451` —
  `initializeProjects` (the one-shot call) and the `projectStores` Map
  iteration sites.
- `src/dispatch/task-dispatcher.ts:191-250` — routing resolution that
  rejects empty-routing tasks at dispatch time (the create-time fix
  should mirror this rejection earlier).
- `src/logging/index.ts` — pino logger setup, where rotation transport
  must be wired.
- `src/tools/*-tools.ts` — `aof_task_create` tool handler (exact file
  TBD by planner) — the validation and createdBy-capture site.

### Project conventions (always honor)
- `CLAUDE.md` (project root) — engineering standards, conventions,
  naming, fragile-area warnings. The "Fragile — Tread Carefully"
  section explicitly calls out the dispatch chain
  (`scheduler.ts → task-dispatcher.ts → action-executor.ts →
  assign-executor.ts`) as tightly coupled. Plans touching these need
  TDD coverage.
- `CODE_MAP.md` (project root) — architecture, module layering. Refresh
  CODE_MAP.md after Phase 46 lands if structural changes ship.
- `lessons.md` — past mistakes log. Check before designing the
  reconciliation pass; there may be related lessons about transition
  bugs.

### Tests to extend (not create new fixtures)
- `src/dispatch/__tests__/deadletter-integration.test.ts` — the
  existing deadletter integration tests are the right place to add a
  regression for partial-transition recovery.
- `src/dispatch/__tests__/deadletter-frontmatter-stamp.test.ts` —
  related coverage of metadata stamping.
- `src/projects/__tests__/registry.test.ts` — extend with a "project
  added after init" integration test.
- `src/service/__tests__/aof-service*.test.ts` (if present) — for the
  per-poll rediscovery integration test.

</canonical_refs>

<specifics>
## Specific Requirements

### Regression tests (one per bug, MUST land with the fix)

1. **Bug 2A regression test** — create a project *after* the
   `AOFService.init()` has completed, then call `poll()` and assert
   the new project's tasks are dispatched. This is the test that
   would have prevented Incident 2.

2. **Bug 1A regression test (drift recovery)** — populate
   `tasks/ready/` with a file whose frontmatter says
   `status: deadletter`, call `init()`, and assert the file is now
   in `tasks/deadletter/`.

3. **Bug 1A regression test (atomic transition)** — simulate a
   transition that fails partway (mock or temp-fault the rename
   step), and assert the frontmatter status was NOT updated either —
   either both succeed or both roll back.

4. **Bug 1C log rotation** — at least one test asserting that the
   rotation is wired (existence test with config sniff is sufficient
   — full rotation behavior is `pino-roll`'s test suite, we don't
   need to re-test the lib).

5. **Bug 2B regression test** — call `aof_task_create` with empty
   routing → assert error returned, no task file written.

6. **Bug 2C regression test** — call `aof_task_create` from a tool
   invocation context with a known caller identity → assert
   `createdBy` reflects that identity.

### Defaults that ship

- Log rotation: 50 MB / 5 files / gzip — no opt-in required.
- Reconciliation pass: runs every `init()` — no opt-in required.
- Project rediscovery: runs every `poll()` — no opt-in required.
- Empty-routing rejection: no escape hatch (a task with no routing
  target is structurally broken).

### Verification commands

After implementation:

```bash
npm run typecheck && npm test                       # all green
npm run test:e2e                                    # 224+ green
npx madge --circular --extensions ts src/           # no new cycles
```

Manual smoke test (run on the live install after deploy):

```bash
# 1. Create a new project AFTER daemon is running, dispatch a task to it,
#    confirm the task gets picked up within one poll cycle.
# 2. Confirm logs are rotating: ls -lh ~/.aof/data/logs/ should show
#    rotation files appearing as the active log grows.
# 3. Try to create a task with no routing target via aof_task_create;
#    confirm the call errors out with a clear message.
```

</specifics>

<deferred>
## Deferred Ideas

### Phase 47 (next)

- **Bug 1D — Per-poll log verbosity.** Drop `task-dispatcher`
  `concurrency limit status` and `scheduler` `scheduler poll complete
  (ready=0)` from info to debug. ~40 % log volume reduction at idle.
- **Bug 1E — Auth-precondition fail-fast.** Pre-dispatch check for the
  routed agent's `auth-profiles.json`. Missing → `errorClass: "permanent"`,
  deadletter on attempt #1 instead of #6.

### Won't do (out of scope by design)

- **Project-manifest / `.aofignore` opt-out for bug-repro fixtures.**
  Per user direction, prefer test hygiene over config layer. Audit
  existing tests to ensure none write to `~/.aof/data/Projects/`.
- **Wake-up subscription TTL.** Per user direction, defer to avoid
  added complexity. Revisit only if the post-restart replay burst
  becomes a real problem.

</deferred>

---

*Phase: 46-daemon-state-freshness*
*Context gathered: 2026-04-24 via direct authoring from debug record*
