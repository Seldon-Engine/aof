---
title: Snapshot writer must exclude unix socket files
created: 2026-04-14T15:17:54Z
area: migration
priority: high
---

## Problem

During v1.14.1 install upgrade, a migration tried to copy a snapshot dir and failed on a socket:

```
✗ Cannot copy a socket file: cp returned EINVAL (cannot copy a socket file:
  /Users/xavier/.aof/data/.aof/snapshots/snapshot-1776179514333/daemon.sock)
```

The snapshot was captured while the daemon was running with its `daemon.sock` unix socket sitting under `~/.aof/data/`. The snapshot writer grabbed the socket file into the snapshot tree. Later migrations that copy or re-verify the snapshot directory hit `cp` returning `EINVAL` — sockets aren't regular files.

Sockets are live endpoints, not state. They should never enter a snapshot.

## Solution

1. Find the snapshot-writing code (likely `src/cli/commands/setup.ts`, migrations under `src/migration/`, or `src/cli/recovery.ts`).
2. When enumerating files to snapshot, skip anything where `fs.stat().isSocket()` (or `.mode & S_IFSOCK` / named check).
3. Audit for other non-regular-file types we should skip: FIFOs, character devices. Realistically: only copy regular files and directories.
4. Also consider: the `daemon.sock` path should not live under `$DATA_DIR` at all — it belongs under a runtime dir (e.g., `$XDG_RUNTIME_DIR` or `$DATA_DIR/.runtime/`). Decouple from the snapshot-eligible tree.

## Files

- Search: `grep -rn "snapshot" src/ | grep -v test`
- Suspected: `src/migration/`, `src/cli/commands/setup.ts`
- Socket location: `~/.aof/data/.aof/snapshots/snapshot-<ms>/daemon.sock` — trace where this sock path is computed (`src/daemon/daemon.ts` or similar)

## Done when

- Fresh install with running daemon → upgrade → setup migrations complete without socket-copy EINVAL warnings
- A unit test asserts that `createSnapshot(dir)` on a dir containing a socket excludes the socket
- `daemon.sock` ideally relocates outside `$DATA_DIR` snapshot tree (follow-up if larger change)
