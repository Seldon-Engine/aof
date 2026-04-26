# Artifact lifecycle v1

Use artifact archives to move bulky finished work out of active workspaces while keeping it locally retrievable and auditable. V1 is a filing cabinet: it creates a local `.tar.gz`, writes a readable manifest, and records metadata in SQLite.

Default cold storage lives outside active workspaces:

```text
~/.openclaw/cold-storage/artifact-archives/
```

## Artifact states

- **Active**: in the current workspace and useful now.
- **Warm**: metadata or docs stay active, but bulky payloads are candidates for archive.
- **Cold**: payload is stored as a tarball plus manifest and index row under cold storage.
- **Trash-pruned**: the original directory was moved to Trash after archive, manifest, and index succeeded. V1 never permanently deletes artifacts.

## Archive

```bash
aof artifacts archive ./reports/big-run \
  --project demo \
  --title "Big run output" \
  --tag report \
  --notes "Restorable local copy"
```

By default, the source directory remains in place. The command prints a JSON summary with the archive id, archive path, manifest path, SHA-256, file count, and byte counts.

## List

```bash
aof artifacts list --limit 10
```

List uses the SQLite index only; it does not inspect or unpack cold payloads. Use this to find an archive id before restore.

For scripts:

```bash
aof artifacts list --json
```

## Restore

```bash
aof artifacts restore 20260426T030000Z-demo-big-run --dest ./restored
```

Restore verifies the tarball SHA-256 against the index before extraction. On success, AOF writes `archive-restored.json` into the restored top-level directory.

## Prune the original to Trash

```bash
aof artifacts archive ./reports/big-run \
  --project demo \
  --prune-original-to-trash
```

Prune only runs after the tarball, manifest, and SQLite index row are written. It moves the source directory to the macOS Trash; it does not permanently delete it. If Trash is unavailable or the move fails, the command fails clearly.
