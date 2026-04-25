# Fix: Installer/Wizard UX + Path Normalization (v2)

## Context
After the first round of fixes (docs, org chart path, plugin registration, installer PATH, standalone executor), three categories of issues remain:

1. **Path normalization bug**: Running `aof` from inside `~/.aof` breaks org chart lookup because `--root` is never resolved to absolute
2. **Upgrade doesn't repair broken installs**: `setup --auto --upgrade` skips the wizard, so missing dirs/org chart are never recreated
3. **Fresh install doesn't auto-start daemon**: Users must manually run `aof daemon install` with no clear guidance

## Bug A: Path normalization (the `--root` is relative pattern)

### Root cause
`src/cli/program.ts` line 47 accepts `--root` without resolving it:
```typescript
.option("--root <path>", "AOF root directory", AOF_ROOT)
```
Every command then does `program.opts()["root"] as string` and passes it through. If the user is `cd ~/.aof` and runs `aof org show`, the root is `~/.aof` but `join("~/.aof", "org", ...)` doesn't expand `~`. Worse, if `AOF_ROOT` or `--root` is relative, `join()` produces a relative path resolved against cwd.

### Fix

**1. `src/config/paths.ts` — add `normalizePath()` helper:**
```typescript
import { join, resolve } from "node:path";

/** Resolve a path to absolute, expanding ~ to homedir. */
export function normalizePath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return resolve(join(homedir(), p.slice(2)));
  }
  return resolve(p);
}
```

**2. `src/config/paths.ts` — wrap `resolveDataDir` with normalization:**
```typescript
export function resolveDataDir(explicit?: string): string {
  const raw = explicit ?? process.env["AOF_DATA_DIR"] ?? DEFAULT_DATA_DIR;
  return normalizePath(raw);
}
```

**3. All path functions in `paths.ts` — add `resolve()` call:**
Every function should call `resolve(join(...))` instead of bare `join(...)` so that even if a caller passes a relative base, the output is always absolute.

**4. `src/cli/program.ts` — normalize root at the gate:**
After program parses options, resolve root to absolute before any command uses it. The cleanest way: use Commander's `.hook('preAction', ...)` to normalize `root` once:
```typescript
program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.opts();
  if (opts.root) {
    opts.root = normalizePath(opts.root);
  }
});
```
Or alternatively, change the option to use a custom argument parser:
```typescript
.option("--root <path>", "AOF root directory", normalizePath, AOF_ROOT)
```

**5. `src/cli/commands/daemon.ts` — normalize `--data-dir` too:**
The daemon commands accept `--data-dir` separately. Normalize it the same way.

**6. Audit remaining `process.cwd()` usage in production code:**
Files to fix (replace with `resolveDataDir()` or accept explicit dataDir param):
- `src/cli/init.ts:70` — already fixed in prior round
- `src/cli/init-steps-lifecycle.ts:19` — already fixed in prior round
- Any other occurrences in src/ (non-test) files

## Bug B: Upgrade doesn't repair broken scaffold

### Root cause
`setup.ts` line 358: `if (!upgrade && !legacy)` gates the wizard. On upgrade, the wizard never runs, so missing dirs/org chart are never recreated.

### Fix

**1. New function `ensureScaffold(dataDir)` in `src/packaging/wizard.ts`:**
Idempotent function that ensures all required directories and files exist. Unlike `runWizard()` (which creates everything fresh), this only fills gaps:
- `mkdir -p` all required directories (same list as wizard: tasks/*, events, data, org, memory, state, logs)
- If `org/org-chart.yaml` missing, create minimal org chart (1 agent, 1 team)
- If `daemon.pid` exists but process not running, remove stale PID file
- Never overwrites existing files
- Returns list of items repaired (for logging)

**2. Call `ensureScaffold()` in `setup.ts` for ALL flows:**
Move the call to BEFORE OpenClaw wiring (~line 384), so it runs for fresh, upgrade, AND legacy:
```typescript
// Ensure scaffold integrity (repairs broken installs on upgrade)
const repaired = await ensureScaffold(dataDir);
if (repaired.length > 0) {
  say(`Repaired: ${repaired.join(", ")}`);
}
```

**3. Also call `ensureScaffold()` from `validateConfig()` in daemon.ts:**
Currently `validateConfig()` only creates `tasks/` and `logs/`. Replace with `ensureScaffold()` call so `aof daemon install` also self-heals.

**4. New migration 004 — scaffold repair:**
Add `src/packaging/migrations/004-scaffold-repair.ts`:
- Idempotent, calls `ensureScaffold()`
- Runs during `setup --auto --upgrade`
- Ensures all existing installs get repaired on next upgrade

## Bug C: Fresh install doesn't auto-start daemon

### Fix

**1. `install.sh` — add daemon install step:**
After `setup_shell_path` and before `print_summary`:
```bash
install_daemon() {
  if [ -f "$INSTALL_DIR/dist/cli/index.js" ]; then
    say "Installing daemon service..."
    node "$INSTALL_DIR/dist/cli/index.js" daemon install \
      --data-dir "$INSTALL_DIR" 2>&1 || {
      warn "Daemon install failed (non-fatal) — run 'aof daemon install' manually"
    }
  fi
}
```

**2. Update `main()` in install.sh:**
```bash
main() {
  ...
  run_node_setup
  write_version_file
  setup_shell_path
  install_daemon      # NEW
  print_summary
  ...
}
```

**3. Update `print_summary()` to reflect auto-installed daemon:**
- If daemon install succeeded: "Daemon installed and running"
- If failed: "Run `aof daemon install` to start the background daemon"

## Bug D: Post-install validation

### Fix

**1. `install.sh` — add validation step:**
```bash
validate_install() {
  local ok=true

  # Check binary works
  if ! node "$INSTALL_DIR/dist/cli/index.js" --version >/dev/null 2>&1; then
    warn "aof binary check failed"
    ok=false
  fi

  # Check org chart exists
  if [ ! -f "$INSTALL_DIR/org/org-chart.yaml" ]; then
    warn "org chart missing after install"
    ok=false
  fi

  # Check tasks dir exists
  if [ ! -d "$INSTALL_DIR/tasks/ready" ]; then
    warn "tasks directory structure missing"
    ok=false
  fi

  if [ "$ok" = false ]; then
    warn "Install validation failed — run 'aof setup --auto --data-dir $INSTALL_DIR' to repair"
  else
    say "Install validated"
  fi
}
```

Add to `main()` after `install_daemon`.

## Execution Order

1. **Path normalization** (Bug A) — foundational fix, touches paths.ts + program.ts + daemon.ts
2. **ensureScaffold** (Bug B) — new function in wizard.ts, wired into setup.ts + daemon.ts
3. **Daemon auto-install** (Bug C) — install.sh changes only
4. **Post-install validation** (Bug D) — install.sh changes only
5. **Tests** — verify path normalization, scaffold repair, upgrade flow

## Files to modify

| File | Changes |
|------|---------|
| `src/config/paths.ts` | Add `normalizePath()`, wrap all functions with `resolve()` |
| `src/cli/program.ts` | Normalize `--root` in preAction hook |
| `src/cli/commands/daemon.ts` | Normalize `--data-dir` |
| `src/packaging/wizard.ts` | New `ensureScaffold()` function |
| `src/cli/commands/setup.ts` | Call `ensureScaffold()` for all flows |
| `src/cli/commands/daemon.ts` | `validateConfig()` calls `ensureScaffold()` |
| `src/packaging/migrations/004-scaffold-repair.ts` | New migration |
| `scripts/install.sh` | Add `install_daemon()`, `validate_install()` |

## Verification

- `cd ~/.aof && aof org show` → works (path normalization)
- `aof --root . org show` from `~/.aof` → works
- `aof setup --auto --upgrade` with missing org chart → org chart recreated
- `aof daemon install` with missing dirs → dirs created
- Fresh `bash scripts/install.sh --prefix /tmp/aof-test` → daemon running, org chart present, `aof --version` works
- Full test suite passes: `npm test`
