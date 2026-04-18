---
title: "AOF Deployment Guide"
description: "Deploy AOF as a daemon with an optional OpenClaw thin-plugin bridge."
---

**Audience:** Operators, SREs, DevOps teams
**Scope:** Daemon deployment, OpenClaw plugin wiring, and post-install verification

---

## Overview

As of v1.15 AOF has **one** runtime shape: a single `aof-daemon` user service
owns the task store, scheduler, and IPC authority. Consumers connect to the
daemon over a Unix-domain socket at `~/.aof/data/daemon.sock`.

There is no longer a "plugin-mode vs daemon-mode" choice. The OpenClaw plugin
is a thin bridge that connects to the daemon; running OpenClaw is optional,
but if you run it the plugin must be able to reach the daemon.

Two dispatch paths coexist in a single daemon:

1. **PluginBridgeAdapter** — used when an OpenClaw plugin is currently attached
   (holding an open long-poll on `GET /v1/spawns/wait`). Agent spawns are
   delegated to the plugin because `runtime.agent.runEmbeddedPiAgent` is only
   reachable from inside the gateway process.
2. **StandaloneAdapter** — fallback for daemon-only deployments without a
   plugin. Dispatches via HTTP directly to the OpenClaw gateway API.

Adapter selection happens per dispatch. You never choose between them in
configuration; whichever applies at the moment is used.

---

## Daemon service

The daemon runs under the host OS supervisor:

- **macOS:** launchd user agent at `~/Library/LaunchAgents/ai.openclaw.aof.plist`
- **Linux:** systemd user unit at `~/.config/systemd/user/ai.openclaw.aof.service`

The supervisor handles crash recovery and restart-on-reboot; you do not run
`aof-daemon` directly.

### Installing the daemon

The installer (`scripts/install.sh`) installs the daemon as part of its normal
flow. Upgrades from v1.14 run Migration 007, which installs the service if
absent. You can also install or refresh the service file manually:

```bash
aof daemon install
```

This command is idempotent — safe to run multiple times. It writes the
platform service file, loads it, and starts the daemon.

### Lifecycle commands

```bash
aof daemon status              # Query /status on the Unix socket
aof daemon stop                # Graceful shutdown (SIGTERM via supervisor)
aof daemon stop --force        # Bypass supervisor, SIGTERM the process directly
aof daemon uninstall           # Stop and remove the service file
```

### Health endpoints

The daemon exposes three classes of HTTP endpoint on `daemon.sock`:

| Route | Purpose |
|-------|---------|
| `GET /healthz`, `GET /status` | Health and state inspection. Used by `aof daemon status`. |
| `POST /v1/tool/invoke` | Tool dispatch from any attached plugin. |
| `POST /v1/event/session-end`, `/v1/event/agent-end`, `/v1/event/before-compaction`, `/v1/event/message-received` | Session lifecycle events forwarded from the plugin. |
| `GET /v1/spawns/wait`, `POST /v1/spawns/{id}/result` | Long-poll spawn callback path (plugin side). |

The socket is created with mode `0600`. Trust boundary is the invoking user's
Unix uid — there is no token-based auth, and AOF does not listen on TCP.

Health check from the shell:

```bash
curl --unix-socket ~/.aof/data/daemon.sock http://localhost/healthz
```

### Verifying the daemon is active

- `aof daemon status` shows `Status: running (healthy)` and the version
- `~/.aof/data/daemon.pid` exists and contains a live PID
- `~/.aof/data/daemon.sock` exists with mode `0600`
- Socket responds to `/healthz`

---

## OpenClaw plugin wiring

The OpenClaw plugin ships inside the AOF tarball at `dist/plugin.js`. It is
referenced by `openclaw.plugin.json` at the install root.

### Auto-discovery

Place the AOF plugin at:

```
~/.openclaw/extensions/aof
```

The installer's `scripts/deploy.sh` creates this symlink when run against a
local checkout. OpenClaw auto-discovers extensions from this path on gateway
start.

### Configuration

Configure the plugin via **gateway config** (not `settings`):

```yaml
plugins:
  entries:
    aof:
      config:
        dryRun: false
        gatewayUrl: "http://127.0.0.1:19003"
        gatewayToken: "YOUR_GATEWAY_TOKEN"
```

**Required for agent spawns (StandaloneAdapter path only):**

```yaml
gateway:
  tools:
    allow:
      - sessions_spawn
```

> `plugins.entries.aof.config` is the correct key. **Do not use**
> `plugins.entries.aof.settings`.

When the plugin is attached the daemon uses `PluginBridgeAdapter` and delegates
spawns back through the long-poll channel — the `sessions_spawn` allowlist is
only needed for deployments where the daemon is expected to fall back to the
HTTP StandaloneAdapter.

### Verifying plugin attachment

- `aof daemon status` shows plugin-related lines when at least one plugin is
  holding an active long-poll
- Daemon log (follow with `tail -f ~/.aof/data/logs/daemon.log`) shows
  `/v1/spawns/wait` and `/v1/tool/invoke` activity during normal operation
- OpenClaw Gateway logs show AOF plugin startup under `~/.openclaw/logs/gateway.log`

### No-plugin-attached behavior

When the scheduler picks up a ready task and no plugin is attached:

- If the daemon is running in plugin-expected mode, the task is **held in
  `ready/`** and the daemon logs
  `log.warn({ taskId, reason: "no-plugin-attached" })`. The task is NOT
  moved to deadletter; it dispatches on the next poll once the plugin
  reconnects. This upholds the "tasks never get dropped" invariant.
- If the daemon is running in standalone mode (no plugin expected), the
  dispatch falls through to `StandaloneAdapter` and the HTTP gateway API is
  used directly.

Mode is determined at scheduler boot based on whether a plugin registers
within the first polls; explicit operator configuration is not required.

---

## Deployment Steps (Docker / OpenClaw Environments)

### 1) Install AOF (daemon + optional plugin symlink)

```bash
# One-liner — installs code, data, and starts the daemon
curl -fsSL https://raw.githubusercontent.com/d0labs/aof/main/scripts/install.sh | sh
```

For a containerized / offline install using a pre-downloaded tarball:

```bash
# --tarball takes a local .tar.gz and skips the GitHub download
sh install.sh --tarball ./aof-1.15.0.tar.gz --data-dir /var/lib/aof
```

### 2) Wire the plugin into OpenClaw

1. Symlink the plugin directory:
   ```bash
   mkdir -p /home/node/.openclaw/extensions
   ln -s ~/.aof /home/node/.openclaw/extensions/aof
   ```
2. Configure gateway:
   ```yaml
   gateway:
     tools:
       allow:
         - sessions_spawn   # still needed for StandaloneAdapter fallback

   plugins:
     entries:
       aof:
         config:
           dryRun: false
           gatewayUrl: "http://127.0.0.1:19003"
           gatewayToken: "${GATEWAY_TOKEN}"
   ```
3. Restart gateway:
   ```bash
   openclaw gateway restart
   ```
4. Verify end-to-end:
   ```bash
   aof daemon status
   curl --unix-socket ~/.aof/data/daemon.sock http://localhost/healthz
   ```

### 3) Daemon-only deployments (no OpenClaw plugin)

Skip the symlink and gateway config. The daemon runs on its own and dispatches
via `StandaloneAdapter` whenever a plugin is not attached. Ensure:

```bash
aof daemon status     # Must show running (healthy)
```

Agents reached via `StandaloneAdapter` require `gateway.tools.allow:
["sessions_spawn"]` on the remote OpenClaw gateway.

---

## TaskFrontmatter (Required Fields)

Every AOF task frontmatter must include:

- `schemaVersion`
- `id`
- `project`
- `title`
- `status`
- `priority`
- `routing`
- `createdAt`
- `updatedAt`
- `lastTransitionAt`
- `createdBy`
- `dependsOn`
- `metadata`

---

## Murmur Orchestration Configuration

**Murmur** is AOF's team-scoped orchestration trigger system. It automatically creates and dispatches review tasks to orchestrator agents based on configurable trigger conditions.

### What Murmur Does

Murmur monitors team task queues and statistics, evaluates trigger conditions, and spawns orchestration review tasks when conditions are met. This enables periodic team health checks, sprint retrospectives, and queue management without manual intervention.

### Enabling Murmur for a Team

Configure murmur in `org-chart.yaml` under team definitions:

```yaml
teams:
  - id: swe-team
    name: "Software Engineering Team"
    orchestrator: swe-pm  # Required: agent ID for review tasks
    murmur:
      triggers:
        - kind: queueEmpty
        - kind: completionBatch
          threshold: 10
        - kind: interval
          intervalMs: 86400000  # 24 hours
      context:
        - vision
        - roadmap
        - taskSummary
```

**Required fields:**
- `team.orchestrator` — Agent ID that will receive review tasks (typically a PM or lead)
- `team.murmur.triggers` — Array of trigger conditions (at least one required)

**Optional fields:**
- `team.murmur.context` — Context sections to inject into review tasks (e.g., `vision`, `roadmap`, `taskSummary`)

### Trigger Types

Murmur evaluates triggers in order; the first trigger that fires wins (short-circuit evaluation). A review will never fire if one is already in progress (idempotency guard).

#### 1. `queueEmpty`

Fires when **both** ready and in-progress queues are empty.

```yaml
triggers:
  - kind: queueEmpty
```

**Use case:** End-of-sprint retrospectives, idle capacity allocation.

#### 2. `completionBatch`

Fires when the team completes a threshold number of tasks since the last review.

```yaml
triggers:
  - kind: completionBatch
    threshold: 10  # Required: number of completions
```

**Use case:** Regular progress check-ins, velocity tracking.

#### 3. `interval`

Fires after a fixed time interval since the last review.

```yaml
triggers:
  - kind: interval
    intervalMs: 86400000  # Required: interval in milliseconds (24 hours)
```

**Use case:** Daily standups, weekly sprint planning.

**Note:** If no review has ever occurred, fires immediately.

#### 4. `failureBatch`

Fires when the team accumulates a threshold number of failed/dead-lettered tasks since the last review.

```yaml
triggers:
  - kind: failureBatch
    threshold: 3  # Required: number of failures
```

**Use case:** Incident response, quality degradation alerts.

### Murmur State Directory

Murmur persists per-team state in `.murmur/<team-id>.json` at the project root. These files track:

- `lastReviewAt` — ISO timestamp of last murmur review
- `completionsSinceLastReview` — Task completion counter
- `failuresSinceLastReview` — Task failure counter
- `currentReviewTaskId` — Review task ID if one is in progress (idempotency guard)
- `reviewStartedAt` — ISO timestamp when current review started
- `lastTriggeredBy` — Which trigger kind fired last

**State files are automatically created** when the scheduler runs. Do not manually edit these files.

**Backup considerations:** Include `.murmur/` in project backups if you need to preserve trigger history across environment migrations.

### Review Timeout and Stale Cleanup

**Default review timeout:** 30 minutes (configurable via scheduler options)

If a review task remains in progress for longer than `reviewTimeoutMs`, murmur's cleanup logic:

1. Logs a stale review warning
2. Clears `currentReviewTaskId` from state (allows new reviews to fire)
3. Does **not** cancel or transition the stale task (manual intervention required)

**Timeout is wall-clock time**, not CPU time. A paused or blocked orchestrator session will trigger stale cleanup.

**Manual recovery:** If a review task is truly stuck, transition it to `blocked` or `done` manually:

```bash
bd trans <task-id> blocked "Orchestrator unresponsive"
```

### Integration with Scheduler

Murmur evaluation runs **after** the normal dispatch cycle. The scheduler:

1. Dispatches ready tasks to agents (normal cycle)
2. Evaluates murmur triggers for teams with `murmur` config
3. Creates and dispatches review tasks if triggers fire
4. Respects global concurrency limits (won't dispatch reviews if at max capacity)

### Troubleshooting

**Review tasks not firing:**
- Check `team.orchestrator` is set and agent exists in `agents` list
- Verify `team.murmur.triggers` is non-empty and valid
- Check scheduler logs for `[AOF] Murmur:` messages
- Inspect `.murmur/<team-id>.json` for `currentReviewTaskId` (blocks new reviews)

**Review tasks stuck in progress:**
- Check orchestrator agent session is active (`openclaw sessions list`)
- Verify review timeout hasn't been exceeded (default 30 minutes)
- Manually transition stale review tasks to `blocked` if needed

**Trigger not firing when expected:**
- Murmur evaluates triggers in order; first match wins
- Check state counters in `.murmur/<team-id>.json`
- Verify threshold values match your expectations

---

## Critical: Plugin configSchema (OpenClaw 2026.2.15+)

OpenClaw validates plugin config against `openclaw.configSchema` in `package.json`. **Missing schema = validation error on restart.**

The AOF `package.json` must include:

```json
{
  "openclaw": {
    "id": "aof",
    "configSchema": {
      "type": "object",
      "properties": {
        "dryRun": { "type": "boolean", "default": true },
        "dataDir": { "type": "string" },
        "gatewayUrl": { "type": "string" },
        "gatewayToken": { "type": "string" },
        "pollIntervalMs": { "type": "number" },
        "defaultLeaseTtlMs": { "type": "number" },
        "heartbeatTtlMs": { "type": "number" }
      },
      "additionalProperties": false
    }
  }
}
```

**Any config property not in the schema will cause "must NOT have additional properties" and prevent gateway restart.**

## Critical: Agent Spawn Permissions

For the `StandaloneAdapter` fallback path to dispatch tasks to agents, the
**main agent** (or whichever agent the AOF executor uses as `sessionKey`) must
have:

```yaml
agents:
  list:
    - id: main
      subagents:
        allowAgents: ["*"]  # Or list specific agent IDs
```

Without this, `sessions_spawn` returns "Agent not found" even though the agent exists in the config. The `agents_list` tool will show `allowAny: false` with only the requesting agent visible.

The `PluginBridgeAdapter` path uses `runtime.agent.runEmbeddedPiAgent` inside
the gateway process and is not subject to the HTTP-tool allowlist.

## Critical: Config Change Protocol (Docker/Container Environments)

1. **Use `openclaw config get/set`** — never edit `openclaw.json` directly
2. **Always run `openclaw doctor`** before restarting — if ANY issues, fix first
3. **Use `openclaw gateway restart`** (or `kill -USR1 <gateway-pid>` in Docker) — **NEVER `kill -9`**
4. Killing the gateway process in Docker crashes the entire container (gateway is PID 1's child)
5. If `openclaw gateway restart` fails (no systemctl), use `kill -USR1 $(pgrep -f openclaw-gateway)`

## Troubleshooting

**Daemon not dispatching:**
- Check `aof daemon status`
- Verify `curl --unix-socket ~/.aof/data/daemon.sock http://localhost/healthz` returns 200
- Check daemon logs for `no-plugin-attached` — means the scheduler expects a
  plugin and is holding tasks until one reconnects

**Plugin not dispatching (StandaloneAdapter path):**
- Ensure `gateway.tools.allow: ["sessions_spawn"]`
- Verify `plugins.entries.aof.config` is used (not `settings`)
- Check `agents_list` via HTTP — should show `allowAny: true` and target agents
- Check `main.subagents.allowAgents: ["*"]` is set

**"Agent not found" but agent exists in config:**
- Check `subagents.allowAgents` on the requesting agent (usually `main`)
- Use `curl -X POST /tools/invoke` with `agents_list` to verify visibility

**"must NOT have additional properties" on restart:**
- AOF plugin `package.json` is missing `openclaw.configSchema`, or the schema doesn't include all config properties being set
- Fix the schema, then restart

**Plugin reports "daemon unreachable":**
- Confirm `~/.aof/data/daemon.sock` exists and has mode `0600`
- Confirm the gateway is running as the same Unix user that installed AOF
- Run `aof daemon status` from the same user to verify reachability

---

## References

- Upgrading from earlier versions: [UPGRADING.md](../../UPGRADING.md)
- Recovery runbook: `docs/RECOVERY-RUNBOOK.md`
- Watchdog design: `docs/design/DAEMON-WATCHDOG-DESIGN.md`
