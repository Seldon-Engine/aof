#!/usr/bin/env bash
# test-lock.sh — Serialize vitest runs via flock + orphan-kill safety net.
#
# Kernel-level advisory lock serializes concurrent runs: auto-releases on
# process exit/crash/kill — no stale locks, no cleanup, no race conditions.
#
# Safety net (added after orphan incident 2026-04-12): vitest fork workers
# stuck in synchronous CPU hangs can survive their parent's death and peg
# CPU indefinitely. This script puts vitest in its own process group and
# runs two watchdogs that SIGKILL the whole group if (a) this script's
# parent dies or (b) a wall-clock timeout elapses.
#
# Transitional until AOF-adf (dispatch throttling) ships at the scheduler
# level. Once concurrent agents use git worktrees, each gets its own lock
# via AOF_TEST_LOCK_DIR.
#
# Config:
#   AOF_TEST_LOCK_DIR      — lock directory (default: /tmp)
#   AOF_TEST_LOCK_TIMEOUT  — max wait seconds for lock (default: 300; 0 = fail immediately)
#   AOF_TEST_WALL_TIMEOUT  — max total vitest runtime seconds (default: 900)
#
# Usage:
#   ./scripts/test-lock.sh [vitest args...]
#   npm test

set -euo pipefail
set -m  # job control: backgrounded pipelines get their own process group

LOCK_FILE="${AOF_TEST_LOCK_DIR:-/tmp}/aof-vitest.lock"
TIMEOUT="${AOF_TEST_LOCK_TIMEOUT:-300}"
WALL_TIMEOUT="${AOF_TEST_WALL_TIMEOUT:-900}"

SCRIPT_PID=$$
CHILD_PID=""
WATCHDOG_PID=""

kill_pgroup() {
  local pid="$1" sig="${2:-TERM}"
  [[ -z "$pid" ]] && return 0
  local pgid
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
  if [[ -n "$pgid" ]]; then
    kill "-$sig" "-$pgid" 2>/dev/null || true
  fi
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM HUP
  [[ -n "$WATCHDOG_PID" ]] && kill "$WATCHDOG_PID" 2>/dev/null || true
  if [[ -n "$CHILD_PID" ]]; then
    kill_pgroup "$CHILD_PID" TERM
    for _ in 1 2 3; do
      kill -0 "$CHILD_PID" 2>/dev/null || break
      sleep 1
    done
    kill_pgroup "$CHILD_PID" KILL
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

flock --timeout "$TIMEOUT" "$LOCK_FILE" npx vitest "$@" &
CHILD_PID=$!

(
  START=$SECONDS
  while true; do
    sleep 5
    if ! kill -0 "$SCRIPT_PID" 2>/dev/null; then
      echo "[test-lock.sh] parent script gone; killing orphaned vitest process group" >&2
      kill_pgroup "$CHILD_PID" KILL
      exit 0
    fi
    if (( SECONDS - START > WALL_TIMEOUT )); then
      echo "[test-lock.sh] wall-clock timeout ${WALL_TIMEOUT}s exceeded; killing vitest process group" >&2
      kill_pgroup "$CHILD_PID" KILL
      exit 0
    fi
  done
) &
WATCHDOG_PID=$!

set +e
wait "$CHILD_PID"
EXIT_CODE=$?
set -e

exit "$EXIT_CODE"
