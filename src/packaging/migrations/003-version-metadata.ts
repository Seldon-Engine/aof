/**
 * Migration 003: Write version metadata to .aof/channel.json.
 *
 * Handles both fresh installs and upgrades:
 * - Fresh install: writes { version, channel, installedAt }
 * - Upgrade: writes { version, previousVersion, channel, upgradedAt }
 * - Idempotent: skips if existing channel.json already has the target version
 */

import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { Migration, MigrationContext } from "../migrations.js";

interface ChannelMetadata {
  version: string;
  previousVersion?: string;
  channel: string;
  installedAt?: string;
  upgradedAt?: string;
}

export const migration003: Migration = {
  id: "003-version-metadata",
  version: "1.3.0",
  description: "Write version metadata to .aof/channel.json",

  up: async (ctx: MigrationContext): Promise<void> => {
    const channelPath = join(ctx.aofRoot, ".aof", "channel.json");
    const now = new Date().toISOString();

    // Try to read existing channel.json
    let existing: ChannelMetadata | undefined;
    try {
      const raw = await readFile(channelPath, "utf-8");
      existing = JSON.parse(raw);
    } catch {
      // File doesn't exist or invalid JSON — treat as fresh install
    }

    // Idempotent: skip if already at target version
    if (existing && existing.version === ctx.version) {
      console.log(
        `  \x1b[32m\u2713\x1b[0m 003-version-metadata skipped (already at ${ctx.version})`,
      );
      return;
    }

    // Ensure .aof directory exists
    await mkdir(join(ctx.aofRoot, ".aof"), { recursive: true });

    let metadata: ChannelMetadata;

    if (existing) {
      // Upgrade: carry forward previous version
      metadata = {
        version: ctx.version,
        previousVersion: existing.version,
        channel: "stable",
        upgradedAt: now,
      };
    } else {
      // Fresh install
      metadata = {
        version: ctx.version,
        channel: "stable",
        installedAt: now,
      };
    }

    await writeFileAtomic(
      channelPath,
      JSON.stringify(metadata, null, 2) + "\n",
    );

    console.log(
      `  \x1b[32m\u2713\x1b[0m 003-version-metadata applied (${existing ? "upgrade" : "fresh install"})`,
    );
  },
};
