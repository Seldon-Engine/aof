#!/usr/bin/env node

/**
 * Stamp the version from package.json into openclaw.plugin.json.
 * Run as part of the build step and release hooks.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
const pluginPath = resolve(root, "openclaw.plugin.json");
const plugin = JSON.parse(readFileSync(pluginPath, "utf-8"));

if (plugin.version !== pkg.version) {
  plugin.version = pkg.version;
  writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");
  console.log(`Stamped openclaw.plugin.json version: ${pkg.version}`);
} else {
  console.log(`openclaw.plugin.json already at ${pkg.version}`);
}
