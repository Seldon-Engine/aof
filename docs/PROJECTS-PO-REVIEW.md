# Projects v0 - Product Owner Coherence Review

**Reviewer:** swe-po (Product Owner)  
**Review Date:** 2026-02-11  
**Spec Version:** v2 (PROPOSED)  
**Spec Location:** `~/Projects/AOF/docs/PROJECTS-V0-SPEC-v2.md`  
**Vision Doc:** `memory/projects/aof/vision.md`  
**Status:** **CONDITIONAL APPROVAL**

---

## Executive Summary

The Projects v0 spec (v2) represents a **significant evolution** that transforms AOF from a single-workspace orchestrator into a **multi-project deterministic fabric**. This change is **foundational and non-reversible** — it redefines canonical storage topology and must be correct from day 1.

**Overall Assessment:** **APPROVE with critical conditions**

The spec advances core AOF vision principles (filesystem-as-API, deterministic transitions, observability) while adding essential multi-team capabilities. However, the v2 revision introduces **executive decisions** that are architecturally sound but require **implementation safeguards** to prevent ecosystem fragmentation.

**Key Strengths:**
- ✅ Aligns with filesystem-as-API principle (project-scoped canonical state)
- ✅ Composable with existing primitives (Tasks, Scheduler, Protocols, Memory v2)
- ✅ Medallion architecture provides clean content maturity model
- ✅ Memory enrollment prevents recall explosion
- ✅ `_inbox` provides backward compatibility anchor

**Critical Concerns:**
- ⚠️ **Migration is underspecified** — existing deployments WILL break without it (P0)
- ⚠️ **Executive decision 0.1** (project-scoped canonical paths) is correct but requires migration tooling BEFORE v0 ships
- ⚠️ **Executive decision 0.2** (lowercase dirs) conflicts with existing AOF conventions (`Tasks/` vs `tasks/`) — needs explicit migration path
- ⚠️ **Acceptance criteria missing** — PM review has 42 BDD scenarios but spec §12 has only vague bullets

**Verdict:**
- **Ship sequence:** Migration tooling → Projects v0 (NOT the reverse)
- **MVP scope:** Right-sized IF migration is included; too risky WITHOUT it
- **Product risk:** High (breaking change to canonical topology) but necessary for multi-project future

---

## 1. Vision Alignment Analysis

### 1.1 Core Principles Served

| Vision Principle | How Projects v0 Advances It | Evidence |
|------------------|------------------------------|----------|
| **Filesystem-as-API** | ✅ **STRONG** | Project-scoped canonical paths (`Projects/<id>/tasks/`) make filesystem the single source of truth; no database dependency introduced |
| **Tasks as files** | ✅ **PRESERVED** | Tasks remain markdown + YAML frontmatter with atomic `rename()` transitions; project scoping adds namespace, doesn't change semantics |
| **Derived views** | ✅ **PRESERVED** | `views/` subdirectory explicitly marked as derived; project manifest is canonical, views are caches |
| **No LLM in scheduler** | ✅ **PRESERVED** | Project discovery is filesystem scan; routing logic is YAML-driven; no LLM involvement |
| **Observable by default** | ✅ **ENHANCED** | Project lifecycle events (created, archived, triage) add new observability surface; promotion logs track artifact maturity |
| **Deterministic** | ✅ **ENHANCED** | Project-scoped state (`state/` subdir) enables per-project checkpoints and cursors without cross-project interference |

**Conclusion:** Projects v0 is **vision-aligned** across all core principles. No violations detected.

---

### 1.2 Primitives Composability Check

AOF vision requires primitives to "work independently and compose together."

| Primitive | Composes with Projects? | Concerns | Mitigation |
|-----------|-------------------------|----------|------------|
| **Tasks** | ✅ YES | Task identity now includes `project_id` — protocol envelopes must be updated | Spec §4.3 addresses this; PM review has BDD scenarios |
| **Scheduler** | ✅ YES | Dispatcher must scan multiple project roots instead of single `tasks/` dir | Performance concern at scale (50+ projects); needs benchmarking |
| **Protocols** | ✅ YES | Resume/completion/handoff protocols carry `project_id` in envelope | Spec §4.3 confirms; no backward compat issues if migration handles it |
| **Memory v2** | ✅ YES | Hot/Warm/Cold tiers map cleanly to Medallion Bronze/Silver/Gold | Spec §6 explicitly aligns; enrollment logic prevents bloat |

**Concern:** Scheduler performance at scale (50+ projects × N tasks each) is **unvalidated**. Dispatcher polls may slow down if discovery is naïve.

**Recommendation:** Add acceptance criterion to §12: "Dispatcher discovery completes in <100ms for ≤50 projects."

---

### 1.3 Vision Principle: "No Database Dependency"

**Question:** Does Projects v0 introduce database-like complexity through `project.yaml` manifests?

**Analysis:**
- Manifests are YAML files (filesystem-native) ✅
- Discovery is `ls Projects/*/project.yaml` (no index needed) ✅
- No schema migrations or transactions required ✅
- Linter enforces schema validity at creation time (fail-fast) ✅

**Verdict:** No violation. Manifests are structured files, not a database.

---

## 2. Vision Violations & Scope Creep Assessment

### 2.1 Potential Violations

#### ❌ **NONE DETECTED** in core design

The spec does NOT:
- Introduce LLM-based routing (preserved determinism ✅)
- Create hidden state outside filesystem (all state in `Projects/` tree ✅)
- Add workflow engine abstractions (remains code-first ✅)
- Require UI for operation (CLI-first, UI optional ✅)

---

### 2.2 Scope Creep Concerns

| Feature | Scope Creep? | Rationale | Verdict |
|---------|--------------|-----------|---------|
| **Medallion tiers** (Bronze/Silver/Gold) | ⚠️ BORDERLINE | Not strictly required for "Projects" primitive; could be deferred to "Artifacts v1" | **ACCEPTABLE** — provides necessary memory scoping guidance; without it, agents would index raw logs |
| **Memory enrollment logic** (§6-7) | ❌ NO | Required to prevent recall explosion when projects multiply | **NECESSARY** |
| **Project archiving** (§10) | ❌ NO | Lifecycle management is essential for multi-project deployments | **NECESSARY** |
| **Linter rules** (§11) | ❌ NO | Prevents drift and invalid state; aligns with "observable by default" | **NECESSARY** |
| **Governance & drift** (§9) | ⚠️ BORDERLINE | Could be deferred to ops tooling outside AOF | **ACCEPTABLE** — drift detection is observability, fits vision |

**Conclusion:** No significant scope creep. Medallion tiers are the only "extra" feature, but they solve a real problem (memory indexing explosion) that would otherwise block multi-project adoption.

---

### 2.3 Non-Goals Violations

From vision doc: *"Not a workflow engine, not a database replacement, not agent-framework-specific, not a UI product."*

**Check:**
- Workflow engine? ❌ No BPMN, no drag-and-drop — still code-first ✅
- Database replacement? ❌ Still filesystem-only ✅
- Agent-framework-specific? ❌ Spec is OpenClaw-aware but not dependent (manifest schema is generic) ✅
- UI product? ❌ Spec defers visualization to v1+ ✅

**Verdict:** No non-goal violations.

---

## 3. Executive Decisions Soundness Review

### Section 0: Executive Decisions (Locked for v0)

These are **architectural commitments** that cannot be changed post-v0 without breaking migration.

---

#### 0.1 Canonical paths are project-scoped

**Decision:** `Projects/<project_id>/tasks/<status>/...` (no global `tasks/` root)

**Product Perspective:**
- ✅ **CORRECT** — enables true multi-project isolation
- ✅ Aligns with filesystem-as-API (projects are first-class filesystem entities)
- ⚠️ **HIGH RISK** — breaks existing AOF deployments that use `~/.openclaw/aof/tasks/`

**Conditions for soundness:**
1. **MUST HAVE:** Migration script that moves existing tasks to `Projects/_inbox/tasks/` BEFORE v0 ships
2. **MUST HAVE:** Rollback mechanism (restore from backup)
3. **MUST HAVE:** Idempotent migration (can be re-run safely)

**PM Review Status:** PM review (§C.2) proposes migration script outline ✅  
**Spec Status:** Migration NOT in §12 MVP scope ❌

**VERDICT:** **Sound decision, but BLOCKING without migration tooling.**

**Recommendation:** Add to §12 MVP:
```markdown
- [ ] Migration script: move existing tasks from `~/.openclaw/aof/tasks/` to `Projects/_inbox/tasks/`
- [ ] Migration backup: create `tasks.backup-<timestamp>/` before migration
- [ ] Migration idempotency: detect already-migrated tasks and skip
```

---

#### 0.2 Status directories are lowercase

**Decision:** `backlog/ ready/ in-progress/ blocked/ review/ done/ _templates/`

**Product Perspective:**
- ✅ Reduces cross-platform issues (case sensitivity on Linux vs macOS)
- ⚠️ **CONFLICTS** with existing AOF conventions (`Tasks/` vs `tasks/` in original spec v1)
- ⚠️ **CONFLICTS** with OpenClaw conventions (Resources/OpenClaw uses TitleCase)

**Analysis:**
- Original spec v1: `Tasks/Backlog/` (TitleCase)
- Spec v2: `tasks/backlog/` (lowercase)
- This is a **normalization choice**, not a functional requirement

**Questions:**
1. Does AOF codebase currently use TitleCase or lowercase?
2. Will this require code changes in dispatcher/executor?
3. Is this change worth the churn?

**VERDICT:** **Sound for new projects, but requires explicit migration path for existing code.**

**Recommendation:**
- If AOF codebase is already lowercase: ✅ Ship as-is
- If AOF codebase uses TitleCase: ⚠️ This decision introduces refactor debt — quantify impact before locking

**Action Required:** Architect should confirm current AOF casing conventions and impact scope.

---

#### 0.3 Task identity is project-scoped

**Decision:** Task IDs unique within project only; protocol envelopes carry `project_id`

**Product Perspective:**
- ✅ **CORRECT** — avoids global ID collisions across projects
- ✅ Aligns with distributed system best practices (scoped namespaces)
- ✅ Protocols already have envelope structure; adding `project_id` is non-breaking if optional field

**Conditions:**
- Protocol envelope schema MUST include `project_id` field (required for project tasks, optional for backward compat)
- Dispatcher MUST pass `project_id` when spawning agents

**PM Review Status:** PM review §C.3 proposes env vars `AOF_PROJECT_ID` and `AOF_PROJECT_ROOT` ✅

**VERDICT:** **Sound. No blockers.**

---

#### 0.4 Run artifacts are project-scoped by default

**Decision:** Run logs/checkpoints under `Projects/<project_id>/state/`; global system log is append-only observability only

**Product Perspective:**
- ✅ **CORRECT** — prevents cross-project state pollution
- ✅ Aligns with deterministic principle (each project's state is isolated)
- ✅ Global system log preserves observability without making it canonical

**VERDICT:** **Sound. No blockers.**

---

#### 0.5 Vault root alignment

**Decision:** Project roots live in vault (`mock-vault/Projects/`), not in AOF's internal `dataDir`

**Product Perspective:**
- ✅ **CORRECT** — treats vault as source of truth (aligns with OpenClaw memory model)
- ✅ Avoids dual storage (canonical in vault, cache in dataDir)
- ⚠️ **ASSUMES** vault is always available and stable (what if vault is on network mount?)

**Question:** What happens if vault is unavailable at dispatcher startup?
- Graceful degradation? (skip project discovery, continue with cached state)
- Hard fail? (refuse to start)

**VERDICT:** **Sound, but needs availability/failure handling spec.**

**Recommendation:** Add to §9 (Governance & Drift):
```markdown
### 9.3 Vault Unavailability
- If vault root is unreachable, dispatcher emits `vault.unreachable` event
- Dispatcher continues with last known project list (cached discovery)
- Tasks cannot be dispatched until vault is restored
- Alert via Matrix if vault is down >5 minutes
```

---

### Summary: Executive Decisions Scorecard

| Decision | Sound? | Blockers | Action Required |
|----------|--------|----------|-----------------|
| 0.1 Project-scoped paths | ✅ YES | ❌ Migration missing | Add migration to §12 MVP |
| 0.2 Lowercase status dirs | ⚠️ YES (if codebase aligns) | ⚠️ Impact unknown | Architect confirm casing conventions |
| 0.3 Project-scoped task ID | ✅ YES | ❌ NONE | None |
| 0.4 Project-scoped run artifacts | ✅ YES | ❌ NONE | None |
| 0.5 Vault root alignment | ✅ YES | ⚠️ Failure handling underspecified | Add vault unavailability handling to §9 |

**Overall:** 3/5 decisions are ship-ready; 2/5 need clarification/tooling.

---

## 4. MVP Scope Assessment (Section 12)

### 4.1 Current MVP Scope (from §12)

```markdown
Minimum for v0:
- filesystem structure + linter
- manifest schema + discovery
- dispatcher support for multi-project scanning
- task addressing/protocol includes `project_id`
- enrollment logic outputs warm paths: `artifacts/silver` + `artifacts/gold`
- `_inbox` triage loop
```

**Deferred:**
```markdown
- UI visualization
- cross-project dependencies
- automatic promotion (keep "move semantics" manual first)
```

---

### 4.2 Product Assessment: Is This Right-Sized?

#### **Too Much?**

❌ NO. Every listed item is **essential** for Projects to function:
- Filesystem structure: without this, there's no project primitive
- Linter: prevents drift and invalid state (observability requirement)
- Manifest + discovery: dispatcher needs to find projects
- Task addressing: tasks must know which project they belong to
- Enrollment logic: without this, memory recall explodes (non-functional)
- `_inbox` triage: without this, backward compatibility breaks

**Verdict:** No scope reduction possible.

---

#### **Too Little?**

⚠️ **YES.** Critical gaps:

| Missing Component | Why It's Critical | Impact if Deferred |
|-------------------|-------------------|---------------------|
| **Migration tooling** | Existing AOF setups break without it | **BLOCKING** — cannot ship v0 |
| **Agent context injection** | Agents won't know project scope | **BLOCKING** — agents will fail |
| **Error handling (invalid manifest)** | Dispatcher may crash | **HIGH** — production stability risk |
| **Rollback plan** | If v0 breaks production, no recovery path | **HIGH** — deployment risk |
| **Performance validation** (50+ projects) | Dispatcher may slow to unusable speeds | **MEDIUM** — scalability unknown |

**Verdict:** MVP scope is **incomplete**. Must add:
1. Migration script (P0)
2. Agent context injection spec (P0)
3. Error handling for malformed manifests (P1)
4. Rollback procedure (P1)

---

### 4.3 Comparison with PM Review

PM Review §A.2 proposes **7 revised acceptance criteria** with specific, testable conditions:
1. Filesystem structure validation
2. Manifest schema validation with error events
3. Dispatcher discovery with performance SLA (<100ms for ≤50 projects)
4. Memory enrollment with cap warning
5. **Migration with data integrity checks** ✅
6. **Agent context injection via env vars** ✅
7. Triage loop (manual v0, automated v1)

**Assessment:** PM's revised acceptance criteria are **significantly better** than spec §12.

**Recommendation:** **REPLACE** spec §12 with PM review §A.2 verbatim.

---

### 4.4 Right-Sized MVP Definition

**Minimum v0 (with conditions):**
- ✅ Filesystem structure + linter (as specified)
- ✅ Manifest schema + discovery (as specified)
- ✅ Dispatcher multi-project scanning (as specified)
- ✅ Task addressing with `project_id` (as specified)
- ✅ Memory enrollment logic (as specified)
- ✅ `_inbox` default project (as specified)
- ➕ **ADDED:** Migration script (move tasks to `_inbox`)
- ➕ **ADDED:** Agent context injection (env vars + workspace)
- ➕ **ADDED:** Error handling (invalid manifests)
- ➕ **ADDED:** Rollback plan
- ➕ **ADDED:** Performance validation (≤50 projects)

**Deferred to v0.1:**
- Enrollment cap hard limit (soft warning in v0)
- Automated triage (manual in v0)
- Cross-project dependencies
- UI visualization
- Automatic promotion

**Verdict:** With additions, MVP scope is **right-sized**.

---

## 5. Non-Goals: Missing Exclusions

### 5.1 Current Non-Goals (from vision)

- Not a workflow engine
- Not a database replacement
- Not agent-framework-specific
- Not a UI product

**Assessment:** These are **system-level non-goals**, not feature-level.

---

### 5.2 Recommended Additions (Project-Specific Non-Goals)

Projects v0 should explicitly exclude:

| Non-Goal | Why Exclude? | Risk if Not Excluded |
|----------|--------------|----------------------|
| **Automatic project creation from tasks** | Adds LLM-based routing complexity | Violates deterministic principle |
| **Cross-project task dependencies** | Requires DAG solver across projects | Out of scope for v0; defer to v1 |
| **Project permissions/ACLs** | Requires auth system; AOF is single-tenant | Scope creep into identity management |
| **Multi-vault projects** | Adds distributed state complexity | Breaks filesystem-as-API assumption |
| **Project templates from registry** | Requires network calls, versioning | Adds external dependency |
| **Automatic artifact promotion** | Requires scoring/ML heuristics | Violates no-LLM-in-control-plane |
| **Sub-projects (nested hierarchies)** | Adds recursive discovery complexity | Defer to v1+ |

**Recommendation:** Add to spec §1 (Definitions) or new §1.5 (Non-Goals):

```markdown
### 1.5 Non-Goals (Projects v0)

The following are explicitly out of scope for v0:

- **Automatic project creation:** Projects are created manually or via explicit automation. No LLM-based routing of tasks to inferred projects.
- **Cross-project dependencies:** Tasks within a project may have dependencies; dependencies ACROSS projects are deferred to v1.
- **Project permissions/ACLs:** AOF is single-tenant. Multi-tenant access control is not planned.
- **Multi-vault projects:** All projects live in a single vault root. Distributed/federated projects are not supported.
- **Automatic artifact promotion:** Promotion from Bronze → Silver → Gold is manual (filesystem move). Scoring-based promotion is deferred to v1.
- **Sub-projects:** Projects cannot contain other projects (no nesting). Use links for related initiatives.
```

---

## 6. Acceptance Criteria Assessment

### 6.1 Current State (Spec §12)

**Problem:** Spec §12 lists **bullet points**, not **testable criteria**.

Example:
```markdown
- filesystem structure + linter
```

**What does "done" look like?**
- Does linter run at creation time? At dispatch time? On cron?
- What happens if lint fails? Hard fail? Warning?
- What's the performance SLA?

**Verdict:** **Insufficient.** Not testable.

---

### 6.2 PM Review Acceptance Criteria

PM Review §A.2 provides **7 categories** with **checkboxes and measurable outcomes**:

Example:
```markdown
3. **Dispatcher Discovery**
   - [ ] Dispatcher discovers all `status: active` projects
   - [ ] `_Inbox` always included regardless of status
   - [ ] Discovery performance: <100ms for ≤50 projects
```

**This is testable:**
- Binary pass/fail (checkbox)
- Measurable (performance SLA)
- Clear failure condition

**Verdict:** **PM review criteria are production-quality.**

---

### 6.3 Capability Breakdown: "Done" Definitions

For each major capability in §12, define "done":

| Capability | "Done" Looks Like |
|------------|-------------------|
| **Filesystem structure** | `aof create-project <id>` creates all required dirs; linter passes; project.yaml validates |
| **Linter** | Linter runs on project creation (blocking); emits `project.lint.passed` or `project.lint.failed` event; report written to `State/lint.log` |
| **Manifest schema** | Invalid YAML fails with parse error; missing required fields fail validation; dispatcher skips invalid projects |
| **Discovery** | Dispatcher finds all `status: active` projects; `_Inbox` always included; discovery <100ms for ≤50 projects |
| **Task addressing** | Task files include `projectId` in frontmatter; protocol envelopes include `project_id` field; dispatcher passes `AOF_PROJECT_ID` env var |
| **Enrollment logic** | Enrolled agents get `Artifacts/Silver` + `Artifacts/Gold` in `extraPaths`; non-enrolled agents excluded; no `Projects/**` wildcards allowed |
| **_Inbox triage** | Tasks can be moved from `_Inbox/tasks/backlog/` to `<project>/tasks/backlog/` via `aof triage` command; `projectId` updated; `task.triaged` event logged |

**Recommendation:** Add these definitions to spec §12 or create new §12.1 "Acceptance Criteria."

---

### 6.4 BDD Scenario Coverage (from PM Review)

PM Review §B provides **42 BDD scenarios** covering:
- Project creation & discovery (5 scenarios)
- _Inbox default project (5 scenarios)
- Dispatcher multi-project (4 scenarios)
- Memory enrollment (6 scenarios)
- Medallion tiers & promotion (7 scenarios)
- Archiving (5 scenarios)
- Linter rules (10 scenarios)

**Assessment:**
- ✅ Comprehensive coverage (happy path, edge cases, error cases)
- ✅ Gherkin format (Given/When/Then) is testable
- ✅ Maps directly to QA test plan

**Recommendation:** **ADOPT** PM review BDD scenarios as official acceptance criteria. Add reference to spec §12:

```markdown
### 12.1 Acceptance Criteria

See PM review (PROJECTS-PM-REVIEW.md) §B for detailed BDD scenarios covering all v0 capabilities.

High-level checklist:
- [ ] Project creation & discovery (5 scenarios)
- [ ] _Inbox default project (5 scenarios)
- [ ] Dispatcher multi-project (4 scenarios)
- [ ] Memory enrollment (6 scenarios)
- [ ] Medallion tiers & promotion (7 scenarios)
- [ ] Archiving (5 scenarios)
- [ ] Linter rules (10 scenarios)

**Total:** 42 scenarios. All must pass before v0 ships.
```

---

## 7. Composability Concerns

### 7.1 Interaction with Existing Primitives

#### **Tasks Primitive**

**Current State (pre-Projects):**
- Tasks live in `~/.openclaw/aof/tasks/{status}/`
- Task ID is globally unique
- No project scoping

**Post-Projects State:**
- Tasks live in `Projects/<project_id>/tasks/{status}/`
- Task ID is project-scoped (unique within project only)
- Task frontmatter includes `projectId`

**Composability Analysis:**
- ✅ Task state machine semantics unchanged (still move = status)
- ✅ Task file format unchanged (still markdown + YAML frontmatter)
- ⚠️ **BREAKING:** Task addressing changes (paths now include project ID)
- ⚠️ **BREAKING:** Protocol envelopes must include `project_id`

**Mitigation:**
- Migration script updates task frontmatter with `projectId: _inbox`
- Protocol schemas add optional `project_id` field (backward compat: default to `_inbox`)
- Dispatcher updated to scan project-scoped task dirs

**Verdict:** **Composable with migration.**

---

#### **Scheduler Primitive**

**Current State:**
- Dispatcher polls single `tasks/ready/` directory
- Lease-based locking prevents double-dispatch
- DAG dependencies tracked in task frontmatter

**Post-Projects State:**
- Dispatcher polls ALL `Projects/*/tasks/ready/` directories
- Lease files scoped per project (`Projects/<id>/state/leases/`)
- DAG dependencies still tracked in task frontmatter (no change)

**Composability Analysis:**
- ✅ Lease-based locking still works (scoped per project, no cross-project collisions)
- ✅ DAG dependencies within project unchanged
- ⚠️ **NEW COMPLEXITY:** Cross-project dependencies not supported in v0 (deferred)
- ⚠️ **PERFORMANCE RISK:** Polling 50 project directories may slow dispatcher

**Mitigation:**
- Discovery caching (scan projects on init, rescan on change events only)
- Performance SLA: <100ms for ≤50 projects (acceptance criterion)

**Verdict:** **Composable with performance validation.**

---

#### **Protocols Primitive**

**Current State:**
- Resume, completion, handoff, routing protocols
- Envelopes carry task metadata (task_id, status, assigned_to)
- No project scoping

**Post-Projects State:**
- Envelopes include `project_id` field
- Resume/completion protocols unchanged semantically
- Handoff may cross projects (triage from `_inbox` to target project)

**Composability Analysis:**
- ✅ Protocol semantics unchanged (resume/complete/handoff still valid)
- ✅ Adding `project_id` to envelope is backward-compatible (optional field)
- ✅ Triage is a specialized handoff (move task between projects)

**Verdict:** **Fully composable.** No breaking changes.

---

#### **Memory v2 Primitive**

**Current State:**
- Hot: `Resources/OpenClaw/_Core/` (always indexed)
- Warm: per-agent `extraPaths` (manually configured)
- Cold: excluded by omission

**Post-Projects State:**
- Hot: unchanged (`Resources/OpenClaw/_Core/`)
- Warm: **auto-computed** from project enrollment + Medallion tiers
  - `Projects/<id>/artifacts/silver` (enrolled agents)
  - `Projects/<id>/artifacts/gold` (enrolled agents)
- Cold: `Projects/<id>/artifacts/bronze`, `Projects/<id>/state`, `Projects/<id>/tasks`

**Composability Analysis:**
- ✅ Hot tier unchanged (no impact)
- ✅ Warm tier **enhanced** (auto-enrollment reduces manual config burden)
- ✅ Cold tier **clarified** (explicit exclusions prevent indexing bloat)
- ⚠️ **NEW DEPENDENCY:** AOF must compute `extraPaths` and communicate to OpenClaw config

**Question:** Who owns the `extraPaths` configuration?
- Spec §6.3: "AOF owns generating enrollment; OpenClaw owns `memorySearch.extraPaths` setting per agent."
- Implication: AOF produces an artifact (recommended config); humans apply it.

**Verdict:** **Composable, but handoff mechanism underspecified.**

**Recommendation:** Clarify in spec §6.3:

```markdown
### 6.3 Ownership boundary: AOF vs OpenClaw config

**AOF Responsibility:**
- Compute enrolled projects per agent (based on `project.yaml` participants + team)
- Generate recommended `extraPaths` list for each agent
- Write artifact: `Resources/OpenClaw/Ops/Config/recommended-memory-paths.yaml`

**Human/Automation Responsibility:**
- Review recommended paths
- Update per-agent config files (`agents/<agent-id>/config.yaml`)
- Restart agents to pick up new paths

**OpenClaw Responsibility:**
- Read `memorySearch.extraPaths` from agent config
- Index specified paths
- No awareness of project enrollment logic (stays dumb)

**v0 Expectation:** Manual config update. v0.1+ may automate via config sync.
```

---

### 7.2 Cross-Primitive Dependency Graph

```
Projects v0
    ├─ depends on → Tasks (reuses state machine, file format)
    ├─ depends on → Scheduler (dispatcher, lease-based locking)
    ├─ depends on → Protocols (envelope schema for project_id)
    ├─ depends on → Memory v2 (Hot/Warm/Cold topology)
    └─ consumed by → (future primitives: Workflows, Multi-Tenancy, etc.)
```

**Risk:** Projects v0 is **foundational**. If it breaks, downstream primitives break.

**Mitigation:**
- Comprehensive test coverage (42 BDD scenarios from PM review)
- Rollback plan (restore from backup)
- Phased rollout (staging first, prod after validation)

**Verdict:** **High-risk, high-value primitive.** Must be correct on first try.

---

## 8. Critical Product Concerns

### 8.1 Migration Is Non-Optional

**Problem:** Spec §12 MVP does NOT include migration tooling.

**Impact:**
- Existing AOF deployments will break on upgrade to v0
- Tasks in `~/.openclaw/aof/tasks/` will be orphaned
- Dispatcher will not discover old tasks (looking in `Projects/` instead)

**Severity:** **P0 BLOCKER**

**Recommendation:** Migration script is **REQUIRED** for v0 ship. Add to §12:

```markdown
### 12.1 Migration Tooling (REQUIRED for v0)

**Migration Script:** `aof migrate-to-projects`

**Behavior:**
1. Check if `~/.openclaw/aof/tasks/` exists
2. If yes:
   - Create `Projects/_inbox/` with all required subdirs
   - Move all tasks to `Projects/_inbox/tasks/{same-status}/`
   - Update task frontmatter: add `projectId: _inbox`
   - Backup original `tasks/` to `tasks.backup-<timestamp>/`
   - Log migration summary (task count, errors)
3. If no:
   - Assume fresh install; create `_inbox` and exit

**Acceptance Criteria:**
- [ ] Migration is idempotent (can re-run safely)
- [ ] No data loss (all tasks moved)
- [ ] Backup created before migration
- [ ] Migration <5 seconds for 1000 tasks
- [ ] Rollback script available (`aof rollback-migration`)

**Test Plan:**
- Test with 0 tasks (fresh install)
- Test with 100 tasks (typical deployment)
- Test with 1000 tasks (stress test)
- Test with corrupted task files (error handling)
- Test rollback (restore from backup)
```

---

### 8.2 Agent Context Injection Underspecified

**Problem:** Spec mentions "dispatcher passes project context" but doesn't specify HOW.

**Impact:**
- Agents spawn without knowing which project they're in
- Agents cannot reference correct artifact paths
- Task execution fails or produces outputs in wrong location

**Severity:** **P0 BLOCKER**

**Recommendation:** Add to spec §8.2 (Spawning rules):

```markdown
### 8.2 Spawning rules (project context injection)

When spawning an agent for a task in a project, dispatcher MUST:

1. **Pass environment variables:**
   - `AOF_PROJECT_ID=<project_id>`
   - `AOF_PROJECT_ROOT=<dataDir>/Projects/<project_id>`

2. **Pass task metadata:**
   - `task_relpath` (relative to project root, e.g., `tasks/ready/TASK-123.md`)
   - `task_id` (from task frontmatter)
   - `project_id` (from task frontmatter)

3. **Inject workspace context:**
   - Add `Projects/<project_id>/README.md` to agent's initial context (budget: 500 tokens)
   - Add project manifest summary (title, owner, participants)

4. **Optional: Role-relevant runbooks:**
   - Include Silver/Gold artifacts from enrolled projects (via Memory v2 recall)

**Acceptance Criteria:**
- [ ] Agent can read `$AOF_PROJECT_ID` and `$AOF_PROJECT_ROOT`
- [ ] Agent workspace includes project README
- [ ] Agent can navigate to `$AOF_PROJECT_ROOT/artifacts/` and write outputs
```

---

### 8.3 Lowercase vs TitleCase Directory Conventions

**Problem:** Spec v2 uses lowercase (`tasks/`, `artifacts/`); original spec v1 used TitleCase (`Tasks/`, `Artifacts/`).

**Impact:**
- If AOF codebase currently uses TitleCase, this change requires refactor across dispatcher, executor, linter
- If OpenClaw conventions are TitleCase (e.g., `Resources/OpenClaw/`), mixing conventions is confusing

**Severity:** **P1 — not blocking, but needs decision BEFORE implementation starts**

**Questions:**
1. What does current AOF codebase use?
2. What does OpenClaw vault structure use?
3. Is consistency across AOF+OpenClaw worth the migration cost?

**Recommendation:**
- **Option A (consistency):** Adopt lowercase everywhere (AOF + OpenClaw). Requires migration across entire vault.
- **Option B (pragmatic):** Use lowercase for new projects, keep TitleCase in `Resources/OpenClaw/` (existing convention). Accept inconsistency.
- **Option C (status quo):** Revert spec v2 to TitleCase (`Tasks/`, `Artifacts/`), align with current codebase.

**Action Required:** Architect must assess current state and recommend option.

---

### 8.4 Performance at Scale

**Problem:** Dispatcher must scan `Projects/*/project.yaml` on every poll.

**Impact:**
- With 50+ projects, discovery may slow poll loop
- Slow polls delay task dispatch
- System feels sluggish

**Severity:** **P2 — not blocking, but needs validation**

**Recommendation:** Add performance acceptance criterion to §12:

```markdown
- [ ] Dispatcher discovery performance: <100ms for ≤50 projects
- [ ] Discovery is cached; rescan only on filesystem change events (inotify/fswatch)
- [ ] Benchmark: measure discovery time with 10, 50, 100 projects
```

**Mitigation:**
- Implement discovery caching (scan on init, rescan on change)
- Use filesystem watchers (inotify) to detect new/changed projects
- Defer full rescan to background cron (every 5 minutes)

---

### 8.5 Vault Unavailability Handling

**Problem:** Spec §0.5 assumes vault is always available. What if it's not?

**Impact:**
- Vault on network mount becomes unavailable (network partition)
- Dispatcher cannot scan projects
- System grinds to halt

**Severity:** **P1 — not blocking for v0, but needs design**

**Recommendation:** Add to spec §9 (Governance & Drift):

```markdown
### 9.3 Vault Unavailability

**Failure Mode:** Vault root (`mock-vault/Projects/`) is unreachable (network mount down, permissions issue, etc.)

**Detection:**
- Dispatcher emits `vault.unreachable` event if project discovery fails
- Alert via Matrix if vault down >5 minutes

**Behavior:**
- Dispatcher continues with **cached project list** (last successful discovery)
- Tasks in `ready/` status can still be dispatched (lease files may be stale)
- No new tasks can be created (filesystem writes fail)
- System is degraded but not halted

**Recovery:**
- When vault restored, dispatcher resumes normal discovery
- Emit `vault.restored` event
- Rescan projects and reconcile state
```

---

## 9. Summary of Recommendations

### 9.1 Blocking Changes (P0 — must address before v0 ships)

| # | Recommendation | Location | Owner |
|---|----------------|----------|-------|
| 1 | **Add migration tooling to MVP scope** | §12 | Backend + PM |
| 2 | **Specify agent context injection** (env vars + workspace) | §8.2 | Architect + Backend |
| 3 | **Replace vague MVP bullets with testable acceptance criteria** | §12 | PM (adopt PM review §A.2) |
| 4 | **Add error handling for invalid project.yaml** | §8.1 | Backend |
| 5 | **Add rollback plan** (restore from backup) | new §13 | Backend + Ops |

---

### 9.2 High-Priority Changes (P1 — should address before v0 ships)

| # | Recommendation | Location | Owner |
|---|----------------|----------|-------|
| 6 | **Clarify lowercase vs TitleCase convention** | §0.2 | Architect (confirm current state) |
| 7 | **Add vault unavailability handling** | §9.3 | Architect + Backend |
| 8 | **Add non-goals (project-specific exclusions)** | §1.5 | PM (this review) |
| 9 | **Clarify AOF→OpenClaw handoff for extraPaths** | §6.3 | Architect |

---

### 9.3 Nice-to-Have Changes (P2 — can defer to v0.1)

| # | Recommendation | Location | Owner |
|---|----------------|----------|-------|
| 10 | **Add performance SLA for discovery** (<100ms for ≤50 projects) | §12 | Backend |
| 11 | **Implement discovery caching** (inotify-based rescan) | §8.1 | Backend |
| 12 | **Add enrollment cap hard limit** (warning in v0, enforcement in v0.1) | §7.3 | Backend |

---

## 10. Ship/No-Ship Decision

### 10.1 Current State

**Spec v2 as written:** ❌ **NOT SHIPPABLE**

**Reasons:**
1. Migration tooling missing (P0 blocker)
2. Agent context injection underspecified (P0 blocker)
3. Acceptance criteria not testable (P0 blocker)
4. Rollback plan missing (P0 blocker)

---

### 10.2 Conditional Approval

**APPROVE Projects v0 IF:**

1. ✅ Migration script added to MVP scope (§12) with acceptance criteria from PM review §C.2
2. ✅ Agent context injection specified in §8.2 (env vars + workspace)
3. ✅ MVP acceptance criteria replaced with PM review §A.2 (42 BDD scenarios)
4. ✅ Error handling added for invalid project.yaml (§8.1)
5. ✅ Rollback plan documented (new §13)
6. ✅ Architect confirms lowercase vs TitleCase convention (§0.2)
7. ✅ Vault unavailability handling added (§9.3)

**Timeline:**
- Address P0 blockers (1-5): **REQUIRED before implementation starts**
- Address P1 items (6-7): **REQUIRED before v0 ships to production**
- Address P2 items: **Can ship v0 without these; add in v0.1**

---

### 10.3 Recommended Ship Sequence

```
Phase 1: Security fixes (if any pending)
  └─ Ship AOF security patches (symlink escapes, injection surface, etc.)

Phase 2: Projects v0 Prep (address P0 blockers)
  ├─ Write migration script + tests
  ├─ Specify agent context injection
  ├─ Adopt PM review acceptance criteria
  ├─ Add error handling for invalid manifests
  └─ Document rollback plan

Phase 3: Projects v0 Implementation
  ├─ Implement filesystem structure + linter
  ├─ Implement manifest schema + validation
  ├─ Update dispatcher for multi-project discovery
  ├─ Update protocols to include project_id
  ├─ Implement enrollment logic
  └─ Implement _inbox + migration script

Phase 4: Projects v0 Testing
  ├─ Run 42 BDD scenarios (PM review §B)
  ├─ Performance validation (≤50 projects)
  ├─ Migration testing (0, 100, 1000 tasks)
  └─ Rollback testing

Phase 5: Projects v0 Ship
  ├─ Deploy to staging
  ├─ Validate on real tasks
  ├─ Deploy to production
  └─ Monitor for 48 hours

Phase 6: Projects v0.1 (follow-up)
  ├─ Enrollment cap hard limit
  ├─ Automated triage
  ├─ Discovery caching (inotify)
  └─ Cross-project dependencies (if needed)
```

---

## 11. Final Verdict

**Product Owner Decision:** ✅ **CONDITIONAL APPROVAL**

Projects v0 is a **necessary evolution** that enables AOF to scale from single-workspace to multi-project, multi-team deployments. The design is **vision-aligned** and **architecturally sound**.

However, the spec as written is **incomplete**. The executive decisions (§0) are correct but introduce **breaking changes** that require **migration tooling** and **rollback safeguards** to ship safely.

**Conditions for approval:**
1. Add migration tooling to MVP scope (**P0 blocker**)
2. Specify agent context injection mechanism (**P0 blocker**)
3. Replace vague MVP bullets with PM review's testable acceptance criteria (**P0 blocker**)
4. Add error handling and rollback plan (**P0 blocker**)
5. Clarify lowercase/TitleCase conventions (**P1**)
6. Add vault unavailability handling (**P1**)

**If conditions are met:** ✅ **SHIP Projects v0**

**If conditions are NOT met:** ❌ **DEFER to v0.1** (too risky to ship incomplete)

---

## 12. Coherence Score

| Criterion | Score | Notes |
|-----------|-------|-------|
| **Vision alignment** | 9/10 | Strong alignment with all core principles; minor gap in non-goals |
| **Composability** | 8/10 | Composes well with existing primitives; minor handoff gaps (AOF→OpenClaw memory config) |
| **Executive decisions** | 7/10 | Sound decisions, but 2/5 need clarification/tooling before ship |
| **MVP scope** | 6/10 | Right features, but missing critical tooling (migration, rollback) |
| **Acceptance criteria** | 4/10 | Spec §12 is vague; PM review §A.2 is excellent (adopt it) |
| **Non-goals** | 7/10 | System-level non-goals clear; project-specific non-goals missing |
| **Testability** | 8/10 | PM review provides 42 BDD scenarios (excellent); spec should reference them |

**Overall Coherence:** **7.0/10** — Good foundation, needs implementation safeguards.

---

## Appendix A: Comparison with PM Review

PM Review (PROJECTS-PM-REVIEW.md) is **comprehensive and high-quality**. Key overlaps and differences:

| Topic | PM Review | This Review (PO) | Alignment |
|-------|-----------|------------------|-----------|
| Migration tooling | ✅ Detailed script outline (§C.2) | ✅ Required for v0 MVP | **ALIGNED** |
| Acceptance criteria | ✅ 42 BDD scenarios (§B) | ✅ Adopt PM scenarios | **ALIGNED** |
| Agent context injection | ✅ Env vars + workspace (§C.3) | ✅ Same recommendation | **ALIGNED** |
| Executive decisions | ⚠️ Not deeply reviewed | ✅ Reviewed all 5 decisions | **COMPLEMENTARY** |
| Vision alignment | ❌ Not in scope for PM | ✅ Core PO responsibility | **COMPLEMENTARY** |
| Performance validation | ✅ Recommended (<100ms SLA) | ✅ Agreed | **ALIGNED** |
| Rollback plan | ✅ Recommended | ✅ Required | **ALIGNED** |

**Conclusion:** PM review and PO review are **highly aligned**. Together they provide complete coverage.

---

## Appendix B: Open Questions for Architect

1. **Lowercase vs TitleCase:** What is current AOF codebase convention? (`tasks/` or `Tasks/`?)
2. **Performance:** What's the estimated discovery time for 50 projects with current implementation?
3. **Memory handoff:** Should AOF write `extraPaths` directly to agent configs, or produce artifact for manual application?
4. **Vault stability:** Is vault on local disk or network mount? What's the failure mode?
5. **Migration scope:** Are there other filesystem conventions (besides status dirs) that need migration?

---

**END OF PRODUCT OWNER REVIEW**
