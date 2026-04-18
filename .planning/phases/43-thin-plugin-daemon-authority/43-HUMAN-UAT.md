---
status: partial
phase: 43-thin-plugin-daemon-authority
source: [43-VERIFICATION.md, 43-09-SUMMARY.md]
started: 2026-04-17T00:00:00Z
updated: 2026-04-17T00:00:00Z
---

## Current Test

[awaiting human testing — user deferred during /gsd-execute-phase 43]

## Tests

### A. Tool invoke round-trip via plugin
expected: OpenClaw session → agent invokes `aof_status_report` → daemon log (`~/.aof/data/logs/daemon.log`) shows `/v1/tool/invoke` with `name=aof_status_report`. Plugin log shows `DaemonIpcClient singleton initialized` once (not per session).
result: [pending]

### B. Dispatch + spawn round-trip
expected: `aof_dispatch` a task from OpenClaw session → daemon enqueues, posts to `/v1/spawns/wait` → plugin's spawn-poller receives SpawnRequest → invokes `runEmbeddedPiAgent` → task transitions `ready → in-progress → done`. Daemon log: `spawn enqueued for plugin` then `spawn result received`.
result: [pending]

### C. OpenClaw session reload (D-11 module-scope singleton)
expected: Close OpenClaw session, open new one (triggers plugin reload). Dispatch second task. Daemon log shows ONE continuous `plugin attached` / NO `plugin detached` + `plugin attached` churn. Same `daemon.pid`.
result: [pending]

### D. Daemon crash + launchd/systemd respawn (D-03)
expected: `kill -9 $(cat ~/.aof/data/daemon.pid)`. launchd respawns within ~5s. `aof daemon status` shows new PID. Plugin's spawn-poller reconnects within ~30s. Third dispatch flows end-to-end.
result: [pending]

### E. --force-daemon deprecation warning (D-04)
expected: From tarball: `sh install.sh --force-daemon`. Output contains: `--force-daemon is deprecated — the daemon is always installed in plugin-mode as of v1.15. Flag will be removed in a future release.` Daemon still installs (no behavior difference).
result: [pending]

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0
blocked: 0

## Gaps

*No issues recorded. User chose "Skip checkpoint" during /gsd-execute-phase 43 execution (2026-04-17). Run these manually before cutting a release tag for Phase 43.*
