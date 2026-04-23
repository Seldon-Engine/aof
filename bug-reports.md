# AOF Bug Reports

> Archived (fixed) bugs moved to `bug-reports-archive.md`.

---

## BUG-003: registerHttpRoute calls rejected by gateway — missing `auth` descriptor

**Date/Time:** 2026-04-23 16:40 EDT
**Severity:** P2
**Status:** new
**Environment:** AOF (current main, deployed at `~/.aof` via thin-bridge), OpenClaw `2026.4.22` (originally surfaced in `2026.4.11`, persists through `.15` and `.22`)

### Short Description
AOF's `/aof/metrics` and `/aof/status` HTTP routes fail to register on every gateway startup because the `api.registerHttpRoute` calls omit the `auth` descriptor that OpenClaw has required since `2026.4.11`. The plugin itself loads fine and tool calls work, but the internal HTTP observability surface is silently unregistered.

### Observed Symptoms
On every gateway boot (consistently since `2026.4.11` through at least `2026.4.22`):
```
[gateway] [plugins] http route registration missing or invalid auth: /aof/metrics (plugin=aof, source=/Users/xavier/.openclaw/extensions/aof/index.ts)
[gateway] [plugins] http route registration missing or invalid auth: /aof/status  (plugin=aof, source=/Users/xavier/.openclaw/extensions/aof/index.ts)
```
Result: neither route is available for external polling. AOF tool calls via MCP continue to work; only the HTTP observability endpoints are affected.

### Root Cause
`src/openclaw/adapter.ts` lines 138–142:
```ts
if (typeof api.registerHttpRoute === "function") {
  const proxy = buildStatusProxyHandler(socketPath);
  api.registerHttpRoute({ path: "/aof/metrics", handler: proxy });
  api.registerHttpRoute({ path: "/aof/status", handler: proxy });
}
```
OpenClaw's `registerHttpRoute` validator now rejects registrations without an `auth` field. Both calls need to pass an auth descriptor. This was documented in the `2026.4.11` release notes ("stricter HTTP route registration") but never propagated into AOF.

### Proposed Fix
Add an `auth` descriptor appropriate for each route. Options, in order of preference:
1. **Gateway-token auth** (matches how existing plugins expose loopback-only admin surfaces):
   ```ts
   api.registerHttpRoute({ path: "/aof/metrics", handler: proxy, auth: { mode: "token" } });
   api.registerHttpRoute({ path: "/aof/status",  handler: proxy, auth: { mode: "token" } });
   ```
2. **Public read (no auth)** if we're confident these endpoints are safe to expose unauthenticated, use whatever the explicit "public" descriptor is in the current OpenClaw API (check `openclaw` types — `auth: { mode: "public" }` or similar).

Exact shape of the `auth` descriptor should be confirmed against the current `PluginApi` type in the OpenClaw npm package before tagging a release — the shape may have evolved between `.11` and `.22`.

### Reproduction
1. Deploy AOF main to `~/.aof`.
2. Start OpenClaw gateway (any version ≥ `2026.4.11`).
3. `grep "http route registration" ~/.openclaw/logs/gateway.err.log` → two entries per boot.
4. `curl http://127.0.0.1:18789/aof/status` → 404 (route never registered).

### Impact
Low-to-medium. Tool calls and MCP surface unaffected. Only internal monitoring/metrics HTTP endpoints are missing. Blocks anyone wanting to scrape AOF's `/aof/metrics` directly (workaround: call via MCP `aof_status_report`).

### Workaround
None needed for core functionality. If metrics scraping is required today, use the daemon's direct socket (`/Users/xavier/.aof/data/daemon.sock` → `/status`) or the MCP `aof_status_report` tool.

---

## BUG-005: AOF tasks can reconcile to `deadletter` even when the requested work completed successfully outside the task lifecycle

**Date/Time:** 2026-04-23 16:42 EDT
**Severity:** P2
**Status:** new
**Environment:** AOF local (`~/Projects/AOF`), OpenClaw orchestration using both AOF tasks and direct subagent fallback

### Short Description
Two real AOF tasks for the Opreto component-library rollout (`TASK-2026-04-23-004`, `TASK-2026-04-23-005`) never visibly progressed through normal task states. The work was completed successfully via direct subagent runs after AOF failed to pick them up. Later, AOF reconciled both tasks to `deadletter` rather than preserving actionable failure context or allowing an explicit coordinator closeout path.

### Observed Symptoms
Original tasks:
- `TASK-2026-04-23-004` — Implement Opreto component library + showcase + skill integration for report assembly (`swe-frontend`)
- `TASK-2026-04-23-005` — Define Opreto report/web component library for agent-authored rich content (`swe-ux`)

Observed timeline:
1. Both tasks were dispatched and remained in `ready` for >1 hour with no visible pickup.
2. Coordinator manually added check-in updates asking the assigned agents to acknowledge/start/block.
3. Because no progress occurred, the same work was executed through direct `sessions_spawn` subagent runs instead.
4. The subagent runs completed successfully and the requested files/specs/components/showcase updates landed.
5. Later, `aof_status_report` showed both original AOF tasks as `deadletter`, not `done`, `blocked`, `cancelled`, or `superseded`.

### Expected Behavior
When work associated with a task is superseded, manually rerouted, or otherwise completed outside the original scheduler path, AOF should support a clean terminal state such as:
- `cancelled` with explicit reason,
- `blocked` with explicit reason,
- `superseded`, or
- explicit coordinator completion override with audit trail.

It should not silently strand such tasks into `deadletter` without an obvious lifecycle explanation.

### Actual Behavior
The tasks never progressed through visible execution states, but eventually surfaced as `deadletter` while the requested work had in fact been completed through fallback orchestration.

### Impact
Medium. This creates misleading operational history:
- dashboards imply failure/abandonment,
- coordinators lose traceability between requested work and delivered work,
- periodic status checks can report confusing state that no longer matches reality.

This is especially damaging during shakeout periods when coordinators are intentionally falling back to direct execution to keep momentum.

### Reproduction (approximate)
1. Dispatch tasks to assigned agents.
2. Observe no pickup from `ready` for an extended period.
3. Complete the same work through a direct subagent path outside AOF.
4. Re-check AOF status later.
5. Observe tasks reconciled to `deadletter` rather than an explicit superseded/cancelled outcome.

### Hypothesis
AOF likely has a stale-task sweeper / reconciler that moves tasks with certain orphaned conditions into `deadletter`, but it does not distinguish between:
- truly abandoned/orphaned tasks,
- tasks awaiting manual intervention,
- tasks intentionally superseded by fallback execution.

There may be no first-class "superseded" or "externally completed" concept in the lifecycle, forcing the scheduler to treat these as dead mail.

### Proposed Fix
1. Add an explicit terminal outcome such as `superseded` (or `completed_elsewhere`).
2. Allow coordinators to mark tasks with that outcome and preserve a reason/body note linking the replacement execution path.
3. Ensure stale-task reconciliation prefers a diagnosable blocked/cancelled/superseded state over `deadletter` when the task was previously valid and simply not picked up.
4. Improve observability so the transition into `deadletter` includes the reason and trigger in task history / status reports.

### Workaround
If fallback execution is needed today, coordinators should explicitly annotate the task body before rerouting and, where possible, manually cancel/block it rather than letting it age out. But this is only partial because the existing lifecycle still appears to reconcile some such tasks into `deadletter` anyway.

---

## BUG-006: `aof_status_report` silently omits freshly dispatched tasks until the file is touched again

**Date/Time:** 2026-04-23 17:13 EDT
**Severity:** P2
**Status:** new
**Environment:** AOF (current main, deployed at `~/.aof` via thin-bridge), OpenClaw `2026.4.22`; surfaced while reproducing BUG-004

### Short Description
Immediately after a successful `aof_dispatch`, calling `aof_status_report(project=<same project>)` returns a count and listing that **excludes** the newly dispatched task, even though the dispatch response confirms the task's file path and the file is visibly on disk in `tasks/ready/`. The task becomes visible to `aof_status_report` only after some subsequent mutation touches the file (e.g. `aof_task_dep_add` / `aof_task_dep_remove`).

### Observed Symptoms
Reproduced on 2026-04-23 in project `aof-bug004-repro`:

1. `aof_dispatch(title="task C", dependsOn=[... bogus IDs ...])` returned:
   ```json
   {
     "taskId": "TASK-2026-04-23-003",
     "status": "ready",
     "filePath": "/Users/xavier/.aof/data/Projects/aof-bug004-repro/tasks/ready/TASK-2026-04-23-003.md"
   }
   ```
2. Disk listing (same second): `TASK-2026-04-23-003.md` present in `tasks/ready/` with correct frontmatter.
3. Direct `FilesystemTaskStore.list()` against the project root returns **3** tasks including TASK-003.
4. `aof_status_report(project="aof-bug004-repro")` called seconds after dispatch returned **2 tasks** (only TASK-001 and TASK-002). TASK-003 was invisible.
5. After subsequent `aof_task_dep_add` + `aof_task_dep_remove` calls on TASK-003 (which rewrite the file), a later `aof_status_report` returned **3 tasks** with TASK-003 present.

### Expected Behavior
`aof_status_report` should reflect the current on-disk state of the project's tasks directory. A task whose file is visible on disk (and whose path was just returned from a successful dispatch) must appear in the same-project status listing without any additional mutation.

### Actual Behavior
`aof_status_report` runs against a daemon-side view that appears to lag disk reality for newly created task files, until a subsequent write to the same file refreshes the view.

### Impact
Medium. Coordinators polling `aof_status_report` right after `aof_dispatch` can see the dispatched task listed in the dispatch response but missing from the immediate status report — making dashboards and automation conclude "the task wasn't created" when it was. Reliability of the primary read-path is undermined.

### Scope of Investigation So Far
- `aofStatusReport` in `src/tools/query-tools.ts` calls `ctx.store.list()` unconditionally; no filtering would exclude TASK-003.
- `FilesystemTaskStore.list()` in `src/store/task-store.ts:368` does fresh disk reads per call and has no in-memory cache at that layer.
- A fresh `new FilesystemTaskStore(projectRoot).list()` from a separate Node process correctly returned all 3 tasks during the anomaly window.

The discrepancy is therefore not in `list()` itself. Suspects:
1. **Daemon-side project-store cache** — `src/daemon/resolve-store-for-task.ts` caches `projectId → ITaskStore` instances indefinitely. If the cached store holds a view constructed before the dispatch wrote its file, and some intermediate layer caches per-call results keyed by store identity, the view could be stale. (Cache inspection inconclusive so far — the store itself reads disk freshly.)
2. **MCP context store mismatch** — if the dispatch call and the status call are routed to different `ctx.store` instances (e.g. scoped vs unscoped, or different store instance per tool call), the dispatch could land in a project-scoped store while status_report reads an unscoped one. Worth tracing.
3. **Plugin-side cache** — OpenClaw plugin might cache tool responses or derived state for short windows.

### Reproduction
1. Create (or reuse) a project: `aof-bug006-repro`.
2. Call `aof_dispatch(project="aof-bug006-repro", title="visible?", brief="test", agent="swe-backend")`.
3. Immediately call `aof_status_report(project="aof-bug006-repro")`.
4. Compare the returned `total` / `tasks[]` against the file count in `~/.aof/data/Projects/aof-bug006-repro/tasks/ready/`.
5. Call `aof_task_dep_add` or `aof_task_update` to mutate the task.
6. Call `aof_status_report` again — task now appears.

### Workaround
After `aof_dispatch`, treat the task as present regardless of what `aof_status_report` shows in the immediately following window. Or call a no-op mutation on the task before polling status.

---
