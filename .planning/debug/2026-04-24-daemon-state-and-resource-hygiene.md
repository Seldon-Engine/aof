---
status: open
trigger: "Two distinct user-visible incidents in 24h, both rooted in daemon state staleness or unbounded resource growth"
created: 2026-04-24T21:15:00Z
updated: 2026-04-24T21:15:00Z
---

# BUG cluster — Daemon state freshness and resource hygiene

This is a combined post-mortem of two incidents observed within 24 hours.
Both have the same underlying flavor: **the daemon trusts an in-memory or
on-disk snapshot too much, and there is no self-correcting cycle that
catches drift.** Bundling them into one debug record because the fixes
are cohesive and one phase can address them together.

## Incident 1 — Daemon spin-loop + 172 MB log growth (2026-04-24, late afternoon)

### Symptoms

- `~/.aof/data/logs/daemon-stderr.log` had grown to **172 MB / 970,735
  lines** over 6 days of continuous churn.
- Constant fsync pressure visibly slowing other processes (Claude Code
  hooks in particular).
- Tail showed scheduler emitting ~40 log lines per 30 s poll across
  many projects, including dependency-gate evaluations on tasks that
  could never resolve.

### Investigation trail

Traced via `~/.aof/data/`:

1. **Bug 1A — Status/location drift on deadletter transition.**
   Five tasks lived in `~/.aof/data/tasks/ready/` while their
   frontmatter said `status: deadletter`. The scheduler's view is
   directory-based (it lists files in `tasks/ready/` to decide what to
   evaluate), so it kept re-evaluating these tasks every poll forever.

   Cause: `src/dispatch/failure-tracker.ts:61-123` `transitionToDeadletter`
   does:
   ```ts
   task.frontmatter.metadata = { ...deadletterReason etc };
   await store.save(task);                          // step 1: stamp metadata
   await store.transition(taskId, "deadletter");    // step 2: move file
   ```
   These are two non-atomic operations. If step 1 succeeds and step 2
   crashes / errors / is interrupted, the file ends up with one status
   in frontmatter and a different location on disk. There is no
   reconciliation pass to fix drift after the fact, so a single failed
   transition leaves a permanent ghost task in `ready/`.

2. **Bug 1B — Bug-repro fixtures live inside production data dir.**
   `~/.aof/data/Projects/` contained nine bug-repro / smoke-test
   project directories (`aof-bug004-repro`, `aof-bug004-verify`,
   `aof-bug006-*` ×6, `aof-smoke`). Some of these had tasks with
   intentional garbage `dependsOn` IDs like
   `TASK-2099-99-99-997` / `…-998` (literally bug-004's RED test
   fixture), which can never resolve.

   `discoverProjects()` (`src/projects/registry.ts:44`) walks the
   `Projects/` subdir indiscriminately — bug-repro fixtures become live
   scheduled work the moment they land in that path. There is no
   marker file or naming convention to opt them out.

3. **Bug 1C — Unbounded `pino` logging.** The `createLogger` setup has
   no rotation, no size cap, no retention. Pathological churn just
   accumulates forever; the daemon stderr log went 6 days without
   touching disk-rotation.

4. **Bug 1D — Per-poll log verbosity at info level.** Every poll
   emits `task-dispatcher` `concurrency limit status` and `scheduler`
   `scheduler poll complete (ready=0)` at info level, even when there
   is no work to do. These two messages are ~40 % of the log volume
   in idle periods. They belong at debug.

5. **Bug 1E — Auth-precondition failures classified as transient.**
   The 5 stuck tasks all had `metadata.dispatchFailures: 6` because
   the routed agent (`researcher` / `growth-lead` / `swe-frontend` /
   `swe-ux` / `main`) was missing its `~/.openclaw/agents/<id>/agent/auth-profiles.json`.
   Each dispatch attempt threw `No API key found for provider "openai"`
   and got tracked as a transient failure → 6 retries → eventual
   deadletter (with the drift bug above). This is a `permanent`
   error class — the absence of an auth profile won't resolve by
   retrying. Should fail-fast on attempt #1, not #6.

### Mitigation applied (manual, not a code fix)

Detailed in conversation transcript and reflected in the live install:

- Stopped daemon (`launchctl unload ai.openclaw.aof`).
- Moved 5 root tasks from `ready/` → `deadletter/` to match their
  frontmatter status.
- Archived the 9 bug-repro project directories to
  `~/.aof/archive-2026-04-24/Projects/` (reversible — not deleted).
- Truncated `daemon-stderr.log` and `daemon-stdout.log`.
- `pkill -9` on orphan `chromium-headless-shell`, stale `serena` MCPs,
  and `agent-browser` (unrelated to AOF root cause; they were using
  CPU and contributing to the perceived slowness).
- Restarted daemon. Steady-state log rate dropped from sustained-bursts
  to ~1 line/sec at idle.

The mitigation does NOT prevent recurrence — it just clears the
accumulated state.

## Incident 2 — growth-lead 5 tasks sat in `ready/` for 21 minutes (2026-04-25, ~00:37 UTC)

### Symptoms

User reported: "I was just talking to the growth-lead agent in the
growth telegram room, it dispatched 5 AOF tasks, then waited, and
waited, and waited. When I asked it to check on the tasks, they were
still sitting in ready and nothing had been done." The agent eventually
gave up and did the work itself, cancelling all 5 tasks with
`reason: "superseded: executing directly due to subagent auth being down"`.

### Investigation trail

Timeline (all UTC):

| Time | Event |
|------|-------|
| `2026-04-24 16:43:38` | Daemon restarted (Incident 1 mitigation) |
| `2026-04-24 20:36:33` | Project `event-calendar-2026/` directory created (~4h post-restart) |
| `2026-04-25 00:37:44` | 5 tasks created in `Projects/event-calendar-2026/tasks/ready/` |
| `2026-04-25 00:58:06` | Agent gives up, cancels all 5 tasks (~21 min later) |

Smoking-gun evidence:

```bash
$ grep -E "TASK-2026-04-25-00[1-5]" ~/.aof/data/logs/daemon-stderr.log | wc -l
0
```

**Zero log entries for any of the 5 task IDs.** The daemon never saw
them. Two distinct root causes:

1. **Bug 2A — Project discovery is one-shot at daemon boot.**
   `src/service/aof-service.ts:257-280` `initializeProjects()` runs
   exactly once during `init()`:
   ```ts
   private async initializeProjects(): Promise<void> {
     if (!this.vaultRoot) return;
     this.projects = await discoverProjects(this.vaultRoot);
     for (const project of this.projects) {
       // … construct FilesystemTaskStore and register in this.projectStores
       this.projectStores.set(project.id, store);
     }
   }
   ```
   The resulting `this.projectStores: Map<string, ITaskStore>` is a
   frozen snapshot. Every subsequent `poll()` iterates that Map
   (`aof-service.ts:298, 451`). There is no fs watcher, no periodic
   rediscover, no manual refresh API. **A project created
   post-startup is invisible to the scheduler until the next daemon
   restart.**

   `event-calendar-2026` was created at 20:36, daemon was last
   restarted at 16:43, so for the entire ~4-hour window (and forward)
   the project's tasks were inert in the scheduler's eyes.

2. **Bug 2B — `aof_task_create` accepts tasks with empty routing
   target.** All 5 tasks had:
   ```yaml
   routing:
     tags: []
   createdBy: unknown
   ```
   No `routing.agent`, no `routing.role`, no `routing.team`.

   `src/dispatch/task-dispatcher.ts:191-250`:
   ```ts
   let targetAgent = routing.agent ?? routing.role ?? routing.team;
   // …
   if (!targetAgent) {
     log.error({ taskId, tags: routing.tags, op: "routing" },
       "task has tags-only routing (not supported), needs explicit agent/role/team assignment");
     // dispatch refused, task stays in ready
   }
   ```
   Even if Bug 2A were fixed, these tasks would have logged-and-skipped
   on every poll instead of being dispatched. They would NOT have been
   deadlettered (the failure counter is not incremented on routing
   refusal); they would just sit in `ready/` forever.

   The right place to catch this is creation, not dispatch. A task
   without a routing target should be rejected at `aof_task_create`
   with a clear error to the caller, OR have routing defaulted from
   the project's owner team / lead.

3. **Bug 2C — `createdBy: unknown` on all 5 tasks.** The tool
   invocation context for `aof_task_create` did not capture the
   calling agent's identity. We cannot tell from the task files who
   created them; we only know it was via the OpenClaw agent channel
   from context. This may be a regression from Phase 44's identity
   enrichment work, or a pre-existing gap that the dispatcher path
   fixed but the create path didn't.

### Org chart and topology — explicitly NOT implicated

User asked: "did my AOF org chart get blown up, or does it no longer
reflect the OpenClaw agent topology?" Confirmed not:

- `~/.aof/data/org/org-chart.yaml` is symlinked to the
  `~/.openclaw/workspace/org/org-chart.yaml` source of truth.
- Schema-valid, contains the `growth` team with `growth-lead` as lead.
- Project `event-calendar-2026` has `owner.team: system` /
  `lead: system` in `project.yaml`, which is a valid (if generic)
  configuration — but again, never reached the dispatcher because of
  Bug 2A.

## Cross-cutting theme

Both incidents are instances of: **the daemon caches state at boot or
during transitions, and there is no reconciliation cycle that catches
drift between the cached view and the on-disk truth.**

| Incident | Cached snapshot | On-disk truth | Drift consequence |
|---|---|---|---|
| 1A — deadletter | `frontmatter.status` | directory location | scheduler keeps re-evaluating ghost tasks every poll, ~40 log lines × 22 projects × hours |
| 2A — project discovery | `projectStores: Map` | `Projects/*/` filesystem | new projects invisible until restart, silent dispatch failures |

The mitigations applied yesterday cleared the *accumulated* state. They
did not prevent the drift from re-occurring. The next incident is
almost certainly a matter of when, not whether.

## Discovered secondary issues (flagged, NOT fixed)

- **Wake-up subscription replay queue has no TTL.** On daemon restart,
  any terminal-state task with an undelivered wake-up gets replayed —
  including transitions from days ago. The `wake-up.recovery-pass`
  drains in seconds, but the user-visible effect is a notification
  burst on every restart. Per user direction, deferring this to avoid
  added complexity. Worth revisiting if the burst becomes more than a
  curiosity.

- **`OpenClaw` zombie agents and stale workers** (already documented
  in `CLAUDE.md`) are a known operational hazard. Not in scope for the
  proposed phase.

- **Per-task locks added in v1.17.0 fix store-side races but not the
  routing-target absence problem.** Bug 2B is upstream of any locking;
  we accept the task into `ready/` before any chance to validate
  routing.

## Recommended fix approach (for phase planning)

Tentative, to be confirmed during phase discuss/plan:

| Bug | Approach |
|---|---|
| 1A — status/location drift | Two-pronged. (1) Atomic `save+transition` in `FilesystemTaskStore` so partial state is impossible. (2) Reconciliation pass at `store.init()` that walks `tasks/<dir>/`, compares `frontmatter.status` to dir, and corrects mismatches. The reconciliation pass is defense-in-depth — it covers this bug AND any future drift, regardless of cause. |
| 1B — bug-repro fixtures in prod data dir | Per user direction, prefer hygiene over project-manifest opt-out. Ensure bug-repro tests use isolated `tmp` roots, not `~/.aof/data/Projects/`. Audit existing tests for accidental writes to the live data dir. |
| 1C — unbounded log growth | Wire `pino-roll` (or equivalent — bundled, ships with AOF) into `src/logging/`. Default: rotate at 50 MB, keep 5 files, gzip on rotation. Configurable via `AOFConfig`. |
| 1D — per-poll log verbosity | Drop `task-dispatcher` `concurrency limit status` and `scheduler` `scheduler poll complete (ready=0)` from info to debug. Keep them at info when `actionsExecuted > 0` or `ready > 0`. |
| 1E — auth-precondition fail-fast | In `assign-executor.ts` pre-dispatch, check that the routed agent's `auth-profiles.json` exists. Missing auth → classify `errorClass: "permanent"`, deadletter on attempt #1 instead of #6. Surfaces user-fixable problems faster and stops eating retry budget on broken agents. |
| 2A — project discovery one-shot | Two options to weigh: (a) rediscover on every poll — cheapest, scans a couple of dirs; (b) fs watcher on `Projects/` — more efficient but more code. Either way the `projectStores: Map` becomes self-healing. Lean toward (a) for simplicity unless poll-time scan cost is measurable. |
| 2B — empty-routing tasks accepted | At `aof_task_create`, validate that `routing.agent ?? routing.role ?? routing.team` resolves to *something*. If absent and the project has an `owner.lead` or `owner.team`, default routing from that. Otherwise return an error to the caller naming the missing field. |
| 2C — `createdBy: unknown` | Trace where the dispatch context's caller-identity gets dropped. Likely a missing field in the `aof_task_create` invocation envelope or the schema's `createdBy` derivation. |

## Files implicated (read for fixes)

Verified by reading code during this investigation:

- `src/dispatch/failure-tracker.ts:61-123` — `transitionToDeadletter`
- `src/store/task-store.ts` — `transition()`, `save()`
- `src/dispatch/task-dispatcher.ts:191-250` — routing resolution
- `src/dispatch/assign-helpers.ts:80-120` — enforcement / deadletter call
- `src/projects/registry.ts:44` — `discoverProjects()`
- `src/service/aof-service.ts:257-280, 298, 395, 451` — `initializeProjects` and `projectStores` Map iteration
- `src/daemon/daemon.ts:200-245` — boot-time recovery + project enumeration
- `src/logging/index.ts` — pino setup
- `src/tools/*-tools.ts` — `aof_task_create` tool handler (location TBD)

## Verification protocol (for the phase)

Each bug should land with at least:
- A regression test under `src/.../__tests__/bug-N-…test.ts` proving the
  failure mode is now caught.
- For 2A specifically: an integration test that creates a project
  *after* the daemon has booted, then dispatches into it, and asserts
  the dispatch lands. This is the test that would have prevented
  Incident 2.
- For 1A: a test that simulates a partial transition (e.g. crash
  between `save` and `transition`) and asserts the reconciliation pass
  fixes it on next `init()`.

## Conversation references

Investigation captured live in two Claude Code conversations on
2026-04-24. Key tool outputs (logs, frontmatter snapshots, ps lines)
preserved in those transcripts. This doc is the structured summary.
