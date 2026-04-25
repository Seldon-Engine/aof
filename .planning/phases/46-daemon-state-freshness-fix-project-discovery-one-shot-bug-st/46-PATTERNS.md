# Phase 46: Daemon state freshness — Pattern Map

**Mapped:** 2026-04-24
**Files analyzed:** 14 source/test files (modified or new)
**Analogs found:** 14 / 14 — every modified site and every new test has a strong existing analog in tree

---

## File Classification

### Source files

| New / Modified | Role | Data flow | Closest analog | Match quality |
|----------------|------|-----------|----------------|---------------|
| `src/store/task-mutations.ts` (MOD) — extend `TransitionOpts` with `metadataPatch` | store/mutation primitive | filesystem-rename-write | self (`transitionTask` already lives here) | exact |
| `src/store/interfaces.ts` (MOD) — extend `ITaskStore.transition` opts shape | store/contract | filesystem-rename-write | self (sibling fields `reason`, `agent`, `blockers` already declared there) | exact |
| `src/store/task-store.ts` (MOD) — call `reconcileDrift()` from `init()` | store/init | filesystem-walk | `lintTasks` (`task-validation.ts`) — same walk shape, read-only today | role-match (extends an existing read into a read-and-fix) |
| `src/store/task-reconciliation.ts` (NEW, optional extraction) | store/init | filesystem-walk + atomic rename | `lintTasks` (`task-validation.ts`) | role-match |
| `src/dispatch/failure-tracker.ts` (MOD) — collapse `save()`+`transition()` into one transition with `metadataPatch` | dispatch/lifecycle | request-response (called from `assign-helpers.ts`) | self (the function being modified) — see also `task-lifecycle.ts:cancelTask` for "set metadata, then transition" pattern done correctly | exact |
| `src/service/aof-service.ts` (MOD) — add `rediscoverProjects()` step in `runPoll()` | service/scheduler | request-response (per-poll diff) | self (`initializeProjects` + `pollAllProjects`) | exact |
| `src/logging/index.ts` (MOD) — wire `pino-roll` transport, drop `fd:2` | logging/factory | streaming (pino transport worker thread) | self (`getRootLogger` is the only function in this file) | exact |
| `src/config/registry.ts` (MOD, OPTIONAL) — add `core.logging` block | config/schema | static | self (sibling `core` fields like `dataDir`, `logLevel`) | exact |
| `src/tools/project-tools.ts` (MOD) — `aofDispatch`: validate routing target, default from project owner with `system` sentinel exception | tool/handler | request-response | self — same handler, with the `dependsOn` validator already in it as the structural template (lines 168-179) | exact |
| `src/ipc/routes/invoke-tool.ts` (MOD) — inject envelope `actor` into `inner.data` before `def.handler` | ipc/route | request-response | self — same route, see line 108 (`actor` already destructured but unused beyond `resolveStore`) and line 166 (`def.handler` call site) | exact |
| `src/openclaw/dispatch-notification.ts` (MOD, defense-in-depth) — fall back `params.actor` to `captured.actor` for `aof_dispatch` | openclaw/plugin-side enrichment | request-response | self (the existing `mergeDispatchNotificationRecipient` function does the exact same shape of enrichment for `notifyOnCompletion`) | exact |
| `package.json` / `package-lock.json` (MOD) — add `pino-roll@4` dep | build | static | self (sibling deps like `pino`, `write-file-atomic`) | exact |
| `~/Library/LaunchAgents/ai.openclaw.aof.plist` (REFERENCE ONLY, NOT committed) | platform-config | static | `src/daemon/service-file.ts:175-200` (the generator) | role-match (deploy-time concern; documented in plan, not committed) |

### Test files

| NEW test | Closest existing test | Match quality |
|----------|-----------------------|---------------|
| `src/store/__tests__/bug-046a-atomic-transition.test.ts` | `src/dispatch/__tests__/deadletter-frontmatter-stamp.test.ts` (BUG-005 stamp test — same domain, same `transitionToDeadletter` flow) AND `src/store/__tests__/task-store-concurrent-transition.test.ts` (race semantics) | exact |
| `src/store/__tests__/bug-046a-startup-reconciliation.test.ts` | `src/store/__tests__/task-store-duplicate-recovery.test.ts` (planted-files fixture, mtimes, recovery on `get()`) | exact — same "plant a misfiled file then call store API and assert it self-heals" shape |
| `src/service/__tests__/bug-046b-project-rediscovery.test.ts` | `src/service/__tests__/multi-project-polling.test.ts` (full `AOFService` boot, `TestExecutor`, fixture project layout) | exact |
| `src/logging/__tests__/rotation.test.ts` (NEW) | `src/logging/__tests__/logger.test.ts` (`PassThrough` capture, `resetLogger` + `resetConfig` discipline) | role-match — same logging factory under test, but rotation needs `pino-roll` config sniff rather than capturing output |
| `src/tools/__tests__/bug-046b-routing-required.test.ts` (NEW) | `src/tools/__tests__/aof-dispatch-dependson-validation.test.ts` (same handler, rejection + non-rejection + "no file written" assertions) | exact — copy this test file structure 1:1 |
| `src/ipc/__tests__/bug-046c-actor-injection.test.ts` (NEW, OR extend existing) | `src/ipc/__tests__/invoke-tool-handler.test.ts` (UDS server bootstrap, `postSocket` helper, mock tool registry) | exact |

---

## Pattern Assignments

### `src/store/task-mutations.ts` — extend `TransitionOpts` with `metadataPatch`

**Analog:** self. The function and opts type already live here. Extend in place.

**Existing `TransitionOpts` shape** (`src/store/task-mutations.ts:110-113`):

```typescript
export interface TransitionOpts {
  reason?: string;
  agent?: string;
}
```

Note: `ITaskStore.transition` opts in `src/store/interfaces.ts:104` declare a third field `blockers?: string[]` that's not actually in `TransitionOpts` — there's an existing minor schema drift to be aware of, do NOT "fix" this incidentally.

**Existing transition body, the insertion point for `metadataPatch`** (`src/store/task-mutations.ts:142-170`):

```typescript
export async function transitionTask(
  id: string,
  newStatus: TaskStatus,
  opts: TransitionOpts | undefined,
  getTask: (id: string) => Promise<Task | null | undefined>,
  getTaskPath: (id: string, status: TaskStatus) => string,
  getTaskDir: (id: string, status: TaskStatus) => string,
  logger?: TaskLogger,
  hooks?: TaskStoreHooks,
): Promise<Task> {
  const task = await getTask(id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }

  const currentStatus = task.frontmatter.status;

  // Idempotent: if already in target state, return early (no-op)
  if (currentStatus === newStatus) {
    return task;
  }

  if (!isValidTransition(currentStatus, newStatus)) {
    throw new Error(
      `Invalid transition: ${currentStatus} → ${newStatus} for task ${id}`,
    );
  }

  const now = new Date().toISOString();
  task.frontmatter.status = newStatus;
  task.frontmatter.updatedAt = now;
  task.frontmatter.lastTransitionAt = now;
```

**Pattern to apply:** between the `lastTransitionAt` assignment and the `lease` clearing (line 167), apply the metadata patch:

```typescript
// Apply caller-supplied metadata patch atomically with the rename.
// Used by failure-tracker.transitionToDeadletter to stamp deadletter
// cause fields without a separate save() call.
if (opts?.metadataPatch) {
  task.frontmatter.metadata = {
    ...task.frontmatter.metadata,
    ...opts.metadataPatch,
  };
}
```

**Existing rename-then-write pattern (post-`6fbcb18` v1.16.3 hardening — DO NOT REINVENT)** (`src/store/task-mutations.ts:174-226`): write-new-then-delete-old, with rollback if companion-dir rename fails. The `metadataPatch` change reuses this — the patched metadata gets baked into the new-location `writeFileAtomic(newPath, serializeTask(task))` at line 194. **Critical:** apply the patch BEFORE `writeFileAtomic` so the new file lands with the patched frontmatter on first write. Idempotent early-return at line 151 should NOT skip the patch — but per CONTEXT.md, this is fine because the failure-tracker only calls transition when the task is in a non-terminal state and going to deadletter; the no-op branch isn't on the failure path. Document this reasoning in code comment.

---

### `src/store/interfaces.ts` — extend `ITaskStore.transition` opts shape

**Analog:** self. **Existing signature** (`src/store/interfaces.ts:101-105`):

```typescript
transition(
  id: string,
  newStatus: TaskStatus,
  opts?: { reason?: string; agent?: string; blockers?: string[] },
): Promise<Task>;
```

**Pattern to apply:** add `metadataPatch?: Record<string, unknown>` as a fourth field. This is an additive interface change with zero call-site breakage (all existing callers pass nothing, or `{ reason }`, or `{ reason, agent }`). The `Record<string, unknown>` shape mirrors how `TaskFrontmatter.metadata` is typed throughout the codebase (`task.frontmatter.metadata.dispatchFailures as number | undefined` style coercion at call sites).

---

### `src/store/task-store.ts` — invoke `reconcileDrift()` from `init()`

**Analog:** the existing `init()` and the existing `lintTasks` reuse pattern.

**Existing `init()` body** (`src/store/task-store.ts:148-153`):

```typescript
/** Ensure all status directories exist. */
async init(): Promise<void> {
  for (const status of STATUS_DIRS) {
    await mkdir(join(this.tasksDir, status), { recursive: true });
  }
}
```

**Existing `lint()` already in the class** (`src/store/task-store.ts:556-558`):

```typescript
async lint(): Promise<Array<{ task: Task; issue: string }>> {
  return lintTasks(this.tasksDir, this.statusDir.bind(this), this.logger);
}
```

**Pattern to apply:** add a private `reconcileDrift()` method after `init()`, call it at the tail of `init()`. The walk MUST use `parseTaskFile(rawContent, filePath)` directly on each enumerated file (NOT `this.get(id)`) — see Pitfall 4 in RESEARCH.md: `get()`'s mtime-wins self-heal will delete files mid-walk if you call it inside the loop. Use `lintTasks` to detect mismatches (it already returns `Status mismatch:` issues — see `task-validation.ts:96-102`):

```typescript
import { rename } from "node:fs/promises";

async init(): Promise<void> {
  for (const status of STATUS_DIRS) {
    await mkdir(join(this.tasksDir, status), { recursive: true });
  }
  await this.reconcileDrift();
}

private async reconcileDrift(): Promise<void> {
  const issues = await this.lint();
  for (const { task, issue } of issues) {
    if (!issue.startsWith("Status mismatch:")) continue;
    const targetStatus = task.frontmatter.status;
    if (!STATUS_DIRS.includes(targetStatus)) {
      storeLog.warn(
        { taskId: task.frontmatter.id, status: targetStatus, op: "reconcile" },
        "frontmatter status not in known dirs — leaving file in place",
      );
      continue;
    }
    const oldPath = task.path!;
    const newPath = this.taskPath(task.frontmatter.id, targetStatus);
    // Use rename for the .md, AND attempt the companion-dir rename — the
    // existing transition() handles companion-dir movement (see
    // task-mutations.ts:196-212). We DELIBERATELY do not call
    // store.transition() here because reconciliation runs at boot, before
    // the per-task mutex makes sense (no concurrent traffic), and because
    // transition() would re-run isValidTransition() which may reject the
    // move (e.g. ready -> deadletter is valid only via specific paths).
    // Reconciliation is "trust the frontmatter" — make on-disk match.
    await mkdir(dirname(newPath), { recursive: true });
    await rename(oldPath, newPath);
    // Companion dir, best-effort
    const oldDir = this.taskDir(task.frontmatter.id, /* infer-from-old-path */);
    const newDir = this.taskDir(task.frontmatter.id, targetStatus);
    await rename(oldDir, newDir).catch(() => { /* missing dir is fine */ });
    storeLog.info(
      { taskId: task.frontmatter.id, from: oldPath, to: newPath, op: "reconcile" },
      "reconciled task file to match frontmatter status",
    );
  }
}
```

**Status-dir enum to reuse** (`src/store/task-store.ts:33-42`):

```typescript
const STATUS_DIRS: readonly TaskStatus[] = [
  "backlog", "ready", "in-progress", "blocked",
  "review", "done", "cancelled", "deadletter",
] as const;
```

(The same array is duplicated in `src/store/task-validation.ts:15-24` — don't worry about deduplication, this is project pattern.)

**Caller-side wiring (multi-project store init in service):** `AOFService.initializeProjects()` at `src/service/aof-service.ts:275` already calls `await store.init()` per project — reconciliation runs automatically, no caller change needed for project stores. The unscoped base store at `src/service/aof-service.ts:152` (`await this.store.init()`) also benefits automatically.

---

### `src/dispatch/failure-tracker.ts` — collapse `save()` + `transition()` into single atomic transition

**Analog:** self — the function being modified.

**Current shape** (`src/dispatch/failure-tracker.ts:80-97` — the bug):

```typescript
// BUG-005: stamp the deadletter cause into the task's own frontmatter
// metadata, not just the event log. ... [comment unchanged]
task.frontmatter.metadata = {
  ...task.frontmatter.metadata,
  deadletterReason,
  deadletterLastError: lastFailureReason,
  deadletterErrorClass: errorClass,
  deadletterAt: deadletteredAt,
  deadletterFailureCount: failureCount,
};
await store.save(task);                               // ← step 1

// Transition task to deadletter status
await store.transition(taskId, "deadletter");         // ← step 2 — non-atomic gap
```

**Pattern to apply:** collapse to one call passing the metadata via `metadataPatch`. The BUG-005 comment must be preserved (or rewritten to reflect the new atomicity). The post-transition `eventLogger.log("task.deadlettered", ...)` and the `log.error` ops alert (lines 101-122) stay UNCHANGED — they're correct as-is.

```typescript
// BUG-005 + BUG-046a (Phase 46): stamp the deadletter cause into the task's
// own frontmatter metadata atomically with the file move. Coordinators
// triaging via aof_status_report need the failure summary on the task
// itself; before Phase 46 the stamp + rename were two awaits and a crash
// between them left the file in tasks/ready/ with frontmatter.status:
// deadletter — the spin-loop bug from the 2026-04-24 incident.
await store.transition(taskId, "deadletter", {
  reason: deadletterReason,
  metadataPatch: {
    deadletterReason,
    deadletterLastError: lastFailureReason,
    deadletterErrorClass: errorClass,
    deadletterAt: deadletteredAt,
    deadletterFailureCount: failureCount,
  },
});
```

**Cross-check:** `trackDispatchFailure` (`src/dispatch/failure-tracker.ts:23-43`) and `resetDispatchFailures` (lines 128-147) ALSO use `store.save()` for metadata-only writes. Those are NOT part of the Phase 46 fix — they don't move files, so they don't have the split-state bug. Leave them alone.

---

### `src/service/aof-service.ts` — add `rediscoverProjects()` to `runPoll()`

**Analog:** the existing `initializeProjects()` (`src/service/aof-service.ts:257-280`) — same construction shape, plus the existing `pollAllProjects()` for the iteration loop.

**Existing `runPoll()`** (`src/service/aof-service.ts:389-433`):

```typescript
private async runPoll(): Promise<void> {
  const start = performance.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), this.pollTimeoutMs);

  try {
    const pollPromise = this.vaultRoot && this.projectStores.size > 0
      ? this.pollAllProjects()
      : this.poller(this.store, this.logger, this.schedulerConfig);

    const result = await Promise.race([pollPromise, /* timeout */]);
    /* ... */
  } catch (err) { /* ... */ }
  finally { /* ... */ }
}
```

**Existing `initializeProjects` (the construction template to mirror)** (`src/service/aof-service.ts:257-280`):

```typescript
private async initializeProjects(): Promise<void> {
  if (!this.vaultRoot) return;

  this.projects = await discoverProjects(this.vaultRoot);

  for (const project of this.projects) {
    if (project.error) {
      svcLog.warn({ projectId: project.id, error: project.error }, "skipping project");
      continue;
    }

    const store = new FilesystemTaskStore(project.path, {
      projectId: project.id,
      hooks: this.createStoreHooks(project.path),
      logger: this.logger,
    });

    await store.init();
    this.projectStores.set(project.id, store);
  }

  svcLog.info({ count: this.projectStores.size }, "initialized project stores");
}
```

**Existing serialization guard (already in place — DON'T add a second one)** (`src/service/aof-service.ts:82, 251-255`):

```typescript
private pollQueue: Promise<void> = Promise.resolve();
// ...
private async triggerPoll(_reason: string): Promise<void> {
  if (!this.running) return;
  this.pollQueue = this.pollQueue.then(() => this.runPoll());
  return this.pollQueue;
}
```

**Confirmed:** `runPoll()` is serialized through `pollQueue`, so calling `rediscoverProjects()` as the first line of `runPoll()` runs strictly before the next `pollAllProjects()` and never overlaps with another poll. No new locks required (RESEARCH.md Pitfall 2).

**Pattern to apply:** add a private `rediscoverProjects()` method that mirrors the construction template above but diffs against `this.projectStores`. Call it as the first step in `runPoll()` (right after the `start = performance.now()` line), guarded on `this.vaultRoot` so the unscoped-mode path is unaffected:

```typescript
private async rediscoverProjects(): Promise<void> {
  if (!this.vaultRoot) return;

  const discovered = await discoverProjects(this.vaultRoot);
  const discoveredIds = new Set(discovered.map(p => p.id));
  const knownIds = new Set(this.projectStores.keys());

  // Add new projects (skip those with manifest errors — same as init)
  for (const project of discovered) {
    if (this.projectStores.has(project.id) || project.error) continue;

    const store = new FilesystemTaskStore(project.path, {
      projectId: project.id,
      hooks: this.createStoreHooks(project.path),
      logger: this.logger,
    });
    await store.init();   // includes Phase 46 reconcileDrift() for the new store
    this.projectStores.set(project.id, store);
    svcLog.info({ projectId: project.id, op: "rediscover" }, "registered new project");
  }

  // Remove vanished projects. In-flight tasks under that project will
  // surface during their next per-task operation as "task not found";
  // the lease/orphan reconciliation in reconcileOrphans() handles cleanup.
  for (const id of knownIds) {
    if (!discoveredIds.has(id)) {
      this.projectStores.delete(id);
      svcLog.info({ projectId: id, op: "rediscover" }, "deregistered vanished project");
    }
  }
}
```

**Insertion point in `runPoll()`** (line 394, just after `try {`):

```typescript
try {
  await this.rediscoverProjects();   // ← NEW Phase 46 / Bug 2A

  const pollPromise = this.vaultRoot && this.projectStores.size > 0
    ? this.pollAllProjects()
    : this.poller(this.store, this.logger, this.schedulerConfig);
  // ...
}
```

---

### `src/logging/index.ts` — wire `pino-roll` transport, drop `fd: 2`

**Analog:** self.

**Current full file** (`src/logging/index.ts:1-65`) — entire file is small; the function being modified is `getRootLogger()` at lines 21-34:

```typescript
let root: Logger | null = null;
let dest: DestinationStream | null = null;

function getRootLogger(): Logger {
  if (root) return root;

  const { core } = getConfig();
  dest = pino.destination({ fd: 2, sync: false });
  root = pino(
    {
      level: core.logLevel,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    dest,
  );
  return root;
}
```

**Existing `resetLogger()` for test isolation** (`src/logging/index.ts:56-62`) — preserve this; the new transport stream needs the same `flushSync` discipline. `pino.transport()` returns a worker-thread-backed stream with `.end()` semantics; ensure `resetLogger()` calls `dest.end()` (or equivalent) for the rotation transport too, otherwise the test suite leaks worker threads (orphan vitest worker hazard from CLAUDE.md).

**Pattern to apply (Option A from RESEARCH.md — drop `fd: 2`):**

```typescript
import pino, { type Logger, type DestinationStream } from "pino";
import { join } from "node:path";
import { getConfig } from "../config/registry.js";
import { resolveDataDir } from "../config/paths.js";

let root: Logger | null = null;
let dest: DestinationStream | null = null;

function getRootLogger(): Logger {
  if (root) return root;

  const { core } = getConfig();
  const logsDir = join(resolveDataDir(), "logs");

  // Phase 46 / Bug 1C: bounded log file with size-based rotation.
  // Replaces unbounded write-to-stderr (which launchd captured into
  // daemon-stderr.log and grew to 172 MB over 6 days).
  // Worker-thread isolation via pino.transport — does not block the
  // event loop on disk IO.
  dest = pino.transport({
    target: "pino-roll",
    options: {
      file: join(logsDir, "aof.log"),
      size: "50m",
      limit: { count: 5 },
      mkdir: true,           // pino-roll silently fails without this
    },
  });

  root = pino(
    {
      level: core.logLevel,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    dest,
  );
  return root;
}
```

**`resetLogger()` change** (the existing implementation calls `flushSync` on the destination):

```typescript
export function resetLogger(): void {
  if (dest) {
    if ("flushSync" in dest && typeof dest.flushSync === "function") {
      (dest as { flushSync: () => void }).flushSync();
    }
    // Phase 46: pino-roll's transport stream is worker-backed; .end()
    // releases the worker so the test suite doesn't leak threads
    // (CLAUDE.md "orphan vitest workers" hazard).
    if ("end" in dest && typeof (dest as { end: () => void }).end === "function") {
      (dest as { end: () => void }).end();
    }
  }
  root = null;
  dest = null;
}
```

**`config/registry.ts` schema extension (OPTIONAL but recommended)** — add a `logging` block under `core`:

```typescript
// in AofConfigSchema.core
logging: z
  .object({
    file: z.string().optional(),                                // overrides default <dataDir>/logs/aof.log
    sizeLimit: z.string().default("50m"),
    fileCount: z.coerce.number().int().positive().default(5),
  })
  .default({}),
```

If config knobs are added, also extend `KNOWN_AOF_VARS` (line 104) and `readEnvInput()` (line 134) with corresponding `AOF_LOG_FILE`, `AOF_LOG_FILE_SIZE`, `AOF_LOG_FILE_COUNT` entries — defaults must mean "no opt-in required" (CONTEXT.md decision).

---

### `src/tools/project-tools.ts` — `aofDispatch` routing validation + project-owner default

**Analog:** self. Two structural templates already inside this file:

**Template 1 — existing validation rejection pattern** (`src/tools/project-tools.ts:154-179`):

```typescript
// Validate required fields
if (!input.title || input.title.trim().length === 0) {
  throw new Error("Task title is required");
}

const brief = input.brief || input.description || "";
if (!brief || brief.trim().length === 0) {
  throw new Error("Task brief/description is required");
}

// Validate dependsOn: every referenced task must exist in the store before
// the new task is created. Silently accepting bogus IDs produced tasks in
// a permanently-blocked dependency state ... (BUG-004 sub-issue A).
if (input.dependsOn && input.dependsOn.length > 0) {
  const missing: string[] = [];
  for (const blockerId of input.dependsOn) {
    const blocker = await ctx.store.get(blockerId);
    if (!blocker) missing.push(blockerId);
  }
  if (missing.length > 0) {
    throw new Error(
      `dependsOn references nonexistent task${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    );
  }
}
```

This is the **exact** structural pattern to copy: `throw new Error(...)` BEFORE `ctx.store.create(...)`. The error string convention is "what was wrong + what the caller can do."

**Template 2 — existing routing object construction** (`src/tools/project-tools.ts:203-217`):

```typescript
const readyTask = await ctx.store.create({
  title: input.title.trim(),
  body: brief.trim(),
  priority,
  routing: {
    agent: input.agent,
    team: input.team,
    role: input.role,
  },
  // ...
  createdBy: actor,
  initialStatus: "ready",
});
```

**Pattern to apply** — insert between brief validation (line 161) and `dependsOn` validation (line 168), OR right after `dependsOn` (your call; both work). Per RESEARCH.md and CONTEXT.md addendum Q3, treat `"system"` as a sentinel:

```typescript
// Phase 46 / Bug 2B: routing-target validation. A task with neither agent
// nor team nor role can never dispatch — the scheduler rejects it on
// every poll (see src/dispatch/task-dispatcher.ts:241-258 "tags-only
// routing not supported"). Reject at create-time so the caller gets a
// clear error instead of a silent task that sits in ready/ forever.
let agent = input.agent;
let team = input.team;
let role = input.role;

if (!agent && !team && !role) {
  // Try defaulting from project owner before rejecting.
  // CONTEXT.md addendum Q3: "system" is a sentinel for "no real owner";
  // do NOT default from it (would just swap one routing failure for another).
  const projectId = input.project ?? ctx.projectId;
  if (projectId) {
    try {
      const manifest = await loadProjectManifest(ctx.store, projectId);
      const lead = manifest?.owner?.lead;
      const ownerTeam = manifest?.owner?.team;
      if (lead && lead.toLowerCase() !== "system") {
        agent = lead;
      } else if (ownerTeam && ownerTeam.toLowerCase() !== "system") {
        team = ownerTeam;
      }
    } catch {
      // Manifest load failure is non-fatal; fall through to rejection.
    }
  }
}

if (!agent && !team && !role) {
  throw new Error(
    "Task creation requires a routing target. " +
    "Provide one of: agent, team, role. Tags-only routing is not supported " +
    "(would never dispatch).",
  );
}
```

Then update the `routing` literal in the existing `ctx.store.create({ ... })` call at line 207 to use the (possibly defaulted) local variables:

```typescript
routing: { agent, team, role },   // was: { agent: input.agent, team: input.team, role: input.role }
```

**New import required** — `loadProjectManifest` is NOT currently imported into `project-tools.ts`. Add:

```typescript
import { loadProjectManifest } from "../projects/manifest.js";
```

**`loadProjectManifest` signature reference** (`src/projects/manifest.ts:115-134`): takes `(store, projectId)`, returns `Promise<ProjectManifest | null>`. Returns `null` for unscoped stores (BUG-044) and on any read/parse error (logs a warn). The `try/catch` above is defense-in-depth — even though the function doesn't throw today, callers shouldn't assume that.

**Project-owner shape reference** (`src/projects/manifest.ts:17-30` and the `_inbox` placeholder at `src/projects/registry.ts:166-167`):

```typescript
owner: { team: "system", lead: "system" }   // placeholder for "no real owner"
```

The `system` sentinel must be matched **case-insensitively** per CONTEXT.md addendum Q3.

---

### `src/ipc/routes/invoke-tool.ts` — inject envelope `actor` into `inner.data`

**Analog:** self.

**Existing envelope parse** (`src/ipc/routes/invoke-tool.ts:97-108`):

```typescript
const envelope = InvokeToolRequest.safeParse(rawJson);
if (!envelope.success) { /* 400 */ return; }
const { name, params, actor, projectId, toolCallId, correlationId } = envelope.data;
```

`actor` is destructured but its only downstream use today is `deps.resolveStore({ actor, projectId })` at line 136. It is NEVER injected into `inner.data` before `def.handler(ctx, inner.data)` at line 166 — that's the gap from the post-mortem.

**Existing inner-params parse** (`src/ipc/routes/invoke-tool.ts:121-131`):

```typescript
const inner = def.schema.safeParse(params);
if (!inner.success) { /* 400 */ return; }
```

After this point, `inner.data` is the typed object. For `aof_dispatch`, its schema (`src/tools/project-tools.ts:18-48`) has `actor: z.string().optional()`.

**Existing handler dispatch** (`src/ipc/routes/invoke-tool.ts:164-167`):

```typescript
// --- Dispatch ---
try {
  const result = await def.handler(ctx, inner.data);
  sendJson(res, 200, { result });
}
```

**Pattern to apply:** between the `inner` parse (line 131) and the handler call (line 166), enrich `inner.data` with the envelope `actor` if the tool input doesn't override it:

```typescript
// Phase 46 / Bug 2C: inject envelope actor into params when caller didn't
// supply one. Closes the createdBy: "unknown" gap on plugin-originated
// aof_dispatch (the OpenClaw plugin sets envelope.actor from the
// invocation context but the daemon-side route never propagated it
// down to the handler input). actor on the envelope is authoritative
// when present; an explicit input.actor still wins (caller-supplied
// identity overrides envelope-derived one).
const enrichedParams: Record<string, unknown> = {
  ...inner.data,
  ...(actor && (inner.data as { actor?: string }).actor === undefined
    ? { actor }
    : {}),
};
```

Then change the handler call at line 166 to pass `enrichedParams`:

```typescript
const result = await def.handler(ctx, enrichedParams);
```

**Caveat — type alignment:** `def.handler` is typed via the `ToolRegistry`'s per-tool `schema` inference. Spreading into `Record<string, unknown>` widens the type — most tools either re-validate or treat the parameter object loosely (`AOFDispatchInput` is an `interface` not a Zod-inferred type, so passing the wider object compiles). If TypeScript complains, cast the enriched value back to `inner.data`'s type with `as typeof inner.data` — that's the existing project pattern (see `src/ipc/routes/invoke-tool.ts:148-162` ToolContext assembly which already uses `as ...` casts).

---

### `src/openclaw/dispatch-notification.ts` — defense-in-depth `params.actor` fallback

**Analog:** self. The function `mergeDispatchNotificationRecipient` already does this exact shape of plugin-side enrichment for `notifyOnCompletion`.

**Existing function** (`src/openclaw/dispatch-notification.ts:19-65`) — already consumes `OpenClawToolInvocationContextStore.consumeToolCall(toolCallId)` to get `captured` (which has `actor: agentId`, see `src/openclaw/tool-invocation-context.ts:132-138`).

**Adapter call site** (`src/openclaw/adapter.ts:110-124`):

```typescript
execute: async (id, params) => {
  const p =
    name === "aof_dispatch"
      ? mergeDispatchNotificationRecipient(params, id, invocationContextStore)
      : params;
  const response = await client.invokeTool({
    pluginId: "openclaw",
    name,
    params: p,
    actor: p.actor as string | undefined,        // ← envelope actor sourced from p.actor
    projectId: (p.project ?? p.projectId) as string | undefined,
    correlationId: randomUUID(),
    toolCallId: id,
    callbackDepth: parseCallbackDepth(p),
  });
```

**The gap:** `mergeDispatchNotificationRecipient` does NOT touch `params.actor`. So if the OpenClaw agent calls `aof_dispatch` without explicit `actor`, `p.actor` is `undefined` and the envelope's `actor` field is `undefined` too. The Phase 46 daemon-side fix above (`invoke-tool.ts`) makes that gap less harmful (no envelope actor → handler still gets `actor: "unknown"`), but defense-in-depth is to populate it on the plugin side from the captured invocation context.

**Pattern to apply** — inside `mergeDispatchNotificationRecipient`, after `consumeToolCall`, inject `actor` if not already set. **CRITICAL caveat:** `consumeToolCall` already removes the entry from the store; if you also want to read it later (you don't), it's gone. For Phase 46, fold the `actor` injection into the same call:

```typescript
export function mergeDispatchNotificationRecipient(
  params: Record<string, unknown>,
  toolCallId: string,
  store: OpenClawToolInvocationContextStore,
): Record<string, unknown> {
  const raw = params.notifyOnCompletion;
  const skipNotify = raw === false;

  // Phase 46 / Bug 2C defense-in-depth: even when the caller has notifyOnCompletion=false,
  // we still want createdBy populated from the captured agentId. Look up the route
  // before the early-return so a single consume call serves both purposes.
  const captured = store.consumeToolCall(toolCallId);

  // actor injection: explicit input.actor wins; otherwise fall back to captured.actor
  // (which is the agentId from the OpenClaw before_tool_call event — see
  // tool-invocation-context.ts:132-138).
  const enriched: Record<string, unknown> =
    typeof params.actor === "string" && params.actor.length > 0
      ? params
      : captured?.actor
        ? { ...params, actor: captured.actor }
        : params;

  if (skipNotify) return enriched;

  // ... rest of existing function unchanged, but using `enriched` as the base
  // and the already-fetched `captured` as the recipient source.
}
```

**WARNING — call-order change:** the existing function early-returns on `raw === false` BEFORE calling `consumeToolCall`. Reordering this means `consumeToolCall` always fires, even when notifications are disabled — which is the desired Phase 46 behavior (we still want to capture actor for `createdBy`), but it is a behavioral change with two consequences:
1. The store entry is consumed (deleted) on every `aof_dispatch` call, regardless of notify setting. That matches the existing semantics for the non-`false` paths anyway.
2. Any test that mocks the store to assert "no consume when notifyOnCompletion=false" will need updating.

If the planner judges this too risky, an alternative is to add a separate plugin-side hook in `adapter.ts` that injects `actor` AFTER `mergeDispatchNotificationRecipient` returns, leaving the existing function untouched. Either is defensible; document the choice.

---

## Shared Patterns (apply across multiple plans)

### Test-file scaffolding template

Every neighbor test in tree (`task-store-concurrent-transition.test.ts`, `aof-dispatch-dependson-validation.test.ts`, `deadletter-frontmatter-stamp.test.ts`) uses the same boilerplate:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../task-store.js";   // adjust depth per dir

vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
    warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(),
  }),
}));

describe("Phase 46 / Bug N — <name>", () => {
  let tmpDir: string;
  let store: FilesystemTaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-bug046N-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("...", async () => { /* ... */ });
});
```

**Apply to:** ALL new test files. The `tmpdir + mkdtemp + rm` discipline is universal in this repo.

### Logger mock for unit tests

When a test exercises code that calls `createLogger("...")`, mock `../../logging/index.js` (path adjusted per directory depth) — verbatim from `task-store-concurrent-transition.test.ts:27-33`. **Apply to:** Bug 1A tests, Bug 2A tests, Bug 2B tests. NOT for Bug 1C tests (those are TESTING the logging module itself; see analog `logger.test.ts` which uses `PassThrough` capture instead).

### EventLogger construction in tests

When the test needs a real `EventLogger` (e.g. to assert deadletter event payloads):

```typescript
import { EventLogger } from "../../events/logger.js";

const logger = new EventLogger(join(tmpDir, "events"));
const store = new FilesystemTaskStore(tmpDir, { projectId: "test", logger });
```

(Pattern from `deadletter-integration.test.ts:33-34`.)

### `FilesystemTaskStore` projectId discipline

When constructing a store in tests:
- Pass `{ projectId: "test" }` if the test exercises any code path that reads `task.frontmatter.project` or calls `loadProjectManifest`.
- Omit `projectId` (or pass `null`) for unscoped tests — the BUG-044 fix at `src/store/task-store.ts:107-113` treats absent `projectId` as "this is the unscoped base store, don't stamp `project:` into frontmatter."

### Dropping `fd: 2` from launchd plist (deploy-time, NOT committed)

The launchd plist at `~/Library/LaunchAgents/ai.openclaw.aof.plist` is GENERATED by `src/daemon/service-file.ts:175-200`. The current generator emits:

```xml
<key>StandardErrorPath</key>
<string>${escapeXml(join(logDir, "daemon-stderr.log"))}</string>
```

Per CONTEXT.md addendum Q2 ("Drop `fd: 2` from pino's destinations"), the daemon code change (`logging/index.ts`) makes `fd: 2` near-empty (only Node-level uncaught crashes still write there) — the plist itself does NOT need to change. `daemon-stderr.log` becomes a rare-event channel.

**Apply to:** Bug 1C plan. Document in plan that no plist regeneration is required, and call out a one-liner UPGRADING note recommending users truncate the legacy `daemon-stderr.log` after upgrade (RESEARCH.md "Existing log files at upgrade time").

### Naming convention for regression tests

Per CLAUDE.md ("Regression tests: `bug-NNN-description.test.ts`") and existing tree (`bug-001-*.test.ts`, `bug-005-*` style implicit, `bug-043-*.test.ts`, `bug-044-*.test.ts`):

| Bug | File name |
|-----|-----------|
| 1A atomic transition | `src/store/__tests__/bug-046a-atomic-transition.test.ts` |
| 1A startup reconciliation | `src/store/__tests__/bug-046a-startup-reconciliation.test.ts` |
| 2A project rediscovery | `src/service/__tests__/bug-046b-project-rediscovery.test.ts` |
| 1C log rotation wired | `src/logging/__tests__/bug-046c-rotation-wired.test.ts` (extends existing `logger.test.ts`) |
| 2B routing required + project-owner default | `src/tools/__tests__/bug-046d-routing-required.test.ts` |
| 2C actor injection (daemon route) | `src/ipc/__tests__/bug-046e-actor-injection.test.ts` (extends existing `invoke-tool-handler.test.ts` OR new file) |

Note: RESEARCH.md suggested `bug-046a/b/c/d/e` per-bug, the prompt suggested `bug-1a/2a/2b/2c`. Pick one scheme consistently; the planner should align with the existing tree's two-digit-with-letter pattern (`bug-001-005-regression.test.ts`, `bug-043-dispatch-hold.test.ts`) — the `bug-046<letter>` form is the natural extension.

---

## No Analog Found

**None.** All ten edited source files and six new test files have strong analogs in the existing tree. The only "new" surface is the `pino-roll` dependency itself, and even there `pino` is already a project dep, so the wiring shape (`pino.transport({ target: "...", options: {...} })`) is documented in pino's own docs and does not require a tree analog.

---

## Cross-cutting concerns / gotchas surfaced during analog scan

1. **Schema drift between `interfaces.ts` and `task-mutations.ts` (existing, do NOT fix in Phase 46).** `ITaskStore.transition` opts at `src/store/interfaces.ts:104` declare `blockers?: string[]`, but `TransitionOpts` at `src/store/task-mutations.ts:110-113` has only `reason` and `agent`. The runtime works because `task-mutations.ts` ignores the field. Phase 46 adds `metadataPatch` to BOTH — keep them aligned for the new field, leave the existing `blockers` drift alone (out of scope, would risk regression).

2. **Idempotent transition early-return** (`src/store/task-mutations.ts:151`) skips the metadata patch on no-op transitions. Per CONTEXT.md the Phase 46 use case (failure-tracker → deadletter) is never a no-op, but document this in code comment so future callers don't surprise themselves.

3. **Pollqueue ordering** (`src/service/aof-service.ts:253`) means `triggerPoll` is fire-and-forget chained. `rediscoverProjects()` running INSIDE `runPoll()` is the right insertion point because each poll's rediscover happens-before its own `pollAllProjects()`. Calling `rediscoverProjects()` from the timer-driven `triggerPoll` path would NOT work (it would run outside the queue and race). Plan must specify "inside `runPoll()`, first line."

4. **`pino-roll` worker thread leak in tests.** Per CLAUDE.md "Orphan vitest workers" — `pino.transport()` spawns worker threads. If `resetLogger()` doesn't release them, the test suite leaks. The `flushSync` discipline already in `resetLogger` is necessary but not sufficient; add `.end()` (and document in code comment that this is the orphan-vitest-worker hazard).

5. **`captureToolCall` only fires for `aof_dispatch`** (`src/openclaw/tool-invocation-context.ts:200`). This means the plugin-side `actor` defense-in-depth fix only helps `aof_dispatch` (the in-scope tool for Bug 2C). Other tools still need the daemon-side `invoke-tool.ts` fix to populate `actor`. Plan should not over-claim coverage.

6. **`_inbox` always-included project** (`src/projects/registry.ts:60-62`) — `discoverProjects` always returns `_inbox` even when missing on disk. Rediscovery is therefore idempotent for `_inbox`; the diff loop's `knownIds.has(project.id)` check handles it correctly. No special case needed (RESEARCH.md Open Question #4).

7. **`STATUS_DIRS` array duplicated** in `task-store.ts:33-42` and `task-validation.ts:15-24`. Reconciliation re-uses the validation copy via `lintTasks`. Don't introduce a third copy in `reconcileDrift` — call `lintTasks` and filter on the issue prefix.

8. **`loadProjectManifest` returns `null` for unscoped stores** (`src/projects/manifest.ts:121`). The Bug 2B project-owner-default code MUST handle `null` return — covered in the `if (manifest?.owner?.lead && ...)` chained optional. Nothing to add, just be aware.

---

## Metadata

**Analog search scope:** `src/dispatch/`, `src/store/`, `src/service/`, `src/projects/`, `src/tools/`, `src/ipc/`, `src/openclaw/`, `src/logging/`, `src/config/`, `src/daemon/` — plus colocated `__tests__/` directories.

**Files read in full or in targeted ranges (no re-reads):**
- `src/dispatch/failure-tracker.ts` (full, 148 lines)
- `src/store/task-store.ts` (full, 676 lines)
- `src/store/interfaces.ts` (full, 211 lines)
- `src/store/task-mutations.ts` (full, 255 lines)
- `src/store/task-validation.ts` (full, 122 lines)
- `src/service/aof-service.ts` (full, 521 lines)
- `src/logging/index.ts` (full, 65 lines)
- `src/ipc/routes/invoke-tool.ts` (full, 196 lines)
- `src/projects/registry.ts` (full, 194 lines)
- `src/projects/manifest.ts` (full, 149 lines)
- `src/tools/project-tools.ts` (full, 286 lines)
- `src/ipc/schemas.ts` (full, 210 lines)
- `src/openclaw/dispatch-notification.ts` (full, 66 lines)
- `src/openclaw/tool-invocation-context.ts` (full, 305 lines)
- `src/dispatch/__tests__/deadletter-frontmatter-stamp.test.ts` (full, 130 lines)
- `src/dispatch/__tests__/deadletter-integration.test.ts` (full, 237 lines)
- `src/logging/__tests__/logger.test.ts` (full, 172 lines)
- `src/store/__tests__/task-store-concurrent-transition.test.ts` (full, 190 lines)
- `src/store/__tests__/task-store-duplicate-recovery.test.ts` (head, 80 lines)
- `src/tools/__tests__/aof-dispatch-dependson-validation.test.ts` (full, 126 lines)
- `src/ipc/__tests__/invoke-tool-handler.test.ts` (full, 257 lines)
- `src/service/__tests__/multi-project-polling.test.ts` (head + middle, 260 lines total in two non-overlapping reads)
- `src/projects/__tests__/registry.test.ts` (head, 120 lines)
- `src/openclaw/adapter.ts` (lines 90-150, targeted)
- `src/dispatch/task-dispatcher.ts` (lines 170-290, targeted)
- `src/config/registry.ts` (head, 160 lines)
- `src/config/paths.ts` (full, 97 lines)
- `src/daemon/service-file.ts` (lines 175-244, targeted)
- `src/tools/types.ts` (head, 60 lines)

**Pattern extraction date:** 2026-04-24
