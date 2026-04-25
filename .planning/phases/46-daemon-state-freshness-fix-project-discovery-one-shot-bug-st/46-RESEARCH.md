# Phase 46: Daemon state freshness — Research

**Researched:** 2026-04-24
**Domain:** Daemon scheduler state-staleness, atomic filesystem transitions, Pino log rotation, IPC actor identity propagation
**Confidence:** HIGH

## Summary

Phase 46 fixes four bugs in the live daemon path (Tier A from the 2026-04-24 incident cluster). All four are **localised** edits to well-understood modules — there is no architectural redesign here. The trickiest part is **Bug 1A (atomic transition)** because the existing `transitionTask` was already hardened in v1.16.3 (commit `6fbcb18`) against partial-rename split-state, AND each task is mutex-guarded per `TaskLocks` (v1.14.8 / commit `746aee7`). The remaining gap is the *call-site* in `failure-tracker.transitionToDeadletter`, which does `save()` then `transition()` as two separate locked operations — between them, a crash leaves the file in `tasks/ready/` with `frontmatter.status: deadletter`. The fix is to **fold the metadata-stamp into a single locked operation** by passing the metadata patch through `store.transition(opts)` (or by introducing one new atomic store method) so that the existing per-task mutex covers stamp+rename as one critical section.

The other three bugs are mechanical:
- **Bug 2A (project discovery freshness)** — call `discoverProjects(vaultRoot)` once per `runPoll()` and diff against the live `projectStores` Map. The Map iteration is already serialized through `pollQueue` (a Promise chain) so concurrency is not a concern.
- **Bug 1C (log rotation)** — wire `pino-roll@4.0.0` (Matteo Collina, sonic-boom-backed) as a `pino.transport()`, with `pino.multistream()` keeping fd:2 (stderr) so launchd's `daemon-stderr.log` continues to receive its keep-alive heartbeat. The 50MB×5 cap applies to the rotated file, not to launchd's redirected stderr (which still needs a separate fix path — flagged below).
- **Bug 2B+2C (routing validation + createdBy capture)** — `aof_task_create` is a misnomer in the post-mortem: AOF only exposes `aof_dispatch` for task creation. The fix lands in `src/tools/project-tools.ts:aofDispatch` (validation) AND `src/ipc/routes/invoke-tool.ts` (envelope `actor` propagation into params before handler dispatch).

**Primary recommendation:** Land each bug as one Plan (4 plans total), TDD-strict per CLAUDE.md. Plan 1 (Bug 1A) is highest-risk — touches the dispatch fragile area; do that one first while context is loaded. Plans 2-4 are independent and parallelizable.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Project discovery freshness (rediscover-on-poll) | service/ (`AOFService.runPoll`) | projects/ (`discoverProjects`) | Service owns polling lifecycle and the `projectStores` Map; `projects/registry.ts` already exposes the discovery primitive. |
| Atomic save+transition | store/ (`task-mutations.ts:transitionTask`) | dispatch/ (`failure-tracker.transitionToDeadletter` call site) | Store is sole authority for filesystem layout; dispatch is a caller. Lock lives in `TaskLocks` keyed per task — already in store layer. |
| Startup reconciliation pass | store/ (`FilesystemTaskStore.init()`) | — | Store owns directory layout; `init()` already creates status dirs and is the natural place for a self-heal sweep. Drift logic exists in `task-validation.ts:lintTasks` and can be reused as the read half. |
| Log rotation transport | logging/ (`createLogger` factory) | config/ (`AofConfigSchema.core` extension) | Logging owns Pino destination wiring; config registry must add new keys for file path / size / count overrides. |
| Routing validation at task creation | tools/ (`project-tools.ts:aofDispatch`) | schemas/ (optional `TaskRouting` refinement) | Tool handler is the rejection site; schema-level refinement is the strongest guarantee but couples MCP/IPC paths. Plan should reject in handler. |
| Actor identity capture (createdBy) | ipc/ (`routes/invoke-tool.ts`) | openclaw/ (`adapter.ts` fallback for params.actor) | Daemon IPC envelope already carries `actor`; route handler must inject it into `inner.data.actor` before dispatching. Plugin-side fallback (read `agentId` from invocation context store) is defense-in-depth. |

## Standard Stack

### Core (existing — no new versions, verified 2026-04-24)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `pino` | 9.14.0 | Structured logging — already the daemon's logger | Pino-author-blessed transport ecosystem; v9 has stable `pino.transport()` worker-thread API and `pino.multistream()` for multi-destination |
| `write-file-atomic` | 7.0.0 | Atomic file writes — used by store everywhere | Survives partial-write crashes; already the store's primitive |
| `zod` | 3.24.0 | Schema validation — source of truth for routing/frontmatter | Project convention, already validates `TaskRouting` |

### Supporting (new — verified via `npm view` 2026-04-24)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pino-roll` | 4.0.0 | Pino transport with size+frequency rotation | `[VERIFIED: npm view pino-roll]` — author Matteo Collina (Pino maintainer), modified 2025-10-06, MIT, dependencies `date-fns@4.1.0` + `sonic-boom@4.0.1`. Bug 1C wiring. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `pino-roll` | `rotating-file-stream` (3.2.9, modified 2026-02-21) | Zero deps, native gzip-on-rotate, but NOT a pino transport — would need a custom adapter wrapping the writable stream. More code to maintain. `[VERIFIED: npm view rotating-file-stream]` |
| `pino-roll` | `pino-rotating-file-stream` (0.0.2, 2023) | Stale (no commits 3y), `0.0.2` version signal. `[VERIFIED: npm view pino-rotating-file-stream]` Reject. |
| `pino-roll` | `pino-transport-rotating` (2.0.0) | Bundles `pino@9.6.0` as a hard dep — version conflict with our `pino@9.14.0`. `[VERIFIED: npm view pino-transport-rotating dependencies]` Reject. |
| `pino-roll` | macOS `newsyslog` / Linux `logrotate` | OS-level rotation. Per CONTEXT.md ("ship rotation as part of AOF, npm dep, not a system-installed thing") — rejected by user. `[CITED: 46-CONTEXT.md ## Bug 1C]` |

**Installation:**
```bash
npm install pino-roll@4.0.0
```

**Version verification (2026-04-24):**
```bash
$ npm view pino-roll version       # 4.0.0
$ npm view pino-roll time.modified # 2025-10-06T20:17:55.573Z
```

**Important pino-roll caveat:** pino-roll has **no built-in gzip compression**. `[CITED: github.com/mcollina/pino-roll README — "limit.count"/"limit.removeOtherLogFiles" are the only retention controls]` The CONTEXT.md decision specifies "gzip on rotation" — this is **NOT supported natively by pino-roll** and would require either:
- Accept uncompressed rotation (revisit gzip later — 5×50MB raw is 250MB worst-case, same disk budget the user already approved).
- A post-rotation external gzip step (more code, race-prone).
- Use `rotating-file-stream` instead (zero deps, native gzip) at the cost of a custom pino adapter.

**Recommendation:** **Drop the gzip requirement** for Phase 46. Ship pino-roll with `size: '50m'`, `limit: { count: 5 }` — the worst-case disk footprint (250MB) matches what the user accepted in CONTEXT.md ("caps log disk use at ~250 MB worst-case"). If gzip becomes important later, swap to `rotating-file-stream` then. **Flag this in discuss-phase as ASSUMED.**

## Architecture Patterns

### System Architecture Diagram

```
                    ┌──────────────────────────────────────────────┐
                    │   AOFService (daemon-only, post-Phase 43)    │
                    └──────────────────────────────────────────────┘
                                         │
       ┌─────────────────────────────────┼─────────────────────────────────┐
       │                                 │                                 │
       ▼                                 ▼                                 ▼
  start()                          runPoll()                         (other hooks)
   │                                  │
   ├─ initializeProjects() (1x)       ├─ [NEW] rediscoverProjects()  ◄── BUG 2A FIX
   │   └─ discoverProjects() ─┐       │   └─ diff against this.projectStores
   ├─ store.init() (per       │       │       ├─ add new projects (init+register)
   │  project)                │       │       └─ remove vanished projects
   │  └─ [NEW] reconcile-     │       │
   │     Drift() ──────► BUG 1A FIX   │
   └─ reconcileOrphans()              ▼
                              pollAllProjects()
                                  │
                                  └─ poll(store, logger, config)  (per-project)
                                       └─ buildDispatchActions(...)
                                            └─ executeAssignAction
                                                 └─ on failure:
                                                     trackDispatchFailure()
                                                     ──► after 3 failures:
                                                         transitionToDeadletter()
                                                         ──► [FIX] atomic
                                                             stamp+transition  ◄── BUG 1A FIX

  ┌──────────────────────────────────────────────────────────────────────┐
  │                  Plugin → Daemon IPC (POST /v1/tool/invoke)           │
  └──────────────────────────────────────────────────────────────────────┘
                                  │
   plugin (adapter.ts)            ▼                  daemon (invoke-tool.ts)
   p.actor (param)         InvokeToolRequest       ─► envelope.data.actor
   ──────────────►        { actor, params, ... }   ─► [FIX] inject envelope.actor
                                                      into inner.data.actor BEFORE
                                                      def.handler(ctx, inner.data)
                                                                │              ◄── BUG 2C FIX
                                                                ▼
                                                       aofDispatch(ctx, input)
                                                          ├─ [FIX] reject if no
                                                          │   agent/role/team       ◄── BUG 2B FIX
                                                          ├─ [FIX] default routing
                                                          │   from project owner
                                                          └─ store.create({
                                                              createdBy: input.actor
                                                              })

  ┌──────────────────────────────────────────────────────────────────────┐
  │                       Logging path (Bug 1C)                           │
  └──────────────────────────────────────────────────────────────────────┘
                                  │
   createLogger(component)        ▼
   ─►  getRootLogger()    pino(opts, dest)
                                  │
                       ┌──────────┴──────────┐
                       │                     │
              [TODAY] pino.destination       [NEW] pino.multistream
                  ({ fd: 2, sync: false })       ├─ stream: { fd: 2 } (stderr — kept)
                                                 └─ stream: pino-roll transport
                                                       ({ file: <dataDir>/logs/aof.log,
                                                         size: '50m',
                                                         limit: { count: 5 } })
```

### Recommended Project Structure (no new directories)

All edits land in existing modules:

```
src/
├── service/aof-service.ts             # NEW: rediscoverProjects() in runPoll()
├── store/
│   ├── task-store.ts                  # NEW: reconcile-on-init() call from init()
│   ├── task-mutations.ts              # NEW: atomic stamp+transition (extend transitionTask opts)
│   └── task-reconciliation.ts         # NEW (extracted): walks status dirs, fixes drift
├── dispatch/failure-tracker.ts        # CHANGE: use single atomic transition call
├── projects/registry.ts               # NO CHANGE (consumer-side wiring only)
├── logging/index.ts                   # NEW: multistream + pino-roll transport
├── config/registry.ts                 # NEW: optional logging.* config block
├── tools/project-tools.ts             # NEW: empty-routing rejection + project-owner default
└── ipc/routes/invoke-tool.ts          # NEW: inject envelope.actor into inner.data.actor
```

### Pattern 1: Per-poll project rediscovery

**What:** Inside `AOFService.runPoll()` (or just-before `pollAllProjects()`), call `discoverProjects(vaultRoot)`, diff against `this.projectStores: Map<string, ITaskStore>`, and reconcile.

**When to use:** Bug 2A only. Runs every 30s (default poll interval).

**Concurrency note:** `runPoll()` is already serialized through `this.pollQueue: Promise<void>` (line 82-83, 253). Mutating `this.projectStores` inside `runPoll()` happens-before the next `pollAllProjects()` iteration, so the existing for-loop at line 451 always sees a consistent view. **No additional locking needed.**

**Example skeleton:**
```typescript
// Source: derived from existing src/service/aof-service.ts:435-458 (pollAllProjects)
private async rediscoverProjects(): Promise<void> {
  if (!this.vaultRoot) return;
  const discovered = await discoverProjects(this.vaultRoot);
  const discoveredIds = new Set(discovered.map(p => p.id));
  const knownIds = new Set(this.projectStores.keys());

  // Add new projects
  for (const project of discovered) {
    if (knownIds.has(project.id) || project.error) continue;
    const store = new FilesystemTaskStore(project.path, {
      projectId: project.id,
      hooks: this.createStoreHooks(project.path),
      logger: this.logger,
    });
    await store.init();
    this.projectStores.set(project.id, store);
    svcLog.info({ projectId: project.id, op: "rediscover" }, "registered new project");
  }

  // Remove vanished projects (file-removed; in-flight tasks have already
  // returned; lease/reconciliation paths handle cleanup).
  for (const id of knownIds) {
    if (!discoveredIds.has(id)) {
      this.projectStores.delete(id);
      svcLog.info({ projectId: id, op: "rediscover" }, "deregistered vanished project");
    }
  }
}
```

Wire as the first step inside `runPoll()` before `pollAllProjects()`. Cost: a single `readdir` of `<vaultRoot>/Projects/` plus N reads of `project.yaml` (already O(N) on every existing call site at startup).

### Pattern 2: Atomic save+transition via `transition()` opts

**What:** Extend `transitionTask`'s `TransitionOpts` to accept a `metadataPatch` field. The store applies the patch to `task.frontmatter.metadata` after the validity check but **before** the `writeFileAtomic(newPath, ...)` call. This means stamp + rename happen inside the same `TaskLocks.run(id, ...)` critical section already guarding `transition()`.

**When to use:** Bug 1A only. The failure-tracker call site collapses from two awaits to one.

**Why this shape:** The CONTEXT.md grants discretion on the exact API ("a single `store.transition(taskId, newStatus, opts)` ... or a save callback ..."). The metadata-patch-in-opts shape:
- Reuses the existing per-task mutex (no new locking primitive).
- Doesn't introduce a new ITaskStore method (no breaking interface change).
- Matches the existing `TransitionOpts` extension pattern (`reason`, `agent` already there).
- Mirrors what v1.16.3 (commit `6fbcb18`) already did for the rename half: write-new-then-delete-old. The metadata stamp is just additional content baked into the new write.

**Example signature change:**
```typescript
// src/store/task-mutations.ts
export interface TransitionOpts {
  reason?: string;
  agent?: string;
  blockers?: string[];
  /** [NEW Bug 1A] Metadata fields to merge into frontmatter.metadata in the same
   *  atomic write that performs the directory transition. Use for deadletter
   *  cause stamping where save+transition were previously two unsafe steps. */
  metadataPatch?: Record<string, unknown>;
}

// inside transitionTask, AFTER lease-clearing block:
if (opts?.metadataPatch) {
  task.frontmatter.metadata = { ...task.frontmatter.metadata, ...opts.metadataPatch };
}
// then existing writeFileAtomic + rename block runs unchanged.
```

**Failure-tracker call site after fix:**
```typescript
// src/dispatch/failure-tracker.ts:transitionToDeadletter — collapsed
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
// no separate save() call — atomic.
```

The post-Phase-44 BUG-005 metadata stamp behavior is preserved because the patch is applied in the same critical section, just without the intermediate save.

### Pattern 3: Startup reconciliation sweep

**What:** Inside `FilesystemTaskStore.init()`, after the status-dir mkdirs, walk every `tasks/<status>/*.md`. For each file whose `frontmatter.status` doesn't match its directory, **rename the file to the dir matching its frontmatter status**. Existing `task-validation.ts:lintTasks()` already does the read+detect half — extract or call it from `init()`.

**When to use:** Bug 1A defense-in-depth. One-shot per project store at boot. Per CONTEXT.md decision: "Run reconciliation once per project store at `init()`, not on every poll."

**Edge cases per CONTEXT.md:**
- Frontmatter status doesn't match a known status dir → log warning, leave in place (do not delete or guess).
- Task file exists in two directories simultaneously (the v1.14.8 `get()` self-heal already covers this — most-recent mtime wins; verify init runs after this self-heal is reachable, or extend self-heal to fire on init walk).

**Cost:** O(total_task_files). The existing `lintTasks` walk is the same shape; cost is "couple ms per 1000 tasks" — negligible compared to daemon startup IPC handshake.

**Example skeleton:**
```typescript
// src/store/task-store.ts — extend init()
async init(): Promise<void> {
  for (const status of STATUS_DIRS) {
    await mkdir(join(this.tasksDir, status), { recursive: true });
  }
  await this.reconcileDrift();
}

private async reconcileDrift(): Promise<void> {
  const issues = await this.lint();   // already returns mismatches
  for (const { task, issue } of issues) {
    if (!issue.startsWith("Status mismatch:")) continue;
    const targetStatus = task.frontmatter.status;
    if (!STATUS_DIRS.includes(targetStatus)) {
      storeLog.warn({ taskId: task.frontmatter.id, status: targetStatus, op: "reconcile" },
        "frontmatter status not in known dirs — leaving file in place");
      continue;
    }
    const oldPath = task.path!;
    const newPath = this.taskPath(task.frontmatter.id, targetStatus);
    await rename(oldPath, newPath);
    storeLog.info({ taskId: task.frontmatter.id, from: oldPath, to: newPath, op: "reconcile" },
      "moved task file to match frontmatter status");
  }
}
```

### Pattern 4: Pino-roll wiring with multistream-preserved stderr

**What:** Replace single `pino.destination({ fd: 2 })` with `pino.multistream([{ stream: pino.destination({ fd: 2 }) }, { stream: pino.transport({ target: 'pino-roll', options: {...} }) }])`. **Stderr fd:2 is kept** so launchd's `daemon-stderr.log` continues to receive a heartbeat (otherwise launchd may infer the process is misbehaving). `[CITED: pinojs/pino docs/transports.md — multistream + transport coexist]`

**When to use:** Bug 1C only. Wire in `getRootLogger()` at `src/logging/index.ts:21-34`.

**Critical operational note (from `service-file.ts:188-192`):** The 172MB log incident was `~/.aof/data/logs/daemon-stderr.log`, written by **launchd** redirecting the daemon process stderr — NOT by pino directly. **Adding pino-roll alone DOES NOT solve the launchd-stderr file growth problem.** Two complementary actions are needed:

1. **(Required) Wire pino-roll** — emits to `<dataDir>/logs/aof.log` with rotation. This is the new home for structured logs.
2. **(Required) Stop double-writing to stderr** — either:
   - **Option A:** Drop the `fd: 2` stream from multistream entirely. Daemon stderr becomes empty (or only carries Node-level uncaught crashes). Launchd's `daemon-stderr.log` will grow much more slowly. **This is what makes the rotation actually solve the user's incident.**
   - **Option B:** Keep `fd: 2` for crash visibility but truncate launchd's redirect to `/dev/null` in `service-file.ts` plist generation. More invasive (changes the plist contract).

**Recommendation:** Option A. The structured logs go to the rotated `aof.log`; launchd's stderr becomes a rare-event channel (Node fatal crashes). The plist redirect can stay as-is. **Plan should explicitly address this** — otherwise the user re-experiences the same incident in 6 days.

**Example wiring:**
```typescript
// src/logging/index.ts
import pino, { type Logger, multistream } from "pino";
import { join } from "node:path";
import { getConfig } from "../config/registry.js";
import { resolveDataDir } from "../config/paths.js";

function getRootLogger(): Logger {
  if (root) return root;
  const { core } = getConfig();
  const logsDir = join(resolveDataDir(), "logs");

  const fileTransport = pino.transport({
    target: "pino-roll",
    options: {
      file: join(logsDir, "aof.log"),
      size: "50m",
      limit: { count: 5 },
      mkdir: true,
    },
  });

  // Decision (Option A): drop fd:2 — structured logs only land in the rotated file.
  // Launchd's daemon-stderr.log captures only Node-level uncaught crashes.
  root = pino({ level: core.logLevel, timestamp: pino.stdTimeFunctions.isoTime }, fileTransport);
  return root;
}
```

### Pattern 5: Routing validation + project-owner default at create time

**What:** In `aofDispatch` (`src/tools/project-tools.ts:148`), after the existing title/brief checks and before `ctx.store.create({...})`, validate routing:

```typescript
// src/tools/project-tools.ts — inside aofDispatch, after brief validation
let agent = input.agent;
let team = input.team;
let role = input.role;
if (!agent && !team && !role) {
  // Try defaulting from project owner
  const projectId = input.project ?? ctx.projectId;
  if (projectId) {
    const manifest = await loadProjectManifest(ctx.store, projectId);
    if (manifest?.owner?.lead) {
      agent = manifest.owner.lead;
    } else if (manifest?.owner?.team) {
      team = manifest.owner.team;
    }
  }
}
if (!agent && !team && !role) {
  throw new Error(
    "Task creation requires a routing target: provide agent, team, or role. " +
    "Tags-only routing is not supported (would never dispatch).",
  );
}
```

**Why in handler not Zod schema:** Zod-level refinement (`.refine(d => d.agent || d.team || d.role)`) would couple to MCP, IPC, and OpenClaw plugin paths simultaneously. The handler-level check is the only place where `loadProjectManifest` defaulting can happen (needs the store). Plus: rejecting later in the handler still happens BEFORE `store.create()`, so no file is written — same atomic guarantee as schema-level.

### Pattern 6: Actor injection in IPC route

**What:** In `src/ipc/routes/invoke-tool.ts`, after parsing `inner.data` but before `def.handler(ctx, inner.data)`, merge envelope `actor` into params if absent:

```typescript
// src/ipc/routes/invoke-tool.ts — after inner.success check, before resolveStore
const enrichedParams = {
  ...inner.data,
  // If envelope carries actor and tool input doesn't override it, inject.
  ...(actor && !(inner.data as any).actor ? { actor } : {}),
};
// then later: const result = await def.handler(ctx, enrichedParams);
```

**Plugin-side prerequisite:** The plugin's adapter at `src/openclaw/adapter.ts:119` already forwards `p.actor` as the envelope's `actor`. For this to be non-undefined, **the OpenClaw agent invoking `aof_dispatch` must set `params.actor`**, OR the plugin must inject it from `invocationContextStore.consumeToolCall(id)` (which Phase 44 already populates with `agentId` from the OpenClaw event — see `tool-invocation-context.ts:132-137`).

**Two-pronged fix recommended:**
- **Primary (daemon-side):** Inject envelope `actor` into params in `invoke-tool.ts`. Covers MCP path (which sets `input.actor ?? "mcp"`) and any plugin that sets envelope actor.
- **Defense-in-depth (plugin-side):** Extend `mergeDispatchNotificationRecipient` (or add a sibling `injectActorFromContext`) so that for `aof_dispatch`, if `params.actor` is undefined, fall back to `captured.actor` from the invocation context store. This closes the gap where the OpenClaw agent doesn't pass `params.actor` explicitly but the gateway DID emit `agentId` in the `before_tool_call` event.

### Anti-Patterns to Avoid

- **Adding an `fs.watch` for project discovery.** Per CONTEXT.md, explicitly rejected. More state, more failure modes (watch handle leaks, missed events on rapid create+delete).
- **Holding a project-store lock during `discoverProjects` to "prevent races".** The poll loop is already serialized via `pollQueue`. Adding a lock invents a second concurrency model.
- **Calling `lintTasks` on every poll for drift detection.** The CONTEXT.md decision is explicit: reconcile at `init()` only, not per-poll. Per-poll is wasted I/O once the boot drain is done.
- **Storing the rotation config in `process.env`.** Per CLAUDE.md "Config: getConfig() from src/config/registry.ts. No process.env elsewhere." Add `core.logging.*` to `AofConfigSchema`.
- **Building a custom write-rename-rollback inside `failure-tracker`.** That logic already exists in `task-mutations.ts:transitionTask` (commit `6fbcb18`). Calling `transition({metadataPatch})` reuses it; recreating it duplicates the v1.16.3 fix.
- **Editing `transitionToDeadletter`'s post-transition event log.** The `eventLogger.log("task.deadlettered", ...)` after transition is correct as-is; the bug was the `save()`+`transition()` split, not the event order.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Log file rotation | Custom size-watch + rename + gzip script | `pino-roll@4.0.0` | Maintained by Pino author; sonic-boom-backed; worker-thread isolation; battle-tested rotation race handling |
| Atomic file write | Custom write+fsync+rename | `write-file-atomic` (already a dep) | Project convention. Crash-safe by design |
| Project YAML parse | Custom YAML parser | `yaml@2.7.0` (already a dep) | Already loads `project.yaml` everywhere |
| Per-task locking | New mutex | `TaskLocks` (`src/store/task-lock.ts`) | Already exists, already keys by task ID, already used by `transition`/`cancel`/`updateBody`/etc. |
| Drift detection | Custom directory walk + frontmatter parse | `lintTasks()` (`src/store/task-validation.ts:40-121`) | Already returns `Array<{task, issue}>` with status-mismatch issues. Reuse from `reconcileDrift()` at init |

**Key insight:** Three of the four bugs have most of the machinery already in the tree. Bug 1A reuses `TaskLocks` + `transitionTask`; Bug 2A reuses `discoverProjects`; reconciliation sweep reuses `lintTasks`. Only Bug 1C introduces a new dependency (`pino-roll`).

## Runtime State Inventory

> Phase 46 is a fix-bugs phase. Renames/migrations are not in scope, but log file location IS. Listing what runtime state is affected.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — task frontmatter shape unchanged. The `metadataPatch` extension is additive within existing `frontmatter.metadata` keys (deadletter* fields already used). | none |
| Live service config | `~/Library/LaunchAgents/ai.openclaw.aof.plist` redirects daemon stderr to `<dataDir>/logs/daemon-stderr.log`. Bug 1C fix changes structured logs to land in `<dataDir>/logs/aof.log` (rotated). The launchd-managed file becomes near-empty (only Node-level crash output). **No plist edit required if Option A is chosen** (drop fd:2 from multistream); plist edit IS required if Option B (redirect launchd to /dev/null). | If Option A: nothing. If Option B: regenerate plist via `aof daemon install --restart`, which rewrites from `service-file.ts`. |
| OS-registered state | None | none |
| Secrets/env vars | None changed. New optional `AOF_LOG_FILE_SIZE` / `AOF_LOG_FILE_COUNT` if exposed via env (not required — defaults are fine). | none |
| Build artifacts | `node_modules/pino-roll/` and `node_modules/date-fns/` will be added on first `npm install`. `dist/` regenerates on `npm run build`. | run `npm install` after merge; `npm run deploy` rebuilds. |

**Existing log files at upgrade time:** `daemon-stderr.log` will continue to grow at the slow new rate (Option A) until the user truncates manually. Add a one-line note to UPGRADING.md or release notes recommending `: > ~/.aof/data/logs/daemon-stderr.log` after upgrade. Not a blocker.

## Common Pitfalls

### Pitfall 1: pino-roll without `mkdir: true` silently fails on first run

**What goes wrong:** pino-roll's `file: '<dataDir>/logs/aof.log'` requires the parent directory to exist. Without `mkdir: true`, it throws on first write — but since the transport runs in a worker thread, the throw doesn't crash the main daemon; logs just disappear silently.

**Why it happens:** `<dataDir>/logs/` is created by launchd's `StandardErrorPath` only when launchd writes the first byte. Pino's transport may try to write before launchd has bootstrapped the directory.

**How to avoid:** Always pass `mkdir: true` in the pino-roll options. Verified against pino-roll README: `[CITED: github.com/mcollina/pino-roll README — "If this path does not exist, the logger will throw an error unless you set mkdir to true"]`.

**Warning signs:** Daemon starts but `<dataDir>/logs/aof.log` never appears; structured logs are missing from any file but visible in `daemon-stderr.log` (because launchd captured the worker-thread stderr).

### Pitfall 2: Per-poll rediscovery races against `pollAllProjects` Map iteration

**What goes wrong:** If `rediscoverProjects()` mutates `this.projectStores` mid-iteration in `pollAllProjects()`, the for-of loop's behavior on a mutated Map is "implementation-defined" (V8: continues iteration, but newly-added entries may or may not be visited).

**Why it happens:** Multiple awaits in `pollAllProjects` give the scheduler chances to interleave.

**How to avoid:** Run `rediscoverProjects()` **before** `pollAllProjects()` inside `runPoll()`, not concurrent with it. Both are awaited inside the same `runPoll()` invocation, which is itself serialized by `this.pollQueue: Promise<void>` (line 253). This makes the sequence "rediscover → snapshot Map keys → iterate" atomic from the caller's perspective.

**Warning signs:** Tests that assert "new project visible after rediscover but during the same poll" pass intermittently; in production, log lines like "registered new project" appear AFTER "failed to poll project" for the same project ID.

### Pitfall 3: Reconciliation move loses the companion directory

**What goes wrong:** `reconcileDrift()` does `rename(oldPath, newPath)` for the `.md` file but ignores the companion directory at `tasks/<status>/<TASK-ID>/` (inputs/, work/, outputs/, subtasks/). After the move, the companion stays in the OLD status dir while the .md is in the NEW.

**Why it happens:** The existing `transitionTask` handles companion-dir rename (`task-mutations.ts:196-212`). A naïve reconciliation loop that just renames the .md replicates only half the operation.

**How to avoid:** Call `store.transition(id, frontmatter.status, opts)` instead of `rename`. Idempotency check at `task-mutations.ts:151` returns early if status already matches (which it does for the bug case — frontmatter says deadletter, file in ready, but `getTask()` returns the task with `status: deadletter` from the file's frontmatter — wait, this is a problem — see Pitfall 4).

**Warning signs:** After daemon restart, task files are in correct dirs but their `inputs/`, `outputs/`, etc. are missing or in stale dirs.

### Pitfall 4: `get(id)` self-heal interferes with reconciliation walk

**What goes wrong:** `FilesystemTaskStore.get()` (lines 313-346) self-heals duplicate-file states by mtime, deleting "stale" copies. If the reconciliation walk uses `get(id)` for each file path it's iterating, it may see the file disappear mid-walk (the self-heal deletes it).

**Why it happens:** The reconciliation walk reads files by directory enumeration (`readdir`), but if it then calls `get(id)` to load each task, `get` does its own multi-dir walk and may delete files the reconciliation walk hasn't visited yet.

**How to avoid:** The reconciliation walk should use `parseTaskFile(rawContent, filePath)` directly on the file it discovered via `readdir` — same pattern `lintTasks` uses (`task-validation.ts:93-94`). Do NOT call `store.get(id)` inside the walk.

**Warning signs:** Reconciliation log lines say "moved task to match frontmatter" but a moment later "duplicate task ID detected — self-healing".

### Pitfall 5: Routing validation breaks the `_inbox` admin/system-task path

**What goes wrong:** The `_inbox` project's `owner` is `{ team: "system", lead: "system" }`. Defaulting from project owner means tasks created in `_inbox` get routed to a `system` agent. If `system` isn't in the org chart as a real agent, dispatch fails downstream — symptom looks identical to Bug 2B (task sits in ready/), just with a different reason.

**Why it happens:** `system` is a placeholder identity used by AOF internals (e.g. `task.transitioned` events emit actor: "system"), not a real OpenClaw agent.

**How to avoid:** When defaulting from owner, validate that the resolved agent/team exists in the org chart. If not, **either** reject the create (consistent with empty-routing rejection) OR fall back to the original empty-routing rejection error message.

**Warning signs:** `_inbox` tasks created via `aof_dispatch` (no agent/team specified) accept successfully but never dispatch; logs show `system` agent has no auth profile.

### Pitfall 6: `actor` env propagation mistakenly affects `mcp/tools.ts`

**What goes wrong:** MCP path at `src/mcp/tools.ts:142` does `createdBy: input.actor ?? "mcp"`. If the IPC-route fix injects envelope `actor`, MCP doesn't use the IPC route at all — but if a future refactor wires MCP through IPC, the fallback chain becomes ambiguous.

**Why it happens:** Two separate code paths converge on `aofDispatch`. The fix should be defensive in BOTH paths, not just the daemon IPC route.

**How to avoid:** Document the actor-source precedence in a comment at `aofDispatch`: "actor source order: explicit input.actor > envelope-injected actor > 'unknown'". Keep MCP's `?? "mcp"` because MCP knows its own context. Both paths converge on `aofDispatch`'s `const actor = input.actor ?? "unknown"` line — that's the right single point of truth.

## Code Examples

### Example 1: pino-roll wired with multistream-Option-A (drop fd:2)

```typescript
// src/logging/index.ts (post-Phase 46)
import pino, { type Logger } from "pino";
import { join } from "node:path";
import { getConfig } from "../config/registry.js";
import { resolveDataDir } from "../config/paths.js";

let root: Logger | null = null;

function getRootLogger(): Logger {
  if (root) return root;
  const { core } = getConfig();
  const logsDir = join(resolveDataDir(), "logs");

  const transport = pino.transport({
    target: "pino-roll",
    options: {
      file: join(logsDir, "aof.log"),
      size: "50m",            // 50 MB per file
      limit: { count: 5 },    // keep 5 rotated files
      mkdir: true,            // create logsDir on first write
    },
  });

  root = pino(
    { level: core.logLevel, timestamp: pino.stdTimeFunctions.isoTime },
    transport,
  );
  return root;
}
```

### Example 2: failure-tracker with single atomic transition

```typescript
// src/dispatch/failure-tracker.ts:transitionToDeadletter — Phase 46 shape
export async function transitionToDeadletter(
  store: ITaskStore,
  eventLogger: EventLogger,
  taskId: string,
  lastFailureReason: string
): Promise<void> {
  const task = await store.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const failureCount = (task.frontmatter.metadata.dispatchFailures as number | undefined) ?? 0;
  const retryCount   = (task.frontmatter.metadata.retryCount       as number | undefined) ?? 0;
  const errorClass   = (task.frontmatter.metadata.errorClass       as string | undefined) ?? "unknown";
  const agent = task.frontmatter.routing?.agent;
  const deadletteredAt = new Date().toISOString();
  const deadletterReason =
    errorClass === "permanent" ? "permanent_error" : "max_dispatch_failures";

  // BUG-005 stamp + transition: now ATOMIC (Phase 46 / Bug 1A).
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

  // Event log + ops alert unchanged from pre-Phase 46.
  await eventLogger.log("task.deadlettered", "system", {
    taskId,
    payload: { /* same as before */ },
  });
  log.error({ taskId, /* ... */ }, "DEADLETTER: ...");
}
```

### Example 3: Routing validation in aofDispatch

```typescript
// src/tools/project-tools.ts:aofDispatch — Phase 46 additions
// Insert after brief validation (~line 162), before normalizePriority:

let agent = input.agent;
let team = input.team;
let role = input.role;

if (!agent && !team && !role) {
  // Try defaulting from project owner before rejecting.
  const projectId = input.project ?? ctx.projectId;
  if (projectId) {
    try {
      const manifest = await loadProjectManifest(ctx.store, projectId);
      if (manifest?.owner?.lead && manifest.owner.lead !== "system") {
        agent = manifest.owner.lead;
      } else if (manifest?.owner?.team && manifest.owner.team !== "system") {
        team = manifest.owner.team;
      }
    } catch {
      /* fall through to rejection */
    }
  }
}

if (!agent && !team && !role) {
  throw new Error(
    "Task creation requires a routing target. " +
    "Provide one of: agent, team, role. Tags-only routing is not supported " +
    "(would never dispatch — see Phase 46 / Bug 2B).",
  );
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `save()` + `transition()` two separate awaits in failure-tracker | Single atomic `transition({ metadataPatch })` | Phase 46 | Eliminates partial-state window forever |
| One-shot `initializeProjects()` at boot | Per-poll `rediscoverProjects()` diff | Phase 46 | New projects live within 30s without daemon restart |
| `pino.destination({ fd: 2 })` only | `pino.transport({ target: 'pino-roll' })` | Phase 46 | Bounded log disk usage (50 MB × 5) |
| `aof_dispatch` accepts empty routing | Reject at create-time, optionally default from project owner | Phase 46 | "Task sat in ready/ for 21 minutes" mode prevented at source |
| `createdBy: "unknown"` for plugin-originated tasks | Envelope actor injected into params before handler | Phase 46 | Forensic traceability restored |

**Deprecated/outdated:**
- The dual-step "save then transition" pattern in failure-tracker, retained from pre-v1.14.8 era when there was no per-task mutex. Per-task locking via `TaskLocks` made it safe in-process; making it atomic via metadataPatch closes the cross-process / crash-recovery gap.

## Project Constraints (from CLAUDE.md)

| Constraint | How Phase 46 honors it |
|------------|------------------------|
| **TDD strict** — failing test first, regression tests as `bug-NNN-description.test.ts` | Each bug has a dedicated regression test under `__tests__/` (see Validation Architecture). Bug names suggested: `bug-046a-deadletter-atomic-transition.test.ts`, `bug-046a-startup-reconciliation.test.ts`, `bug-046b-project-rediscovery.test.ts`, `bug-046c-log-rotation-wired.test.ts`, `bug-046d-empty-routing-rejected.test.ts`, `bug-046e-actor-injected-from-envelope.test.ts`. |
| **Config: `getConfig()` from `src/config/registry.ts`. No `process.env` elsewhere.** | Optional log rotation knobs (size/count override) added under `core.logging` in `AofConfigSchema`. Defaults set so no opt-in required. No new env reads outside the registry. |
| **Logging: `createLogger('component')`. No `console.*` in core modules.** | Pino-roll wiring stays inside `src/logging/index.ts`. All other modules continue using `createLogger`. |
| **Store: `ITaskStore` methods only. Never `serializeTask` + `writeFileAtomic` directly.** | `metadataPatch` extension lands inside `task-mutations.ts:transitionTask` — already an `ITaskStore` method. Reconciliation sweep stays inside `FilesystemTaskStore.init()` — internal to the store class. |
| **Schemas: Zod source of truth.** | `TransitionOpts` is the canonical opts object; extend with `metadataPatch?: Record<string, unknown>` (no schema change required since it's an internal type, not a wire contract). |
| **Tools: Register in `src/tools/tool-registry.ts`.** | No new tools. `aofDispatch` is already registered. |
| **No circular deps.** | `loadProjectManifest` is already imported by `project-tools.ts` consumers (verified via existing `dispatch/task-dispatcher.ts` import chain). Verify post-edit with `npx madge --circular --extensions ts src/`. |
| **Naming: PascalCase types, camelCase functions, `I` prefix for store interfaces.** | All new symbols follow convention. `reconcileDrift` (camelCase method), `TransitionOpts` (PascalCase type extended). |
| **`.js` in import paths** (ESM convention). | All new imports use `.js`. |
| **Barrels are pure re-exports.** | No barrel changes required. |
| **Fragile: dispatch chain is tightly coupled.** | Bug 1A touches `failure-tracker.ts` (in dispatch chain). TDD coverage: extend `deadletter-integration.test.ts` and `deadletter-frontmatter-stamp.test.ts`. Verify no regression in `bug-005-*`, `bug-001-005-regression.test.ts`. |
| **Fragile: plugin/standalone executor wiring.** | Bug 2C touches `src/ipc/routes/invoke-tool.ts` (consumed by both modes). Both adapters surface tool calls via the same `inner.data` parsing — fix is symmetric. Verify with `tests/integration/tool-invoke-roundtrip.test.ts`. |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `vitest@3.0.0` |
| Config file | `vitest.config.ts` (root, unit) + `tests/vitest.e2e.config.ts` (E2E) + `tests/integration/vitest.config.ts` (integration) |
| Quick run command | `./scripts/test-lock.sh run path/to/specific.test.ts` |
| Full suite command | `npm run typecheck && npm test && npm run test:e2e` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| 46-2A | New project created post-startup is dispatched within one poll | integration | `./scripts/test-lock.sh run src/service/__tests__/multi-project-polling.test.ts` (extend) | ✅ extend existing |
| 46-1A-atomic | `transitionToDeadletter` is atomic — partial-state impossible | unit | `./scripts/test-lock.sh run src/dispatch/__tests__/deadletter-frontmatter-stamp.test.ts` (extend) | ✅ extend existing |
| 46-1A-recover | `init()` reconciles a file with `frontmatter.status: deadletter` in `tasks/ready/` to `tasks/deadletter/` | unit | `./scripts/test-lock.sh run src/store/__tests__/task-store-reconciliation.test.ts` | ❌ NEW file (Wave 0) |
| 46-1C | `pino-roll` is wired into `getRootLogger()` with `size: '50m'` and `limit: { count: 5 }` | unit | `./scripts/test-lock.sh run src/logging/__tests__/logger.test.ts` (extend) | ✅ extend existing |
| 46-2B | `aof_dispatch` rejects with clear error when no agent/team/role and no project owner default | unit | `./scripts/test-lock.sh run src/tools/__tests__/aof-dispatch-empty-routing.test.ts` | ❌ NEW file (Wave 0) |
| 46-2B-default | `aof_dispatch` defaults `routing.team` from project `owner.team` when no explicit routing | unit | same file as above | ❌ NEW file (Wave 0) |
| 46-2C-route | IPC `/v1/tool/invoke` injects envelope `actor` into `inner.data.actor` before handler dispatch | unit | `./scripts/test-lock.sh run src/ipc/__tests__/invoke-tool-handler.test.ts` (extend) | ✅ extend existing |
| 46-2C-end-to-end | Plugin-originated `aof_dispatch` lands a task with `createdBy === <agentId>` not "unknown" | integration | `./scripts/test-lock.sh run --config tests/integration/vitest.config.ts tests/integration/tool-invoke-roundtrip.test.ts` (extend) | ✅ extend existing |

### Sampling Rate

- **Per task commit:** unit tests for the touched module (`./scripts/test-lock.sh run src/<module>/__tests__/`) — < 30s.
- **Per wave merge:** full unit suite (`npm test`) — ~10s for 3017 tests, well under 30s.
- **Phase gate:** full suite green: `npm run typecheck && npm test && npm run test:e2e && npx madge --circular --extensions ts src/`.

### Wave 0 Gaps

- [ ] `src/store/__tests__/task-store-reconciliation.test.ts` — covers Bug 1A reconciliation; assert init() moves a misfiled task; assert idempotency on second init().
- [ ] `src/tools/__tests__/aof-dispatch-empty-routing.test.ts` — covers Bug 2B; rejection case + project-owner default case + `_inbox`/`system` ignored case (Pitfall 5).

*(All other regression tests extend existing files. No framework install needed — vitest already configured.)*

### Manual UAT (post-deploy verification)

Per CONTEXT.md Verification commands:

```bash
# 1. Bug 2A — create a project AFTER daemon is running, dispatch a task, expect dispatch within ~30s
mkdir -p ~/.aof/data/Projects/phase46-uat-$(date +%s)/tasks/ready
# write project.yaml; aof_dispatch via openclaw agent main; observe dispatch within 1 poll

# 2. Bug 1C — confirm rotation
ls -lh ~/.aof/data/logs/  # expect aof.log + aof.<n>.log files as size grows

# 3. Bug 2B — empty routing rejection
openclaw agent --session-id <sid> --message "/aof_dispatch title='test' brief='test' agent=''"  # expect error
```

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All phase work | ✓ | >=22 | — |
| npm | `npm install pino-roll` | ✓ | bundled | — |
| `pino` | already installed | ✓ | 9.14.0 | — |
| `write-file-atomic` | already installed | ✓ | 7.0.0 | — |
| `pino-roll` (NEW) | Bug 1C | needs `npm install` | 4.0.0 | If install fails: keep current pino.destination, fall back to OS-level logrotate config (CONTEXT.md rejected this — surface as blocker) |
| launchd (macOS) | daemon stderr capture | ✓ (current platform) | 25.2.0 | — |
| `madge` (devDep) | circular dep check | ✓ via npx | latest | — |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** `pino-roll` requires `npm install` to land — trivial.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | pino-roll's worker-thread transport coexists cleanly with the Phase 43 daemon's launchd-managed lifecycle (no SIGTERM ordering issues during shutdown) | Pattern 4 / Bug 1C | Low — pino documents transport.end() as graceful; if pino-roll's worker survives daemon SIGTERM, last few log lines may be lost on shutdown. Acceptable. `[ASSUMED]` |
| A2 | Dropping `fd: 2` from multistream is safe — Node uncaught-exception output still goes to stderr via Node's default handler, which launchd will still capture | Pattern 4 — Option A | Medium — if Node fatal crashes happen *during* pino-roll worker init, the error may not be persisted anywhere. Mitigation: also capture `process.on('uncaughtException', e => fs.appendFileSync(...))` to a known fallback. **Recommend planner discuss with user.** `[ASSUMED]` |
| A3 | The `_inbox` project's `owner: { team: "system", lead: "system" }` should NOT be used as a routing default (Pitfall 5 — `system` is a placeholder). Other projects with `owner.team: "system"` should also be skipped. | Pattern 5 / Pitfall 5 | Low — if wrong, defaulting fires for `_inbox` tasks and they immediately fail dispatch with auth-precondition errors (current behavior anyway). User can override via explicit routing. `[ASSUMED]` |
| A4 | "gzip on rotation" requirement in CONTEXT.md can be relaxed (pino-roll lacks native gzip; using rotating-file-stream costs a custom adapter). 250MB uncompressed budget matches the user-approved cap. | Standard Stack — pino-roll caveat | Medium — user explicitly named gzip in decisions. **Recommend planner confirm in discuss-phase or pivot to rotating-file-stream + custom adapter.** `[ASSUMED]` |
| A5 | The plugin's invocation-context store's `captured.actor` (which is `agentId` from the OpenClaw event) is reliably populated when an OpenClaw agent calls `aof_dispatch` — i.e., the `before_tool_call` event always carries `agentId`. | Pattern 6 (defense-in-depth) | Medium — Phase 44 added this mapping but corner cases (channel-relayed messages, system-injected dispatches) may not have agentId. Mitigation: keep daemon-side IPC injection as primary fix; plugin-side fallback is additive. `[ASSUMED]` |
| A6 | `loadProjectManifest(ctx.store, projectId)` is safe to call from `aofDispatch` — `ctx.store` is the project-scoped store post-Phase-43 IPC route resolution, so the manifest read is local. | Pattern 5 | Low — verified via `src/projects/manifest.ts:115-130` (loadProjectManifest takes any ITaskStore + projectId). `[VERIFIED: src/projects/manifest.ts]` |

## Open Questions

1. **Should the rotation file be `<dataDir>/logs/aof.log` or `<dataDir>/logs/daemon.log`?**
   - What we know: launchd already redirects to `daemon-stderr.log` in same directory. Naming `aof.log` separates structured-pino-output from launchd-captured-stderr cleanly.
   - What's unclear: dashboards / external log shippers may scrape `daemon-stderr.log` today and expect that path.
   - Recommendation: Plan should choose `aof.log` (clear separation) and call out the change in release notes.

2. **Is the `metadataPatch` extension to `TransitionOpts` the right shape, or should we add a sibling `transitionWithMetadata(id, status, patch, opts)` method on ITaskStore?**
   - What we know: CONTEXT.md grants discretion. The patch-in-opts shape requires no interface change and reuses the same critical section.
   - What's unclear: if other callers grow similar needs (cancel-with-metadata, block-with-metadata), the opts pattern doesn't generalize.
   - Recommendation: ship `metadataPatch` in `TransitionOpts` for Phase 46. Promote to first-class API only when a second caller emerges.

3. **Should reconciliation move-on-init also handle the duplicate-file case (same task ID in two dirs)?**
   - What we know: `get(id)` already self-heals via mtime (lines 313-346). If `init()`'s reconciliation walk uses `parseTaskFile` directly (Pitfall 4 fix), it iterates each path independently — duplicates are not detected.
   - What's unclear: are duplicates possible at startup? Pre-v1.14.8 installs may have left some.
   - Recommendation: Plan should add a "duplicate detection" pass to reconciliation that mirrors `get()`'s mtime-wins logic, deleting older copies. Defensive, cheap.

4. **Does the per-poll rediscovery affect the existing `pollAllProjects` "<root>" base store iteration?**
   - What we know: Line 444 explicitly polls `this.store` (the unscoped base store) before iterating `projectStores`. Rediscovery only mutates `projectStores`, never `this.store`.
   - What's unclear: should the rediscovery skip `_inbox` (always re-added) or treat it as a normal project?
   - Recommendation: discoverProjects() always returns `_inbox` (registry.ts:60-62 always-include logic). Rediscovery is idempotent — `_inbox` is found, already in map, no-op. No special-case needed.

5. **Should empty-routing rejection be enforced via Zod refinement, raising at envelope-parse time rather than handler time?**
   - What we know: Zod refinement would reject earlier (before storeResolution) — slightly faster failure, slightly cleaner stack trace.
   - What's unclear: Zod `.refine()` doesn't have access to `ctx.store` for project-owner defaulting. The defaulting MUST happen in handler. Splitting validation across schema (reject-empty) + handler (default-from-owner) creates two failure paths.
   - Recommendation: Single rejection point in handler, after defaulting attempt. Keep schema permissive.

## Sources

### Primary (HIGH confidence)
- `src/dispatch/failure-tracker.ts:61-123` — current `transitionToDeadletter` shape (verified via Read)
- `src/store/task-store.ts:149-153, 462-477, 664-667` — `init()`, `transition()`, `save()` shapes (verified)
- `src/store/task-mutations.ts:130-254` — `transitionTask` post-`6fbcb18` hardened shape (verified)
- `src/store/task-validation.ts:40-121` — `lintTasks()` reuse target for reconciliation (verified)
- `src/store/interfaces.ts:97-105` — `ITaskStore.transition` signature (verified)
- `src/service/aof-service.ts:257-280, 389-493` — `initializeProjects` + `pollAllProjects` shapes (verified)
- `src/projects/registry.ts:44-75` — `discoverProjects` (verified)
- `src/projects/manifest.ts:115-130` — `loadProjectManifest` signature (verified)
- `src/logging/index.ts:21-33` — current pino setup (verified)
- `src/tools/project-tools.ts:148-285` — `aofDispatch` handler (verified)
- `src/tools/tool-registry.ts` — confirmed `aof_task_create` does not exist; `aof_dispatch` is the create+dispatch entry point (verified)
- `src/ipc/routes/invoke-tool.ts:97-167` — daemon IPC route, no actor-injection today (verified)
- `src/ipc/schemas.ts:37-49` — `InvokeToolRequest` envelope carries `actor: z.string().optional()` (verified)
- `src/openclaw/adapter.ts:101-135, 119` — plugin-side adapter forwards `p.actor` to envelope (verified)
- `src/openclaw/tool-invocation-context.ts:132-137` — Phase 44 captures `agentId` as `captured.actor` (verified)
- `src/openclaw/dispatch-notification.ts:42-55` — `mergeDispatchNotificationRecipient` precedent for plugin-side enrichment (verified)
- `src/daemon/service-file.ts:188-192, 239-240` — launchd plist + systemd unit point stderr to `daemon-stderr.log` (verified)
- `src/daemon/daemon.ts:200-254` — daemon startup pattern (existing per-project enumeration in wake-up replay) (verified)
- `git show 6fbcb18` — v1.16.3 commit hardening transition write order (verified via `git show`)
- `git show 746aee7` — v1.14.8 commit introducing per-task TaskLocks (verified)
- npm view (2026-04-24): pino-roll 4.0.0 / pino 9.14.0 / write-file-atomic 7.0.0 / rotating-file-stream 3.2.9 / pino-rotating-file-stream 0.0.2 / pino-transport-rotating 2.0.0 (all verified via `npm view <pkg> version time.modified dependencies`)

### Secondary (MEDIUM confidence)
- pino-roll README on npm (gzip not natively supported; `mkdir: true` required) — `[CITED: npm view pino-roll readme]`
- pino docs on `pino.transport()` (worker-thread isolation) — `[CITED: github.com/pinojs/pino/blob/main/docs/transports.md]`
- rotating-file-stream README (native gzip support, no native deps) — `[CITED: github.com/iccicci/rotating-file-stream]`
- pino multistream coexistence with transport — `[CITED: pinojs/pino issue #1189 + #1514]`

### Tertiary (LOW confidence)
- None. All claims either verified against source-of-truth code or cited from authoritative docs.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all versions verified against `npm view` 2026-04-24; alternatives investigated.
- Architecture: HIGH — all six patterns derived from existing code shapes (per-task locks, write-then-rename hardening, multi-project poll loop).
- Pitfalls: HIGH — three of six (1, 3, 4) derived from observed code interactions; two (2, 5) derived from CONTEXT.md edge cases; one (6) derived from cross-path consistency check.
- Bug 1C gzip caveat: HIGH that pino-roll lacks gzip; MEDIUM that user accepts uncompressed (decision deferred to discuss-phase).
- Phase 45 overlap: HIGH (verified — Phase 45 plans touch `src/openclaw/`, `src/ipc/schemas.ts`, `src/openclaw/openclaw-chat-delivery.ts`; Phase 46 touches `src/service/`, `src/store/`, `src/dispatch/failure-tracker.ts`, `src/logging/`, `src/tools/project-tools.ts`, `src/ipc/routes/invoke-tool.ts` — **no overlap**).

**Research date:** 2026-04-24
**Valid until:** 2026-05-24 (30 days — stable codebase, no fast-moving deps in scope)
