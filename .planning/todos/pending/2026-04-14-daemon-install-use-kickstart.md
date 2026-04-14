---
title: aof daemon install should be idempotent (use kickstart not unconditional bootstrap)
created: 2026-04-14T15:17:54Z
area: daemon
priority: high
---

## Problem

During v1.14.1 upgrade, `aof daemon install` (invoked by installer setup) failed:

```
Bootstrap failed: 5: Input/output error
Failed to install daemon: Command failed:
  launchctl bootstrap gui/$(id -u) /Users/xavier/Library/LaunchAgents/ai.openclaw.aof.plist
```

`launchctl bootstrap` returns EIO (code 5) when the service is already loaded. The daemon-install logic unconditionally runs `bootstrap` even on an upgrade path where the plist was already bootstrapped before the installer paused it.

The correct pattern: `bootstrap` only when NOT already loaded; `kickstart` to start (or restart) regardless of initial state. `kickstart -k` handles the "loaded but not running" and "running — restart me" cases idempotently.

## Solution

In the daemon-install code path (likely `src/cli/commands/daemon.ts` or `src/daemon/service-file.ts` — grep for `launchctl bootstrap`):

```ts
const label = 'ai.openclaw.aof';
const service = `gui/${uid}/${label}`;
const plist = plistPath(...);

// Write the plist first
await writeFile(plist, ...);

// Bootstrap only if not already loaded
const isLoaded = await tryRun(`launchctl print ${service}`).then(() => true).catch(() => false);
if (!isLoaded) {
  await run(`launchctl bootstrap gui/${uid} ${plist}`);
}

// Start (or restart) regardless
await run(`launchctl kickstart -k ${service}`);
```

Also apply the same idempotency to `scripts/install.sh::resume_live_writers` — it currently does unconditional `bootstrap`. Same EIO risk when a plist was only `bootout`'d but the daemon re-bootstrapped it before our resume ran.

## Files

- `src/daemon/service-file.ts` — plist generation
- `src/cli/commands/daemon.ts` — the install/start/stop command
- `scripts/install.sh` — `resume_live_writers` function (currently hardcodes `launchctl bootstrap`)

## Done when

- `aof daemon install` can run twice in a row without the second invocation failing with EIO
- Installer upgrade path completes cleanly when `ai.openclaw.aof` was pre-bootstrapped
- Unit/integration test: mock launchctl, verify `bootstrap` only called when `print` fails
