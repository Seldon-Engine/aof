# Upgrading to AOF v1.3

This guide covers installing AOF v1.3 fresh, upgrading from v1.2, and upgrading from pre-v1.2 releases.

## What's New in v1.3

- **DAG workflows** replace gate-based workflows as the default task structure.
  Tasks now form directed acyclic graphs with explicit dependency edges instead
  of linear gate sequences.
- **Automatic default workflow assignment.** Projects with workflow templates
  automatically get a `defaultWorkflow` field in `project.yaml`. New tasks
  inherit the default workflow unless overridden with `--workflow` or
  `--no-workflow`.
- **Migration framework with pre-migration snapshots.** Upgrades apply numbered
  migrations automatically. Before each migration, a snapshot of your data
  directory is saved to `.aof/snapshots/` so you can roll back if needed.
- **`aof smoke` health check command.** Run post-install or post-upgrade to
  verify your installation is healthy. Checks version, schema, task store,
  org chart, migration status, and workflow templates.
- **Tarball verification in the release pipeline.** Every release tarball is
  verified in CI before upload -- bad builds never reach users.
- **Version tracking.** AOF now writes `.aof/channel.json` to track the
  installed version and update channel.

## Prerequisites

- **Node.js >= 22** (LTS recommended)
- An existing AOF installation (if upgrading)

## Fresh Install

### Using the installer (recommended)

```sh
curl -fsSL https://raw.githubusercontent.com/d0labs/aof/main/scripts/install.sh | sh
```

The installer downloads the latest release tarball, extracts it, installs
production dependencies, and runs `aof setup --auto` to initialize your data
directory.

### Manual install

1. Download `aof-1.3.0.tar.gz` from the
   [GitHub Releases](https://github.com/d0labs/aof/releases) page.
2. Extract it to your preferred location:
   ```sh
   tar xzf aof-1.3.0.tar.gz
   cd aof-1.3.0
   ```
3. Install production dependencies:
   ```sh
   npm ci --omit=dev
   ```
4. Run initial setup:
   ```sh
   aof setup --auto
   ```

## Upgrading from v1.2

Run the same installer command used for fresh installs. The installer detects
your existing installation, creates a backup, extracts the new version, and
triggers migrations automatically.

```sh
curl -fsSL https://raw.githubusercontent.com/d0labs/aof/main/scripts/install.sh | sh
```

### Migrations applied

Three migrations run automatically on first launch after upgrade:

1. **001-default-workflow-template** -- Adds a `defaultWorkflow` field to each
   `project.yaml` that has a matching workflow template. Projects without
   templates are left unchanged.

2. **002-gate-to-dag-batch** -- Converts all gate-based task workflows to DAG
   format. Gate sequences become dependency edges in the new DAG structure.
   Task data is preserved; only the workflow representation changes.

3. **003-version-metadata** -- Writes version tracking information to
   `.aof/channel.json`. This file records the installed version and update
   channel for future upgrade checks.

Each migration creates a snapshot of your data directory in `.aof/snapshots/`
before making changes. The last two snapshots are retained.

### Verification after upgrade

```sh
aof --version
# Expected: 1.3.0

aof smoke
# Runs 6 checks: version, schema, task store, org chart, migration status,
# workflow templates. All should pass.
```

## Upgrading from pre-v1.2

The upgrade process is the same as upgrading from v1.2. The installer handles
both paths.

```sh
curl -fsSL https://raw.githubusercontent.com/d0labs/aof/main/scripts/install.sh | sh
```

If you are upgrading from a release before v1.2, the installer may need to
migrate additional data files (tasks, events, memory, state) from legacy paths.
The installer backs up all existing data before making changes.

All three v1.3 migrations (001, 002, 003) still apply. The gate-to-DAG
migration (002) converts any gate-based workflows present in your task store,
regardless of which version created them.

### Verification after upgrade

```sh
aof --version
# Expected: 1.3.0

aof smoke
# Runs 6 checks: version, schema, task store, org chart, migration status,
# workflow templates. All should pass.
```

## Verification

After any install or upgrade path, verify your installation:

| Command | Expected result |
|---------|----------------|
| `aof --version` | `1.3.0` |
| `aof smoke` | All 6 checks pass |

The `aof smoke` command runs the following checks:

1. **Version** -- installed version matches expected version
2. **Schema** -- data directory schema is valid
3. **Task store** -- task database is readable and consistent
4. **Org chart** -- organization structure loads (optional; passes if absent)
5. **Migration status** -- all migrations have been applied
6. **Workflow templates** -- templates directory is present and parseable

## Rollback

If something goes wrong after upgrading, two rollback mechanisms are available.

### Migration snapshots

Each migration saves a snapshot of your data directory to `.aof/snapshots/`
before making changes. The last two snapshots are retained.

To restore from a migration snapshot:

```sh
# List available snapshots
ls .aof/snapshots/

# Pick the snapshot you want to restore (e.g., pre-001-default-workflow-template)
# Copy its contents back to your data directory
cp -R .aof/snapshots/<snapshot-name>/* .aof/
```

### Installer backups

The installer creates a broader backup at `.aof-backup/` before extracting a
new version. This backup includes: tasks, events, memory, state, data, logs,
Projects, `memory.db`, `memory-hnsw.dat`, and `.version`.

To restore from an installer backup:

```sh
# Copy backup contents back to your AOF data location
cp -R .aof-backup/* .aof/
```

After restoring from either mechanism, you may need to reinstall the previous
AOF version (the binary/scripts) to match the restored data format. The
rollback steps above restore your data only.

---

*Last updated for AOF v1.3.0*
