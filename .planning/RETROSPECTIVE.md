# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.1 — Stabilization & Ship

**Shipped:** 2026-02-27
**Phases:** 6 | **Plans:** 16 | **Sessions:** ~16

### What Was Built
- HNSW memory subsystem hardened with auto-resize, parity checks, crash-safe writes, and CLI health/rebuild tools
- CI pipeline with GitHub Actions (PR validation + tag-triggered releases with tarball artifacts)
- curl|sh installer with prerequisite detection, wizard scaffolding, OpenClaw plugin wiring, and upgrade safety
- Multi-project isolation verified end-to-end (tool scoping, dispatch filtering, per-project memory pools)
- Audience-segmented documentation with auto-generated CLI reference and pre-commit guardrails

### What Worked
- Hard dependency chain (Memory → CI → Installer → Projects) researched and validated upfront — zero blocked phases
- Small, focused plans (avg 4.3 min execution) — fast iteration with clear scope
- Milestone audit after initial phases caught Phase 7 gap and production dependency issue before shipping
- Phase 8 (hotfix pattern) addressed audit gaps without disrupting main flow
- Pre-commit doc hook prevents the drift that caused the documentation debt in the first place

### What Was Inefficient
- Phase 7 (Projects) was in scope from the start but wasn't planned until audit flagged it as missing
- rebuildHnswFromDb exported for reuse but CLI rebuild reimplemented inline — duplication could have been avoided
- test-lock.sh uses flock (Linux-only) — safe for CI but creates platform-specific tech debt
- ROADMAP.md didn't include Phase 9 under the v1.1 milestone header — required manual reconciliation during completion

### Patterns Established
- Audit-before-ship workflow catches gaps that phase-level verification misses
- Hotfix phases (Phase 8) work well for closing audit gaps without replanning the milestone
- Node 22 pinning is a hard constraint — must be enforced in CI, installer, and docs consistently
- Four-check pre-commit hook (doc staleness, undocumented commands, broken links, README freshness) as standard practice

### Key Lessons
1. Run milestone audit early (not just before shipping) — Phase 7 gap would have been caught sooner
2. Dependency chain research pays for itself — zero rework across 16 plans
3. Product messaging matters even for infrastructure tools — reframing from "deterministic orchestration layer" to "multi-team agent orchestration platform" changes how users perceive the product

### Cost Observations
- Sessions: ~16 (one per plan, plus audit and milestone completion)
- Total execution time: ~1.7 hours for 16 plans
- Notable: Phase 9 (docs, 5 plans) took 27 min total — doc generation and restructuring was the most file-intensive work (37 files in 09-02 alone)

---

## Cross-Milestone Trends

| Metric | v1.0 | v1.1 |
|--------|------|------|
| Phases | 3 | 6 |
| Plans | 7 | 16 |
| Commits | 15 | 40 |
| Files changed | 64 | 148 |
| Lines added | +3,527 | +7,583 |
| Lines removed | -584 | -4,865 |
| Avg plan duration | ~4 min | ~4.3 min |
| Total execution | ~30 min | ~1.7 hrs |

**Observations:**
- Plan execution time is consistent (~4 min avg) regardless of phase complexity
- v1.1 had 3x more deletions proportionally — cleanup and refactoring (doc restructure, dead code removal)
- Audit-driven hotfix phases (Phase 8) are lightweight and effective for gap closure
