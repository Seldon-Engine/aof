# AOF Bug Reports — Archive

Resolved bugs moved out of `bug-reports.md`. Each entry notes the fixing commit(s) and the date the bug was archived.

---

## BUG-001: Hnswlib capacity limit reached on memory insert

**Date/Time:** 2026-02-25 21:15 EST
**Severity:** P1
**Status:** fixed
**Archived:** 2026-04-23
**Fixing commits:**
- `95cdc03` feat(04-01): harden HnswIndex and VectorStore for crash safety and concurrency — adds `ensureCapacity()` with 1.5× `GROWTH_FACTOR` auto-resize on hitting `max_elements`, plus save-after-mutation for crash safety.
- `1adb41c` feat(04-01): add startup parity check and auto-rebuild in `registerMemoryModule` — detects desynced indexes and rebuilds with headroom.
- `a978fcc` test(04-01): add integration tests for HNSW resilience (resize, rebuild, parity, save/load).
**Verification:** `src/memory/store/hnsw-index.ts` `ensureCapacity()` at lines 147–163 auto-grows the index before an insert would exceed `maxElements`, so the original failure path (`The number of elements exceeds the specified limit`) is no longer reachable in normal operation.

### Short Description
The AOF memory plugin's underlying HNSW vector graph has reached its maximum element count. Attempting to store new memories fails entirely, and retrieving recent memories (`memory_search`) returns completely empty results.

### Technical Notes
- **Error output:** `Hnswlib Error: The number of elements exceeds the specified limit` upon `memory_store` call.
- **Search failure:** Calling `memory_search` for known, recently added topics (like "dispatch caveat") yields no results, suggesting index instability or read failures when the limit is breached.
- **Hypothesis:** The graph was initialized with a hard capacity limit (e.g., `max_elements`) which has now been exceeded by the number of memory chunks. The index needs to be resized, rebuilt, or garbage collected.
- **Workaround:** None currently. Memory subsystem is functionally broken for inserts and searches.

---

## BUG-002: AOF dispatch via HTTP tools/invoke fails to propagate pairing token

**Date/Time:** 2026-02-25 12:00 EST
**Severity:** P0
**Status:** fixed
**Archived:** 2026-04-23
**Fixing commit:**
- `fc5a83e` fix(openclaw): replace HTTP dispatch with embedded agent executor — bypasses gateway WebSocket auth and device pairing by running agents in-process via `runEmbeddedPiAgent()`.

### Short Description
Sub-agent spawn attempts via HTTP `POST /tools/invoke` calling `sessions_spawn` reliably fail with `1008 pairing required`. The auth token from the local loopback isn't propagated correctly into the child websocket connection.

### Technical Notes
- **Error output:** `spawn_failed: gateway closed (1008): pairing required` on `ws://127.0.0.1:18789`.
- **Cause:** Initially attempted to use an HTTP loopback path which failed to authenticate the websocket spawn.
- **Resolution:** Fixed by replacing HTTP dispatch with the embedded agent executor (`runEmbeddedPiAgent()`). This bypasses gateway WebSocket auth and device pairing entirely by running agents in-process, which unblocked the task pipeline and allowed the queued tasks to complete successfully.

---

## BUG-004: `aof_dispatch` accepted nonexistent `dependsOn` task IDs and produced corrupted dependency state

**Date/Time:** 2026-04-23 16:42 EDT
**Severity:** P1
**Status:** fixed
**Archived:** 2026-04-23
**Fixing commits:**
- `94e794d` fix(store): guard addDep/removeDep/update/updateBody with per-task lock — eliminates the lost-update race where concurrent `aof_task_dep_add` calls clobbered each other (sub-issue C).
- `5340610` fix(dispatch): validate dependsOn IDs against store at dispatch time — nonexistent blocker IDs now fail the dispatch loudly with the offending IDs in the error; no corrupt task is written (sub-issue A).
- `00cd869` fix(tools): aof_task_dep_remove tolerates nonexistent blocker IDs — mirrors CLI behavior so legacy/orphan blocker entries can be cleaned up via MCP (sub-issue B).

**Verification:** Three regression tests reproduce the original failure modes and pass on the new code:
- `src/store/__tests__/task-store-deps.test.ts` — "concurrent mutations" block (Promise.all races).
- `src/tools/__tests__/aof-dispatch-dependson-validation.test.ts` — dispatch rejects bogus `dependsOn`.
- `src/tools/__tests__/aof-task-dep-remove-tolerance.test.ts` — MCP remove succeeds on legacy-corrupt tasks.

**Related:** A bonus indexing anomaly surfaced during BUG-004 repro — `aof_status_report` silently omitted a freshly dispatched task until its file was touched again by a subsequent mutation. Tracked separately as BUG-006 (see `bug-reports.md`).

### Short Description
A review task was dispatched with `dependsOn` references to task IDs that did not exist in the target project. `aof_dispatch` still created the task as `ready`, later `aof_task_dep_add` calls showed partially inconsistent dependency lists, and `aof_task_dep_remove` could not clean up the bogus blockers because AOF reported them as `not-found`.

### Root Causes (three independent sub-issues)
1. **Sub-issue A — `aof_dispatch` didn't validate `dependsOn`**: `src/tools/project-tools.ts` `aofDispatch` passed `input.dependsOn` straight into `store.create` without checking that each id resolved to an existing task. Silent acceptance → task materializes as `ready` with impossible-to-satisfy blockers.
2. **Sub-issue B — `aof_task_dep_remove` demanded blocker resolves**: `src/tools/task-workflow-tools.ts` `aofTaskDepRemove` called `resolveTask(ctx.store, input.blockerId)` which threw `Task not found` before ever reaching the store. The CLI path in `src/cli/commands/task-dep.ts:88-91` had always fallen through with the literal blockerId; the MCP handler was inconsistent. Cleanup of orphan blockers was impossible through the MCP surface.
3. **Sub-issue C — `addDep`/`removeDep` had a read-modify-write race**: `FilesystemTaskStore.addDep`/`removeDep` performed read-modify-write on `frontmatter.dependsOn` without the per-task mutex that `transition`/`cancel` already used. Two concurrent `aof_task_dep_add` calls both read the same baseline and each wrote their own mutation atomically — last write wins, and the earlier addition was lost.

### Fix Summary
- Dispatch-time validation rejects any `dependsOn` entry that doesn't resolve, with a clear error listing missing IDs.
- The MCP `dep_remove` handler now mirrors the CLI: tries to resolve for nicer messaging but falls through with the literal blockerId if not found. `aof_task_dep_add` stays strict.
- `TaskLocks` now guards `addDep`, `removeDep`, `update`, and `updateBody` in addition to `transition` and `cancel` — closes the last read-modify-write races in the store. `block`/`unblock` are intentionally not wrapped because they call `transition` internally (re-entering the same lock would deadlock).

### Original Observed Symptoms
Smoke-test project creation and dispatch sequence:
- Project: `aof-smoke`
- Tasks created:
  - `TASK-2026-04-23-001` — frontend marker
  - `TASK-2026-04-23-003` — tech-writer marker
  - `TASK-2026-04-23-002` — architect review
- The architect review task was initially dispatched with:
  - `dependsOn: ["TASK-2026-04-23-006", "TASK-2026-04-23-007"]`
- Those IDs did **not** exist in the project, but AOF still returned the task as created and `ready`.

Follow-up repair attempts:
- `aof_task_dep_add(taskId=TASK-2026-04-23-002, blockerId=TASK-2026-04-23-003)` returned success with `["...-006", "...-007", "...-003"]` in dependsOn.
- `aof_task_dep_add(taskId=TASK-2026-04-23-002, blockerId=TASK-2026-04-23-001)` then returned `["...-006", "...-007", "...-001"]` — the previously-added `...-003` had vanished.
- `aof_task_dep_remove(... blockerId="TASK-2026-04-23-006")` → `not-found: Task not found: TASK-2026-04-23-006`.
- Despite all of the above, `aof_status_report` continued to show the review task as `ready`.

---

## BUG-003: registerHttpRoute calls rejected by gateway — missing `auth` descriptor

**Date/Time:** 2026-04-23 16:40 EDT
**Severity:** P2
**Status:** fixed
**Archived:** 2026-04-23
**Fixing commit:**
- `c683c71` fix(openclaw): pass auth: "gateway" on registerHttpRoute calls — adds required `auth` field to both `/aof/metrics` and `/aof/status` registrations and tightens the local `OpenClawHttpRouteDefinition` type so future callers can't omit it.

**Verification:**
- Pre-fix: `curl http://127.0.0.1:18789/aof/status` → HTTP 404 (route never registered); gateway.err.log logged `http route registration missing or invalid auth` on every plugin load.
- Post-fix (deployed, both services restarted): `curl http://127.0.0.1:18789/aof/status` → HTTP 401 (route registered, gateway auth middleware reached). No further `http route registration` errors in `gateway.err.log` for the new plugin boot.

**Notes on the auth shape:** The original bug report hypothesized an `auth: { mode: "token" }` object. Source inspection of the OpenClaw CLI loader (`/opt/homebrew/lib/node_modules/openclaw/dist/loader-*.js`) showed the validator requires `auth` to be the literal string `"gateway"` or `"plugin"`. The local `OpenClawHttpRouteDefinition` interface mirrors this.

### Short Description
AOF's `/aof/metrics` and `/aof/status` HTTP routes failed to register on every gateway startup because the `api.registerHttpRoute` calls omitted the `auth` descriptor that OpenClaw has required since `2026.4.11`. The plugin loaded fine and tool calls worked; only the internal HTTP observability surface was silently unregistered.

### Root Cause
`src/openclaw/adapter.ts` passed only `{ path, handler }` to `api.registerHttpRoute`. OpenClaw's loader validator (since `2026.4.11`) rejects any registration where `params.auth !== "gateway" && params.auth !== "plugin"`, logging an error and skipping the registration. Net effect: the two routes never joined the plugin-http-route table, so the gateway returned 404 for any request to them.

### Original Observed Symptoms
On every gateway boot (consistently since `2026.4.11` through at least `2026.4.22`):
```
[gateway] [plugins] http route registration missing or invalid auth: /aof/metrics (plugin=aof, source=/Users/xavier/.openclaw/extensions/aof/index.ts)
[gateway] [plugins] http route registration missing or invalid auth: /aof/status  (plugin=aof, source=/Users/xavier/.openclaw/extensions/aof/index.ts)
```
Result: neither route was available for external polling. AOF tool calls via MCP continued to work.

---
