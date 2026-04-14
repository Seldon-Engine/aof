---
phase: 41-clean-install-upgrade
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/config/paths.ts
  - src/config/registry.ts
  - src/projects/resolver.ts
  - src/plugin.ts
  - src/cli/commands/setup.ts
  - src/packaging/migrations/006-data-code-separation.ts
  - src/packaging/__tests__/006-data-code-separation.test.ts
  - src/openclaw/__tests__/plugin.unit.test.ts
  - scripts/install.sh
  - scripts/build-tarball.mjs
  - openclaw.plugin.json
autonomous: false
requirements: []

must_haves:
  truths:
    - "User data lives in a dedicated subdirectory of the install root (~/.aof/data/) — segregated from code (~/.aof/dist/, node_modules/, package.json, etc.) so the installer can freely wipe and re-extract everything but the data subdir on upgrade"
    - "A migration moves legacy mixed-layout data (~/.aof/{tasks,org,events,...}) into ~/.aof/data/ and updates the OpenClaw plugin config pointer atomically"
    - "A --clean flag on install.sh wipes the install root (preserving data subdir) + OpenClaw integration points (plugin symlinks, companion skill, openclaw.json entries), then re-installs"
    - "Normal upgrade preserves user data via move-out/wipe/extract/move-in, not via in-place tar-over-existing — this is what eliminates zombie code files"
    - "A failed step at any point leaves user data preserved in an external backup directory named in the installer output"
  artifacts:
    - path: "src/config/paths.ts"
      provides: "DEFAULT_DATA_DIR = ~/.aof/data (was ~/.aof); new DEFAULT_CODE_DIR constant"
      contains: "DEFAULT_DATA_DIR"
    - path: "src/packaging/migrations/006-data-code-separation.ts"
      provides: "Migration 006 — moves ~/.aof/{tasks,org,...} → ~/.aof/data/; updates openclaw.json"
      contains: "006-data-code-separation"
    - path: "scripts/install.sh"
      provides: "preserve_data_dir/wipe_code_in_install_dir/restore_preserved_data; --clean flag"
      contains: "preserve_data_dir"
---

<objective>
Eliminate the zombie-file class of upgrade bug by structurally segregating user data from installer-owned code, and add a `--clean` recovery path for installs that are already in a bad state.

Purpose: Today's upgrade path extracts the new tarball over the existing install. Files present in the OLD layout but absent from the new tarball are never removed, so every layout change across versions leaves orphans behind. The concrete symptom on the user's machine was `~/.aof/` containing a mix of Mar 20 flat-layout files and Apr 8 `dist/`-layout files, with the root-level `version.js` crashing on `require('../package.json')`.
</objective>

## Design

### 1. Directory layout

Single roof at `~/.aof/`, two concerns:

```
~/.aof/                   ← installer-owned, safely wipe-able on upgrade
├── dist/                 ← compiled JS
├── node_modules/         ← runtime deps
├── package.json
├── package-lock.json
├── openclaw.plugin.json
└── data/                 ← user-owned, preserved across upgrades
    ├── tasks/
    ├── events/
    ├── memory/
    ├── state/
    ├── Projects/
    ├── logs/
    ├── org/
    └── config/
```

Any path at `~/.aof/` root other than `data/` belongs to the installer. `data/` belongs to the user.

### 2. Upgrade and --clean share one machinery

`install.sh` runs the same three steps for both upgrade and `--clean`:

```
preserve_data_dir      # mv ~/.aof/data → ~/.aof-backup-<ts>/data
wipe_code_in_install_dir  # rm -rf ~/.aof
mkdir ~/.aof
tar -xzf tarball -C ~/.aof
restore_preserved_data    # mv ~/.aof-backup-<ts>/data → ~/.aof/data
```

Backup directory lives *outside* the install root so a wipe cannot destroy its own safety net.

`--clean` adds three things on top:
- Refuse if openclaw-gateway is running (gateway has old code/config in memory).
- Confirm prompt (skippable via `--yes`).
- Remove external integration points: `~/.openclaw/extensions/aof` symlink, orphan `~/.openclaw/plugins/aof` symlink, `~/.openclaw/skills/aof/` directory, and AOF entries in `~/.openclaw/openclaw.json`.

### 3. Migration 006

For pre-v1.13 installs where user data is mixed with code at the root, migration 006 runs during `aof setup --upgrade` to move it into the new subdirectory layout.

- Moves each top-level data directory from `~/.aof/<dir>/` to `~/.aof/data/<dir>/` via atomic rename (same filesystem).
- Updates `~/.openclaw/openclaw.json` to point `plugins.entries.aof.config.dataDir` at the new location, with a timestamped backup of the original.
- Handles the case where `aof setup`'s scaffold-repair migration (004) has already created empty scaffold dirs at the new location — deletes empty scaffold, then performs the rename.
- Handles real-content conflicts by renaming the legacy copy to `<dir>.migrated-<ts>` in the install root (never deleted, so manual reconciliation is always possible).
- Writes a breadcrumb `~/.aof/.migrated-to-data-subdir` for idempotency.

### 4. Path constants

Touched everywhere the old `~/.aof` default appeared:
- `src/config/paths.ts` — `DEFAULT_DATA_DIR` and new `DEFAULT_CODE_DIR`
- `src/config/registry.ts` — Zod default
- `src/projects/resolver.ts` — `DEFAULT_AOF_ROOT`
- `src/plugin.ts` — plugin-local default (openclaw config value takes precedence)
- `src/cli/commands/setup.ts` — Commander default + targetVersion lookup falls back to compiled-in `VERSION` when data dir has no `package.json`
- `openclaw.plugin.json` — configSchema description

### 5. setup.ts targetVersion fix

Pre-refactor, `targetVersion` came from `${dataDir}/package.json` (because dataDir WAS the install root). Under the split, the new data dir has no `package.json`. Migration framework gates by version, so migrations with `version > targetVersion` silently skip. Fix: fall back to the compiled-in `VERSION` from `src/version.ts` when dataDir has no package.json.

## Scope

### In scope
- All of the above — shipped as part of this phase.
- Test coverage: unit test for migration 006 (moves + idempotency + openclaw config update); existing plugin unit tests updated for new default path.
- Deploy + verify on one live install (the author's own machine).

### Out of scope
- Removing the `backup_user_data`/`restore_user_data` logic that used to live inside `install.sh` for in-place upgrades — already gone via simplification.
- Full reorganization of `src/projects/resolver.ts` to separate vault from data dir cleanly — vault currently inherits from data dir semantically. That's fine for now; worth a follow-up only if a new use case arises.
- Cleanup of stale compiled-JS files that followed old flat-layout deploys into user data dirs (`memory/`, `events/`, `config/`). The migration moves directories wholesale; distinguishing code from data inside them is a separate task. For the deploying user, handle manually; for future users this won't arise because they'll install into the new layout from the start.

## Verification

1. **Fresh install**: `install.sh` on a clean system creates `~/.aof/` with `dist/`, `package.json`, etc., and `~/.aof/data/` with `tasks/`, `org/org-chart.yaml`, etc.
2. **Upgrade from mixed layout**: `install.sh` on a pre-v1.13 install (data at `~/.aof/tasks/` etc.) preserves all data into `~/.aof/data/` and updates `openclaw.json`.
3. **--clean**: wipes `~/.aof/` except `data/`, removes plugin symlinks and skill dir, unregisters from openclaw.json, reinstalls, restores data.
4. **Gateway round-trip**: after install/upgrade, restart gateway. `~/.openclaw/logs/gateway.log` shows `[AOF] Plugin loaded — dataDir=~/.aof/data`. New events go to `~/.aof/data/events/`.
5. **Migration idempotency**: running `aof setup --upgrade` twice in a row is a no-op on the second run.

## Known residuals from the real-world deploy (author's machine)

Observed during the deploy validation:
- A long-running `openclaw-completion` process (unrelated to gateway) had old dataDir config in memory and continued writing `scheduler.poll` events to `~/.aof/events/` after the gateway restart. Terminating it stopped the writes. Follow-up: install.sh `--clean` gating should also refuse if any `openclaw-*` processes with AOF loaded are live, not just the gateway.
- Stale compiled-JS artifacts from old flat-layout deploys existed inside `memory/`, `events/`, `config/` data dirs (e.g., `~/.aof/memory/adapter.js`). Migration 006 moved them wholesale into `~/.aof/data/`. They were cleaned up manually by diffing against `~/.aof/dist/<subdir>/`. Not a functional problem — just cruft. Consider a hygiene pass in migration 006 that removes top-level files in data dirs whose names collide with a file in `dist/<same-subdir>/`.
