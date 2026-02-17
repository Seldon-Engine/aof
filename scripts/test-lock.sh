#!/usr/bin/env bash
# test-lock.sh — Serialize vitest runs via advisory file lock.
#
# Uses flock (Linux, auto-release on death) or a PID-file approach (macOS).
# Lock is AUTOMATICALLY released when the process exits, crashes, or is killed.
# Stale locks from dead processes are detected and reclaimed.
#
# This is a transitional measure. Once AOF-adf (dispatch throttling) ships,
# concurrent agents can coordinate at the scheduler level instead, and this
# script becomes a safety net rather than the primary gate.
#
# Config via env vars:
#   AOF_TEST_LOCK_DIR     — lock directory (default: /tmp)
#   AOF_TEST_LOCK_TIMEOUT — max wait seconds (default: 300; 0 = fail immediately)
#
# Usage:
#   ./scripts/test-lock.sh [vitest args...]
#   ./scripts/test-lock.sh run --reporter=verbose
#   npm test  (wired via package.json)

set -euo pipefail

LOCK_DIR="${AOF_TEST_LOCK_DIR:-/tmp}"
LOCK_FILE="${LOCK_DIR}/aof-vitest.lock"
WAIT_TIMEOUT="${AOF_TEST_LOCK_TIMEOUT:-300}"  # 5 min default

# --- Acquire lock ---

if command -v flock &>/dev/null; then
  # Linux: flock with timeout, kernel auto-releases on process death
  exec flock --timeout "$WAIT_TIMEOUT" "$LOCK_FILE" npx vitest "$@"
fi

# macOS / fallback: PID-file locking with stale detection

cleanup_lock() {
  rm -f "$LOCK_FILE"
}

try_acquire() {
  # Atomic create-if-not-exists via noclobber
  if (set -o noclobber; echo "$$" > "$LOCK_FILE") 2>/dev/null; then
    return 0
  fi

  # File exists — check if holder is alive
  local holder_pid
  holder_pid=$(cat "$LOCK_FILE" 2>/dev/null) || return 1

  if [ -z "$holder_pid" ]; then
    # Empty/corrupt lock file — reclaim
    rm -f "$LOCK_FILE"
    (set -o noclobber; echo "$$" > "$LOCK_FILE") 2>/dev/null
    return $?
  fi

  if ! kill -0 "$holder_pid" 2>/dev/null; then
    # Holder is dead — reclaim
    echo "[test-lock] Reclaiming stale lock from dead PID $holder_pid" >&2
    rm -f "$LOCK_FILE"
    (set -o noclobber; echo "$$" > "$LOCK_FILE") 2>/dev/null
    return $?
  fi

  return 1  # Lock held by a live process
}

elapsed=0
while ! try_acquire; do
  if [ "$WAIT_TIMEOUT" -eq 0 ]; then
    echo "[test-lock] Another test run is active (PID $(cat "$LOCK_FILE" 2>/dev/null || echo '?')). Exiting." >&2
    exit 1
  fi
  if [ "$elapsed" -ge "$WAIT_TIMEOUT" ]; then
    echo "[test-lock] Timed out waiting for lock after ${elapsed}s (holder: PID $(cat "$LOCK_FILE" 2>/dev/null || echo '?'))." >&2
    exit 1
  fi
  if [ "$((elapsed % 30))" -eq 0 ] && [ "$elapsed" -gt 0 ]; then
    echo "[test-lock] Waiting for lock... ${elapsed}s elapsed (holder: PID $(cat "$LOCK_FILE" 2>/dev/null || echo '?'))" >&2
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

# We hold the lock — clean up on any exit
trap cleanup_lock EXIT

npx vitest "$@"
