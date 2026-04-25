---
status: resolved
trigger: "aof-daemon spams ENOENT on ~/.aof/data/project.yaml with projectId:\"data\" every poll"
created: 2026-04-18T19:00:00Z
updated: 2026-04-18T19:25:00Z
---

# BUG-044 — Projectless base store leaks `project: data` into dispatch

## Symptoms

- `aof-daemon` at `~/.aof/data` logged on EVERY poll:
  ```
  ENOENT: no such file or directory, open '/Users/xavier/.aof/data/project.yaml'
  projectId:"data"
  ```
- Live install damage: two tainted tasks in `~/.aof/data/tasks/done/`
  (`TASK-2026-04-18-001.md`, `TASK-2026-04-18-002.md`) had
  `project: data` in their frontmatter.

## Investigation Trail

The orchestrator had already traced the full call chain before handing
off, so the investigation was primarily a **design** problem: figure out
the minimal, non-band-aid API change that addresses the root cause
without churning unrelated code paths.

### Call chain (verified by reading code)

1. **`src/store/task-store.ts:89`** (pre-fix):
   ```ts
   this.projectId = opts.projectId ?? basename(this.projectRoot);
   ```
   For `new FilesystemTaskStore("/Users/xavier/.aof/data")`,
   `basename() === "data"` → `store.projectId = "data"`.

2. **`src/store/task-store.ts:218`** (pre-fix):
   ```ts
   TaskFrontmatter.parse({
     ...
     project: this.projectId,   // stamps "data" into every task
     ...
   })
   ```

3. **`src/dispatch/task-dispatcher.ts:209`**:
   ```ts
   const projectId = task.frontmatter.project;   // "data"
   if (projectId && targetAgent) {
     const manifest = await loadProjectManifest(store, projectId);
     ...
   }
   ```

4. **`src/projects/manifest.ts:113`** (pre-fix):
   ```ts
   const projectPath = (store.projectId === projectId)
     ? join(store.projectRoot, "project.yaml")
     : join(store.projectRoot, "projects", projectId, "project.yaml");
   ```
   `store.projectId === "data"` matched the passed `projectId === "data"`,
   so it probed `~/.aof/data/project.yaml` — which doesn't exist at the
   data-dir root. `readFile` threw ENOENT; `catch` logged at `warn` level
   and returned `null`.

5. Repeat on every scheduler poll (default: every 30s).

### Design decision

I considered three API shapes for "make unscoped explicit":

| Option | Shape | Rejected because |
|--------|-------|------------------|
| A      | `projectId: string \| null` on `ITaskStore` | Widest blast radius — every `.projectId` consumer has to handle `null`. |
| B      | `projectId: string` with `""` sentinel | Existing truthy checks already handle `""`, but downstream `${store.projectId}:foo` becomes `":foo"` (ugly, collision-prone). |
| C      | Subclass `UnscopedTaskStore` | Would require constructor changes at 20+ test sites. |

**Chose A.** `null` is the clearest TypeScript signal and the blast
radius turned out to be small — only 5 call sites needed a
`?? undefined` coercion (the consumers that feed `store.projectId`
into contexts typed as `string | undefined`). Everywhere else
(`lease-manager`, `lint.ts`) the existing truthy-check patterns
handled the `null` case naturally.

**Also required:** `TaskFrontmatter.project` had to become
`.optional()` (was `z.string().min(1)`). Without that, `TaskFrontmatter.parse({})`
with the `project` key absent would throw at runtime — so the
"unscoped store omits the field" strategy literally couldn't be
expressed. Kept `.min(1)` to keep rejecting the empty-string
edge case.

## Fix (TDD, atomic commits)

| # | Commit | Subject |
|---|--------|---------|
| 1 | `c3b63b5` | `test(044): RED — assert no project leak from unscoped store` |
| 2 | `4297713` | `fix(store): remove basename() projectId fallback, make unscoped explicit` |
| 3 | `1389667` | `fix(daemon,service,mcp): pass explicit null projectId for root store` |
| 4 | `b1014f2` | `feat(migrations): add 008-strip-bogus-project-data to clean tainted tasks` |

### Commit 1 — RED baseline

Two regression tests added:

- `src/store/__tests__/task-store-unscoped.test.ts` — 4 tests
  asserting `projectId === null`, no basename stamping, no
  `project:` frontmatter line on disk, and that scoped construction
  still stamps correctly.

- `src/dispatch/__tests__/bug-044-projectId-leak.test.ts` — 3 tests
  covering the dispatch-path invariant: unscoped task has no
  `project` field → dispatcher skips manifest load;
  `loadProjectManifest` returns null without FS probe for
  falsy projectId or null store.projectId.

Baseline: **4 failed / 3 passed** of 7 new tests. The 3 that passed
did so only because the pre-existing `try/catch` in `loadProjectManifest`
already suppressed ENOENT into `null` — but with a warning log on every
poll. The fix tightens the contract so the probe is never attempted.

### Commit 2 — Core fix (10 files)

- `src/schemas/task.ts` — `TaskFrontmatter.project` → `.optional()`.
- `src/store/interfaces.ts` — `ITaskStore.projectId: string | null`.
- `src/store/task-store.ts`:
  - Constructor: `opts.projectId && length > 0 ? opts.projectId : null`
    (removed `basename()` fallback).
  - `create()`: `...(this.projectId ? { project: this.projectId } : {})`
    (conditional stamping).
  - `TaskStoreOptions.projectId?: string | null`.
- `src/projects/manifest.ts` — `loadProjectManifest`:
  - Early-return null on falsy projectId.
  - Same-root match guard: `store.projectId && store.projectId === projectId`.
- `src/permissions/task-permissions.ts` — `projectId` getter
  widened to `string | null`.
- 5 coercion sites (`?? undefined`):
  - `src/dispatch/assign-executor.ts:124`
  - `src/dispatch/murmur-integration.ts:273`
  - `src/ipc/routes/invoke-tool.ts:154`
  - `src/memory/curation-generator.ts:268` (uses conditional spread instead).
  - `src/openclaw/permissions.ts:45`

### Commit 3 — Call site fixes

Three unscoped construction sites now pass `{ projectId: null }`
explicitly:

- `src/daemon/daemon.ts:60` (daemon startup)
- `src/service/aof-service.ts:97` (AOFService constructor)
- `src/mcp/shared.ts:75` (legacy MCP bootstrap)

The explicit `null` makes the intent documentable and greppable.
Omitting `projectId` would also work (constructor defaults to null)
but explicit is better — and survives future API changes.

### Commit 4 — Migration 008

`src/packaging/migrations/008-strip-bogus-project-data.ts` (~130 lines):

- Scans `<aofRoot>/tasks/<status>/*.md` across all 8 status dirs.
- For any file whose frontmatter has `project === "data"` EXACTLY,
  deletes the key and rewrites atomically via `writeFileAtomic`.
- **Only the exact `"data"` sentinel is stripped** — other project-ID
  mismatches (if any exist from other bugs) are left for `aof lint`
  to surface.
- Idempotent: re-running on clean data is a no-op. Tests prove mtime
  doesn't change on repeated runs over untainted data.
- Version `1.15.1` (pairs with the patch release).
- Registered in `src/cli/commands/setup.ts::getAllMigrations()`.

10 tests cover: identity, strip-tainted, preserve-legit,
preserve-absent, idempotency, non-.md skip, missing-dirs tolerance,
missing-tasks-tree tolerance, malformed-frontmatter tolerance, and
all-8-status-dirs coverage.

## Verification

| Check | Result |
|-------|--------|
| `npm run typecheck` | **clean** (exit 0) |
| `npm test` | **2937 passed, 3 skipped** (270 files) |
| `npm run test:e2e` | **224 passed, 5 skipped** (17 files) |
| BUG-044 regression suite | **7/7 green** (was 3/7 before fix) |
| Migration 008 suite | **10/10 green** |

### Proof-of-fix on the live install

The tainted tasks at `~/.aof/data/tasks/done/TASK-2026-04-18-{001,002}.md`
have frontmatter like:

```yaml
---
schemaVersion: 1
id: TASK-2026-04-18-001
project: data           ← this line gets stripped
title: Daily Triage Run
...
---
```

Migration 008's `stripBogusProjectFromFile` function parses the
frontmatter, confirms `parsed.project === "data"`, `delete`s the key,
re-serializes via `stringifyYaml`, and atomically rewrites. Tested
in `008-strip-bogus-project-data.test.ts` with exactly this shape
(plus 9 other shapes). The agent did NOT run the migration against
the live install per the task instructions — that lands on the next
`aof setup --auto --upgrade` after the v1.15.1 deploy.

After the fix + migration:
1. No new tasks stamped with bogus project IDs (store-level fix).
2. Existing tainted tasks cleaned (migration 008).
3. Dispatch no longer tries to load a project manifest for legacy
   tasks that no longer have a `project` field (manifest early-return).
4. ENOENT log spam stops on the very next poll cycle post-restart.

## Discovered Secondary Issues (flagged, NOT fixed)

None of scope. The only adjacent observation worth noting is that
**`src/projects/lint.ts:229`** currently checks
`if (frontmatter.project && frontmatter.project !== projectId)` —
this still works correctly for both scoped and unscoped stores after
the fix, but might deserve a follow-up to detect
`frontmatter.project !== undefined && !storeIsScoped` as a separate
lint warning. Not urgent — migration 008 handles the known instance;
future regressions would surface via the BUG-044 regression test.

The E2E suite surfaced a YAML warning about an unrelated fixture
with duplicate `role:` keys in an org chart — pre-existing, unrelated
to BUG-044, not addressed.

## Files Changed

- `src/schemas/task.ts`
- `src/store/interfaces.ts`
- `src/store/task-store.ts`
- `src/projects/manifest.ts`
- `src/permissions/task-permissions.ts`
- `src/dispatch/assign-executor.ts`
- `src/dispatch/murmur-integration.ts`
- `src/ipc/routes/invoke-tool.ts`
- `src/memory/curation-generator.ts`
- `src/openclaw/permissions.ts`
- `src/daemon/daemon.ts`
- `src/service/aof-service.ts`
- `src/mcp/shared.ts`
- `src/packaging/migrations/008-strip-bogus-project-data.ts` (new)
- `src/cli/commands/setup.ts` (register migration)
- `src/store/__tests__/task-store-unscoped.test.ts` (new, regression)
- `src/dispatch/__tests__/bug-044-projectId-leak.test.ts` (new, regression)
- `src/packaging/migrations/__tests__/008-strip-bogus-project-data.test.ts` (new, migration test)

## Commits

- `c3b63b5` test(044): RED — assert no project leak from unscoped store
- `4297713` fix(store): remove basename() projectId fallback, make unscoped explicit
- `1389667` fix(daemon,service,mcp): pass explicit null projectId for root store
- `b1014f2` feat(migrations): add 008-strip-bogus-project-data to clean tainted tasks
