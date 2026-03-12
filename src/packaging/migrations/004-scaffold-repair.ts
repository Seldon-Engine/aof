/**
 * Migration 004: Scaffold repair.
 *
 * Idempotent — ensures all required directories and org chart exist.
 * Runs during `setup --auto --upgrade` to repair broken installs.
 */

import type { Migration, MigrationContext } from "../migrations.js";
import { ensureScaffold } from "../wizard.js";

export const migration004: Migration = {
  id: "004-scaffold-repair",
  version: "1.9.0",
  description: "Ensure scaffold directories and org chart exist",

  up: async (ctx: MigrationContext): Promise<void> => {
    const repaired = await ensureScaffold(ctx.aofRoot);

    if (repaired.length === 0) {
      console.log(
        `  \x1b[32m\u2713\x1b[0m 004-scaffold-repair skipped (scaffold intact)`,
      );
    } else {
      console.log(
        `  \x1b[32m\u2713\x1b[0m 004-scaffold-repair applied (repaired: ${repaired.join(", ")})`,
      );
    }
  },
};
