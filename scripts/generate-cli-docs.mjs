#!/usr/bin/env node

/**
 * CLI documentation generator.
 *
 * Imports the Commander program object from the built dist/ and walks the
 * command tree to produce a complete markdown CLI reference document.
 *
 * Usage: npm run docs:generate   (requires `npm run build` first)
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const programPath = resolve(projectRoot, "dist/cli/program.js");

// ── Pre-flight check ──────────────────────────────────────────────────
if (!existsSync(programPath)) {
  console.error("Error: dist/cli/program.js not found.");
  console.error("Run `npm run build` first.");
  process.exit(1);
}

const { program } = await import(programPath);

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Build the full command name by walking up the parent chain.
 * @param {import("commander").Command} cmd
 * @returns {string}
 */
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

/**
 * Escape pipe characters inside markdown table cells.
 * @param {string} text
 * @returns {string}
 */
function escapeCell(text) {
  return (text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * Slugify a command name for use as a markdown anchor.
 * @param {string} name
 * @returns {string}
 */
function toAnchor(name) {
  return name.replace(/[^a-z0-9 -]/gi, "").replace(/\s+/g, "-").toLowerCase();
}

// ── Walk the command tree ─────────────────────────────────────────────

/** @typedef {{ heading: string; anchor: string; body: string; depth: number }} Section */

/** @type {Section[]} */
const sections = [];

/**
 * Recursively process a Command and its subcommands.
 * @param {import("commander").Command} cmd
 * @param {number} depth
 */
function walkCommand(cmd, depth = 0) {
  const name = fullName(cmd);
  const desc = cmd.description();

  // Skip the implicit 'help' command added by Commander
  if (cmd.name() === "help") return;

  const hLevel = Math.min(depth + 3, 6); // h3 for top-level, h4 for sub, etc.
  const hPrefix = "#".repeat(hLevel);
  const anchor = toAnchor(name);

  const lines = [];
  lines.push(`${hPrefix} \`${name}\``);
  lines.push("");

  if (desc) {
    lines.push(desc);
    lines.push("");
  }

  // Arguments table
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

  // Options table (filter hidden options)
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

  sections.push({
    heading: name,
    anchor,
    body: lines.join("\n"),
    depth,
  });

  // Recurse into subcommands
  for (const sub of cmd.commands) {
    walkCommand(sub, depth + 1);
  }
}

// Walk each top-level command (skip the root program itself for the TOC, but
// process its subcommands).
for (const cmd of program.commands) {
  walkCommand(cmd, 0);
}

// ── Assemble document ─────────────────────────────────────────────────

const header = `<!-- AUTO-GENERATED — do not edit manually. Run: npm run docs:generate -->

# CLI Reference

Complete command reference for the \`aof\` CLI, auto-generated from the Commander command tree.

`;

// Table of contents — flat list of all commands
const tocLines = ["## Table of Contents", ""];
for (const sec of sections) {
  const indent = "  ".repeat(sec.depth);
  tocLines.push(`${indent}- [\`${sec.heading}\`](#${sec.anchor})`);
}
tocLines.push("");
tocLines.push("---");
tocLines.push("");

// Command sections
const bodySections = sections.map((s) => s.body).join("\n---\n\n");

const document = header + tocLines.join("\n") + bodySections + "\n";

// ── Write output ──────────────────────────────────────────────────────

const outDir = resolve(projectRoot, "docs/guide");
mkdirSync(outDir, { recursive: true });

const outPath = resolve(outDir, "cli-reference.md");
writeFileSync(outPath, document, "utf-8");

console.log(`Generated: ${outPath}`);
