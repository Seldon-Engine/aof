#!/usr/bin/env node

/**
 * Fires from .release-it.json `after:release` hook. release-it has just
 * created a GitHub release with the auto-generated `@release-it/conventional-changelog`
 * dump — which CLAUDE.md says we MUST NOT ship. This script:
 *
 *   1. Writes a starter notes file at /tmp/v<version>-notes.md with the
 *      required CLAUDE.md structure (TL;DR / Bug Fixed / Upgrade Notes /
 *      Internals / Full Changelog) plus the auto-generated content as
 *      raw material to draw from.
 *   2. Prints a loud banner with the exact `gh release edit` command.
 *
 * Non-blocking on purpose: the operator (or Claude) reads the banner and
 * runs the edit. If we ever need a hard gate, swap this for an exec of
 * $EDITOR on the starter file.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
const version = `v${pkg.version}`;

let prevTag = "";
try {
  const tags = execSync("git tag --sort=-v:refname", { encoding: "utf-8" })
    .trim()
    .split("\n")
    .filter((t) => t.startsWith("v") && t !== version);
  prevTag = tags[0] ?? "";
} catch {
  // no prior tags — first release
}

let rawMaterial = "";
try {
  rawMaterial = execSync(
    `node ${resolve(__dirname, "generate-release-notes.mjs")} ${version}`,
    { encoding: "utf-8" },
  ).trim();
} catch (err) {
  rawMaterial = `(generate-release-notes.mjs failed: ${err.message})`;
}

const compareUrl = prevTag
  ? `https://github.com/d0labs/aof/compare/${prevTag}...${version}`
  : `https://github.com/d0labs/aof/releases/tag/${version}`;

const starter = `# AOF ${version}

## TL;DR
<one or two sentences: what changed, what user does to upgrade. Required.>

## Bug Fixed
<For patches: user-visible behavior changes, not commit titles. Tables for enumerable things (routes, flags, config keys). "Who is affected" paragraph for each user-visible bugfix. Rename to "What's New" for minor+ features.>

## Upgrade Notes
<Required actions: migrations, deprecations, config changes, compat breaks. Cite migration numbers and idempotence. Remove this section if none apply.>

## Internals
<Brief — for developers working on AOF itself. Only include for minor+. Remove for patches.>

## Full Changelog
**${prevTag ? `${prevTag}...${version}` : version}:** ${compareUrl}

<!--
================================================================================
RAW MATERIAL — auto-generated from generate-release-notes.mjs.
DELETE THIS BLOCK BEFORE PUBLISHING. It is here as input, not output.
Hard rules (CLAUDE.md → Release):
  - No GSD phase internals (43-08, D-01, WR-01) in user copy
  - No bare commit-title dumps — translate to user behavior
  - Cite concrete commands and paths users will run
  - "Who is affected" paragraph for user-visible bugfixes
================================================================================

${rawMaterial}
-->
`;

const starterPath = join(tmpdir(), `${version}-notes.md`);
writeFileSync(starterPath, starter, "utf-8");

const ghCmd = `gh release edit ${version} --notes-file ${starterPath}`;
const bar = "=".repeat(72);

process.stdout.write(`
${bar}
  RELEASE NOTES REMINDER — ${version} shipped with the auto-generated dump.
  Per CLAUDE.md → Release, hand-crafted notes are MANDATORY.
${bar}

  Starter file written to:
    ${starterPath}

  Required structure: TL;DR / Bug Fixed (or What's New) / Upgrade Notes /
  Internals (minor+) / Full Changelog. Raw material from generate-release-notes
  is appended as an HTML comment — delete it before publishing.

  When ready, overwrite the GitHub release notes:
    ${ghCmd}

  Verify: gh release view ${version}
${bar}
`);
