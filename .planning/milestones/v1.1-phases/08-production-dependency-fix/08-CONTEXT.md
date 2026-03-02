# Phase 8: Production Dependency Fix - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Fix production-blocking dependency issues left from Phases 4-6. Two specific fixes: make @inquirer/prompts available in production installs, and correct the package.json repository URL. No new features, no refactoring — just fix what's broken.

</domain>

<decisions>
## Implementation Decisions

### Fix strategy for @inquirer/prompts
- Add @inquirer/prompts to `dependencies` in package.json (move from devDependencies or add explicitly)
- Do NOT refactor the CLI code or replace with Node built-in readline — keep existing interactive UX intact
- Scope is just this one dependency — no broader dev-dependency audit

### Repository URL
- Update `package.json` `repository.url` to `github.com/d0labs/aof`
- This is a cosmetic fix but important for npm metadata and installer references

### Verification
- Plan must include running `npm ci --production` and confirming @inquirer/prompts resolves
- This proves the fix actually works in a production install scenario

### Claude's Discretion
- Whether @inquirer/prompts needs a version pin or can use the existing version range
- Exact verification approach (temp directory, in-place, etc.)

</decisions>

<specifics>
## Specific Ideas

- The `--yes` flag on `aof memory rebuild` already exists to skip confirmation — the fix is about making the default interactive path work, not changing behavior
- The current repo URL says `demerzel-ops/aof` — change to `d0labs/aof`

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 08-production-dependency-fix*
*Context gathered: 2026-02-26*
