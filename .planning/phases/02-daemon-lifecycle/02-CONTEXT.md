# Phase 2: Daemon Lifecycle - Context

**Gathered:** 2026-02-25
**Status:** Ready for planning

<domain>
## Phase Boundary

AOF runs as a launchd/systemd-supervised service with health reporting, clean start/stop, and automatic crash recovery via the OS. Covers `aof daemon install/uninstall/start/stop/status` commands, health server, PID file management, and service file generation. Does not include gateway integration (Phase 3) or self-healing (Phase 4).

</domain>

<decisions>
## Implementation Decisions

### Install command UX
- `aof daemon install` writes the service file AND starts the daemon in one command (like `brew services start`)
- Validate AOF config (data dir, providers, etc.) before writing the service file — fail with clear message if config is bad
- `aof daemon uninstall` paired command: stop daemon, remove service file, clean up
- User-level only: macOS → `~/Library/LaunchAgents`, Linux → `~/.config/systemd/user`. No sudo needed.

### Health endpoint
- Bind to Unix socket (e.g. `~/.aof/daemon.sock`) — no port conflicts, inherently local-only, no auth needed
- Two paths: `/healthz` returns 200 OK (liveness for supervisor watchdog), `/status` returns full JSON (for CLI and debugging)
- Required JSON fields: task counts, uptime, version, component status
- Also include: active config summary (data dir, poll interval, providers configured) for troubleshooting
- PID file gated on first successful health response (bind → self-check → write PID) — guarantees health endpoint is fully functional before advertising readiness

### Stop & status output
- `aof daemon status` defaults to human-readable structured table; `--json` flag for raw JSON
- Table shows: Status, PID, Uptime, Tasks (by state), Version, Config summary
- `aof daemon stop` shows progress with drain info: 'Stopping daemon (PID 1234)...', drain countdown, 'Daemon stopped'
- Exit codes: 0 = success, 1 = general error, 2 = not running (for `stop`/`status` when daemon isn't up)
- When daemon is not running: 'Daemon is not running. Run `aof daemon install` to start.'

### Crash loop handling
- OS supervisor handles crash loop limits natively (launchd `ThrottleInterval`, systemd `RestartSec`/`StartLimitBurst`)
- Restart delay: 5 seconds in generated service files
- On startup after crash: detect stale PID file, log 'Recovered from crash (previous PID: 1234)', emit `system.crash_recovery` event
- `aof daemon status` surfaces crash recovery info (last crash time, recovery status) when a crash occurred since last clean start

### Claude's Discretion
- Exact socket path and naming
- Plist/unit file template details (environment vars, working directory, stdout/stderr paths)
- Health server implementation (http vs raw socket protocol)
- How to forward `pollTimeoutMs`/`taskActionTimeoutMs` from daemon options to AOFService (noted in Phase 1 verification)

</decisions>

<specifics>
## Specific Ideas

- Phase 1 already built the drain protocol — `aof daemon stop` should reuse it via `service.stop()` and surface the drain countdown to the CLI
- Phase 1 verification noted `startAofDaemon()` doesn't forward timeout config options — this phase should fix that wiring

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-daemon-lifecycle*
*Context gathered: 2026-02-25*
