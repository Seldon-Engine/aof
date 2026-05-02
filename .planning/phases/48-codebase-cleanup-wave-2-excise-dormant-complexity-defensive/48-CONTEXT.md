# Phase 48 Context — Codebase Cleanup Wave 2

## Origin

Session-driven audit on **2026-04-30** triggered by user observation: "we've made a lot of changes recently and I feel like we've left a lot of bodies behind." Audit method: read `CODE_MAP.md`, walk the largest files via Serena symbolic tools, grep for stale references, compare CODE_MAP claims against actual production callers via `find_referencing_symbols`.

## Already shipped during the audit session

These two commits are on `main` ahead of this phase being created. Phase 48 picks up where they leave off.

### Commit `01da21d` — `OpenClawAdapter` excision

- `src/openclaw/openclaw-executor.ts`: 557 → 420 LOC. Removed the `OpenClawAdapter` class (90 LOC), `runAgentBackground` and `parsePlatformLimitError` helpers (only the class used them), and the deprecated `OpenClawExecutor` alias.
- `src/openclaw/executor.ts`: deleted (1-line barrel re-export, no external importers).
- `src/openclaw/index.ts`: dropped the re-export line.
- Tests: deleted `executor.test.ts` (359 LOC) and `openclaw-executor-platform-limit.test.ts` (128 LOC) — both tested the dead class. Added `run-agent-from-spawn-request.test.ts` (15 tests covering prompt/model/agent-id/setup-error behaviors) and retargeted `bug-2026-04-28-auth-profile-and-setup-timeout.test.ts` at the spawn-poller production entry.
- `CODE_MAP.md`: removed the misleading "kept in-tree for the standalone/legacy in-process path" claim; updated `GatewayAdapter` implementations table.
- Net: **−578 LOC**.

### Commit `23f2055` — Dormant `platformLimit` throttling excision

Phase 43 deleted the only producer of `SpawnResult.platformLimit` (the in-process `OpenClawAdapter`). Neither `PluginBridgeAdapter` nor `StandaloneAdapter` parses platform-limit errors. The whole auto-throttling mechanism was a closed loop only exercised by `MockAdapter`-fed tests.

- `SpawnResult.platformLimit` field removed.
- `assign-executor.ts`: ~30 LOC consumer block removed (`releaseLease` + `concurrency.platformLimit` event emission + `effectiveCap` mutation) plus the `effectiveConcurrencyLimitRef` parameter.
- `scheduler.ts`: module-level `effectiveConcurrencyLimit` state and the ref threading through `executeActions → handleAssign → executeAssignAction` removed.
- `assign-helpers.ts`: `effectiveConcurrencyLimitRef` field removed from `OnRunCompleteContext` (was never read inside `handleRunComplete` even before).
- `task-dispatcher.ts`: `effectiveConcurrencyLimit` parameter removed from `buildDispatchActions`.
- `schemas/event.ts`: `concurrency.platformLimit` event type removed.
- `events/notification-policy/rules.ts`: associated alert rule removed.
- `assign-executor.ts`: orphan JSDoc block at end-of-file (stale doc-comment for a function that had moved to `task-dispatcher.ts`) removed.
- Tests: deleted `scheduler-adaptive-concurrency.test.ts` (321 LOC) and `e2e-platform-limit.test.ts` (198 LOC) — both fed `MockAdapter` `platformLimit` values and asserted the event/cap roundtrip. Cleaned boilerplate `effectiveConcurrencyLimitRef: { value: null }` from two surviving test files.
- Static throttling via `config.maxConcurrentDispatches` (PROJECT manifest, default 3) and per-team `team.dispatch.maxConcurrent` are unchanged and remain load-bearing.
- Net: **−618 LOC**.

### Memory cleanup (also during audit session)

- Deleted Serena memories `dispatch-system/executor-resolution` and `plugin-executor-path-analysis` (both described the pre-Phase-43 in-plugin executor flow that no longer exists).
- Rewrote `project_overview` memory to point at CODE_MAP for architecture and only carry what doesn't belong in CODE_MAP (Node version pin, parser gaps, drift markers for future stale-memory detection).
- Rewrote `suggested_commands` memory to fix the deploy/restart procedure (old version said "daemon runs inside gateway plugin (self-starts)" — false since Phase 43).

## Audit findings still to action (this phase)

Original audit ranked findings by impact-to-effort. Items 1 and 2 above shipped already. Items 3-11 are this phase's scope, renumbered as Plans 1-9 in ROADMAP.md.

### 1. `chat-delivery-poller.ts` defensive-cast reduction

- File: `src/openclaw/chat-delivery-poller.ts` (658 LOC)
- Pattern: file is full of `as { config?: { loadConfig?: ... } } | undefined` shape-cast guards even though the runtime is fully typed in `src/openclaw/types.ts` (`OpenClawSystemRuntime`, `OpenClawAgentRuntime`).
- Specific hot spots:
  - `injectSessionWakeUp` (`:163-321`) — 158 LOC for redirect-key → enqueue → choose-mechanism → wake. 16 separate `wakeLog.info({...})` calls with verbose payloads. Collapse to one summary log per outcome.
  - `agentHasHeartbeat` (`:554-586`) — 33 LOC of `as { agents?: unknown }` introspection.
  - `readMainKey` (`:514-522`), `wakeViaEmbeddedRun` (`:386` cast), `agentHasHeartbeat` (`:556` cast) — three identical `as { config?: { loadConfig?: ... } } | undefined` casts.
- Target: ~250 LOC reduction, mostly cast removal and log consolidation.

### 2. `dispatch/scheduler.ts:poll()` god-function decomposition

- File: `src/dispatch/scheduler.ts:77-530` (the `poll` function alone is ~450 LOC).
- Structure: nine numbered inline phases (`// 1.`, `// 2.`, etc.), two manual stats-counting loops, inline DFS at `:128-164` for circular deps, inline YAML parse for project manifest, inline alert thresholds.
- Targets to extract:
  - `findCircularDeps(allTasks): Set<string>` — replaces inline DFS.
  - The duplicate stats-counting block at `:339-360` should call `buildTaskStats(updatedTasks)` (already exists).
  - Each numbered step (SLA, hop timeouts, promotion, recovery, DAG hop dispatch, callback retry, telemetry, alerts, murmur eval) becomes a one-line `await ...Action(...)` call leaving `poll()` as ~80-LOC orchestrator.
- Risk: this is the dispatch hot path. Behavior must be byte-identical. **This plan goes LAST in the wave, gets its own integration-test pass before commit, and ships as a separate atomic commit.**

### 3. `AOFService.pollAllProjects` stats consolidation

- File: `src/service/aof-service.ts:500-558`
- Manually zeros nine `stats.*` fields in the `aggregated` initialization, then increments each one in a loop. Replace with `Status[]` array + `reduce`.
- Pure local refactor. ~30 LOC → ~10.

### 4. `AOFService.reconcileOrphans` dedup

- File: `src/service/aof-service.ts:352-447`
- Two near-identical try/log/transition blocks for DAG-task vs non-DAG-task paths with the same error-swallow shape.
- Extract `reclaimOne(task)`. Target: ~95 LOC → ~55.

### 5. `protocol/router.ts:handleSessionEnd` cast cleanup

- File: `src/protocol/router.ts:286-382`
- 70-LOC DAG branch repeats `this.logger as import("../events/logger.js").EventLogger` four separate times.
- Hoist the cast to constructor or actually narrow the type at the property declaration (`logger: EventLogger | undefined` → required at construction).

### 6. Sweep historical phase/bug references from production source

- Pattern: 119 hits across 25 files matching `/Phase 4[0-9]|BUG-046[a-e]|D-0[0-9]|D-1[0-9]|WR-0[0-9]|T-43-0[0-9]|D-44-/`.
- CLAUDE.md rule: "Don't reference the current task, fix, or callers ('used by X', 'added for the Y flow', 'handles the case from issue #123'), since those belong in the PR description and rot as the codebase evolves."
- Worst offenders (file: ref count):
  - `dispatch/scheduler.ts: 15`
  - `openclaw/daemon-ipc-client.ts: 11`
  - `tools/project-tools.ts: 7`
  - `store/task-store.ts: 7`
  - `packaging/migrations/007-daemon-required.ts: 7`
  - `ipc/schemas.ts: 7`
  - `openclaw/openclaw-chat-delivery.ts: 6`
  - `openclaw/dispatch-notification.ts: 6`
  - `logging/index.ts: 6`
  - `daemon/daemon.ts: 6`
- Mechanical sweep. **Keep the substantive WHY, drop the milestone tag.** A comment that says "Phase 43 D-12: no-plugin-attached → hold task in ready/, no retry increment" becomes "no-plugin-attached → hold task in ready/, no retry increment" — the rule survives, the milestone reference goes.
- Migration files (`packaging/migrations/00X-*.ts`) are a special case: their `Phase 43`/`Phase 42` references describe historical migration intent for users running the upgrade. Probably keep those — the migration code itself is historical record. Decide per-file during the sweep.

### 7. Audit and remove the two callbackDepth env-var fallbacks

- Sites:
  - `src/openclaw/adapter.ts:41-43` — `parseCallbackDepth` reads `process.env.AOF_CALLBACK_DEPTH` if the IPC envelope field is missing.
  - `src/mcp/shared.ts:97-98` — same pattern.
- Phase 43 D-06 made the IPC envelope the source of truth.
- **Pre-work:** confirm the env fallback is dead before excising. Specifically check whether `dispatch/callback-delivery.ts:351-400` (the documented CLAUDE.md exception that mutates `process.env.AOF_CALLBACK_DEPTH` cross-process) is still load-bearing post-43, or whether the envelope path obsoletes it. If the cross-process mutation is also dead, this becomes a much larger cleanup that finally closes the CLAUDE.md "one exception to config-only env access" caveat.

### 8. Split `cli/commands/{memory,daemon,setup}.ts`

- Current sizes: `memory.ts` 607 LOC (17 subcommands), `daemon.ts` 599 LOC (11 subcommands), `setup.ts` 589 LOC (2 huge subcommands: interactive wizard + migration registry).
- Standard Commander.js layout: `src/cli/commands/<group>/<verb>.ts` per subcommand, with `<group>/index.ts` registering the subtree.
- Mechanical, lowest-risk in the phase.

### 9. `FilesystemTaskStore.create` retry-loop bound

- File: `src/store/task-store.ts:353` — `for (let attempt = 0; attempt < 1000; attempt++)`.
- Leftover from per-store sequential counter (replaced by nanoid8 in commit `fbcdda8`).
- With nanoid8 (~218 trillion possible suffixes per day), EEXIST is vanishingly rare. A real EEXIST means disk full / permission denied / clock skew — fail fast.
- Cap at 5 retries. One-line change.

### 10. Adopt `gray-matter` for frontmatter parsing (library-swap track)

- We already pay for `gray-matter` as a runtime dep but use it in exactly one file (`src/memory/tools/metadata.ts`). The main task-file parser at `src/store/task-parser.ts` hand-rolls fence-finding + `yaml.parse/stringify` instead. Worst of both worlds: paying for the library, not benefiting from it.
- Replace `parseTaskFile` and `serializeTask` with `gray-matter` calls. Keep the `TaskFrontmatter.parse(...)` Zod step for validation.
- Saves ~80 LOC. Removes hand-rolled edge cases (CRLF line endings, missing trailing newline, etc.).

### 11. Replace `TaskLocks` with `async-mutex` (library-swap track)

- File: `src/store/task-lock.ts` — 73 LOC of hand-rolled per-key Promise-tracking mutex.
- `async-mutex` provides `Mutex`, `Semaphore`, and a key-collection pattern with battle-tested correctness around release-on-throw, queue ordering, and fairness — all of which the hand-rolled version *almost* gets right but has subtle edges (the `inflight.get(id) === ours` slot-eviction check is correct but fragile).
- Add `async-mutex` dep. Replace `TaskLocks` with a thin `KeyedMutex` wrapper (~15 LOC) over `Mutex` instances keyed by task id.
- Saves ~60 LOC + correctness upgrade.

### 12. Consolidate retry/timeout patterns onto `p-retry` + `p-timeout` (library-swap track)

- Three sites have hand-rolled exponential backoff with the same `INITIAL_BACKOFF_MS = 1_000` / `MAX_BACKOFF_MS = 30_000` / `Math.min(backoff * 2, MAX)` pattern: `src/openclaw/chat-delivery-poller.ts`, `src/openclaw/spawn-poller.ts`, `src/daemon/standalone-adapter.ts:pollForCompletion`. None have jitter, so all pollers retry in lockstep when the daemon hiccups (mild thundering-herd risk).
- 5+ sites have `Promise.race` + `setTimeout(reject, ...)` + manual `unref()` boilerplate for timeouts: `withSetupTimeout` and the agent-run timeout in `openclaw-executor.ts`, fetch timeouts in `standalone-adapter.ts`, etc.
- Add `p-retry` (gives jitter for free, abort signals, max-attempts caps) and `p-timeout` (10-line library, removes the `unref()` boilerplate).
- Saves ~140 LOC across files + free jitter on backoff.

## Wave order (suggested)

1. **Wave A — mechanical, low-risk:** Plans 3, 4, 8, 9. No behavior implications.
2. **Wave B — noise reduction:** Plans 5, 6 (router cast cleanup + historical-ref sweep). Touches many files but no behavior.
3. **Wave C — library-swap drop-ins:** Plans 10, 11, 12 (`gray-matter`, `async-mutex`, `p-retry` + `p-timeout`). Each is a drop-in with equivalent semantics; ship as separate atomic commits so any regression is bisectable to a single library swap.
4. **Wave D — defensive-cast reduction:** Plan 1 (chat-delivery-poller). Single file but significant. Needs the existing `chat-delivery-poller.test.ts` (20 tests) to remain green without modification.
5. **Wave E — investigation + likely cleanup:** Plan 7 (callbackDepth fallbacks). Needs analysis before action; may grow scope if the cross-process env mutation can also go.
6. **Wave F — risky last:** Plan 2 (scheduler.poll decomposition). Own commit. Own integration-test pass. Manual smoke against the running daemon if possible.

## Tools and references

- Audit working notes (this conversation, not preserved as standalone doc): identified the 11-item list with file:line citations during a CODE_MAP-driven walk on 2026-04-30.
- v1.10 milestone (Phases 34-40, shipped 2026-03-16) is the closest precedent — 7 phases, multiple atomic refactors, no behavior change, +17,351/-8,623 lines net (most of the +17k was test infrastructure adoption).
- CLAUDE.md "Engineering Standards" section lists the rules being enforced here: TDD, root-causes-over-bandaids, no premature abstractions, no comment debt, no backwards-compatibility shims for hypothetical futures.

## Out-of-scope reminders

- Behavior changes: zero. User-facing CLI surface, daemon HTTP routes, plugin IPC contracts must be byte-identical.
- The 5 Serena-parser-incompatible files (`events/logger.ts`, `events/notifier.ts`, `views/kanban.ts`, `views/mailbox.ts`, `events/notification-policy/engine.ts`): flagged as Noted Issues in CODE_MAP, but the parser bug is upstream Serena's. Don't touch them as part of this phase.
- The `migrations/00X-*.ts` `console.log` calls: bootstrap context where Pino isn't initialized; intentional.
- Adding new tests beyond regression contracts: this is reduction, not addition. The two waves already shipped (0a, 0b) added one new test file each only because the deleted tests had unique behavioral coverage that needed retargeting.

## Acceptance gates

Per atomic commit:
- `npm run typecheck` clean
- `npm test` green
- `npx madge --circular --extensions ts src/` reports 0 cycles

Per wave:
- `npm run test:integration:plugin` green (especially after Wave E)

Per phase end:
- `npm run test:e2e` green
- CODE_MAP.md updated to reflect post-cleanup file sizes and any structural changes
- Serena memories refreshed where structural changes would invalidate them
- v1.20.0 patch release with hand-crafted release notes per CLAUDE.md "Build & Release"
- Total LOC reduction target: **−2,800 to −3,800** across `src/` (combined with the −1,196 already shipped in Waves 0a/0b). The library-swap track (Plans 10-12) contributes ~−280 LOC of that.
