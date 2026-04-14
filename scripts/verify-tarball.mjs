#!/usr/bin/env node

/**
 * Tarball verification script — validates a built tarball before release.
 *
 * Designed to run in CI between build and upload steps.
 * Complements scripts/build-tarball.mjs.
 *
 * Checks:
 *   1. Size under threshold
 *   2. Extraction succeeds
 *   3. Required files present
 *   4. npm ci --production completes
 *   5. CLI boots (--version)
 *   6. Version matches package.json
 *
 * Usage: node scripts/verify-tarball.mjs <tarball-path>
 * Exit code: 0 on all-pass, 1 on any failure.
 */

import { execSync } from "node:child_process";
import {
  statSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// --- Usage check ---

const tarball = process.argv[2];
if (!tarball) {
  console.log("Usage: node scripts/verify-tarball.mjs <tarball-path>");
  process.exit(1);
}

if (!existsSync(tarball)) {
  console.log(`FAIL: Tarball not found: ${tarball}`);
  process.exit(1);
}

// --- Constants ---

const MAX_SIZE_MB = 15;

let extractDir;

function cleanup() {
  if (extractDir) {
    try {
      rmSync(extractDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}

try {
  // --- Step 1: Size check ---

  const stats = statSync(tarball);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

  if (stats.size > MAX_SIZE_MB * 1024 * 1024) {
    console.log(
      `FAIL: Tarball size ${sizeMB}MB exceeds ${MAX_SIZE_MB}MB threshold`,
    );
    process.exit(1);
  }
  console.log(`PASS: Size ${sizeMB}MB (max ${MAX_SIZE_MB}MB)`);

  // --- Step 2: Extract ---

  extractDir = mkdtempSync(join(tmpdir(), "aof-verify-"));

  try {
    execSync(`tar -xzf ${tarball} -C ${extractDir}`, { stdio: "pipe" });
  } catch {
    console.log("FAIL: Extraction failed");
    cleanup();
    process.exit(1);
  }
  console.log("PASS: Extraction");

  // --- Step 3: Required files ---

  const requiredFiles = [
    "package.json",
    "dist/cli/index.js",
    "openclaw.plugin.json",
    "dist/openclaw.plugin.json",
  ];

  for (const file of requiredFiles) {
    if (!existsSync(join(extractDir, file))) {
      console.log(`FAIL: Missing required file: ${file}`);
      cleanup();
      process.exit(1);
    }
  }
  console.log("PASS: Required files present");

  // --- Step 4: npm ci --production ---

  try {
    execSync("npm ci --omit=dev --ignore-scripts", {
      cwd: extractDir,
      stdio: "pipe",
    });
  } catch {
    console.log("FAIL: npm ci --production failed");
    cleanup();
    process.exit(1);
  }
  console.log("PASS: npm ci --production");

  // --- Step 5: CLI boot ---

  let cliVersion;
  try {
    cliVersion = execSync("node dist/cli/index.js --version", {
      cwd: extractDir,
      encoding: "utf-8",
    }).trim();
  } catch {
    console.log("FAIL: CLI failed to boot");
    cleanup();
    process.exit(1);
  }
  console.log("PASS: CLI boots");

  // --- Step 6: Version match ---

  const pkgRaw = readFileSync(join(extractDir, "package.json"), "utf-8");
  const pkg = JSON.parse(pkgRaw);
  const pkgVersion = pkg.version;

  if (cliVersion !== pkgVersion) {
    console.log(
      `FAIL: Version mismatch: package.json=${pkgVersion}, CLI=${cliVersion}`,
    );
    cleanup();
    process.exit(1);
  }
  console.log(`PASS: Version match (${pkgVersion})`);

  // --- Step 7: openclaw.plugin.json version match ---

  const pluginRaw = readFileSync(join(extractDir, "openclaw.plugin.json"), "utf-8");
  const pluginJson = JSON.parse(pluginRaw);

  if (pluginJson.version !== pkgVersion) {
    console.log(
      `FAIL: openclaw.plugin.json version mismatch: plugin=${pluginJson.version}, package.json=${pkgVersion}`,
    );
    cleanup();
    process.exit(1);
  }
  console.log(`PASS: openclaw.plugin.json version match (${pluginJson.version})`);

  // --- Step 7b: dist-local openclaw.plugin.json ---
  // OpenClaw's plugin loader resolves manifests relative to the symlink target
  // (~/.openclaw/extensions/aof → $INSTALL_DIR/dist/). Without a dist-local
  // manifest, fresh installs fail with "plugins.entries.aof: plugin not found".

  const distPluginRaw = readFileSync(
    join(extractDir, "dist", "openclaw.plugin.json"),
    "utf-8",
  );
  const distPluginJson = JSON.parse(distPluginRaw);

  if (distPluginJson.main !== "plugin.js") {
    console.log(
      `FAIL: dist/openclaw.plugin.json main="${distPluginJson.main}", expected "plugin.js"`,
    );
    cleanup();
    process.exit(1);
  }
  if (distPluginJson.version !== pkgVersion) {
    console.log(
      `FAIL: dist/openclaw.plugin.json version mismatch: plugin=${distPluginJson.version}, package.json=${pkgVersion}`,
    );
    cleanup();
    process.exit(1);
  }
  console.log(`PASS: dist/openclaw.plugin.json main=plugin.js version=${pkgVersion}`);

  // --- Step 8: SKILL.md present ---

  if (!existsSync(join(extractDir, "skills", "aof", "SKILL.md"))) {
    console.log("FAIL: Missing skills/aof/SKILL.md");
    cleanup();
    process.exit(1);
  }
  console.log("PASS: skills/aof/SKILL.md present");

  // --- Cleanup & Summary ---

  cleanup();
  console.log("\nAll checks passed.");
  process.exit(0);
} catch (error) {
  console.log(`FAIL: Unexpected error: ${error.message}`);
  cleanup();
  process.exit(1);
}
