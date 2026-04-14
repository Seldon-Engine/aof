---
phase: 42
depth: standard
status: minor_issues
files_reviewed: 3
findings_count: 7
severity_counts:
  critical: 0
  high: 1
  medium: 2
  low: 2
  info: 2
reviewed_at: 2026-04-14T21:00:00Z
---

# Phase 42: Code Review — Installer Mode-Exclusivity

**Depth:** standard
**Files reviewed:** 3
**Status:** minor_issues (no blockers; one high-severity correctness gap)

---

## Summary

Phase 42 lands a clean ~30-line delta to `scripts/install.sh` (plugin-mode detection helper, daemon-skip gate, --force-daemon override, D-05 convergence block) plus a RED-first integration test harness and three new `uninstallService` idempotency unit tests. The architecture is sound: the detection function is zero-dependency POSIX shell, the D-05 uninstall shells out to the existing `aof daemon uninstall` CLI (avoiding logic duplication), and the TDD commit order is correct (RED scaffold in `test(42-01)` commits, GREEN implementations in later `feat` commits). One high-severity gap exists: the D-05 branch emits a "removing redundant standalone daemon" success message unconditionally, but the actual uninstall shell-out is guarded by a `[ -f "$INSTALL_DIR/dist/cli/index.js" ]` check that silently skips cleanup when the CLI binary is absent. On a fresh install with a pre-existing plist and no prior AOF code, the plist survives while the user sees a success message. Two medium-severity issues cover the missing `local` scoping on `ext_link` in `plugin_mode_detected()` and the real `launchctl bootout` bleed-through risk in the D-05 integration spec. The remaining findings are low-severity or informational.

---

## Findings

| Severity | File:Line | Issue | Recommendation |
|----------|-----------|-------|----------------|
| High | `scripts/install.sh:690-695` | D-05 success message fires before the CLI-exists guard — plist survives silently on fresh install | Move the `say "Plugin-mode detected; removing..."` inside the `[ -f "$INSTALL_DIR/dist/cli/index.js" ]` block, or add a `warn` on the else branch; see detail below |
| Medium | `scripts/install.sh:674` | `ext_link` assigned without `local` in `plugin_mode_detected()`; variable leaks to global scope | Add `local ext_link=...`; the rest of the script uses `local` universally — this is an inconsistency the 42-02-SUMMARY explicitly documents as a deliberate decision but that decision is wrong given the file's existing `local` usage |
| Medium | `tests/integration/install-mode-exclusivity.test.ts:154-166` | D-05 spec shells out to real `launchctl bootout gui/<UID>/ai.openclaw.aof` with no `afterEach` re-registration guard — if the service is loaded on the dev machine, the spec silently unloads it | Add a comment block or an `afterEach` no-op `launchctl bootstrap` re-check; see detail below |
| Low | `scripts/install.sh:687` | `plist` assigned without `local` inside `install_daemon()` — shadows the loop-scoped `plist` in `resume_live_writers` (line 427) if the call order ever changes | Add `local plist=...` for hygiene |
| Low | `scripts/install.sh:688-695` | D-05 uninstall fires but no post-uninstall check verifies plist was actually removed — a `warn` on the else-branch of `[ -f "$INSTALL_DIR/dist/cli/index.js" ]` is missing | Add `else warn "dist/cli/index.js not found — plist at $plist may remain; run 'aof daemon uninstall' manually"` |
| Info | `tests/integration/install-mode-exclusivity.test.ts:173` | Regex `Daemon (installed and running\|install failed)` uses a pipe literal in the pattern string passed to `.toMatch()`; `.toMatch()` accepts a RegExp or string — passing a string with `|` means it matches literally, not as alternation | Use `expect(output).toMatch(/Daemon (installed and running|install failed)/)` (RegExp literal) |
| Info | `src/daemon/__tests__/service-file.test.ts:380` | `void uninstallService;` sentinel to satisfy the "unused import" lint is unusual and surprising to readers; a comment on the static import itself would be cleaner | Replace `void uninstallService;` with an inline comment on the static import line explaining why it is kept: `// imported for grep-verifiability (see describe block below)` |

---

## Detail

### High: D-05 success message precedes the CLI-exists guard

**File:** `scripts/install.sh:690-695`

```sh
    if [ -f "$plist" ]; then
      # D-05: pre-existing dual-mode install — converge to plugin-only.
      say "Plugin-mode detected; removing redundant standalone daemon."   # ← fires unconditionally
      if [ -f "$INSTALL_DIR/dist/cli/index.js" ]; then                   # ← guard comes AFTER say
        node "$INSTALL_DIR/dist/cli/index.js" daemon uninstall \
          --data-dir "$DATA_DIR" 2>&1 || \
          warn "Daemon uninstall returned non-zero (continuing — plist may already be gone)"
      fi
```

When `INSTALL_DIR/dist/cli/index.js` is absent (e.g. a fresh install where the tarball extract hasn't run yet, or an edge case where the build is missing), the `say` message tells the user the daemon was removed, but the plist is left intact. On next boot, launchd will respawn the daemon, reproducing the dual-mode state the user thought they just resolved.

**Fix — restructure the inner block:**

```sh
    if [ -f "$plist" ]; then
      if [ -f "$INSTALL_DIR/dist/cli/index.js" ]; then
        say "Plugin-mode detected; removing redundant standalone daemon."
        node "$INSTALL_DIR/dist/cli/index.js" daemon uninstall \
          --data-dir "$DATA_DIR" 2>&1 || \
          warn "Daemon uninstall returned non-zero (continuing — plist may already be gone)"
      else
        warn "Plugin-mode detected; pre-existing daemon plist found but dist/cli/index.js missing." \
        warn "  Remove manually: launchctl bootout gui/\$(id -u)/ai.openclaw.aof && rm -f \"$plist\""
      fi
```

Note: in practice the `dist/cli/index.js` guard is rarely falsy during a real install (the tarball extract runs before `install_daemon`). But the guard exists for a reason; the message should respect it.

---

### Medium: `ext_link` not scoped with `local` in `plugin_mode_detected()`

**File:** `scripts/install.sh:674`

```sh
plugin_mode_detected() {
  ext_link="$OPENCLAW_HOME/extensions/aof"   # ← global assignment
```

The 42-02-SUMMARY documents this as intentional, citing "POSIX /bin/sh may not support `local`." However, `install.sh` uses `local` in at least 12 other places (lines 605, 625, 626, 631, 641, 650, 722, 848, 873, 887, 969, 977, 986). The script already depends on `local` being available — `local` is a de-facto POSIX extension supported by every shell this script will realistically run under (bash, dash, ash, ksh, zsh). The inconsistency is confusing to contributors and leaves `ext_link` in global scope where it could be read or clobbered by a future edit.

**Fix:**

```sh
plugin_mode_detected() {
  local ext_link="$OPENCLAW_HOME/extensions/aof"
```

---

### Medium: D-05 integration spec bleeds real `launchctl bootout` onto the host

**File:** `tests/integration/install-mode-exclusivity.test.ts:154-166`

The D-05 spec sets `HOME=fakeHome` and calls `runInstall()`. When the D-05 branch inside `install_daemon` fires, it runs:

```sh
node "$INSTALL_DIR/dist/cli/index.js" daemon uninstall --data-dir "$DATA_DIR"
```

The spawned Node.js process inherits `HOME=fakeHome`, so `os.homedir()` returns `fakeHome`, and `getServiceFilePath('darwin')` resolves to the correct sandbox plist path. However, `service-file.ts:381` executes:

```sh
launchctl bootout gui/$(id -u)/ai.openclaw.aof
```

This issues a real `launchctl bootout` against the host's launchd using the developer's actual UID. If `ai.openclaw.aof` is loaded (normal for an AOF developer running the suite on their own machine), this silently unloads it. There is no `afterEach` that re-registers the service.

**Recommended mitigation:**

Add a comment block documenting the known risk and the workaround, and optionally add an `afterEach` that re-bootstraps any service it unloaded:

```ts
afterEach(() => {
  // Best-effort: if the D-05 spec issued a real launchctl bootout against a
  // loaded ai.openclaw.aof on the dev machine, attempt to re-bootstrap it.
  // Harmless no-op if the service was never loaded.
  const realPlist = join(
    process.env.HOME_REAL ?? homedir(),
    "Library", "LaunchAgents", "ai.openclaw.aof.plist"
  );
  if (existsSync(realPlist)) {
    try {
      execFileSync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, realPlist], {
        stdio: "ignore",
      });
    } catch { /* best effort */ }
  }
  rmSync(sandbox, { recursive: true, force: true });
});
```

At minimum, add a comment to the test body warning that the spec issues a real `launchctl bootout`.

---

### Info: `.toMatch()` string argument treats `|` as a literal character

**File:** `tests/integration/install-mode-exclusivity.test.ts:173`

```ts
expect(output).toMatch(/Daemon (installed and running|install failed)/);
```

The file already uses a RegExp literal here, so this is actually correct. But double-check: at line 173 in the source the spec reads `expect(output).toMatch(/Daemon (installed and running|install failed)/)` — confirming the RegExp literal form is used. This finding is withdrawn. No action needed.

---

## Positive Observations

- **TDD discipline maintained.** The commit sequence is clearly RED-first: `test(42-01)` creates failing integration specs, then `feat(42-02)` through `feat(42-04)` incrementally turn them green. This is textbook TDD per CLAUDE.md.

- **D-05 shells out to `aof daemon uninstall` rather than hand-rolling.** The decision to delegate to the existing `uninstallService()` path (cross-platform, idempotent, already unit-tested in Plan 01) avoids logic duplication and future drift — consistent with the research recommendation.

- **`|| warn` suffix on the uninstall shell-out.** Under `set -eu`, the installer would abort on non-zero exit without the fallback. The explicit `|| warn` makes the D-05 uninstall best-effort and keeps the install from aborting on a stale plist (Pitfall 2 from RESEARCH.md, correctly mitigated).

- **`OPENCLAW_HOME` scoped correctly.** The `plugin_mode_detected()` helper correctly references `$OPENCLAW_HOME` which is set at global scope (line 48, before `parse_args`), ensuring it is populated before the function is ever called regardless of call site.

- **`[ -L ] || [ -d ]` test (not `[ -L ] || [ -e ]`).** The detection correctly uses `-d` for the directory arm, which rejects dangling symlinks, consistent with RESEARCH.md §Pitfall 4 and the `remove_external_integration` pattern rationale.

- **Integration test is skipped in the standard `npm test` suite.** The `AOF_INTEGRATION=1` guard and the `process.platform === "darwin"` check ensure the heavy shell-out tests never slow down the unit suite or break on non-macOS CI.

- **`uninstallService` idempotency unit tests (service-file.test.ts)** cover the three relevant failure modes (already-removed plist, launchctl throwing, ENOENT on runtime files) with clean `vi.doMock + vi.resetModules + dynamic import` isolation. The `void uninstallService;` sentinel is unusual but the intent is documented in the surrounding comment.

---

## Recommended Follow-Ups

1. **(High → fix in follow-up commit)** Move the `say "Plugin-mode detected; removing..."` message inside the `[ -f dist/cli/index.js ]` guard in `install_daemon`, or add a `warn` on the missing-binary else branch. A 3-line patch.

2. **(Medium → hygiene)** Add `local` to `ext_link` in `plugin_mode_detected()` for consistency with the rest of the script. Override the 42-02-SUMMARY decision: `local` is already load-bearing in 12+ places in this file; the POSIX concern is moot.

3. **(Medium → hygiene, post-phase)** Add a comment to the D-05 integration spec documenting that `launchctl bootout` is issued against the real host launchd, and optionally add a best-effort `afterEach` re-bootstrap guard for developers running the spec on machines where `ai.openclaw.aof` is active.

4. **(Linux parity — explicitly deferred)** The D-05 plist check (`$HOME/Library/LaunchAgents/...`) is macOS-only. Linux dual-mode convergence would require an analogous `~/.config/systemd/user/ai.openclaw.aof.service` pre-check. This is correctly documented as deferred in 42-04-SUMMARY.

---

_Reviewed: 2026-04-14T21:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
