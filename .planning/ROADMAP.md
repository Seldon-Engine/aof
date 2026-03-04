# Roadmap: AOF

## Milestones

- ✅ **v1.0 AOF Production Readiness** — Phases 1-3 (shipped 2026-02-26)
- ✅ **v1.1 Stabilization & Ship** — Phases 4-9 (shipped 2026-02-27)
- ✅ **v1.2 Task Workflows** — Phases 10-16 (shipped 2026-03-03)
- ✅ **v1.3 Seamless Upgrade** — Phases 17-20 (shipped 2026-03-04)
- 🚧 **v1.4 Context Optimization** — Phases 21-24 (in progress)

## Phases

<details>
<summary>✅ v1.0 AOF Production Readiness (Phases 1-3) — SHIPPED 2026-02-26</summary>

- [x] Phase 1: Foundation Hardening (2/2 plans) — completed 2026-02-26
- [x] Phase 2: Daemon Lifecycle (3/3 plans) — completed 2026-02-26
- [x] Phase 3: Gateway Integration (2/2 plans) — completed 2026-02-26

See: `.planning/milestones/v1.0-ROADMAP.md` for full details

</details>

<details>
<summary>✅ v1.1 Stabilization & Ship (Phases 4-9) — SHIPPED 2026-02-27</summary>

- [x] Phase 4: Memory Fix & Test Stabilization (3/3 plans) — completed 2026-02-26
- [x] Phase 5: CI Pipeline (2/2 plans) — completed 2026-02-26
- [x] Phase 6: Installer (2/2 plans) — completed 2026-02-26
- [x] Phase 7: Projects (3/3 plans) — completed 2026-02-26
- [x] Phase 8: Production Dependency Fix (1/1 plan) — completed 2026-02-26
- [x] Phase 9: Documentation & Guardrails (5/5 plans) — completed 2026-02-27

See: `.planning/milestones/v1.1-ROADMAP.md` for full details

</details>

<details>
<summary>✅ v1.2 Task Workflows (Phases 10-16) — SHIPPED 2026-03-03</summary>

- [x] Phase 10: DAG Schema Foundation (2/2 plans) — completed 2026-03-03
- [x] Phase 11: DAG Evaluator (2/2 plans) — completed 2026-03-03
- [x] Phase 12: Scheduler Integration (2/2 plans) — completed 2026-03-03
- [x] Phase 13: Timeout, Rejection, Safety (3/3 plans) — completed 2026-03-03
- [x] Phase 14: Templates, Ad-Hoc API, Artifacts (3/3 plans) — completed 2026-03-03
- [x] Phase 15: Migration and Documentation (3/3 plans) — completed 2026-03-03
- [x] Phase 16: Integration Wiring Fixes (1/1 plan) — completed 2026-03-03

See: `.planning/milestones/v1.2-ROADMAP.md` for full details

</details>

<details>
<summary>✅ v1.3 Seamless Upgrade (Phases 17-20) — SHIPPED 2026-03-04</summary>

- [x] Phase 17: Migration Foundation & Framework Hardening (3/3 plans) — completed 2026-03-04
- [x] Phase 18: DAG-as-Default (1/1 plan) — completed 2026-03-04
- [x] Phase 19: Verification & Smoke Tests (2/2 plans) — completed 2026-03-04
- [x] Phase 20: Release Pipeline, Documentation & Release Cut (1/1 plan) — completed 2026-03-04

See: `.planning/milestones/v1.3-ROADMAP.md` for full details

</details>

### v1.4 Context Optimization (In Progress)

**Milestone Goal:** Cut agent context injection by 50%+ while preserving full AOF capability -- agents use less context but can still leverage DAG workflows, org chart setup, and all tools effectively.

- [x] **Phase 21: Tool & Workflow API** - Add workflow param to aof_dispatch, trim tool descriptions, merge projects skill (completed 2026-03-04)
- [x] **Phase 22: Compressed Skill** - Replace verbose agent documentation with a compact SKILL.md reflecting actual tool capabilities (completed 2026-03-04)
- [x] **Phase 23: Tiered Context Delivery** - Support seed and full context tiers so simple tasks get minimal injection (completed 2026-03-04)
- [ ] **Phase 24: Verification & Budget Gate** - Document 50%+ token reduction and enforce a token budget ceiling in CI

## Phase Details

### Phase 21: Tool & Workflow API
**Goal**: Add workflow composition to aof_dispatch so agents can define DAG workflows through MCP tools, trim tool descriptions to schema + one-liner, and merge projects skill into main skill
**Depends on**: Phase 20 (v1.3 complete)
**Requirements**: TOOL-01, TOOL-02, TOOL-03, TOOL-04
**Success Criteria** (what must be TRUE):
  1. aof_dispatch accepts a `workflow` parameter that lets agents compose DAG workflows (linear, review cycle, parallel fan-out) at task creation time
  2. Every tool definition in tools.ts has a description of one sentence or less, with no inline examples or redundant parameter documentation
  3. Projects skill content is merged into the main SKILL.md (single file injection, not two separate files)
  4. All tool parameters and schemas remain correct -- existing tests pass, no tool functionality is broken
  5. Workflow parameter is wired through handleAofDispatch to task creation with proper validation
**Plans:** 2/2 plans complete
Plans:
- [ ] 21-01-PLAN.md -- Trim tool descriptions, merge projects skill into main SKILL.md
- [ ] 21-02-PLAN.md -- Add workflow parameter to aof_dispatch with template resolution and DAG validation

### Phase 22: Compressed Skill
**Goal**: Agents receive a compact SKILL.md that accurately documents all tool capabilities (including the new workflow param), with proper DAG workflow guidance and org chart setup instructions
**Depends on**: Phase 21
**Requirements**: SKILL-01, SKILL-02, SKILL-03, SKILL-04, SKILL-05, SKILL-06
**Success Criteria** (what must be TRUE):
  1. Agent context includes a compressed SKILL.md covering all AOF tools, DAG workflow composition, and agent protocols
  2. SKILL.md contains no CLI reference section (agents don't run CLI commands)
  3. SKILL.md contains no notification events table (agents emit events via tools, not by consulting a reference table)
  4. SKILL.md uses minimal inline YAML examples for org chart concepts instead of verbose multi-line examples
  5. SKILL.md contains no parameter tables (tool JSON schemas already provide parameter documentation)
  6. SKILL.md includes org chart setup guidance sufficient for an agent to provision teams, agents, and routing
  7. DAG workflow section includes examples of linear, review cycle, and parallel fan-out patterns via aof_dispatch
**Plans:** 1/1 plans complete
Plans:
- [ ] 22-01-PLAN.md -- Write compressed SKILL.md and create skill.json manifest

### Phase 23: Tiered Context Delivery
**Goal**: Context injection supports two tiers so agents working on simple tasks receive a minimal seed, while complex tasks get the full skill
**Depends on**: Phase 22
**Requirements**: SKILL-07
**Success Criteria** (what must be TRUE):
  1. A seed tier exists that injects significantly less context than the full tier while still enabling agents to complete simple tasks
  2. A full tier exists that injects the complete compressed skill for complex tasks requiring workflow composition or org chart setup
  3. The tier selection mechanism is explicit and deterministic (not LLM-decided)
**Plans:** 2/2 plans complete
Plans:
- [ ] 23-01-PLAN.md -- Create SKILL-SEED.md, extend skill.json with tiers, add tier support to SkillManifest and SkillResolver
- [ ] 23-02-PLAN.md -- Wire contextTier through dispatch pipeline (MCP tool, store, task frontmatter) and update installer

### Phase 24: Verification & Budget Gate
**Goal**: The 50%+ context reduction is proven with before/after measurements and protected by an automated test that fails if context exceeds the budget
**Depends on**: Phase 22, Phase 23
**Requirements**: MEAS-01, MEAS-02
**Success Criteria** (what must be TRUE):
  1. A document exists showing before and after token counts for total context injection, proving at least 50% reduction
  2. An automated test (vitest) fails if total context injection for the full tier exceeds a defined token budget ceiling
  3. The token budget test runs in CI alongside existing tests
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 21 -> 22 -> 23 -> 24
(Phase 23 depends on Phase 22 only, so sequential execution is simplest.)

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation Hardening | v1.0 | 2/2 | Complete | 2026-02-26 |
| 2. Daemon Lifecycle | v1.0 | 3/3 | Complete | 2026-02-26 |
| 3. Gateway Integration | v1.0 | 2/2 | Complete | 2026-02-26 |
| 4. Memory Fix & Test Stabilization | v1.1 | 3/3 | Complete | 2026-02-26 |
| 5. CI Pipeline | v1.1 | 2/2 | Complete | 2026-02-26 |
| 6. Installer | v1.1 | 2/2 | Complete | 2026-02-26 |
| 7. Projects | v1.1 | 3/3 | Complete | 2026-02-26 |
| 8. Production Dependency Fix | v1.1 | 1/1 | Complete | 2026-02-26 |
| 9. Documentation & Guardrails | v1.1 | 5/5 | Complete | 2026-02-27 |
| 10. DAG Schema Foundation | v1.2 | 2/2 | Complete | 2026-03-03 |
| 11. DAG Evaluator | v1.2 | 2/2 | Complete | 2026-03-03 |
| 12. Scheduler Integration | v1.2 | 2/2 | Complete | 2026-03-03 |
| 13. Timeout, Rejection, Safety | v1.2 | 3/3 | Complete | 2026-03-03 |
| 14. Templates, Ad-Hoc API, Artifacts | v1.2 | 3/3 | Complete | 2026-03-03 |
| 15. Migration and Documentation | v1.2 | 3/3 | Complete | 2026-03-03 |
| 16. Integration Wiring Fixes | v1.2 | 1/1 | Complete | 2026-03-03 |
| 17. Migration Foundation & Framework Hardening | v1.3 | 3/3 | Complete | 2026-03-04 |
| 18. DAG-as-Default | v1.3 | 1/1 | Complete | 2026-03-04 |
| 19. Verification & Smoke Tests | v1.3 | 2/2 | Complete | 2026-03-04 |
| 20. Release Pipeline, Documentation & Release Cut | v1.3 | 1/1 | Complete | 2026-03-04 |
| 21. Tool & Workflow API | v1.4 | 2/2 | Complete | 2026-03-04 |
| 22. Compressed Skill | 1/1 | Complete    | 2026-03-04 | - |
| 23. Tiered Context Delivery | 2/2 | Complete   | 2026-03-04 | - |
| 24. Verification & Budget Gate | v1.4 | 0/? | Not started | - |
