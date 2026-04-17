/**
 * Migration 007: Daemon is now mandatory infrastructure (Phase 43, D-14).
 *
 * Phase 43 makes the aof-daemon the single scheduler authority; the plugin
 * becomes a thin bridge that IPCs to the daemon over a Unix socket. Existing
 * users upgrading from Phase 42 (where plugin-mode installs deliberately
 * skipped the daemon per Phase 42 D-03) need the daemon installed so the
 * plugin has something to connect to.
 *
 * Behavior:
 *   - If the launchd plist (macOS) or systemd user unit (Linux) is already
 *     installed, this migration is a no-op. A pre-existing daemon — left over
 *     from Phase 42 `--force-daemon`, a dual-mode install, or a prior run of
 *     this migration — is kept as-is; `installService` would be idempotent
 *     anyway, but skipping keeps the migration log clean and avoids noisy
 *     bootstrap/kickstart calls when nothing needs doing.
 *   - Otherwise, install the service via the existing
 *     `src/daemon/service-file.ts::installService` helper. That helper writes
 *     the plist/unit file AND loads/starts the service through launchctl/
 *     systemctl.
 *
 * Rollback: no `down()`. Uninstalling the daemon would strand the plugin with
 * no IPC authority to talk to (the in-process AOFService path is removed in
 * Phase 43 D-02). The canonical rollback path is "install an older AOF
 * version" — consistent with migrations 005/006 which also have no down.
 *
 * Idempotency: verified by RED test src/packaging/migrations/__tests__/
 * 007-daemon-required.test.ts (Wave 0, 43-01). Rerunning after a successful
 * install short-circuits on the plist/unit existence check; `installService`
 * is called exactly once.
 *
 * Source pattern: src/packaging/migrations/004-scaffold-repair.ts (canonical
 * idempotent skeleton) + src/packaging/migrations/006-data-code-separation.ts
 * (existsSync breadcrumb pattern).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Migration, MigrationContext } from "../migrations.js";
import { installService } from "../../daemon/service-file.js";

function say(msg: string): void {
  console.log(`  \x1b[32m\u2713\x1b[0m ${msg}`);
}

export const migration007: Migration = {
  id: "007-daemon-required",
  version: "1.15.0",
  description: "Phase 43: install aof-daemon service as plugin IPC authority",

  up: async (ctx: MigrationContext): Promise<void> => {
    // Paths must match what `getServiceFilePath` in src/daemon/service-file.ts
    // writes. Hardcoding here rather than importing keeps the migration
    // dependency surface small (no launchctl probing); if those paths ever
    // change in service-file.ts, this migration's existence check drifts,
    // which the integration tests at tests/integration/ would catch.
    const plist = join(homedir(), "Library", "LaunchAgents", "ai.openclaw.aof.plist");
    const unit = join(homedir(), ".config", "systemd", "user", "ai.openclaw.aof.service");

    if (existsSync(plist) || existsSync(unit)) {
      say("007-daemon-required skipped (daemon service already installed)");
      return;
    }

    // ctx.aofRoot IS the user-data dir (per migration 006 / setup.ts, the
    // `aof setup` flow passes `--data-dir` as `aofRoot`). `installService`
    // expects `dataDir` in the same shape — no double-nesting into /data.
    await installService({ dataDir: ctx.aofRoot });
    say("007-daemon-required installed aof-daemon service");
  },
};
