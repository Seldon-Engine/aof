---
phase: 46-daemon-state-freshness-fix-project-discovery-one-shot-bug-st
reviewed: 2026-04-25T16:18:24Z
depth: standard
files_reviewed: 24
files_reviewed_list:
  - src/dispatch/__tests__/bug-046a-atomic-transition.test.ts
  - src/dispatch/failure-tracker.ts
  - src/integration/__tests__/bug-005-tool-persistence.test.ts
  - src/ipc/__tests__/bug-046e-actor-injection.test.ts
  - src/ipc/routes/invoke-tool.ts
  - src/logging/__tests__/bug-046c-rotation-wired.test.ts
  - src/logging/__tests__/logger.test.ts
  - src/logging/index.ts
  - src/openclaw/__tests__/bug-046e-dispatch-notification-actor.test.ts
  - src/openclaw/dispatch-notification.ts
  - src/service/__tests__/bug-046b-project-rediscovery.test.ts
  - src/service/aof-service.ts
  - src/store/__tests__/bug-046a-startup-reconciliation.test.ts
  - src/store/interfaces.ts
  - src/store/task-mutations.ts
  - src/store/task-store.ts
  - src/tools/__tests__/aof-dispatch-dependson-validation.test.ts
  - src/tools/__tests__/aof-dispatch-timeout.test.ts
  - src/tools/__tests__/aof-tools-events.test.ts
  - src/tools/__tests__/aof-tools-persistence.test.ts
  - src/tools/__tests__/bug-046d-routing-required.test.ts
  - src/tools/__tests__/task-seeder.test.ts
  - src/tools/project-tools.ts
  - package.json
findings:
  critical: 0
  warning: 3
  info: 5
  total: 8
status: issues_found
---

# Phase 46: Code Review Report

**Reviewed:** 2026-04-25T16:18:24Z
**Depth:** standard
**Files Reviewed:** 24
**Status:** issues_found

## Summary

Phase 46 lands six tightly-scoped fixes for the 2026-04-24 daemon incidents:
atomic deadletter transition + startup reconciliation (1A), bounded log
rotation via pino-roll with `fd:2` removal (1C), per-poll project
rediscovery (2A), routing-target validation with `system`-sentinel handling
(2B), and dual-side actor injection on plugin tasks (2C). Implementation
quality is high — every fix is regression-tested with at least one bug-NNN
test, locks-and-rollback semantics in `task-mutations.transitionTask` and
`task-store.reconcileDrift` are well thought-out, and the `system` sentinel
is correctly case-insensitive.

Three warnings worth addressing:

1. **WR-01** — `transitionToDeadletter` happy-path is now atomic, but the
   `trackDispatchFailure` and `resetDispatchFailures` neighbors in
   `failure-tracker.ts` still call bare `store.save(task)` (lines 42, 154).
   The Phase 46 invariant ("metadata stamps that *accompany* status
   transitions go through `metadataPatch`") is preserved — these two
   functions don't move files, they just update counters. But the
   inconsistency is worth a comment, especially because future deadletter
   work might re-introduce a `save()+transition()` pair if the boundary
   isn't documented.

2. **WR-02** — `resetLogger()` calls `dest.end()` for the production path,
   but the test-injected `PassThrough` has both `.end()` and `.flushSync()`
   only by accident (PassThrough has `end`, no `flushSync`). The dynamic
   `"flushSync" in dest` check guards correctly. However, when a test
   passes a `PassThrough` via `__setLoggerTransportForTests`, the
   subsequent `resetLogger()` call invokes `passthrough.end()`, which
   destroys the stream. If a test's `afterEach` calls
   `__setLoggerTransportForTests(null)` BEFORE `resetLogger()` (as
   `logger.test.ts:21-25` does), the test-supplied stream is never `.end()`d.
   In that ordering nothing leaks, but it's brittle — a swap of those two
   afterEach lines would silently double-end the previous transport.

3. **WR-03** — `reconcileDrift` parses the current status out of the
   lint-issue string with a regex (`task-store.ts:220`). The same comment
   acknowledges the brittleness. Companion-dir rename silently degrades
   to "skipped" when the parse fails, with the `.md` rename still
   succeeding — non-data-loss but operationally confusing if the issue
   string format changes.

No Critical findings. No security vulnerabilities introduced. Path-traversal
risk on `frontmatter.status` in `reconcileDrift` is correctly blocked by
the `STATUS_DIRS.includes(targetStatus)` check; the daemon-side actor
injection adds defense-in-depth without trust assumptions on plugin input.

## Warnings

### WR-01: `failure-tracker.ts` neighbors still call bare `store.save()` — document the boundary

**File:** `src/dispatch/failure-tracker.ts:42, 154`

**Issue:** Phase 46 collapsed `transitionToDeadletter` from a `save() +
transition()` pair into a single `transition({ metadataPatch })` call to
close the partial-state window (the spin-loop bug). The block comment at
lines 80-95 is excellent. However, two adjacent functions in the same
file still use the old pattern:

- `trackDispatchFailure` (line 42): mutates `task.frontmatter.metadata.dispatchFailures`/`lastDispatchFailureReason`/`lastDispatchFailureAt`, then `await store.save(task)`.
- `resetDispatchFailures` (line 154): mutates several metadata fields, then `await store.save(task)`.

These are semantically different from `transitionToDeadletter` —
they don't move files between status directories, so there's no rename to
desync against the metadata write. But a future contributor reading this
file with the Phase 46 lens may either (a) wrongly conclude `save()` is
also unsafe and pile on unnecessary refactors, or (b) regress the
deadletter path by reintroducing a `save() + transition()` pair when
adding a new metadata field, since the file already has `save()` calls
that "look fine."

**Fix:** Add a one-liner inline comment at each `save()` call clarifying
the invariant. Example:

```typescript
// Track failure counter only — no status transition, no rename, so a
// bare save() is safe here. Phase 46's atomic transition+metadataPatch
// pattern only applies when status changes (see transitionToDeadletter).
await store.save(task);
```

This makes the boundary explicit and prevents the pattern from drifting.

### WR-02: `resetLogger()` afterEach ordering can double-end the test transport

**File:** `src/logging/index.ts:127-143`, `src/logging/__tests__/logger.test.ts:21-25`

**Issue:** `resetLogger()` reads the module-level `dest` variable and
calls `.end()` on it. The test-only escape hatch
`__setLoggerTransportForTests(stream)` injects a `PassThrough` into the
`testTransportOverride` slot, and `getRootLogger()` then assigns that
stream to `dest`. The current `logger.test.ts` afterEach does:

```typescript
afterEach(() => {
  __setLoggerTransportForTests(null);  // 1. Clear override
  resetLogger();                        // 2. Call .end() on dest (still the PassThrough)
  resetConfig();
});
```

This works because step 1 only clears the *override slot*, not the
already-assigned `dest`. Step 2 then ends the PassThrough exactly once.

But the ordering is load-bearing and undocumented. If a future test
swaps the order to `resetLogger(); __setLoggerTransportForTests(null);`
(which reads more naturally — "reset, then clear test state"), the
`.end()` call in `resetLogger` still hits the PassThrough that was
written into `dest` during the test, then a subsequent
`resetLogger()` call in beforeEach (line 17) might re-`.end()` the
already-ended stream. PassThrough's `.end()` is idempotent in practice,
but this is exactly the kind of "works because the streams library is
forgiving" pattern that breaks when someone swaps in a stricter
DestinationStream.

**Fix:** Either (a) add a brief comment in `resetLogger()` documenting
that callers must clear `__setLoggerTransportForTests(null)` AFTER
`resetLogger()`, or (b) make `resetLogger()` defensive — set `dest = null`
*before* calling `.end()` so a re-entrant call to `resetLogger()` is a
no-op:

```typescript
export function resetLogger(): void {
  const toEnd = dest;
  root = null;
  dest = null;
  if (toEnd) {
    if ("flushSync" in toEnd && typeof toEnd.flushSync === "function") {
      (toEnd as { flushSync: () => void }).flushSync();
    }
    if ("end" in toEnd && typeof (toEnd as { end: () => void }).end === "function") {
      (toEnd as { end: () => void }).end();
    }
  }
}
```

Option (b) is more robust against test-author error and matches the
"orphan vitest workers" pain point called out in CLAUDE.md.

### WR-03: `reconcileDrift` regex-parses the lint issue string — fragile contract

**File:** `src/store/task-store.ts:220`

**Issue:** `reconcileDrift` derives the *current* (on-disk) status from
the issue string returned by `lintTasks`:

```typescript
const match = issue.match(/but file in '(\w[\w-]*)\/'/);
const currentStatus =
  match && STATUS_DIRS.includes(match[1] as TaskStatus)
    ? (match[1] as TaskStatus)
    : undefined;
```

`task-validation.ts:100` formats the issue string as
`` `Status mismatch: frontmatter='${task.frontmatter.status}' but file in '${status}/'` ``.
A change to that format (e.g. swapping single quotes to backticks, or
reordering "frontmatter=" / "file in") silently makes the regex miss,
which makes `currentStatus` `undefined`, which skips the companion-dir
rename. The `.md` move still succeeds, so no data loss — but the
companion dir is orphaned at the old location until the next `init()`,
when it has nothing to migrate (the .md is already at the new location
with no drift), so the orphan persists indefinitely.

The inline comment acknowledges this and notes a more robust alternative:
parse `currentStatus` from `oldPath` itself by splitting on `/tasks/`.
That alternative is strictly better — `oldPath` is a structural input,
the issue string is a presentation artifact.

**Fix:** Replace the regex parse with structural extraction from
`oldPath`:

```typescript
// task.path is `<projectRoot>/tasks/<status>/<id>.md` — split on the
// hard-coded segment we control rather than on lintTasks' issue prose.
const segments = oldPath.split(`${this.tasksDir}/`);
const tail = segments[1]; // `<status>/<id>.md`
const currentStatus =
  tail && tail.includes("/")
    ? (tail.split("/")[0] as TaskStatus)
    : undefined;
const validatedCurrentStatus =
  currentStatus && STATUS_DIRS.includes(currentStatus) ? currentStatus : undefined;
```

This decouples reconciliation from the lint message format. The lint
function can change its prose freely; reconciliation will keep working.

## Info

### IN-01: Comment update needed in `transitionToDeadletter` line 87-95

**File:** `src/dispatch/failure-tracker.ts:80-95`

**Issue:** The block comment is excellent but contains one mildly
misleading phrase: "Atomic application via the existing TaskLocks per-task
mutex makes the partial-state structurally impossible." The TaskLocks
mutex serializes concurrent `transition()` calls — that's not what makes
the partial-state impossible. What closes the window is that
`transitionTask` applies the `metadataPatch` to in-memory frontmatter
*before* the `writeFileAtomic` of the new-location file (lines 184-189
in `task-mutations.ts`), so the metadata stamp lands atomically with
the new file, not separately.

**Fix:** Tighten the comment:

```text
// Atomic via the metadataPatch path: task-mutations.transitionTask
// applies the patch to in-memory frontmatter BEFORE writeFileAtomic
// at the new location, so the metadata stamp and the file move land
// in the same on-disk write. The TaskLocks mutex prevents concurrent
// transitions on the same task; the metadataPatch ordering is what
// closes the partial-state window.
```

### IN-02: `discoverProjects` is called twice when `start()` runs

**File:** `src/service/aof-service.ts:148-167, 304-341`

**Issue:** `start()` calls `initializeProjects()` (which calls
`discoverProjects(vaultRoot)`), then calls `triggerPoll("startup")`,
which dispatches into `runPoll()`, which calls `rediscoverProjects()`,
which calls `discoverProjects(vaultRoot)` *again*. The second call is
redundant on the very first poll because `initializeProjects` just
populated `projectStores` from the same scan.

This is intentional and harmless — `discoverProjects` is microseconds,
and the duplication is the cost of "rediscovery runs as the first step
of every poll, no special-case at startup." But it's worth a brief note
acknowledging the duplication so a future optimizer doesn't conclude
there's a bug.

**Fix:** Add a comment near `initializeProjects()` explaining that the
first poll's `rediscoverProjects()` is a redundant-but-cheap scan, kept
for code-path uniformity:

```typescript
// First poll's rediscoverProjects() will redundantly scan vaultRoot
// (initializeProjects just did). Kept this way for code-path uniformity:
// every runPoll() begins with rediscovery — no startup-vs-running branch.
await this.initializeProjects();
```

### IN-03: `aofDispatch` `actor` defaults to `"unknown"` even after Phase 46

**File:** `src/tools/project-tools.ts:161`

**Issue:** Line 161: `const actor = input.actor ?? "unknown";`. After Phase
46's daemon-side and plugin-side actor injection, `input.actor` should
almost always be populated. But if both the IPC envelope and the
plugin-side `mergeDispatchNotificationRecipient` fail to populate it
(e.g., MCP path with no `actor` set, or a custom adapter), the task lands
with `createdBy: "unknown"`, which is the exact debuggability gap Bug 2C
was supposed to close.

This isn't a regression — it's the documented fallback. But the comment
in `invoke-tool.ts:170-175` says "MCP path is unaffected because MCP
constructs its own envelope with its own `actor: "mcp"`," which suggests
MCP always passes an actor. Worth a one-liner regression test in
`aof-tools-persistence.test.ts` asserting that the `unknown` default
*never* reaches the file in the standard daemon+plugin path.

**Fix:** Add a small assertion in
`bug-046e-actor-injection.test.ts` (daemon path) and
`bug-046e-dispatch-notification-actor.test.ts` (plugin path) that
follows up by reading the resulting task file from disk and asserting
`createdBy !== "unknown"`. This catches the case where the actor is
correctly injected at the IPC layer but a downstream handler change
strips it before reaching `store.create()`.

### IN-04: `bug-005-tool-persistence.test.ts` — Phase 46 actor coverage gap

**File:** `src/integration/__tests__/bug-005-tool-persistence.test.ts:36-148`

**Issue:** All `aofDispatch` calls pass `actor: "bug-005-test"` or
`actor: "test"` explicitly, so the test never exercises the
`actor: undefined` → daemon-injection path. That's appropriate for
BUG-005 scope (persistence), but worth noting that no test in this file
catches a regression of Bug 2C's daemon-side actor injection.

`bug-046e-actor-injection.test.ts` covers the IPC envelope behavior with
a mock handler. `bug-046e-dispatch-notification-actor.test.ts` covers the
plugin-side merge function. Neither asserts the *end-to-end* outcome:
"caller passes no actor, IPC envelope carries it, persisted task
frontmatter has `createdBy === <envelope.actor>`."

**Fix:** Optional follow-on test (out of Phase 46 acceptance scope, but
worth noting): an integration test that drives the full IPC →
`aofDispatch` → `store.create` chain with an envelope-only actor and
asserts the resulting task's `createdBy` field. The phase's existing
unit tests cover both halves; an integration test would catch a future
refactor that severs the connection between them.

### IN-05: `transitionTask` rollback `unlink(newPath).catch(() => {})` swallows errors silently

**File:** `src/store/task-mutations.ts:231-234`

**Issue:** When companion-dir rename fails and we roll back the
new-location `.md` write, the `unlink(newPath).catch(() => {})` swallows
all errors silently. If the unlink fails (e.g., because writeFileAtomic
left a partial file the unlink can't clean up due to a permission
change), the on-disk state ends up with both old AND new files present —
the duplicate-file state. The inline comment acknowledges this and
notes startup reconciliation will clean it up.

That's acceptable behavior, but the swallowed error means no log line
fires when this happens. If a deployment encounters this systematically
(e.g., due to a permissions bug elsewhere), there's no signal in the
daemon log.

**Fix:** Log a warn before swallowing:

```typescript
await unlink(newPath).catch((cleanupErr) => {
  // Best-effort rollback; if this also fails the next startup
  // reconciliation will clean up. Log so we have a signal if this
  // happens repeatedly in production.
  storeLog.warn(
    { taskId: id, newPath, err: cleanupErr },
    "rollback unlink failed — duplicate-file state will be reconciled at next init()",
  );
});
```

(`storeLog` is not in scope here since this is `task-mutations.ts`, not
`task-store.ts`. Plumbing one in is mildly invasive — a smaller fix is to
attach the error to the originating `throw err` as a secondary `cause`
so the upstream caller's logger sees both.)

---

_Reviewed: 2026-04-25T16:18:24Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
