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

## Milestone: v1.4 — Context Optimization

**Shipped:** 2026-03-04
**Phases:** 4 | **Plans:** 6 | **Sessions:** ~8

### What Was Built
- Compressed SKILL.md from 3411 to 1665 tokens (51.2% reduction) covering all tools, DAG workflows, and org chart setup
- Tiered context delivery: seed tier (563 tokens, 82.5% reduction) for simple tasks, full tier for complex tasks
- Workflow parameter on aof_dispatch enabling agent-composed DAG pipelines via MCP tools
- CI budget gate test enforcing 2150-token ceiling on total context injection
- skill.json manifest with programmatic tier selection and token estimates

### What Worked
- Prerequisite audit of existing code revealed tool descriptions were already one-liners — saved an entire plan's worth of refactoring
- Linear dependency chain (21→22→23→24) kept execution clean with no blocked phases
- Budget gate test design (read from disk, count tokens, assert ceiling) is simple and maintainable
- Seed tier defaulting means existing agents get context reduction without code changes

### What Was Inefficient
- Phase 22 context capture initially had wrong user decisions — required a fix commit before planning
- Progress table in ROADMAP.md had misaligned columns for phases 22-24 (missing milestone column) — minor but required manual fix during completion
- Nyquist validation was missing for all 4 phases (marked in audit) — not a blocker but incomplete process coverage

### Patterns Established
- Token-counting budget gate as CI regression prevention for context size
- Tier-based context delivery pattern (seed/full) applicable to future skill additions
- skill.json manifest as machine-readable skill metadata
- SKILL.md compression approach: table format for tools, inline examples for patterns, no parameter tables

### Key Lessons
1. Always check existing state before planning changes — Phase 21 found tool descriptions already optimized, avoiding unnecessary work
2. Static tiers beat dynamic selection — simpler, deterministic, no LLM overhead for tier choice
3. Budget gates with headroom (25% above current) prevent both regression and overly-tight constraints

### Cost Observations
- Sessions: ~8 (context capture + plan + execute per phase, plus audit and completion)
- Total execution time: ~19 min for 6 plans (avg ~3.2 min/plan)
- Notable: Fastest milestone yet — 1 day, 4 phases, 39 commits. Context optimization is a well-scoped, low-risk workstream

---

## Milestone: v1.5 — Event Tracing

**Shipped:** 2026-03-08
**Phases:** 3 | **Plans:** 6 | **Sessions:** ~8

### What Was Built
- Completion enforcement — agents exiting without `aof_task_complete` caught, marked failed, deadlettered after 3 strikes
- Dual-channel agent guidance: SKILL.md (standing) + formatTaskInstruction (per-dispatch with consequences)
- Streaming JSONL session parser extracting tool calls, reasoning, and output from OpenClaw transcripts
- No-op detector flagging zero-tool-call sessions via `completion.noop_detected` events
- Structured trace capture with retry accumulation (trace-N.json, atomic writes)
- `aof trace <task-id>` CLI with summary, --debug, --json modes and DAG hop correlation

### What Worked
- Linear dependency chain (25→26→27) with clean phase boundaries — each phase consumed exactly what the prior phase provided
- TDD approach in Phase 27 (trace reader/formatter) produced pure functions that were trivial to wire into the CLI
- Enforcement + tracing split (Phases 25 vs 26) was the right boundary — enforcement is a state machine concern, tracing is observational
- ENFC-03 (no-op detection) naturally fit into Phase 26 trace infrastructure despite being originally assigned to Phase 25
- Integration checker verified all 12 cross-phase exports were properly wired — zero orphans

### What Was Inefficient
- SUMMARY.md frontmatter overclaimed ENFC-02 (dropped) and ENFC-03 (deferred) as completed in Plan 25-01 — traceability mismatch caught only at milestone audit
- TypeScript strict null errors in array indexing (`traces[i]`, `result[i]`) required post-execution fixes in all 3 phases — pattern should be anticipated
- Nyquist validation files created as drafts but never completed for any phase — process step consistently skipped

### Patterns Established
- Observational systems (tracing) placed after control flow (enforcement) — never interfere with state transitions
- CorrelationId-first with sequential fallback for DAG hop mapping — graceful degradation pattern
- Streaming JSONL parsing via node:readline for memory-efficient processing of large session files
- Reader/formatter separation (I/O separated from pure presentation functions) for testability

### Key Lessons
1. Requirement reassignment across phases (ENFC-03 moving from Phase 25 to 26) should be updated in REQUIREMENTS.md immediately — catching it at audit is too late
2. TypeScript strict null checks on array indexing are a predictable friction point — add `!` assertions proactively when bounds are already checked
3. Three-phase milestones with linear dependencies execute cleanly — the smallest milestone scope yet (3 phases, 6 plans) with zero blocked phases

### Cost Observations
- Sessions: ~8 (context capture + plan + execute per phase, plus audit and completion)
- Total execution time: ~35 min for 6 plans (avg ~5.8 min/plan)
- Notable: Slightly slower per-plan than v1.4 due to larger test suites (68 trace tests + 13 CLI tests written via TDD)

---

## Milestone: v1.8 — Task Notifications

**Shipped:** 2026-03-12
**Phases:** 6 | **Plans:** 9

### What Was Built
- Subscription schema + SubscriptionStore with crash-safe co-located persistence
- MCP tools for subscribe/unsubscribe + dispatch-time subscription
- Scheduler-driven callback delivery with retry (3 attempts, 30s cooldown)
- All-granularity delivery with cursor-based batching and trace capture
- Callback depth limiting (MAX_DEPTH=3) with daemon restart recovery
- Agent guidance in SKILL.md with budget gate enforcement (2500 ceiling)

### What Worked
- Milestone audit after Phase 32 caught two real integration gaps (orphaned export, broken depth propagation) — Phase 33 closed both cleanly
- TDD approach continued to pay off — 3,090 tests with zero regressions across all 9 plans
- Gap closure as a dedicated phase (33) with focused scope: 2 tasks, 2 commits, clean verification
- Budget gate CI pattern extended successfully from v1.4 — caught context growth and adapted ceiling

### What Was Inefficient
- deliverAllGranularityCallbacks was built in Phase 31 but never wired into production — integration gap survived 2 phases before audit caught it
- callbackDepth propagation designed in Phase 31 research but env var bridge approach only discovered during Phase 33 planning
- REQUIREMENTS.md coverage summary became stale ("Pending: 2") after Phase 33 completed — no auto-update mechanism

### Patterns Established
- **Env var bridge for MCP boundary crossing:** AOF_CALLBACK_DEPTH set before spawnSession, cleared in finally — pragmatic approach for in-process agent spawning
- **Cursor-based delivery scanning:** lastDeliveredAt high-water mark into EventLogger.query — self-healing on failure
- **Dual delivery paths:** deliverCallbacks (completion) and deliverAllGranularityCallbacks (all) called independently in separate try/catch blocks

### Key Lessons
- Integration gaps are invisible to phase-level verification — milestone audit is essential for catching cross-phase wiring issues
- Functions that are exported but never called from production should be flagged during phase verification (add key_links check)
- Requirements that span multiple phases (GRAN-02, SAFE-01 split across 31 and 33) need explicit "wiring phase" planning

---

## Milestone: v1.10 — Codebase Cleanups

**Shipped:** 2026-03-16
**Phases:** 7 | **Plans:** 18

### What Was Built
- Removed ~2,900 lines dead code (legacy gate system, 15 unused MCP schemas, deprecated type aliases)
- Fixed 4 correctness bugs (buildTaskStats, daemon startTime, UpdatePatch type, TOCTOU race via shared lock manager)
- Centralized config registry with Zod validation, resetConfig() for test isolation
- Structured logging with Pino (child loggers per module, 120+ console.* calls replaced, 36 silent catches remediated)
- Decomposed god functions (executeAssignAction, executeActions) into handler modules
- Unified tool registration across MCP and OpenClaw via shared toolRegistry
- Broke all circular dependencies (0 cycles via madge), enforced store abstraction (save/saveToPath)
- Standardized test infrastructure (createTestHarness adopted by 13 files, typed mock factories)

### What Worked
- Sequential phase ordering (34→35→36→37→38→39→40) naturally built on each other — dead code removed before refactoring, config centralized before logging
- Phase-level verification caught 2 gaps in Phase 40 (missing getMetric, zero harness adoption) — gap closure plan 40-03 resolved both
- v1.10 was the first purely internal milestone (no new features) — scope was well-defined by static analysis and code metrics
- 43 requirements fully traceable across 7 phases — 3-source cross-reference (VERIFICATION + SUMMARY + REQUIREMENTS) confirmed completeness
- Integration checker verified 47 exports and 5 E2E flows with zero breaks

### What Was Inefficient
- Plan 40-02 migrated tests to mock factories but not to createTestHarness — gap closure was needed because the plan objective and actual execution diverged
- Nyquist VALIDATION.md templates created for all phases but never populated — skeleton artifacts add noise without value
- Summary frontmatter `task_count` field was 0 for most plans — extraction tooling returned no useful data for stats gathering
- One-liner field missing from all summaries — accomplishment extraction during milestone completion required manual derivation

### Patterns Established
- Zod-based config registries with resetConfig() for test isolation — reusable pattern for any typed configuration
- Child logger per module pattern — consistent structured logging with filterable component field
- Tool registry pattern — single handler map consumed by multiple transport adapters
- createTestHarness() consolidating tmpDir + store + logger + events — eliminates boilerplate across integration tests

### Key Lessons
1. Internal cleanup milestones benefit from static analysis research upfront — madge, grep, and LOC counts define scope more precisely than feature milestones
2. Plan objectives must match actual execution — "migrate to harness" vs "migrate to mock factories" caused a gap closure cycle
3. Summary frontmatter fields (one_liner, task_count) need to be consistently populated during execution — downstream tooling depends on them
4. 7-phase milestones with 18 plans execute well in 5 days — larger scope but lower risk than feature milestones

### Cost Observations
- Total: 107 commits across 242 files (+17,351 / -8,623 lines)
- Timeline: 5 days (2026-03-12 → 2026-03-16)
- Notable: Net reduction of codebase by ~8,600 lines despite adding new infrastructure (logging, config, testing) — cleanup milestones are net-negative on LOC

---

## Cross-Milestone Trends

| Metric | v1.0 | v1.1 | v1.2 | v1.3 | v1.4 | v1.5 | v1.8 | v1.10 |
|--------|------|------|------|------|------|------|------|-------|
| Phases | 3 | 6 | 7 | 4 | 4 | 3 | 6 | 7 |
| Plans | 7 | 16 | 16 | 7 | 6 | 6 | 9 | 18 |
| Commits | 15 | 40 | — | — | 39 | ~30 | ~25 | 107 |
| Files changed | 64 | 148 | — | — | 47 | 47 | 22 | 242 |
| Lines added | +3,527 | +7,583 | — | — | +3,767 | +6,600 | +3,970 | +17,351 |
| Lines removed | -584 | -4,865 | — | — | -580 | -88 | -11 | -8,623 |
| Timeline | 1 day | 2 days | — | — | 1 day | 2 days | 4 days | 5 days |

**Observations:**
- Plan execution time is consistent (~3-5 min avg) regardless of phase complexity
- v1.5 had highest lines-added per plan (+1,100/plan) due to TDD approach generating substantial test code
- Three-phase milestones (v1.5) with linear dependencies execute most cleanly — zero blocked phases, zero rework
- Audit-driven hotfix phases (Phase 8 in v1.1, Phase 33 in v1.8) work well for closing integration gaps
- Budget gate pattern (CI test asserting ceiling) is reusable for other measurable constraints
- v1.8 had lowest lines-removed (-11) — almost entirely additive, indicating clean new feature with no legacy removal
- Integration gaps (orphaned exports, broken cross-boundary propagation) are a recurring pattern — milestone audit is the safety net
- v1.10 was the largest milestone by every metric (7 phases, 18 plans, 107 commits, 242 files) but also the first net-negative on LOC (-8,623 removed)
- Cleanup milestones benefit from well-defined scope via static analysis — 43 requirements derived from grep/madge/LOC audits
