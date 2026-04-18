# Upgrading to AOF v1.15

This guide covers installing AOF v1.15 fresh and upgrading from any earlier
version. The single biggest change in v1.15 is structural: the `aof-daemon`
service is now mandatory infrastructure. If you are upgrading from v1.14 and
deliberately opted out of the daemon, read
[Upgrading from v1.14](#upgrading-from-v114) first.

## What's New in v1.15

- **Thin-plugin architecture.** The OpenClaw plugin is now a bridge to the
  `aof-daemon` over a Unix-domain socket at `~/.aof/data/daemon.sock`. The
  daemon owns the task store, scheduler, and `AOFService` — there is one
  authority per install, not one per OpenClaw session.
- **Daemon is always installed.** `install.sh` and Migration 007 both install
  the launchd (macOS) or systemd (Linux) user service unconditionally. The
  Phase 42 plugin-mode skip branch is gone.
- **`--force-daemon` is deprecated.** The installer still accepts the flag so
  v1.14 scripts and CI pipelines keep working, but it is a no-op that emits a
  deprecation warning. The flag will be removed in a future release.
- **Socket is owner-only.** `daemon.sock` is created with mode `0600`. The
  trust boundary is the invoking user's Unix uid — no token, no cross-user
  access, still single-machine.
- **Migration 007.** `aof setup --auto --upgrade` installs the daemon service
  if absent. Idempotent; safe to re-run. Rollback-aware via the v1.3 migration
  framework.

## Prerequisites

- **Node.js >= 22** (LTS recommended)
- An existing AOF installation (if upgrading)

## Fresh Install

### Using the installer (recommended)

```sh
curl -fsSL https://raw.githubusercontent.com/d0labs/aof/main/scripts/install.sh | sh
```

The installer downloads the latest release tarball, extracts it to `~/.aof/`,
installs production dependencies, and runs `aof setup --auto` to initialize
your data directory at `~/.aof/data/`. Migration 007 runs during setup and
installs the `aof-daemon` service. The daemon starts immediately and listens
on `~/.aof/data/daemon.sock`.

### Manual install

1. Download `aof-1.15.0.tar.gz` from the
   [GitHub Releases](https://github.com/d0labs/aof/releases) page.
2. Extract it:
   ```sh
   tar xzf aof-1.15.0.tar.gz
   cd aof-1.15.0
   ```
3. Install production dependencies:
   ```sh
   npm ci --omit=dev
   ```
4. Run setup (installs the daemon service):
   ```sh
   aof setup --auto
   ```

## Upgrading from v1.14

v1.14 had an installer flag (`--force-daemon`) that opted into running the
standalone daemon alongside plugin mode; by default, plugin-mode installs
skipped the daemon. v1.15 removes that choice. Every install runs the daemon.

If you were running v1.14 without the daemon, **the daemon will be installed
on upgrade** (by Migration 007). The OpenClaw plugin in v1.15 can no longer
run a scheduler in-process; it bridges over IPC to the daemon, so a daemon
must be present for dispatch to work.

Run the installer:

```sh
curl -fsSL https://raw.githubusercontent.com/d0labs/aof/main/scripts/install.sh | sh
```

If you pass `--force-daemon` out of habit, you will see:

```
WARNING: --force-daemon is DEPRECATED as of v1.15 and has no effect —
the daemon is always installed now. Flag will be removed in a future release.
```

### If you want to stay without a daemon

There is no supported way to run v1.15 without the daemon. If that is a hard
requirement for your environment, downgrade to v1.14 and pin the version in
your deployment tooling. We'd also like to hear why — file an issue.

## Upgrading from v1.3 – v1.13

Run the same installer command used for fresh installs. The installer detects
your existing installation, creates a backup at `~/.aof-backup/`, extracts the
new version, and runs `aof setup --auto --upgrade`, which applies every
pending migration in order.

```sh
curl -fsSL https://raw.githubusercontent.com/d0labs/aof/main/scripts/install.sh | sh
```

### Migrations applied

Migrations are numbered and applied in order. Each creates a snapshot in
`.aof/snapshots/` before making changes.

| # | Name | What it does |
|---|------|--------------|
| 001 | `default-workflow-template` | Adds `defaultWorkflow` to `project.yaml` when a matching template exists. |
| 003 | `version-metadata` | Writes `.aof/channel.json` recording the installed version and update channel. |
| 004 | `scaffold-repair` | Repairs missing scaffold directories (`tasks/`, `events/`, etc.). |
| 005 | `path-reconciliation` | Normalizes legacy data paths. |
| 006 | `data-code-separation` | Relocates mixed data out of the install directory into `~/.aof/data/`. |
| 007 | `daemon-required` | Installs the `aof-daemon` launchd (macOS) or systemd (Linux) user service if absent. No-op if the service file is already present. |

> Migration 002 (gate-to-DAG) was removed after v1.3 deprecated gates.

### Verification after upgrade

```sh
aof --version
# Expected: 1.15.0

aof smoke
# Runs 6 checks: version, schema, task store, org chart, migration status,
# workflow templates. All should pass.

aof daemon status
# Expected: Status: running (healthy); Version: 1.15.0
```

## Upgrading from pre-v1.2

The upgrade process is the same as upgrading from v1.3. The installer handles
both paths and backs up your data before making changes.

```sh
curl -fsSL https://raw.githubusercontent.com/d0labs/aof/main/scripts/install.sh | sh
```

Every migration from 001 onward applies, in order. Allow extra time; the
first-time migration bundle is larger.

## Verification

After any install or upgrade path, verify your installation:

| Command | Expected result |
|---------|----------------|
| `aof --version` | `1.15.0` |
| `aof smoke` | All 6 checks pass |
| `aof daemon status` | `Status: running (healthy)` |

The `aof smoke` command runs the following checks:

1. **Version** — installed version matches expected version
2. **Schema** — data directory schema is valid
3. **Task store** — task database is readable and consistent
4. **Org chart** — organization structure loads (optional; passes if absent)
5. **Migration status** — all migrations have been applied
6. **Workflow templates** — templates directory is present and parseable

## Rollback

If something goes wrong after upgrading, two rollback mechanisms are available.

### Migration snapshots

Each migration saves a snapshot of your data directory to `.aof/snapshots/`
before making changes. The last two snapshots are retained.

To restore from a migration snapshot:

```sh
# List available snapshots
ls .aof/snapshots/

# Copy a snapshot's contents back to your data directory
cp -R .aof/snapshots/<snapshot-name>/* .aof/
```

Migration 007 has no `down()` because uninstalling the daemon would strand
the v1.15 thin-bridge plugin with no IPC authority to talk to. The canonical
rollback path for v1.15 is "install an older AOF version" — same policy as
Migrations 005 and 006.

### Installer backups

The installer creates a broader backup at `~/.aof-backup/` before extracting
a new version. This backup includes: tasks, events, memory, state, data,
logs, Projects, `memory.db`, `memory-hnsw.dat`, and `.version`.

To restore from an installer backup:

```sh
cp -R ~/.aof-backup/* ~/.aof/
```

After restoring from either mechanism, you may need to reinstall the previous
AOF version (the binary/scripts) to match the restored data format. The
rollback steps above restore your data only.

### Full downgrade from v1.15 → v1.14

1. Stop the daemon: `aof daemon stop`.
2. Download the v1.14 tarball and install it over the top (the installer
   backs up `~/.aof/` to `~/.aof-backup/`).
3. On v1.14, if you had previously opted out of the daemon, run
   `aof daemon uninstall` to remove the launchd plist / systemd unit file
   that v1.15 installed.

---

*Last updated for AOF v1.15.0.*
