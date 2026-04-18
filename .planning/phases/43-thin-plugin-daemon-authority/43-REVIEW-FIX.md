---
phase: 43-thin-plugin-daemon-authority
fixed_at: 2026-04-17T23:59:59Z
review_path: .planning/phases/43-thin-plugin-daemon-authority/43-REVIEW.md
iteration: 1
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 43: Code Review Fix Report

**Fixed at:** 2026-04-17T23:59:59Z
**Source review:** .planning/phases/43-thin-plugin-daemon-authority/43-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 3
- Fixed: 3
- Skipped: 0

## Fixed Issues

### WR-01: `readBody` — chunks still accumulate after `PayloadTooLargeError` is thrown

**Files modified:** `src/ipc/http-utils.ts`
**Commit:** 87d1b29
**Applied fix:** Added `let limitExceeded = false` flag before the `data` handler. The handler now returns immediately (`if (limitExceeded) return`) at the top of each invocation. When the size cap is first crossed, `limitExceeded` is set to `true` before calling `req.destroy()` and `reject()`, preventing any buffered `data` events from re-entering the rejection path or appending to `chunks`.

### WR-02: `install.sh` equality guard uses `&&` instead of `||` — symlink bypass

**Files modified:** `scripts/install.sh`
**Commit:** 0c595ff
**Applied fix:** Removed the redundant raw-string equality condition (`&& [ "$INSTALL_DIR" = "$DATA_DIR" ]`) from the DATA_DIR/INSTALL_DIR guard. The check now uses only the canonical-path comparison (`$(cd … && pwd)` on both sides), so symlinks that resolve to the same directory are correctly caught.

### WR-03: `SpawnQueue` — `enqueue()` casts `partial` with `as SpawnRequest` unsafely

**Files modified:** `src/ipc/spawn-queue.ts`
**Commit:** 3ef5726
**Applied fix:** Replaced `const full = { id: randomUUID(), ...partial } as SpawnRequest` with `const full: SpawnRequest = { id: randomUUID(), ...partial }`. TypeScript now structurally validates the assignment, ensuring any future required field added to `SpawnRequest` (beyond `id`) will produce a compile error at this site rather than silently producing an incomplete object.

---

_Fixed: 2026-04-17T23:59:59Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
