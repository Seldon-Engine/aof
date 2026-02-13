# Migration Guide — Legacy Vault to Projects v0

This guide covers migrating a legacy single-project AOF vault to the new Projects v0 architecture.

## Overview

Projects v0 introduces a multi-project workspace structure. Legacy vaults with top-level `tasks/`, `events/`, `views/`, and `state/` directories can be migrated to `Projects/_inbox/`.

The migration tool:
- **Backs up your legacy data** to `tasks.backup-<timestamp>/`
- **Preserves all files** (task cards, companion directories, JSON artifacts, non-.md files)
- **Updates task frontmatter** to include `project: "_inbox"` field
- **Is idempotent** — safe to re-run, skips already-migrated task cards
- **Supports dry-run** — preview changes without modifying files
- **Includes rollback** — restore legacy layout from backup if needed

## Migration Commands

### Migrate to Projects v0

```bash
# Standard migration
aof migrate

# Dry-run (preview without changes)
aof migrate --dry-run

# Specify custom backup directory (for testing)
aof migrate --backup-dir=my-backup
```

**What happens:**
1. Checks if migration is needed (legacy dirs present, `_inbox` missing or partial)
2. Creates backup directory: `tasks.backup-<timestamp>/`
3. Moves legacy directories (`tasks/`, `events/`, `views/`, `state/`) into backup
4. Creates `Projects/_inbox/` with required structure (via bootstrap)
5. Copies entire backup into `_inbox` scope (preserves all files and subdirectories)
6. Updates task card frontmatter (only top-level `.md` files in `tasks/<status>/`) to add `project: "_inbox"`
7. Skips task cards that already have `project` field (idempotent)

**Fresh Install Behavior:**
If no legacy directories exist and `_inbox` is missing, the migration tool creates a fresh `_inbox` project without creating a backup.

### Rollback Migration

```bash
# Rollback from latest backup
aof rollback

# Rollback from specific backup
aof rollback --backup-dir=tasks.backup-2026-01-15T12-00-00-000Z

# Dry-run rollback
aof rollback --dry-run
```

**What happens:**
1. Finds backup directory (explicit or latest `tasks.backup-*`)
2. Renames `Projects/_inbox/` to `_inbox.rollback-<timestamp>` (to avoid data loss)
3. Moves backup directories back to vault root
4. Restores original legacy layout

## Migration Behavior Details

### What Gets Copied

The migration **copies the entire `tasks/` directory structure**, including:
- Task card files (`.md` files at status level)
- Task companion directories (`TASK-*/inputs/`, `TASK-*/outputs/`, `TASK-*/work/`)
- Non-.md files (JSON artifacts, text files, etc.)
- Nested subdirectories

**Example:**
```
Legacy:
  tasks/
    ready/
      TASK-123.md           ← Task card
      TASK-123/
        inputs/
          spec.json
        outputs/
          handoff.md        ← Companion file (NOT a task card)
        work/
          notes.txt

After Migration:
  Projects/_inbox/tasks/
    ready/
      TASK-123.md           ← Frontmatter updated (project: "_inbox" added)
      TASK-123/
        inputs/
          spec.json         ← Preserved as-is
        outputs/
          handoff.md        ← Preserved as-is (no frontmatter injection)
        work/
          notes.txt         ← Preserved as-is
```

### Frontmatter Updates

The migration **only updates task card files** (top-level `.md` files in `tasks/<status>/`). It does **not** recurse into task companion directories.

**Updated:**
- `tasks/backlog/TASK-001.md`
- `tasks/ready/TASK-002.md`
- `tasks/done/TASK-003.md`

**Not Updated (Preserved As-Is):**
- `tasks/ready/TASK-002/outputs/handoff.md` (companion file)
- `tasks/ready/TASK-002/inputs/requirements.json` (artifact)
- `tasks/done/TASK-003/work/notes.txt` (work file)

**Idempotency:**
If a task card already has a `project` field set to `_inbox`, it is skipped. This allows safe re-runs without overwriting user modifications.

### Project Manifest

The migration creates `Projects/_inbox/project.yaml` with default settings:
```yaml
schemaVersion: 1
id: "_inbox"
title: "_Inbox"
status: active
createdAt: <timestamp>
updatedAt: <timestamp>
```

If `project.yaml` already exists, it is **not overwritten**.

## Backup Directory Structure

Backup directories are named `tasks.backup-<timestamp>` (ISO 8601 format with safe characters):
```
tasks.backup-2026-01-15T12-00-00-000Z/
  tasks/
  events/
  views/
  state/
```

Rollback finds the **latest backup** (lexicographically sorted) if no explicit backup is specified.

## Safety & Best Practices

1. **Run dry-run first**: `aof migrate --dry-run` to preview changes
2. **Backup manually** (optional): Copy vault before migration for extra safety
3. **Verify backup created**: Check that `tasks.backup-*` directory exists with expected contents
4. **Keep backups**: Don't delete backup directories until you're confident migration succeeded
5. **Test rollback** (optional): Run `aof rollback --dry-run` to verify rollback will work if needed

## Common Scenarios

### Fresh Install (No Legacy Data)
```bash
$ aof migrate
✓ Fresh install: creating _inbox project
```
Creates `Projects/_inbox/` with bootstrap structure. No backup created.

### Standard Migration
```bash
$ aof migrate
✓ Backup created: tasks.backup-2026-01-15T12-00-00-000Z
✓ Migrated 4 directories (tasks, events, views, state)
✓ Updated 47 task cards
✓ Skipped 0 task cards
```

### Partial Migration (Some Tasks Already Have `project` Field)
```bash
$ aof migrate
⚠ Projects/_inbox already exists; migration may have been partially completed
✓ Backup created: tasks.backup-2026-01-15T13-00-00-000Z
✓ Migrated 1 directory (tasks)
✓ Updated 12 task cards
✓ Skipped 35 task cards (already migrated)
```

### Already Migrated
```bash
$ aof migrate
✓ Already migrated: no legacy dirs and _inbox exists
```

### Rollback After Migration
```bash
$ aof rollback
✓ Restored 4 directories (tasks, events, views, state) from tasks.backup-2026-01-15T12-00-00-000Z
⚠ Renamed _inbox to _inbox.rollback-2026-01-15T14-00-00-000Z
```

## Troubleshooting

### "Task file must start with YAML frontmatter (---)"
A task card file is missing frontmatter. This is a validation error. Check the file and add valid frontmatter before migrating.

### "No backup directory found (tasks.backup-*)"
Rollback requires a backup directory. Either:
- Specify explicit backup: `aof rollback --backup-dir=tasks.backup-<timestamp>`
- Ensure backup directory exists in vault root

### Tasks Were Skipped During Migration
This is normal if:
- Tasks already have `project: "_inbox"` field (re-running migration)
- Previous migration partially completed

Check `result.skippedTaskCount` in output.

### Companion Files Lost After Migration
**This should not happen** with the fixed migration tool. If you experience this:
1. Check the backup directory — all files should be present
2. Run rollback to restore: `aof rollback`
3. Report the issue with migration output logs

## See Also

- [Projects v0 Specification](./PROJECTS-V0-SPEC-v2.md)
- [Task Schema](./task-schema.md)
- [Bootstrap Tool](./bootstrap.md)
