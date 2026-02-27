#!/usr/bin/env node

/**
 * Pre-commit hook runner — four documentation checks.
 *
 * 1. Stale generated docs   — CLI reference matches generator output
 * 2. Undocumented commands   — every Commander command has a doc heading
 * 3. Broken internal links   — all relative markdown links resolve to files
 * 4. README freshness        — repo URL and Node version match package.json
 *
 * Exit 0 if all pass, exit 1 if any fail.
 * Wired via simple-git-hooks pre-commit in package.json.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// ── Shared helpers ────────────────────────────────────────────────────

/** Build the full command name by walking up the parent chain. */
function fullName(cmd) {
  const parts = [];
  let current = cmd;
  while (current) {
    const name = current.name();
    if (name) parts.unshift(name);
    current = current.parent;
  }
  return parts.join(" ");
}

/** Escape pipe characters inside markdown table cells. */
function escapeCell(text) {
  return (text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Slugify a command name for use as a markdown anchor. */
function toAnchor(name) {
  return name.replace(/[^a-z0-9 -]/gi, "").replace(/\s+/g, "-").toLowerCase();
}

/** Recursively collect .md files in a directory. */
function collectMdFiles(dir, results) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMdFiles(full, results);
    } else if (entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
}

/**
 * Generate the CLI reference markdown from the Commander tree.
 * Identical logic to generate-cli-docs.mjs so comparison is exact.
 */
function generateCliReference(program) {
  const sections = [];

  function walkCommand(cmd, depth = 0) {
    const name = fullName(cmd);
    if (cmd.name() === "help") return;

    const hLevel = Math.min(depth + 3, 6);
    const hPrefix = "#".repeat(hLevel);
    const anchor = toAnchor(name);

    const lines = [];
    lines.push(`${hPrefix} \`${name}\``);
    lines.push("");

    const desc = cmd.description();
    if (desc) {
      lines.push(desc);
      lines.push("");
    }

    const args = cmd.registeredArguments ?? [];
    if (args.length > 0) {
      lines.push("**Arguments:**");
      lines.push("");
      lines.push("| Argument | Required | Description |");
      lines.push("|----------|----------|-------------|");
      for (const arg of args) {
        const argName = typeof arg.name === "function" ? arg.name() : arg.name;
        const required = arg.required ? "Yes" : "No";
        const argDesc = escapeCell(arg.description || "");
        lines.push(`| \`${argName}\` | ${required} | ${argDesc} |`);
      }
      lines.push("");
    }

    const opts = (cmd.options ?? []).filter((o) => !o.hidden);
    if (opts.length > 0) {
      lines.push("**Options:**");
      lines.push("");
      lines.push("| Flag | Description | Default |");
      lines.push("|------|-------------|---------|");
      for (const opt of opts) {
        const flags = escapeCell(opt.flags);
        const optDesc = escapeCell(opt.description || "");
        const def =
          opt.defaultValue !== undefined
            ? `\`${JSON.stringify(opt.defaultValue)}\``
            : "";
        lines.push(`| \`${flags}\` | ${optDesc} | ${def} |`);
      }
      lines.push("");
    }

    sections.push({ heading: name, anchor, body: lines.join("\n"), depth });
    for (const sub of cmd.commands) {
      walkCommand(sub, depth + 1);
    }
  }

  for (const cmd of program.commands) {
    walkCommand(cmd, 0);
  }

  const header = `<!-- AUTO-GENERATED — do not edit manually. Run: npm run docs:generate -->\n\n# CLI Reference\n\nComplete command reference for the \`aof\` CLI, auto-generated from the Commander command tree.\n\n`;
  const tocLines = ["## Table of Contents", ""];
  for (const sec of sections) {
    const indent = "  ".repeat(sec.depth);
    tocLines.push(`${indent}- [\`${sec.heading}\`](#${sec.anchor})`);
  }
  tocLines.push("");
  tocLines.push("---");
  tocLines.push("");

  const bodySections = sections.map((s) => s.body).join("\n---\n\n");
  return header + tocLines.join("\n") + bodySections + "\n";
}

// ── Check 1: Stale generated docs ────────────────────────────────────

async function checkStaleDocs() {
  const issues = [];
  const programPath = resolve(projectRoot, "dist/cli/program.js");

  if (!existsSync(programPath)) {
    issues.push("Build required. Run: npm run build");
    return issues;
  }

  const { program } = await import(programPath);
  const generated = generateCliReference(program);

  const committedPath = resolve(projectRoot, "docs/guide/cli-reference.md");
  if (!existsSync(committedPath)) {
    issues.push("docs/guide/cli-reference.md does not exist. Run: npm run docs:generate");
    return issues;
  }

  const committed = readFileSync(committedPath, "utf-8");
  if (generated !== committed) {
    issues.push("Generated CLI docs are stale. Run: npm run docs:generate");
  }

  return issues;
}

// ── Check 2: New commands without docs ────────────────────────────────

async function checkUndocumentedCommands() {
  const issues = [];
  const programPath = resolve(projectRoot, "dist/cli/program.js");

  if (!existsSync(programPath)) {
    return issues; // Already caught in check 1
  }

  const { program } = await import(programPath);

  // Collect all command names from the tree
  const commandNames = new Set();

  function walkTree(cmd) {
    if (cmd.name() === "help") return;
    commandNames.add(fullName(cmd));
    for (const sub of cmd.commands) {
      walkTree(sub);
    }
  }

  for (const cmd of program.commands) {
    walkTree(cmd);
  }

  // Read CLI reference doc and extract headings
  const docPath = resolve(projectRoot, "docs/guide/cli-reference.md");
  if (!existsSync(docPath)) {
    return issues; // Already caught in check 1
  }

  const doc = readFileSync(docPath, "utf-8");
  const headingPattern = /^#{2,6}\s+`([^`]+)`/gm;
  const documented = new Set();
  let match;
  while ((match = headingPattern.exec(doc)) !== null) {
    documented.add(match[1]);
  }

  // Find undocumented commands
  const undocumented = [];
  for (const name of commandNames) {
    if (!documented.has(name)) {
      undocumented.push(name);
    }
  }

  if (undocumented.length > 0) {
    issues.push(`Undocumented commands: ${undocumented.join(", ")}`);
  }

  return issues;
}

// ── Check 3: Broken internal links ────────────────────────────────────

async function checkBrokenLinks() {
  const issues = [];

  // Gather all markdown files in docs/ and root README/CONTRIBUTING
  const mdFiles = [];

  const docsDir = resolve(projectRoot, "docs");
  if (existsSync(docsDir)) {
    collectMdFiles(docsDir, mdFiles);
  }

  for (const name of ["README.md", "CONTRIBUTING.md"]) {
    const p = resolve(projectRoot, name);
    if (existsSync(p)) mdFiles.push(p);
  }

  const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;

  for (const filePath of mdFiles) {
    const content = readFileSync(filePath, "utf-8");
    let m;
    while ((m = linkPattern.exec(content)) !== null) {
      const target = m[2];

      // Skip external links, anchors, mailto
      if (/^https?:\/\//i.test(target)) continue;
      if (/^mailto:/i.test(target)) continue;
      if (target.startsWith("#")) continue;

      // Strip fragment
      const targetWithoutFragment = target.split("#")[0];
      if (!targetWithoutFragment) continue;

      // Resolve relative to file's directory
      const resolved = resolve(dirname(filePath), targetWithoutFragment);

      if (!existsSync(resolved)) {
        const rel = relative(projectRoot, filePath);
        issues.push(`${rel}: broken link -> ${target}`);
      }
    }
  }

  return issues;
}

// ── Check 4: README freshness ─────────────────────────────────────────

async function checkReadmeFreshness() {
  const issues = [];

  const pkgPath = resolve(projectRoot, "package.json");
  const readmePath = resolve(projectRoot, "README.md");

  if (!existsSync(readmePath)) {
    issues.push("README.md not found");
    return issues;
  }

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const readme = readFileSync(readmePath, "utf-8");

  // Check repository URL
  const repoUrl = pkg.repository?.url ?? "";
  const repoMatch = repoUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  if (repoMatch) {
    const expectedRepo = repoMatch[1].replace(/\.git$/, "").toLowerCase();
    const readmeRepoPattern = /github\.com[:/]([^/\s]+\/[^/\s.)]+)/g;
    let rm;
    while ((rm = readmeRepoPattern.exec(readme)) !== null) {
      const readmeRepo = rm[1].replace(/\.git$/, "").toLowerCase();
      if (readmeRepo !== expectedRepo) {
        issues.push(
          `README references repo "${rm[1]}" but package.json says "${repoMatch[1]}"`
        );
        break;
      }
    }
  }

  // Check Node.js version prerequisite
  const enginesNode = pkg.engines?.node ?? "";
  const engineVersionMatch = enginesNode.match(/(\d+)/);
  if (engineVersionMatch) {
    const requiredMajor = parseInt(engineVersionMatch[1], 10);
    const nodeVersionPattern = /Node\.js\s+(\d+)\+/gi;
    let nv;
    while ((nv = nodeVersionPattern.exec(readme)) !== null) {
      const readmeMajor = parseInt(nv[1], 10);
      if (readmeMajor !== requiredMajor) {
        issues.push(
          `README says Node.js ${nv[1]}+ but package.json engines.node requires >=${requiredMajor}`
        );
        break;
      }
    }
  }

  return issues;
}

// ── Run all checks ────────────────────────────────────────────────────

const checks = [
  { name: "Stale generated docs", fn: checkStaleDocs },
  { name: "New commands without docs", fn: checkUndocumentedCommands },
  { name: "Broken internal links", fn: checkBrokenLinks },
  { name: "README freshness", fn: checkReadmeFreshness },
];

let failed = false;
for (const check of checks) {
  try {
    const issues = await check.fn();
    if (issues.length > 0) {
      console.error(`FAIL: ${check.name}`);
      for (const issue of issues) console.error(`  - ${issue}`);
      failed = true;
    } else {
      console.log(`OK: ${check.name}`);
    }
  } catch (err) {
    console.error(`ERROR: ${check.name}: ${err.message}`);
    failed = true;
  }
}
if (failed) process.exit(1);
