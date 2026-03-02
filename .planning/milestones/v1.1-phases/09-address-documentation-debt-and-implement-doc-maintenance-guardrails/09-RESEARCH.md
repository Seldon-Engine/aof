# Phase 9: Address Documentation Debt and Implement Doc Maintenance Guardrails - Research

**Researched:** 2026-02-26
**Domain:** Documentation architecture, CLI doc generation, pre-commit guardrails
**Confidence:** HIGH

## Summary

AOF already has 28 files in `docs/` and a comprehensive root `README.md`, but the structure is flat and contributor/internal-focused. The phase requires restructuring into `docs/guide/` (end-user) and `docs/dev/` (contributor), writing a getting-started guide, generating CLI reference from Commander.js command definitions, adding JSDoc to public API exports, and implementing four pre-commit hook checks via `simple-git-hooks`.

The CLI doc generator is straightforward: Commander.js 14.0.3 (already installed) exposes full introspection on commands, subcommands, options, and arguments via `.commands`, `.options`, `.registeredArguments`, `.name()`, and `.description()`. A custom script that imports the program, walks the command tree, and emits markdown is the right approach. TypeDoc is not useful here because the CLI reference comes from Commander registrations, not TypeScript type exports.

The pre-commit hook integrates with the existing `simple-git-hooks` setup (currently only `commit-msg` for commitlint). Adding a `pre-commit` key to the `simple-git-hooks` config in `package.json` is the standard approach. The hook script should be a single shell command that calls a Node.js script to run all four checks, exiting non-zero on any failure.

**Primary recommendation:** Build a custom `scripts/generate-cli-docs.mjs` that introspects the Commander program tree and emits `docs/guide/cli-reference.md`. Implement `scripts/check-docs.mjs` as the pre-commit hook runner with four discrete checks. Restructure existing docs into `docs/guide/` and `docs/dev/` subdirectories. Write the getting-started guide manually.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Three audiences: end users (installing/using AOF), contributors (understanding internals), and the maintainer
- Covers: AOF framework, companion scripts/skills, OpenClaw plugin wiring, AOF config
- Does NOT cover: agent workspace identity docs, peripheral tooling, internal code comments
- Pre-launch prep — no users yet, docs are getting ready for public release
- `docs/` directory at repo root with two sections: `docs/guide/` (end-user) and `docs/dev/` (contributor/architecture)
- Concise landing-page `README.md` at repo root — what AOF is, one-liner install, quick example, links into docs/
- CLI reference auto-generated from command definitions (not hand-written)
- Content priority order: (1) Getting started guide, (2) Configuration reference, (3) Auto-generated CLI reference, (4) Architecture overview, (5) JSDoc on public API exports
- Pre-commit hook that blocks commits on failure (bypass with `--no-verify`)
- Hook checks four things: stale generated docs, new commands without docs, broken internal links, README freshness
- `npm run docs:generate` script for CLI doc regeneration
- Tech debt items from v1.1 audit are separate — don't fix them, don't document them as known issues

### Claude's Discretion
- Exact doc generator implementation (could be custom script, typedoc, or similar)
- Internal organization of docs/guide/ and docs/dev/ subdirectories
- How to detect "new commands without docs" (AST parsing, grep, or convention)
- JSDoc coverage strategy for public API

### Deferred Ideas (OUT OF SCOPE)
- None — discussion stayed within phase scope
</user_constraints>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Commander.js | 14.0.3 | CLI framework (already installed) | Provides full command tree introspection for doc generation |
| simple-git-hooks | 2.13.1 | Git hook management (already installed) | Already manages commit-msg hook; adding pre-commit is trivial |
| Node.js built-in fs/path | N/A | File reading, link resolution | Zero-dependency link checking for internal markdown links |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| remark-cli + remark-validate-links | latest | Markdown internal link validation | ALTERNATIVE: if custom link checker proves too brittle |
| markdown-link-check | latest | External + internal link checking | NOT recommended: overkill for internal-only checks, adds HTTP overhead |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom CLI doc generator script | TypeDoc | TypeDoc generates from TS types, not Commander registrations — wrong tool for CLI reference |
| Custom link checker (Node script) | remark-validate-links | remark-validate-links is more robust but adds 3 deps (remark-cli, remark, remark-validate-links); custom script is ~80 lines and sufficient for internal links only |
| Custom link checker | markdown-link-check | markdown-link-check checks HTTP links too (slow, network-dependent); we only need local file/heading resolution |

**Installation:**
```bash
# No new packages needed — all tooling is custom scripts using existing deps
# If remark approach is chosen instead:
npm install --save-dev remark-cli remark-validate-links
```

## Architecture Patterns

### Recommended Documentation Structure
```
docs/
├── guide/                    # End-user documentation
│   ├── getting-started.md    # Zero-to-working walkthrough (PRIORITY 1)
│   ├── configuration.md      # org-chart.yaml, AOF config, OpenClaw plugin config (PRIORITY 2)
│   ├── cli-reference.md      # AUTO-GENERATED from Commander tree (PRIORITY 3)
│   ├── task-format.md        # Moved from docs/task-format.md
│   ├── workflow-gates.md     # Moved from docs/WORKFLOW-GATES.md
│   ├── protocols.md          # Moved from docs/PROTOCOLS-USER-GUIDE.md
│   ├── memory.md             # Moved from docs/MEMORY-MODULE.md
│   ├── notifications.md      # Moved from docs/notification-policy.md
│   ├── sla.md                # Moved from docs/SLA-GUIDE.md
│   └── deployment.md         # Moved from docs/DEPLOYMENT.md
├── dev/                      # Contributor/architecture documentation
│   ├── architecture.md       # System overview for contributors (PRIORITY 4)
│   ├── workflow-gates-design.md
│   ├── protocols-design.md
│   ├── protocols-bdd-specs.md
│   ├── daemon-watchdog-design.md
│   ├── sla-primitive-design.md
│   ├── adaptive-concurrency.md
│   ├── agentic-sdlc-design.md
│   ├── memory-module-plan.md
│   ├── memory-tier-pipeline.md
│   ├── security-remediation-design.md
│   ├── e2e-test-harness-design.md
│   ├── dev-workflow.md        # Moved from docs/contributing/DEV-WORKFLOW.md
│   ├── engineering-standards.md
│   ├── refactoring-protocol.md
│   ├── agents.md
│   └── dev-tooling.md
├── examples/                 # Kept as-is (workflow YAML examples)
│   ├── sales-pipeline.yaml
│   ├── simple-review.yaml
│   └── swe-sdlc.yaml
└── README.md                 # Updated index pointing to new structure
```

### Pattern 1: Commander.js Command Tree Introspection for Doc Generation
**What:** A script that imports the CLI program object, recursively walks all commands/subcommands, and emits structured markdown.
**When to use:** For the `npm run docs:generate` script and the "stale generated docs" pre-commit check.
**How it works:**

Commander.js 14.0.3 exposes full metadata on every registered command:
- `program.commands` — array of subcommand `Command` objects
- `cmd.name()` — command name string
- `cmd.description()` — description string
- `cmd.options` — array of `Option` objects with `.flags`, `.description`, `.defaultValue`
- `cmd.registeredArguments` — array of `Argument` objects with `.name()`, `.required`, `.description`
- `cmd.commands` — nested subcommands (recursive)

Verified this works with the installed Commander version by running introspection against the live AOF CLI.

The doc generator script:
1. Imports the program from `dist/cli/index.ts` (must build first)
2. Walks the command tree recursively
3. For each command: emits name, description, usage, arguments, options with defaults
4. Writes to `docs/guide/cli-reference.md` with a header comment `<!-- AUTO-GENERATED — do not edit manually. Run: npm run docs:generate -->`
5. Exits with the file path for the pre-commit check to compare

**Key detail:** The script must suppress Commander's `.parseAsync()` call. The approach is to either:
- (a) Export the program before `.parseAsync()` and import it in the generator, or
- (b) Have the generator script set an env var (e.g., `AOF_DOC_GEN=1`) that the CLI checks before calling `.parseAsync()`

Option (a) is cleaner: refactor `src/cli/index.ts` to export the configured `program` object, and have the entrypoint file call `program.parseAsync()` separately.

### Pattern 2: Pre-Commit Hook with Multiple Checks
**What:** A single Node.js script that runs four doc checks in sequence, collecting failures, and exits non-zero if any fail.
**When to use:** As the `pre-commit` hook via `simple-git-hooks`.

The `simple-git-hooks` config in `package.json` supports multiple hook types simultaneously:
```json
{
  "simple-git-hooks": {
    "commit-msg": "npx --no -- commitlint --edit $1",
    "pre-commit": "node scripts/check-docs.mjs"
  }
}
```

After updating, run `npx simple-git-hooks` to install the new hook file.

### Pattern 3: README Freshness Check
**What:** Extract version from `package.json`, check that `README.md` references match.
**When to use:** As one of the four pre-commit checks.

The current README has:
- `git clone` URL pointing to `demerzel-ops/aof.git` (stale — should be `d0labs/aof.git`)
- Version badge showing "2195 passing"
- Node.js prerequisite says "20+" (should be "22+")
- Install instructions use `git clone` (should use installer for end users)

The freshness check should verify:
1. Version in README matches `package.json` version (or isn't hardcoded)
2. Repository URL matches `package.json` repository URL
3. Node.js version prerequisite matches `package.json` engines field

### Anti-Patterns to Avoid
- **Flat docs directory:** The current 28 files in `docs/` with no audience separation makes it hard for end users to find what they need. Restructure into `guide/` and `dev/`.
- **Hand-written CLI reference:** The current README has a manual CLI table that is already outdated (missing commands like `runbook`, `config`, `metrics`, `notifications`, `install`, `deps`, `channel`, `update`). Auto-generation prevents this.
- **External link checking in pre-commit:** Checking HTTP links makes commits slow and flaky. Only check internal (relative) links.
- **Whole-file regeneration check without diffing:** The stale-docs check should re-run the generator to a temp file and diff, not regenerate in-place (which would stage changes mid-commit).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| CLI doc generation | Manual markdown tables | Commander.js introspection script | Commander exposes `.commands`, `.options`, `.registeredArguments` — full metadata for every registered command |
| Git hook management | Raw `.git/hooks/` files | simple-git-hooks (already installed) | Handles hook installation on `npm install` via `prepare` script |
| Markdown parsing for link extraction | Regex-based link finder | Node.js regex on `[text](url)` patterns | Internal links are simple relative paths — full markdown AST parsing is overkill |
| Config schema documentation | Manual schema docs | Extract from Zod schemas + OpenClaw plugin configSchema JSON | Both already have field descriptions; generate config reference from these |

**Key insight:** The project already has rich machine-readable metadata in Commander registrations, Zod schemas, and `openclaw.plugin.json` configSchema. Documentation should be generated from these sources, not duplicated manually.

## Common Pitfalls

### Pitfall 1: CLI Doc Generator Executes Side Effects
**What goes wrong:** Importing the CLI module triggers `program.parseAsync()`, which tries to run a command or exits.
**Why it happens:** The CLI entrypoint file both configures and executes the program.
**How to avoid:** Refactor `src/cli/index.ts` to separate program configuration from execution. Export the configured program; have a thin entrypoint that calls `.parseAsync()`. The doc generator imports only the configuration.
**Warning signs:** Generator script hangs or exits with errors about missing arguments.

### Pitfall 2: Pre-Commit Hook Too Slow
**What goes wrong:** Developers bypass the hook with `--no-verify` because it takes too long.
**Why it happens:** Running `npm run build` + doc generation + link checking on every commit.
**How to avoid:** The doc generator should work against the ALREADY-BUILT `dist/` (not rebuild). Link checking should be fast (pure filesystem, no HTTP). Target: entire pre-commit hook under 3 seconds.
**Warning signs:** Hook takes more than 5 seconds.

### Pitfall 3: Broken Internal Links After Restructure
**What goes wrong:** Moving 28 docs files to new subdirectories breaks every cross-reference.
**Why it happens:** Files that reference `../WORKFLOW-GATES.md` now need `../guide/workflow-gates.md`.
**How to avoid:** Run the link checker immediately after restructuring. Update all internal links in the same commit. The link checker pre-commit hook will catch regressions going forward.
**Warning signs:** Markdown link targets that start with `../` or reference the old flat structure.

### Pitfall 4: README Rewrites Root README Too Aggressively
**What goes wrong:** The new "landing page" README loses useful content that existed before.
**Why it happens:** Trying to make it "concise" without preserving the substantive sections.
**How to avoid:** The root README should link to detailed docs rather than removing content. Keep the quick-start inline but move architecture details, full CLI reference, and configuration examples to `docs/guide/`.
**Warning signs:** Users asking "where did X go?" after the README rewrite.

### Pitfall 5: Stale Docs Check Fails When dist/ Is Not Built
**What goes wrong:** The pre-commit hook runs the doc generator, which imports from `dist/`, but dist is stale or missing.
**Why it happens:** Developer edited source but didn't rebuild.
**How to avoid:** The check should detect a missing/stale `dist/` and print a clear message: "Run `npm run build` before committing." Do NOT auto-build in the hook (too slow).
**Warning signs:** Cryptic import errors in the hook output.

## Code Examples

### CLI Doc Generator - Command Tree Walker
```typescript
// scripts/generate-cli-docs.mjs
// Walks Commander.js command tree and emits markdown

function formatCommand(cmd, prefix = '') {
  const fullName = prefix ? `${prefix} ${cmd.name()}` : cmd.name();
  let md = `### \`aof ${fullName}\`\n\n`;
  md += `${cmd.description()}\n\n`;

  // Arguments
  const args = cmd.registeredArguments;
  if (args.length > 0) {
    md += '**Arguments:**\n\n';
    md += '| Argument | Required | Description |\n';
    md += '|----------|----------|-------------|\n';
    for (const arg of args) {
      md += `| \`${arg.name()}\` | ${arg.required ? 'Yes' : 'No'} | ${arg.description || ''} |\n`;
    }
    md += '\n';
  }

  // Options
  const opts = cmd.options.filter(o => !o.hidden);
  if (opts.length > 0) {
    md += '**Options:**\n\n';
    md += '| Flag | Description | Default |\n';
    md += '|------|-------------|--------|\n';
    for (const opt of opts) {
      const def = opt.defaultValue !== undefined ? `\`${opt.defaultValue}\`` : '';
      md += `| \`${opt.flags}\` | ${opt.description} | ${def} |\n`;
    }
    md += '\n';
  }

  // Recurse into subcommands
  for (const sub of cmd.commands) {
    if (sub.name() === 'help') continue;
    md += formatCommand(sub, fullName);
  }

  return md;
}
```

### Pre-Commit Hook Runner Structure
```javascript
// scripts/check-docs.mjs
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const checks = [
  { name: 'Stale generated docs', fn: checkStaleDocs },
  { name: 'New commands without docs', fn: checkUndocumentedCommands },
  { name: 'Broken internal links', fn: checkBrokenLinks },
  { name: 'README freshness', fn: checkReadmeFreshness },
];

let failed = false;
for (const check of checks) {
  const issues = check.fn();
  if (issues.length > 0) {
    console.error(`FAIL: ${check.name}`);
    for (const issue of issues) console.error(`  - ${issue}`);
    failed = true;
  }
}

if (failed) process.exit(1);
```

### Internal Link Checker Pattern
```javascript
// Check that [text](./relative/path.md) links resolve to actual files
function checkBrokenLinks() {
  const issues = [];
  const mdFiles = globSync('docs/**/*.md').concat(['README.md']);
  const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;

  for (const file of mdFiles) {
    const content = readFileSync(file, 'utf-8');
    let match;
    while ((match = linkPattern.exec(content)) !== null) {
      const target = match[2];
      // Skip external links, anchors-only, mailto
      if (target.startsWith('http') || target.startsWith('#') || target.startsWith('mailto:')) continue;
      // Resolve relative to file's directory
      const resolved = resolve(dirname(file), target.split('#')[0]);
      if (!existsSync(resolved)) {
        issues.push(`${file}: broken link to ${target}`);
      }
    }
  }
  return issues;
}
```

### simple-git-hooks Config Update
```json
{
  "simple-git-hooks": {
    "commit-msg": "npx --no -- commitlint --edit $1",
    "pre-commit": "node scripts/check-docs.mjs"
  }
}
```
After updating, run `npx simple-git-hooks` to install the new pre-commit hook.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hand-written CLI tables in README | Auto-generated from Commander.js introspection | Standard practice since Commander 7+ | CLI docs never drift from code |
| Flat docs directory | Audience-segmented docs (guide/ + dev/) | Modern OSS standard (Astro, Vite, etc.) | Users find what they need faster |
| No doc validation | Pre-commit hooks catch doc drift | Standard since lint-staged/husky era | Docs stay current without discipline |
| TypeDoc for everything | TypeDoc for API types, custom scripts for CLI | Common pattern in CLI-heavy projects | CLI docs need Commander metadata, not TS types |

**Deprecated/outdated:**
- The current README references `demerzel-ops/aof.git` (should be `d0labs/aof.git` per Phase 6 decision)
- The current README says "Node.js 20+" (should be "Node.js 22+" per project engines field)
- The README CLI reference table is incomplete (missing ~15 commands that exist in the actual CLI)

## Existing State Assessment

### Current Documentation Inventory
The project already has significant documentation. Here is what exists and where it should move:

| Current Location | Audience | Target Location | Action |
|-----------------|----------|-----------------|--------|
| `README.md` (root) | All | `README.md` (rewrite) | Rewrite as concise landing page |
| `CONTRIBUTING.md` | Contributors | Keep at root | Update links after restructure |
| `docs/README.md` | All | `docs/README.md` | Rewrite as index for new structure |
| `docs/DEPLOYMENT.md` | Users | `docs/guide/deployment.md` | Move, lowercase filename |
| `docs/WORKFLOW-GATES.md` | Users | `docs/guide/workflow-gates.md` | Move |
| `docs/PROTOCOLS-USER-GUIDE.md` | Users | `docs/guide/protocols.md` | Move |
| `docs/MEMORY-MODULE.md` | Users | `docs/guide/memory.md` | Move |
| `docs/task-format.md` | Users | `docs/guide/task-format.md` | Move |
| `docs/notification-policy.md` | Users | `docs/guide/notifications.md` | Move |
| `docs/SLA-GUIDE.md` | Users | `docs/guide/sla.md` | Move |
| `docs/migration-guide.md` | Users | `docs/guide/migration.md` | Move |
| `docs/event-logs.md` | Users | `docs/guide/event-logs.md` | Move |
| `docs/CLI-RECOVERY-REFERENCE.md` | Users | `docs/guide/cli-recovery.md` | Move |
| `docs/RECOVERY-RUNBOOK.md` | Users/Ops | `docs/guide/recovery.md` | Move |
| `docs/KNOWN-ISSUES.md` | All | `docs/guide/known-issues.md` | Move |
| `docs/DEFINITION-OF-DONE.md` | Contributors | `docs/dev/definition-of-done.md` | Move |
| `docs/RELEASE-CHECKLIST.md` | Maintainer | `docs/dev/release-checklist.md` | Move |
| `docs/DEV-TOOLING.md` | Contributors | `docs/dev/dev-tooling.md` | Move |
| `docs/ROADMAP.md` | All | `docs/dev/roadmap.md` | Move |
| `docs/E2E-TEST-HARNESS-DESIGN.md` | Contributors | `docs/dev/e2e-test-harness.md` | Move |
| `docs/PROTOCOLS-DESIGN.md` | Contributors | `docs/dev/protocols-design.md` | Move |
| `docs/PROTOCOLS-BDD-SPECS.md` | Contributors | `docs/dev/protocols-bdd-specs.md` | Move |
| `docs/SECURITY-REMEDIATION-DESIGN.md` | Contributors | `docs/dev/security-remediation.md` | Move |
| `docs/memory-tier-pipeline.md` | Contributors | `docs/dev/memory-tier-pipeline.md` | Move |
| `docs/design/` (5 files) | Contributors | `docs/dev/` (flatten) | Move, flatten |
| `docs/contributing/` (4 files) | Contributors | `docs/dev/` (flatten) | Move, flatten |
| `docs/architecture/` (1 file) | Contributors | `docs/dev/` (flatten) | Move, flatten |
| `docs/examples/` (3 files) | Users | `docs/examples/` (keep) | Keep as-is |

### New Documents Needed
| Document | Audience | Location | Priority |
|----------|----------|----------|----------|
| Getting started guide | Users | `docs/guide/getting-started.md` | 1 (highest) |
| Configuration reference | Users | `docs/guide/configuration.md` | 2 |
| CLI reference (auto-generated) | Users | `docs/guide/cli-reference.md` | 3 |
| Architecture overview | Contributors | `docs/dev/architecture.md` | 4 |

### Scripts Needed
| Script | Purpose |
|--------|---------|
| `scripts/generate-cli-docs.mjs` | Walks Commander tree, emits `docs/guide/cli-reference.md` |
| `scripts/check-docs.mjs` | Pre-commit hook runner (4 checks) |

### CLI Entrypoint Refactor
The current `src/cli/index.ts` both registers commands AND calls `program.parseAsync()` at module level. The doc generator needs to import the registered program WITHOUT executing it. A small refactor is needed:

1. Extract program registration into an exported function or separate file
2. Have `src/cli/index.ts` call registration + `.parseAsync()`
3. Doc generator imports only the registration part

### Public API Files Needing JSDoc
Based on `src/index.ts` exports and `package.json` exports map:

| File | Export | Current JSDoc |
|------|--------|---------------|
| `src/tools/aof-tools.ts` | Tool types + functions | Minimal (file-level only) |
| `src/tools/project-tools.ts` | `aofDispatch` | Minimal |
| `src/tools/query-tools.ts` | `aofStatusReport` | Minimal |
| `src/tools/task-tools.ts` | 8 task mutation functions | Minimal |
| `src/schemas/task.ts` | Task schema + types | Good (13 JSDoc blocks) |
| `src/schemas/org-chart.ts` | Org chart schema | Good (27 JSDoc blocks) |
| `src/schemas/config.ts` | Config schemas | Good (6 JSDoc blocks) |
| `src/schemas/protocol.ts` | Protocol types | None |
| `src/store/interfaces.ts` | ITaskStore interface | Minimal |
| `src/plugin.ts` | Plugin entry point | None |
| `src/openclaw/types.ts` | OpenClawApi type | Unknown |

Priority: schemas already have good JSDoc. Focus JSDoc effort on `src/tools/` (public tool functions) and `src/schemas/protocol.ts`.

## Open Questions

1. **Config reference source: Zod schemas vs plugin configSchema JSON?**
   - What we know: The Zod schemas in `src/schemas/config.ts` define AOF's internal config, while `openclaw.plugin.json` has a JSON Schema for plugin config. The org-chart schema is in `src/schemas/org-chart.ts`.
   - What's unclear: Should the configuration reference document be auto-generated from schemas, or hand-written with schema extracts?
   - Recommendation: Hand-write the configuration reference using schema field descriptions as source material. Auto-generation from Zod is possible but adds complexity for a one-time doc. The pre-commit freshness check can verify key values (version, repo URL) without full schema-to-doc generation.

2. **"New commands without docs" detection strategy**
   - What we know: Commander registrations are the source of truth. The doc generator walks the command tree.
   - What's unclear: How granular should the check be? Top-level commands only, or every subcommand?
   - Recommendation: The check should compare command names from the Commander tree against section headings in `cli-reference.md`. If a command exists in the tree but not in the doc, fail. This naturally works at every level since the generator creates headings for every command/subcommand.

3. **Handling existing `docs/README.md` during migration**
   - What we know: The current `docs/README.md` is a comprehensive index with direct links to all 28 docs.
   - What's unclear: Should it become the new root of the docs/ directory or be replaced?
   - Recommendation: Rewrite `docs/README.md` as the new index pointing to `guide/` and `dev/` sections. The current content is a good template for the new structure.

## Sources

### Primary (HIGH confidence)
- AOF source code at `~/Projects/AOF/` — direct inspection of CLI structure, Commander registrations, existing docs, package.json, git hooks
- Commander.js 14.0.3 API — verified introspection capabilities by running against live AOF CLI binary
- simple-git-hooks 2.13.1 — verified multi-hook support via [GitHub README](https://github.com/toplenboren/simple-git-hooks)

### Secondary (MEDIUM confidence)
- [remark-validate-links](https://github.com/remarkjs/remark-validate-links) — npm package for offline markdown internal link validation (alternative to custom script)
- [markdown-link-check](https://www.npmjs.com/package/markdown-link-check) — npm package for link validation (not recommended for this use case)

### Tertiary (LOW confidence)
- None — all findings verified against project source or official documentation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new libraries needed; all tooling is custom scripts using existing Commander.js and simple-git-hooks
- Architecture: HIGH - doc structure decisions are locked; Commander introspection verified working against actual project
- Pitfalls: HIGH - based on direct inspection of current project state (stale README, missing commands, entrypoint coupling)

**Research date:** 2026-02-26
**Valid until:** 2026-03-28 (stable — documentation tooling patterns don't change fast)
