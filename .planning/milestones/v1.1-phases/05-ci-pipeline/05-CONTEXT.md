# Phase 5: CI Pipeline - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

GitHub Actions workflows that validate every PR and package every release. Two workflows: a CI workflow (typecheck, build, test on push/PR to main) and a release workflow (triggered by tag push, produces GitHub Release with tarball and changelog). Branch protection enforces CI passing before merge.

</domain>

<decisions>
## Implementation Decisions

### PR workflow triggers & matrix
- Trigger on push to main AND on PRs targeting main
- Skip draft PRs — only run when PR is marked ready for review
- Node version matrix: 22 and 23
- Ubuntu runners only (pure JS, no native deps)
- Cache npm dependencies (actions/cache or setup-node built-in cache)

### Release mechanics
- Release triggered by tag push (e.g., `git tag v1.2.0 && git push --tags`)
- Version numbers derived from conventional commits (fix=patch, feat=minor, breaking=major)
- Use release-it for version bump, changelog generation, and GitHub Release creation
- release-it runs locally: bumps version, updates CHANGELOG.md, commits, creates tag — then CI picks up the tag push
- Release workflow runs full test suite before publishing artifacts (safety net)

### Artifact & changelog shape
- Tarball contains: built JS + package.json + README (production files only, no source/tests/dev deps)
- Tarball named by version only: `aof-v1.2.0.tar.gz` (no platform suffix — pure JS)
- Changelog auto-grouped by conventional commit type: Features, Fixes, Breaking Changes
- CHANGELOG.md committed by release-it locally before tag push (not by CI)

### Failure handling & notifications
- Branch protection requires CI status checks to pass before merge
- GitHub default notifications only — no extra webhooks
- Release build failures require manual investigation and retry (no auto-retry)

### Claude's Discretion
- Exact GitHub Actions workflow structure and job naming
- setup-node cache strategy details
- release-it plugin configuration
- Tarball build script implementation

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 05-ci-pipeline*
*Context gathered: 2026-02-26*
