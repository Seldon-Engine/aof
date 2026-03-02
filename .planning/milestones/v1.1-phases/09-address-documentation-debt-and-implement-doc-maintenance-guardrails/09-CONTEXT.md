# Phase 9: Address Documentation Debt and Implement Doc Maintenance Guardrails - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Create user-facing and contributor-facing documentation for the AOF framework, and implement mechanical guardrails that prevent docs from drifting as code changes. The AOF source lives at `~/Projects/AOF/`. This phase covers the framework itself, companion scripts/skills, OpenClaw plugin integration, and AOF configuration. Workspace identity docs, tech debt fixes, and internal code comments (beyond public API) are out of scope.

</domain>

<decisions>
## Implementation Decisions

### Documentation Scope
- Three audiences: end users (installing/using AOF), contributors (understanding internals), and the maintainer
- Covers: AOF framework, companion scripts/skills, OpenClaw plugin wiring, AOF config
- Does NOT cover: agent workspace identity docs, peripheral tooling, internal code comments
- Pre-launch prep — no users yet, docs are getting ready for public release

### Documentation Structure
- `docs/` directory at repo root with two sections: `docs/guide/` (end-user) and `docs/dev/` (contributor/architecture)
- Concise landing-page `README.md` at repo root — what AOF is, one-liner install, quick example, links into docs/
- CLI reference auto-generated from command definitions (not hand-written)

### Content Priority Order
1. Getting started guide — install AOF, configure it, run first task end-to-end (the "zero to working" path)
2. Configuration reference — org-chart.yaml schema, AOF config options, OpenClaw plugin wiring
3. Auto-generated CLI reference — every command, flag, and option
4. Architecture overview for contributors (in docs/dev/)
5. JSDoc on public API exports only (functions/types that plugins and skills interact with)

### Guardrail Mechanisms
- Pre-commit hook that **blocks** commits on failure (bypass with `--no-verify` for emergencies)
- Hook checks four things:
  1. Stale generated docs — re-runs doc generator, fails if output differs from committed version
  2. New commands without docs — scans CLI command registrations, checks for corresponding doc entries
  3. Broken internal links — validates markdown links between doc files resolve correctly
  4. README freshness — checks install command and version references match package.json
- `npm run docs:generate` script for CLI doc regeneration — developer runs manually, hook enforces

### Claude's Discretion
- Exact doc generator implementation (could be custom script, typedoc, or similar)
- Internal organization of docs/guide/ and docs/dev/ subdirectories
- How to detect "new commands without docs" (AST parsing, grep, or convention)
- JSDoc coverage strategy for public API

</decisions>

<specifics>
## Specific Ideas

- README should feel like a modern OSS landing page — concise, not a wall of text
- CLI reference generated from code so it never drifts
- Pre-commit hook is the main enforcement mechanism, not CI (catches drift before push)
- Tech debt items from v1.1 audit are a separate concern — don't fix them in this phase, don't document them as known issues

</specifics>

<deferred>
## Deferred Ideas

- None — discussion stayed within phase scope

</deferred>

---

*Phase: 09-address-documentation-debt-and-implement-doc-maintenance-guardrails*
*Context gathered: 2026-02-26*
