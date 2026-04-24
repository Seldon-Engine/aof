---
status: pending
phase: 44-deliver-completion-notification-wake-ups-to-dispatching-agen
source: [44-RESEARCH.md §Wave 3, 44-08-PLAN.md, CLAUDE.md §Build & Release]
created: 2026-04-24
---

# Phase 44 — Human UAT Matrix

Purpose: prove the full dispatcher-wake-up chain works on a live OpenClaw gateway +
Telegram bot. Automated tests (2979 unit + E2E + the new `wake-up-dispatcher.test.ts`)
cover the mocked outbound path. This matrix covers what the mocks can't: the real
OpenClaw plugin-reload cycle, the real Telegram send, the real daemon↔plugin long-poll,
and the restart-recovery behavior under live conditions.

---

## Preconditions (run in this exact order)

1. **Deploy:**
   ```bash
   npm run deploy
   ```

2. **Verify `op run` wrapper present in both plists** (upgrades have been observed to
   strip it — see CLAUDE.md §Build & Release for history):
   ```bash
   rg -A 1 "ProgramArguments" ~/Library/LaunchAgents/ai.openclaw.gateway.plist ~/Library/LaunchAgents/ai.openclaw.aof.plist | rg "oprun|op run|\.openclaw/bin/"
   ```
   Both plists must show an `op run --env-file ...` wrapper (or equivalent
   `openclaw-gateway-oprun.sh` invocation). If missing, restore from the most recent
   `.bak-pre-oprun-restore-*` backup in `~/Library/LaunchAgents/` BEFORE kickstarting.
   Otherwise the processes come up without 1Password-sourced env vars and the failure
   mode is a cascade of unrelated-looking errors.

3. **Restart BOTH launchd jobs** (dual-restart is mandatory — restarting only the gateway
   leaves the daemon on stale code, producing a silent 30s-backoff loop):
   ```bash
   launchctl kickstart -k "gui/$(id -u)/ai.openclaw.aof"
   launchctl kickstart -k "gui/$(id -u)/ai.openclaw.gateway"
   ```

4. **Kill zombie `openclaw-agent` processes that pre-date the deploy.** OpenClaw reloads
   the AOF plugin per-session, but process-resident agents hold whatever plugin code
   they loaded at startup. Zombies from a previous AOF version will log wake-ups from
   old code paths and mask real bugs:
   ```bash
   ps -eo pid,lstart,command | grep openclaw-agent | grep -v grep
   ```
   Kill any PID whose `lstart` predates the deploy timestamp (or reboot to be safe).

5. **Confirm daemon socket is live:**
   ```bash
   curl --unix-socket ~/.aof/data/daemon.sock http://localhost/v1/health
   ```
   Must return HTTP 200.

6. **Mark the UAT start time** (used by scenario verification to filter on-disk artifacts):
   ```bash
   touch /tmp/44-uat-start
   ```

---

## Scenario A — Telegram group dispatch → wake-up in same group

**Why:** Verifies the default path and the most common production case. This is the
D-44-GOAL acceptance criterion from the plan frontmatter.

### Steps
1. From a live Telegram session where the bot is present (the `main` agent must be the
   routable recipient), send the agent a message asking it to dispatch a tiny task.
   Example prompt:
   > "Dispatch a one-line probe task: have the agent simply report `ok` and mark itself
   > `done`. Use `notifyOnCompletion: true` (the default)."

2. Observe the agent's reply confirming the dispatch. It should include the new task id
   (format: `TASK-YYYY-MM-DD-NNN`). Note it here: **TASK-__________**

3. Wait for the task to reach `done`. For a trivial no-op worker this is typically
   under 60 seconds; for real work, up to ~5 minutes.

4. **Expected:** the same Telegram chat receives a new bot message referencing the task
   (e.g. `TASK-... completed: ok` or the wake-up prompt the child agent produced).
   Message MUST arrive in the SAME chat thread as the dispatch call.

### Verification
- Subscription on disk (replace `TASK-NNN` with the id from step 2):
  ```bash
  find ~/.aof/data -name "subscriptions.json" -newer /tmp/44-uat-start | xargs grep -l "TASK-NNN"
  ```
  Inspect the matching file: the subscription has `status: "delivered"`,
  `notifiedStatuses` includes `"done"`, and exactly one `attempts[]` entry with
  `success: true`.

- Daemon log shows the structured telemetry events. Grep for the task id:
  ```bash
  rg "wake-up\.(attempted|delivered)" ~/.aof/data/logs/daemon.log | rg TASK-NNN
  ```
  Expected: one `wake-up.attempted` followed by one `wake-up.delivered`. Both lines
  should contain the same `subscriptionId`, `taskId`, `dispatcherAgentId: "main"`, and
  `sessionKey` matching the Telegram group route.

- [ ] PASS / FAIL (tick after observing)

---

## Scenario B — Telegram topic dispatch → wake-up lands in correct topic

**Why:** Threads/topics are a distinct code path inside `sendChatDelivery` (threadId
field on the `OpenClawChatDelivery` payload). Group-level delivery can work while
topic-level delivery regresses without a test hitting it.

### Steps
1. From a Telegram group that has topics enabled, switch to a specific topic thread
   (NOT the group's "General" topic).

2. Dispatch a probe task from within that topic (same prompt shape as Scenario A).
   Note the task id: **TASK-__________**

3. Wait for completion.

4. **Expected:** the wake-up message arrives in the SAME topic thread — NOT in the
   group's General thread, NOT in a different topic.

### Verification
- Inspect the subscription's `delivery.threadId`:
  ```bash
  find ~/.aof/data -name "subscriptions.json" -newer /tmp/44-uat-start | xargs grep -l "TASK-NNN"
  ```
  The matching subscription's `delivery.threadId` must equal the Telegram topic id.

- Daemon log:
  ```bash
  rg "wake-up\.delivered" ~/.aof/data/logs/daemon.log | rg TASK-NNN
  ```
  The log line's `target` / delivery block contains the same `threadId`.

- [ ] PASS / FAIL

---

## Scenario C — Plugin restart mid-dispatch → wake-up still arrives after re-attach

**Why:** Confirms that subscriptions survive a gateway restart. The captured route is
persisted in the on-disk subscription (`subscriptions.json`), not only in the plugin's
in-memory `OpenClawToolInvocationContextStore`. When the plugin re-attaches it should
long-poll `/v1/deliveries/wait` and drain any queued wake-ups.

### Steps
1. Dispatch a slower probe task from Telegram — one that takes ~30-60s to complete
   (e.g. "sleep for 60 seconds then report done" or any task with a known short wait).
   Note the task id: **TASK-__________**

2. **Immediately after dispatch** (before completion), kickstart ONLY the gateway:
   ```bash
   launchctl kickstart -k "gui/$(id -u)/ai.openclaw.gateway"
   ```

3. Wait for the task to complete.

4. **Expected:** once the plugin re-attaches, it long-polls `/v1/deliveries/wait`, picks
   up the queued wake-up, and delivers it to the Telegram chat. The chat receives the
   completion message despite the mid-flight gateway restart.

### Verification
- Daemon log shows a `plugin detached` + `plugin attached` pair during the window:
  ```bash
  rg "plugin (detached|attached)" ~/.aof/data/logs/daemon.log | tail -5
  ```
- `wake-up.delivered` eventually logs for the task:
  ```bash
  rg "wake-up\.delivered" ~/.aof/data/logs/daemon.log | rg TASK-NNN
  ```

- [ ] PASS / FAIL

---

## Scenario D — Daemon restart between transition and plugin ACK → recovery pass replays the wake-up

**Why:** Confirms D-44-RECOVERY (Plan 07 `replayUnnotifiedTerminals` + daemon bootstrap
wiring) works on real hardware. The mocked integration test proves the function is
called; this proves it's effective under real conditions.

### Steps
1. Dispatch a task from Telegram that completes reasonably fast (5-15 seconds).
   Note the task id: **TASK-__________**

2. Watch for the task to reach `done`:
   ```bash
   watch -n 1 'aof scan --project <your-project>'
   ```
   (or `aof task list` which aliases to scan.)

3. **Within the same 1-2 second window** that the task hits `done`, kickstart the daemon:
   ```bash
   launchctl kickstart -k "gui/$(id -u)/ai.openclaw.aof"
   ```
   This is a timing-sensitive scenario — you want to catch the daemon with a subscription
   that is `notifiedStatuses=[]` but the task already at `done`. If you miss the window,
   repeat with a new task.

4. Wait 10-30s for the daemon to boot and for the startup recovery pass to fire.

5. **Expected:** the Telegram chat receives the wake-up message even though the daemon
   restarted between transition and plugin ACK.

### Verification
- Daemon log shows the recovery pass firing on bootstrap:
  ```bash
  rg "wake-up\.(recovery-pass-complete|recovery-replay)" ~/.aof/data/logs/daemon.log | tail -10
  ```
  The `replayed` counter should show ≥1 if the timing landed on the recovery path.

- Subscription `attempts[]` on disk may show EITHER:
  - Two entries: one with `success: false` (pre-restart) and one with `success: true`
    (post-restart replay), OR
  - One entry with `success: true` if the timing landed cleanly. Either outcome is
    acceptable — the acceptance criterion is that the message arrives.

- [ ] PASS / FAIL / SKIP (SKIP acceptable if the timing window cannot be reproduced
  reliably in 3 attempts; note in SUMMARY)

---

## Scenario E (stretch, optional) — Subagent dispatch → agent-callback-fallback recorded

**Why:** Confirms D-44-AGENT-CALLBACK-FALLBACK (Plan 06 NoPlatformError + fallback)
surfaces correctly on real subagent dispatches where no Telegram platform is captured.

### Steps
1. Trigger a scenario where a child task itself spawns a subagent that calls
   `aof_dispatch` — i.e. the dispatcher session is NOT a chat surface but an
   agent-to-agent session. This is harder to set up by hand; may require a purpose-built
   test agent or running a DAG workflow from the `main` agent.
   Note the task id: **TASK-__________**

2. When the subagent dispatch completes, inspect the subscription.

3. **Expected:** the subscription has `attempts[0].error.kind === "agent-callback-fallback"`
   and `status: "active"` (NOT `"delivered"`). Daemon log shows a
   `wake-up.(fallback|attempted)` entry whose outcome is the fallback path rather than
   chat delivery.

### Verification
- Subscription file:
  ```bash
  find ~/.aof/data -name "subscriptions.json" -newer /tmp/44-uat-start | xargs grep -l "TASK-NNN"
  ```
  Look for `"kind": "agent-callback-fallback"` and `"originalKind": "no-platform"`
  in the attempts entry.

- Daemon log:
  ```bash
  rg "wake-up.*fallback|agent-callback-fallback" ~/.aof/data/logs/daemon.log | rg TASK-NNN
  ```

- [ ] PASS / FAIL / SKIP (SKIP is acceptable — this is stretch scope)

---

## Sign-off

- Reporter: ____________________
- Date: ______________________
- Build version: `git rev-parse HEAD` = ______________________
- Deploy timestamp (from `stat -f %Sm ~/.aof/bin/aof` or equivalent): ______________________
- AOF version from `aof --version`: ______________________

Scenarios A–D all PASS: [ ] yes / [ ] no

Scenario E: [ ] PASS / [ ] FAIL / [ ] SKIP

### If any of A–D failed

File a Phase 44 gap entry in `.planning/phases/44-deliver-completion-notification-wake-ups-to-dispatching-agen/44-BLOCKERS.md` with:
- Scenario letter and expected-vs-actual
- `TASK-NNN` id used
- Daemon log snippet (output of `rg "wake-up\.\\w+" ~/.aof/data/logs/daemon.log | rg TASK-NNN`)
- Subscription file content at time of failure

Then reply to the executor checkpoint with:
`blocked: Scenario <X> failed — <one-line symptom>`

### If all A–D passed (E optional)

Reply: `approved` (or `approved with caveats: <description>` if Scenario E revealed a
stretch-scope gap that should become a follow-up phase, e.g. backlog 999.4).
