# Milestones

## v1.0 AOF Production Readiness (Shipped: 2026-02-26)

**Phases completed:** 3 phases, 7 plans, 15 commits
**Timeline:** 2026-02-25 (single day)
**Code:** +3,527 / -584 lines across 64 files

**Key accomplishments:**
- Restart-safe scheduler with poll timeout guard, graceful drain, and startup orphan reconciliation
- Three-way error classification (transient/permanent/rate_limited) with jittered backoff and dead-letter failure chains
- OS-supervised daemon with launchd (macOS) and systemd (Linux) service files and automatic crash recovery
- Unix socket health server with /healthz liveness and /status operational overview, PID-gated startup
- GatewayAdapter abstraction with OpenClaw and Mock implementations, config-driven adapter selection
- End-to-end dispatch tracking with UUID v4 correlation IDs and adapter-mediated force-complete on stale heartbeats

**Tech debt accepted:** 9 items (see v1.0-MILESTONE-AUDIT.md)

---


## v1.1 Stabilization & Ship (Shipped: 2026-02-27)

**Phases completed:** 6 phases (4-9), 16 plans, 40 commits
**Timeline:** 2026-02-25 → 2026-02-26 (2 days)
**Code:** +7,583 / -4,865 lines across 148 files (~90k LOC TypeScript)

**Key accomplishments:**
- Fixed P0 HNSW memory crash — auto-resize, startup parity check, crash-safe writes, CLI health/rebuild tools
- Added CI pipeline — GitHub Actions validation on PRs + tag-triggered release with tarball artifacts and changelog
- Built curl|sh installer — prerequisite detection, download/extract, wizard scaffolding, OpenClaw plugin wiring, upgrade-safe
- Verified and completed multi-project isolation — project-scoped dispatch, per-project memory pools, participant filtering
- Fixed production dependency gap — @inquirer/prompts in production deps, corrected repo URL
- Complete documentation — audience-segmented docs, auto-generated CLI reference, pre-commit guardrails, architecture overview

**Git range:** feat(04-01) → docs(09-05)
**Tech debt accepted:** See v1.1-MILESTONE-AUDIT.md (stale — all gaps resolved by Phases 7, 8, 9)

---

