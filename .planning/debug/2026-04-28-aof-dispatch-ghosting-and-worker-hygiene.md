---
status: open
trigger: "Recurring 'No credentials found for profile openai:default' on AOF dispatches (25+ failures over 2026-04-25/26/27). Initial RCA pointed at a credential-classification gap, but live probes proved the credential error is a sometimes-symptom of a deeper dispatch-path issue — spawn requests silently ghost between AOF's plugin-bridge and OpenClaw's runEmbeddedPiAgent."
created: 2026-04-28T03:30:00Z
updated: 2026-04-28T03:30:00Z
---

# Investigation — AOF dispatch ghosting + OpenClaw worker hygiene

This file exists so the investigation survives context compaction. If
you (future Claude) are reading this, **read it fully before acting**.
The user explicitly does not trust that follow-through happens after
compaction without an artifact like this.

## TL;DR for next session

Three workstreams, **execute in this order** unless the user redirects:

1. **Patch (small, ship-soon)** — credential errors should classify as
   `permanent` so the 30-min retry cycle stops wasting OpenClaw
   dispatches. See § "Workstream 1" below.
2. **Audit (one-off script)** — measure whether AOF dispatches leak
   `openclaw` worker processes. See § "Workstream 2".
3. **Phase (broader investigation)** — dispatch-ghosting root cause.
   Probably warrants `/gsd-debug` or a real phase. See § "Workstream 3".

## What is actually happening (evidence-based, not speculation)

### Surface symptom

Tasks routed to AOF agents (researcher, swe-architect, swe-tech-writer,
swe-qa, swe-po — multiple distinct agents, not one) fail with:

```
Agent error: exception: No credentials found for profile "openai:default".
```

Frequency: 25 occurrences across 2026-04-25/26/27 in
`~/.aof/data/events/2026-04-{25,26,27}.jsonl` (3 + 15 + 7).

### What I proved with live probing on 2026-04-28

1. **Credentials are NOT missing in the gateway process.**
   `openclaw infer model run --gateway --model openai/gpt-5.5 …`
   succeeds. Credentials are env-ref'd
   (`~/.openclaw/agents/<agent>/agent/auth-profiles.json` →
   `keyRef.source=env, id=OPENAI_API_KEY`) and the gateway plist
   correctly wraps in `op run --env-file ~/.openclaw/op.env`.
2. **All failing agents have valid `openai:default` profile entries.**
   Verified via `jq` across all six agent dirs.
3. **Killing the 29 stale Apr-25 `openclaw` workers did NOT fix the
   dispatch path.** Probe 2 (post-kill) still ghosted: `dispatch.matched`
   fired, `spawn-poller` received the spawn, then total silence — no
   new agent process, no session file, no completion callback, no
   error. Task sat in `in-progress` until main's subscription closed
   it with a synthetic completion.
4. **Probe 1 had identical pathology** before the worker kill. So worker
   staleness is not the proximate ghost cause; it's a co-existing
   leak that compounds the issue but isn't the trigger.

### Process-tree forensics from the probe window

- Gateway: PID 50241/50242 (started Apr 27 22:47:18, fresh after a
  manual restart whose recorded reason was literally
  "Apply researcher model routing fix so AOF tasks stop using
  uncredentialed openai:default" — someone tried to fix this earlier).
- AOF daemon: PID 50208 (started Apr 27 22:47:09).
- Stale `openclaw` workers before kill: 30, all PPID=1, all started
  in clusters between Apr 25 21:12 → Apr 25 23:02. Now reaped.
- After probes 1 and 2, **zero new `openclaw` worker processes
  spawned**. The spawn request reached the spawn-poller and went
  nowhere.

### The "main intercepts" caveat

User's `main` agent has an AOF subscription that auto-handles tasks it
sees in `in-progress` without a live agent run. Both diagnostic probes
were closed by main rather than the routed agent. Task bodies show
synthesised "Completion Summary" content from main's session
(`c068819c-…` lives in `~/.openclaw/agents/main/sessions/`, NOT
swe-architect's). For a clean reproduction we would need to:
- create a probe with an agent main is not allowed to fill in for, OR
- temporarily disable main's AOF subscription, OR
- exercise the dispatch path at a lower level (direct
  `runEmbeddedPiAgent` call via openclaw CLI without going through
  AOF's task lifecycle).

## Where the bugs actually live

### Bug A — Error classification gap (small, deterministic)

`src/dispatch/assign-helpers.ts:78-82` — `handleRunComplete` builds the
enforcement reason string but **never calls** `classifySpawnError`.
`classifySpawnError` exists at `src/dispatch/scheduler-helpers.ts:163`
and is wired only into the dispatch-time path
(`assign-executor.ts:265`), not the run-complete callback path.

`PERMANENT_ERROR_PATTERNS` (`scheduler-helpers.ts:137-145`) covers
"unauthorized" / "forbidden" but **not** "no credentials" / "no api
key". A test fixture in
`src/dispatch/__tests__/bug-046a-atomic-transition.test.ts:117` already
uses `'No API key found for provider "openai"'` as a failure-mode
sample, but it isn't routed through classification, so it's silently
treated as transient.

The lease-expiry handler's `errorClass`-aware short-circuit
(`shouldAllowSpawnFailedRequeue` in `scheduler-helpers.ts:207`) only
fires when `metadata.blockReason` includes `"spawn_failed"` (see
`lifecycle-handlers.ts:43-45`). `handleRunComplete` writes the failure
to `metadata.enforcementReason`, not `metadata.blockReason`, so the
short-circuit never engages — the task cycles
`blocked → ready → blocked` every ~10 min until the dispatch-failures
counter hits the deadletter threshold.

### Bug B — Dispatch ghosting (deeper, less understood)

AOF's call into `runEmbeddedPiAgent`
(`src/openclaw/openclaw-executor.ts:316-338` `executeEmbeddedRun`)
omits `authProfileId` and `authProfileIdSource`. Both are documented
on `RunEmbeddedPiAgentParams`
(`/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/agents/pi-embedded-runner/run/params.d.ts:88-89`).
OpenClaw's normal interactive runner threads `authProfileId` through
session creation
(`agent-runner.runtime-MNZtJ3vM.js`, the
`params.sessionEntry?.authProfileOverride` line) — AOF skips session
creation entirely, building a synthetic
`agent:${agentId}:subagent:${sessionId}` sessionKey and diving
straight into `runEmbeddedPiAgent`.

But: even fixing that probably doesn't explain the ghost. The probes
showed the spawn arriving at `spawn-poller` and producing no further
gateway-log activity — no `runEmbeddedPiAgent` invocation visible at
all. So somewhere between `spawn-poller`'s "spawn received" log
(`pid=50242 component=spawn-poller`) and `runAgentFromSpawnRequest`
calling the runner, the request is dropped. Suspects:
- IPC envelope handed off to a worker pool that isn't running.
- Promise constructed and never awaited.
- Background task started without an active reference, GC'd before
  it could fire.
- AOF plugin reload race (gateway.log shows `[AOF] Plugin loaded`
  ~30+ times across one session — every reload re-registers the
  service; in-flight spawns may be orphaned).

### Bug C — Worker leak (compounds; AOF may or may not be a contributor)

CLAUDE.md "Flavor 1" describes zombie `openclaw-agent` processes
caching stale plugin code. CLAUDE.md "Flavor 2" describes stale
`openclaw` workers from incomplete `npm install -g openclaw@latest`
cycles. The 29 zombies I cleaned up today were a Flavor-2 picture
(all from before the most recent install at 2026-04-25 17:04).

Open question: **does AOF contribute to the leak?** Suspects in
`src/`:
- `src/openclaw/spawn-poller.ts` and `src/openclaw/chat-delivery-poller.ts`
  run `setTimeout`-delayed loops. Only one `.unref()` exists in all
  of `src/`, at `openclaw-executor.ts:346`. The poller loops are
  `await`-driven, so they probably can't keep the process alive on
  their own — but a stop signal is only useful if `stop()` is wired
  to break the loop, which I haven't audited.
- `OpenClawServiceDefinition` (`src/openclaw/types.ts:9-14`) has a
  `stop` hook — verify AOF actually halts both pollers when OpenClaw
  invokes it. If `stop` is a no-op or doesn't propagate cancellation,
  the pollers keep the worker alive after session end.
- No `process.on('exit'|'beforeExit')` cleanup hooks in `plugin.ts`
  or `src/openclaw/`. Comparable bundled OpenClaw plugins (lobster,
  matrix, telegram) might handle this differently — diff them.

## Workstream 1 — Credential-error classification patch (ship-soon)

**Files to edit:**
1. `src/dispatch/scheduler-helpers.ts:137-145` — extend
   `PERMANENT_ERROR_PATTERNS`:
   ```ts
   "no credentials found",
   "no api key found",
   "missing credentials",
   "missing api key",
   "invalid api key",
   ```
2. `src/dispatch/assign-helpers.ts handleRunComplete` (around line
   78-115) — when `outcome.error` is present:
   - Call `classifySpawnError(outcome.error.message)` and stamp
     `errorClass` on the task metadata.
   - Stamp `metadata.blockReason = "spawn_failed: " + reason` so the
     lease-expiry guard kicks in.
   - OR `errorClass === "permanent"` into the
     `shouldTransitionToDeadletter(updatedTask)` branch so a permanent
     error deadletters on failure 1, not failure 3.
3. **Regression test** following `bug-NNN-description.test.ts`
   convention. Asserts: a run-complete callback with
   `error.message = 'No credentials found for profile "openai:default".'`
   lands directly in `deadletter` with `errorClass: "permanent"`,
   not in `blocked` for retry.

**Done when:** `npm run typecheck && npm test` passes. Atomic commit on
`main` per TBD policy.

## Workstream 2 — Worker-leak audit (one-off, before any structural fix)

Goal: prove or disprove that AOF dispatches leave `openclaw` worker
processes alive.

Steps:
1. Snapshot baseline:
   `ps -eo pid,lstart,command | grep -E ' openclaw *$' > /tmp/wkr-pre.txt`
2. Dispatch N=10 probe tasks via `aof task create -a swe-architect …`
   + `aof scheduler run`. Stagger by 30s.
3. Wait 5 min after the last task completes.
4. Snapshot after:
   `ps -eo pid,lstart,command | grep -E ' openclaw *$' > /tmp/wkr-post.txt`
5. Compare `comm -13 /tmp/wkr-pre.txt /tmp/wkr-post.txt` — any new
   workers still alive? Any of them tied to AOF dispatch sessionIds
   (check `lsof -p <pid> | grep aof`)?

**Confounder:** main's auto-handler will close some probes. Either run
the audit at a time when main is paused, or accept that some probes
won't actually exercise the AOF runner — but worker count should
still increment per *attempted* spawn. Document carefully.

If workers leak: file the audit results in this debug file under
"## Audit results". Then move to Workstream 3 to fix.

If workers don't leak: the credential/ghost issue is purely
OpenClaw-side worker pool churn (Phase 999.5 territory) and AOF's
contribution is just the missed classification (Workstream 1).

## Workstream 3 — Dispatch-ghosting investigation (broader)

This needs `/gsd-debug` or a full phase, not a quick patch. Scope:

- Why does `spawn-poller` "spawn received" not produce a corresponding
  `runEmbeddedPiAgent` invocation in gateway.log?
- Is the AOF-plugin reload pattern (gateway.log shows ~30+ reloads/day)
  racing against in-flight spawns?
- Should AOF's `executeEmbeddedRun` pass `authProfileId` and
  `authProfileIdSource: "user"` explicitly?
- Should AOF prime the runtime auth-profile snapshot
  (`replaceRuntimeAuthProfileStoreSnapshots`,
  `ensureAuthProfileStore`) at plugin load time so subsequent
  dispatches can't get a cold cache?

Acceptance: a re-probe (10 dispatches in a row) where every dispatch
either (a) actually spawns a fresh worker that runs the routed
agent end-to-end, OR (b) fails fast with a classified, retryable
error. No more silent ghosting.

## Quick references — load these next session

- `src/dispatch/assign-helpers.ts` — `handleRunComplete` (line 44)
- `src/dispatch/scheduler-helpers.ts` — `classifySpawnError` (163),
  `PERMANENT_ERROR_PATTERNS` (137), `shouldAllowSpawnFailedRequeue`
  (207)
- `src/dispatch/lifecycle-handlers.ts` — lease expiry handler (40-110)
- `src/dispatch/failure-tracker.ts` — `trackDispatchFailure` (22),
  `transitionToDeadletter` (60)
- `src/openclaw/openclaw-executor.ts` — `executeEmbeddedRun` (316),
  `prepareEmbeddedRun` (245), `runAgentFromSpawnRequest` (138)
- `src/openclaw/types.ts` — `OpenClawServiceDefinition` (9),
  `OpenClawAgentRuntime` (54)
- OpenClaw SDK type:
  `/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/agents/pi-embedded-runner/run/params.d.ts:88-89`
- OpenClaw runner reference:
  `/opt/homebrew/lib/node_modules/openclaw/dist/agent-runner.runtime-MNZtJ3vM.js`
  (search for `runEmbeddedPiAgent`)

## Tasks affected (for closing the loop)

These tasks are all currently in some bad state because of this issue.
After fixing, sweep them:
- `~/.aof/data/tasks/TASK-2026-04-27-K3UZM6eN.md` — currently
  `status: ready, dispatchFailures: 8` despite the deadletter metadata
  being stamped. Manually-resurrected ghost.
- `~/.aof/data/Projects/openclaw-security/tasks/cancelled/TASK-2026-04-27-AVRCC5C9.md` —
  the task that triggered this entire investigation.
- Any task with `metadata.lastDispatchFailureReason` matching
  "No credentials found for profile" — `rg -l` over `tasks/`.

## Audit results (Workstream 2 — partial, static + lightweight live)

Static + log-based audit completed 2026-04-28. **Strong evidence that
AOF contributes to worker leaks.** Three findings, in priority order:

### Finding A — Per-process pollers keep workers alive (high)

`src/openclaw/spawn-poller.ts` and `src/openclaw/chat-delivery-poller.ts`
both expose a `startXPollerOnce` guarded by a module-level boolean
(`spawnPollerStarted`, `chatDeliveryPollerStarted`). The comment in
spawn-poller.ts explicitly says "at most one active long-poll loop
**per plugin process**" — i.e. the singleton is per-Node-process, not
per-system. Every Node process that loads `registerAofPlugin`
unconditionally calls both `startXPollerOnce`s
(adapter.ts:144-145), so each spawned worker process opens its own
long-poll on the daemon socket and never lets go.

The poll loop uses `await client.waitForSpawn(30_000)` followed by
re-entry, so the underlying Node socket handle is effectively held
forever. There is no abort signal, no `process.on("exit")` teardown,
no `stop` hook from OpenClaw — the only documented way to end the
loop is `stopSpawnPoller` which is labeled a *test helper*. Production
has no clean shutdown path.

**Live evidence:**
- `gateway.log` shows **6,019 `[AOF] Plugin loaded` lines since
  2026-02-08** (~79 reloads/day average).
- `aof.log` shows the register-time `selfCheck` warning emitted by
  **28 distinct PIDs** over the log retention window.
- **11 of those 28 PIDs are still alive right now** (1 gateway
  primary, 1 generic `openclaw`, 9 `openclaw-agent` workers all
  spawned in a 14-second window 2026-04-28 07:55-07:56). Each one
  is running an idle spawn-poller + chat-delivery-poller pair
  competing for the same daemon socket.

This matches CLAUDE.md "Flavor 1 zombie agent" pattern: agents started
on prior days hold loaded plugin code. AOF's plugin code, once loaded,
keeps the worker process alive via the poller's open socket handle.

### Finding B — Event listeners accumulate per reload (medium)

`registerAofPlugin` (`src/openclaw/adapter.ts:69-90`) calls
`api.on(...)` 7 times: `session_end`, `agent_end`,
`before_compaction`, `message_received`, `message_sent`,
`before_tool_call`, `after_tool_call`. There is no `api.off()` or
deduplication. If OpenClaw's `api.on` is additive (the common Node
EventEmitter contract), a process that gets the plugin reloaded N
times will fire each handler N times per event — N copies of
`postSessionEnd`, etc., hitting the daemon over IPC.

We can't directly inspect OpenClaw's listener registry without a
runtime probe, but the gateway-log volume (6,019 reloads vs. one
process) strongly implies accumulation. The cost is daemon IPC churn
(load-amplified event delivery), not necessarily worker leaks per
se — but it's a contributing factor to "AOF feels slow under heavy
session churn".

### Finding C — No `stop` lifecycle hook on the plugin export (medium)

`src/plugin.ts` exports a plugin object with `{ id, name, description,
register }` only — no symmetric `stop()` or `unload()`. OpenClaw's
plugin lifecycle apparently has no way to signal "you're being
unloaded, clean up." Even if OpenClaw added that signal tomorrow, AOF
wouldn't honour it because there's no entry point.

By contrast, `OpenClawServiceDefinition` (`src/openclaw/types.ts:9`)
has a `stop` field — the *service* lifecycle has it, the *plugin*
lifecycle does not. AOF used to register a service (pre-Phase 43
thin-bridge). Now it just registers tools/handlers and starts pollers
in `register()`. Removing the service removed the only place AOF
could plausibly attach teardown logic.

### Phase scope (Workstream 2.5 — fix lifecycle)

Three changes, ordered by leverage:

1. **Detect "I'm in a worker, not the gateway main" and skip
   pollers in workers.** Probe needed first: what does
   `api.config`/`api.runtime`/some context flag look like in the
   gateway main vs. a per-session worker? If there's a
   distinguishable signal, wrap `startSpawnPollerOnce` and
   `startChatDeliveryPollerOnce` in a guard. If not, this requires
   OpenClaw cooperation (adding a context flag).

2. **Add an `unregister`/`stop` hook to the plugin export and wire
   it to `stopSpawnPoller` + `stopChatDeliveryPoller` + `api.off`
   counterparts.** Even if OpenClaw doesn't call it today, having it
   makes AOF cleanly unloadable when OpenClaw eventually wires
   plugin teardown. The internal stop already exists for the
   pollers (test helpers); promote them to production primitives.

3. **Make `api.on` registrations idempotent** — keep a module-level
   `Set<string>` of registered events and skip if already wired.
   This is a defensive fix; ideal would be `api.off` on stop, but
   skipping re-registration is the minimum.

### What I did NOT verify

- Whether `api.on` is actually additive in OpenClaw's runtime (vs.
  silently dedup by handler reference). Needs a tiny runtime probe.
- Whether the in-flight `src/openclaw/openclaw-executor.ts` and
  `src/openclaw/__tests__/executor.test.ts` uncommitted changes
  affect any of this. They thread `provider`/`model` through
  `runEmbeddedPiAgent` but don't touch lifecycle.
- Live N=10 dispatch comparison from the original plan. Skipped
  because (a) main intercepts, (b) dispatches ghost (Workstream 3),
  and (c) static evidence already pointed at AOF concretely.

## Status log

- 2026-04-28 03:30Z — Investigation opened. Workstream 1 ready to
  implement; Workstreams 2+3 pending.
- 2026-04-28 07:35Z — Workstream 1 shipped (commit 2261107). Docs
  regen prep in 046b773. 3 production files + 1 regression test +
  this debug doc.
- 2026-04-28 12:00Z — Workstream 2 audit complete. AOF confirmed
  contributing to worker leaks via per-process pollers without
  shutdown path (Finding A). Workstream 2.5 (lifecycle fix) scoped
  but not implemented — pending user decision on whether to
  prioritise that vs. Workstream 3 (dispatch ghosting).
