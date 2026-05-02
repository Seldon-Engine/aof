#!/usr/bin/env node
/**
 * One-time cleanup: mark stale "active" subscriptions as "cancelled" so
 * the daemon's recovery-replay pass stops resurrecting them on every
 * restart.
 *
 * A subscription is considered stale when its target session can never
 * be reached again:
 *   - Ephemeral session keys (`agent:X:cron:UUID`, `agent:X:subagent:UUID`)
 *     point at one-shot OpenClaw sessions that have already terminated;
 *     no outbound platform exists for them and the wake-redirect to
 *     `:main` only helps the wake-injection half, not the chat-send half.
 *   - `agent-callback` subscriptions with `subscriberId: "unknown"` are
 *     broken metadata from older AOF code paths.
 *
 * The subscription file is updated in place; the original is backed up
 * to a sibling `.bak-pre-expunge-<timestamp>.json` once per file.
 *
 * Usage:
 *   node scripts/expunge-stale-subscriptions.mjs           # dry-run (default)
 *   node scripts/expunge-stale-subscriptions.mjs --apply   # write changes
 *   node scripts/expunge-stale-subscriptions.mjs --data-dir /custom/path
 */

import { readFile, writeFile, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { glob } from "node:fs/promises";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
let DATA_DIR = `${homedir()}/.aof/data`;
const dataDirIdx = process.argv.indexOf("--data-dir");
if (dataDirIdx !== -1 && process.argv[dataDirIdx + 1]) {
  DATA_DIR = process.argv[dataDirIdx + 1];
}

const TERMINAL_TASK_STATUSES = new Set(["done", "cancelled", "deadletter"]);
const EPHEMERAL_SEGMENTS = new Set(["cron", "subagent"]);
const STAMP = new Date().toISOString();
const REASON = `expunged ${STAMP.slice(0, 10)}: ephemeral session or unreachable target — no recovery path`;
const TIMESTAMP_TAG = STAMP.replace(/[:.]/g, "-");

function isEphemeralSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return false;
  const parts = sessionKey.split(":");
  if (parts.length < 3 || parts[0] !== "agent") return false;
  return EPHEMERAL_SEGMENTS.has(parts[2]);
}

function shouldExpunge(sub, taskStatus) {
  if (sub.status !== "active") return null;
  if (!TERMINAL_TASK_STATUSES.has(taskStatus)) return null;

  const delivery = sub.delivery ?? {};
  const sessionKey = delivery.sessionKey;
  if (sessionKey && isEphemeralSessionKey(sessionKey)) {
    return `ephemeral session (${sessionKey.split(":").slice(0, 3).join(":")})`;
  }

  const kind = delivery.kind ?? "agent-callback";
  if (kind === "agent-callback" && (sub.subscriberId === "unknown" || !sub.subscriberId)) {
    return `agent-callback with unknown subscriberId`;
  }

  return null;
}

function parseTaskPath(path) {
  const parts = path.split("/");
  const idx = parts.indexOf("tasks");
  if (idx === -1) return null;
  const taskStatus = parts[idx + 1];
  const taskId = parts[idx + 2];
  const project = idx >= 2 && parts[idx - 2] === "Projects" ? parts[idx - 1] : "<root>";
  return { taskStatus, taskId, project };
}

async function* findSubscriptionFiles(root) {
  for await (const entry of glob(`${root}/**/subscriptions.json`)) {
    yield entry;
  }
}

async function main() {
  let filesScanned = 0;
  let filesWithGhosts = 0;
  let ghostsFound = 0;
  let backupsWritten = 0;

  console.log(`AOF subscription expunge tool ${APPLY ? "(APPLY MODE — writes changes)" : "(DRY RUN — no writes)"}`);
  console.log(`Data dir: ${DATA_DIR}\n`);

  for await (const path of findSubscriptionFiles(DATA_DIR)) {
    filesScanned++;
    const meta = parseTaskPath(path);
    if (!meta) continue;

    let raw;
    try {
      raw = await readFile(path, "utf-8");
    } catch (err) {
      console.error(`  ! read failed: ${path}: ${err.message}`);
      continue;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.error(`  ! parse failed: ${path}: ${err.message}`);
      continue;
    }

    const subs = data.subscriptions ?? [];
    let changedHere = 0;
    const changes = [];

    for (const sub of subs) {
      const reason = shouldExpunge(sub, meta.taskStatus);
      if (!reason) continue;
      ghostsFound++;
      changedHere++;
      changes.push({ id: sub.id, reason });
      if (APPLY) {
        sub.status = "cancelled";
        sub.failureReason = REASON;
        sub.updatedAt = STAMP;
      }
    }

    if (changedHere === 0) continue;
    filesWithGhosts++;

    console.log(`${meta.project}/${meta.taskStatus}/${meta.taskId} (${changedHere} ghost${changedHere > 1 ? "s" : ""})`);
    for (const c of changes) {
      console.log(`  - ${c.id}: ${c.reason}`);
    }

    if (APPLY) {
      const backupPath = path.replace(/\.json$/, `.bak-pre-expunge-${TIMESTAMP_TAG}.json`);
      try {
        await copyFile(path, backupPath);
        backupsWritten++;
      } catch (err) {
        console.error(`  ! backup failed: ${err.message} — skipping write`);
        continue;
      }
      try {
        await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
      } catch (err) {
        console.error(`  ! write failed: ${err.message}`);
      }
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Files scanned:      ${filesScanned}`);
  console.log(`  Files with ghosts:  ${filesWithGhosts}`);
  console.log(`  Ghost subscriptions: ${ghostsFound}`);
  if (APPLY) {
    console.log(`  Backups written:    ${backupsWritten}`);
    console.log(`\nDone. Restart the daemon to stop replaying these on next boot:`);
    console.log(`  launchctl kickstart -k "gui/$(id -u)/ai.openclaw.aof"`);
  } else {
    console.log(`\nThis was a DRY RUN. Re-run with --apply to write changes.`);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
