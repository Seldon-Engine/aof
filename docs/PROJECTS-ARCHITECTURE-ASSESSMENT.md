# Projects v0 — Architecture Assessment (AOF)

**Author:** swe-architect  
**Date:** 2026-02-10  
**Scope:** Compatibility analysis + implementation decomposition for Projects v0 MVP (spec §13), with explicit references to current AOF code paths.

---

## Executive Summary
Projects v0 introduces a **project-scoped filesystem topology** (`mock-vault/Projects/<id>/...`) and project manifests as the primary routing + memory-enrollment source. The current AOF architecture assumes a **single global task root** under `dataDir/tasks/<status>/` with **lowercase status directories** and **global protocol handling**. This is a **structural mismatch** that affects **TaskStore**, **scheduler/dispatcher**, **protocols**, **context assembly**, and **memory scoping**. 

To implement Projects v0 safely, we need a **project registry layer** and **project-scoped task stores**, or a **TaskStore refactor** that can address a configurable per-project base path. Additionally, **protocol message routing must gain project context** (or a deterministic lookup strategy) to avoid ambiguity across projects.

---

## A) Compatibility Analysis

### 1) TaskStore ↔ Projects
**Current design:**
- `src/store/task-store.ts` hardcodes `tasksDir = resolve(dataDir, "tasks")` and expects `tasks/<status>/<id>.md` (lowercase status dirs: `backlog`, `ready`, `in-progress`, `blocked`, `review`, `done`).
- `TaskStore.init()` creates these status directories under `dataDir/tasks/`.
- Task IDs are global (no project scoping), and `TaskStore.get()` scans all status directories in that single root.

**Projects v0 requirement:**
- Canonical paths become `mock-vault/Projects/<projectId>/Tasks/<status>/` with **titlecase** status names in the spec (`Backlog`, `Ready`, `In-Progress`, ...). 
- `_Inbox` must exist as a default project.

**Compatibility impact:**
- **Breaking**: TaskStore’s path assumptions (`dataDir/tasks` and lowercase statuses) conflict with project-scoped hierarchy and casing.
- **Breaking**: Task ID lookup becomes ambiguous across projects unless projectId is included or tasks are namespaced.
- **Additive**: We can preserve current behavior as a special case of a project-aware TaskStore rooted at `_Inbox`, but the spec wants the canonical root under `Projects/`.

**Implication:**
- Need a **project-scoped TaskStore** (e.g., `TaskStore(projectRoot)` or `ProjectTaskStore(projectId)`), or a **TaskStore refactor** to allow `tasksDir` base path and **status directory mapping** (lowercase ↔ titlecase).
- Must decide if **status directory names** remain lowercase for compatibility, or if the project spec should be adapted to lowercase to avoid churn across code/tests/tools.

### 2) Dispatcher / Scheduler / Executor
**Current design:**
- Scheduler in `src/dispatch/scheduler.ts` calls `store.list()` to scan **all tasks globally** and then plans actions.
- Dispatch action builds `TaskContext` in `src/dispatch/scheduler.ts` with `{ taskId, taskPath, agent, priority, routing }` and hands it to `DispatchExecutor.spawn()` (`src/dispatch/executor.ts`).

**Projects v0 requirement:**
- Dispatcher scans `mock-vault/Projects/*/project.yaml` (skipping archived), uses project-level routing + participant enrollment.
- Spawning should pass `projectId`, task path, project README, and relevant runbooks.

**Compatibility impact:**
- **Breaking**: Scheduler’s global scan assumes a single task store. Must become project-aware.
- **Breaking**: `TaskContext` lacks `projectId`; executor cannot infer project scope.
- **Additive**: Add `projectId` to `TaskContext` + route based on project manifest enrollment.

**Recommended change pattern:**
- Introduce a **ProjectRegistry** that discovers projects (`Projects/*/project.yaml`) and yields `ProjectContext` objects (id, rootPath, status, manifest).
- Scheduler either:
  - (A) loops over projects and runs `poll(projectTaskStore, ...)` per project, or
  - (B) gets refactored to accept a **multi-project store interface** (prefer A for simpler isolation).
- Executor interface updated to include `projectId` and `projectRoot` and `taskPath` remains fully-qualified.

### 3) Protocols Primitive (completion, handoff, resume)
**Current design (post-P2.3):**
- Protocol router (`src/protocol/router.ts`) uses `TaskStore.get(taskId)` and `TaskStore.transition(taskId, ...)` with **no project context**.
- `writeRunResult` / `readRunResult` in `src/recovery/run-artifacts.ts` resolve run artifacts under `<dataDir>/runs/<taskId>/` using store.tasksDir to find dataDir.
- Delegation handoff artifacts are written under `tasks/<status>/<taskId>/inputs/` via `src/delegation/index.ts` (invoked from protocol router).

**Projects v0 implications:**
- **Ambiguous task resolution**: protocol messages containing `taskId` alone are insufficient once tasks are project-scoped.
- **Run artifacts location**: spec expects deterministic state under `Projects/<id>/State/` (not currently used). Runs are currently **global** at `<dataDir>/runs/`.
- **Handoff artifacts** remain under task companion dirs, but the base path changes.

**Compatibility impact:**
- **Breaking**: Protocol router must be project-aware; otherwise ambiguous task lookups or accidental cross-project transitions.
- **Design decision**: include `projectId` in the **protocol envelope** or add a deterministic resolution strategy (e.g., taskId uniqueness across all projects — risky).
- **Additive**: relocate or namespace run artifacts per project (e.g., `Projects/<id>/State/runs/<taskId>/`). This aligns with spec’s `State/` directory.

### 4) Other code path assumptions
The following modules **assume `tasks/<status>/` is global** and will need project-aware resolution:
- **Context assembly**: `src/context/assembler.ts` constructs `taskCardPath = tasks/<status>/<taskId>.md` when `task.path` missing.
- **Tools/CLI**: `src/tools/aof-tools.ts`, `src/dispatch/aof-dispatch.ts`, CLI and docs assume `tasks/` root.
- **Lints & views**: `TaskStore.lint()` scans `dataDir/tasks/` and detects non-standard directories; derived views assume canonical paths.
- **MCP resources**: `src/mcp/resources.ts` uses `aof://tasks/<id>` with no project scoping.

**Conclusion:** Projects v0 is **not additive** to the current task root; it requires a **multi-project abstraction** and **project-aware API surface**.

---

## B) Implementation Decomposition (v0 MVP §13)

Below are **implementation tasks (design briefs)** with dependencies and test estimates. Counts are rough and assume vitest with existing patterns.

### Task 1 — Project Manifest Schema + Loader
- **Objective:** Create schema and loader for `project.yaml` with validation.
- **Scope:**
  - Add `src/schemas/project.ts` (manifest schema per spec §3).
  - Add loader module (e.g., `src/projects/loader.ts`) to read/validate.
- **Acceptance:** Valid/invalid manifests parsed correctly; id matches folder.
- **Dependencies:** None.
- **Estimated Tests:** 8–12 (schema parse + validation errors).

### Task 2 — Project Registry + Discovery
- **Objective:** Discover active projects by scanning `Projects/*/project.yaml`.
- **Scope:**
  - New module (e.g., `src/projects/registry.ts`).
  - Supports `_Inbox` default, skip archived (per spec §9, §11).
- **Acceptance:** Detects projects + handles missing/invalid manifests (drift report).
- **Dependencies:** Task 1.
- **Estimated Tests:** 8–10 (discovery, archived skip, `_Inbox` enforcement).

### Task 3 — Project Filesystem Bootstrap + Linter
- **Objective:** Enforce required structure + project lint rules (spec §12).
- **Scope:**
  - New linter module (separate from `TaskStore.lint()`), e.g., `src/projects/lint.ts`.
  - Validate required dirs: `Tasks/`, `Artifacts/`, `State/`, `Cold/` and medallion tiers.
- **Acceptance:** Detects missing dirs, invalid manifest id, forbidden paths.
- **Dependencies:** Task 1.
- **Estimated Tests:** 10–14.

### Task 4 — Project-Scoped TaskStore
- **Objective:** Support `Projects/<id>/Tasks/<status>/` as canonical task root.
- **Scope:**
  - Refactor `TaskStore` to accept `tasksRoot` (or introduce `ProjectTaskStore`).
  - Decide casing policy: keep lowercase status dirs or map to Titlecase.
- **Acceptance:** Create/list/transition tasks inside project root.
- **Dependencies:** Task 2.
- **Estimated Tests:** 12–18 (store CRUD + transition + lint in project scope).

### Task 5 — Scheduler / Dispatcher Project Loop
- **Objective:** Run scheduling across projects and pass project context to executor.
- **Scope:**
  - Update `SchedulerConfig` and `TaskContext` to include `projectId` and `projectRoot`.
  - Update `src/dispatch/scheduler.ts` to accept project-scoped store or a project loop driver in `AOFService`.
- **Acceptance:** Actions and spawn context include projectId; scheduler works per project.
- **Dependencies:** Task 2 + Task 4.
- **Estimated Tests:** 10–16 (dispatch per project, project scoping).

### Task 6 — Protocol Router Project Context
- **Objective:** Ensure protocol messages resolve to correct project.
- **Scope:**
  - Extend protocol envelope to include `projectId` (or new routing policy). 
  - Update `src/protocol/router.ts` to use project-aware store lookup.
  - Update run artifacts path to project `State/` (if chosen).
- **Acceptance:** Completion/handoff/resume operate within correct project.
- **Dependencies:** Task 4 + Task 5.
- **Estimated Tests:** 12–18 (protocol routing + completion/resume in project scope).

### Task 7 — Memory Enrollment Generator (Projects)
- **Objective:** Compute `memorySearch.extraPaths` from project manifests (Silver/Gold only).
- **Scope:**
  - Extend or supplement `src/memory/generator.ts` to merge project enrollment rules.
  - Implement cap logic for enrolled projects (spec §7.3).
- **Acceptance:** Only Silver/Gold paths included; Cold excluded; enrollment respects participants/teams.
- **Dependencies:** Task 1 + Task 2.
- **Estimated Tests:** 10–14 (enrollment logic, caps, deny list).

### Task 8 — Tooling/Context/Views Updates
- **Objective:** Update modules that hardcode `tasks/<status>` paths.
- **Scope:**
  - Context assembly (`src/context/assembler.ts`), tools (`src/tools/aof-tools.ts`), dispatch CLI, MCP URIs.
  - Add project awareness or full task path handling.
- **Acceptance:** All paths resolve correctly for project-scoped tasks.
- **Dependencies:** Task 4.
- **Estimated Tests:** 8–12.

### Task 9 — `_Inbox` + Migration/Backcompat Strategy
- **Objective:** Provide default `_Inbox` project and controlled migration from legacy `dataDir/tasks`.
- **Scope:**
  - Bootstrap `_Inbox` structure in Projects root.
  - Define migration or bridging for legacy tasks.
- **Acceptance:** System works without manual migration; clear upgrade path.
- **Dependencies:** Task 2 + Task 4.
- **Estimated Tests:** 6–10.

**Suggested order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9.

---

## C) Roadmap Placement

**Current context:** Protocols primitive is completed (P2.3+). Security audit findings are pending.

**Recommendation:**
1. **Address security audit findings first** — Projects v0 touches filesystem layout, memory scopes, and path inclusion/exclusion, which are **security-sensitive** (indexing / injection surface). Implementing Projects before audit fixes risks compounding findings.
2. After audit fixes: Projects v0 can be a **Phase 5 initiative** with explicit migration plan.

**Effort estimate:**
- **Tasks:** 8–10 implementation tasks as above.
- **Tests:** ~86–124 new tests total (broad refactors + path logic + memory enrollment + protocol routing).
- **Risk:** Medium–High due to filesystem + routing + protocol changes.

---

## D) Risks & Open Questions

### Spec Open Questions (§14)
1) **Promote Gold into `_Core` via approvals workflow?**
   - **Risk:** Without approvals, accidental elevation into Hot memory increases recall noise and security risk.
   - **Recommendation:** Defer to v1. For v0, keep promotion manual with explicit governance doc + optional lint rule. 

2) **Cap enrolled project count per role?**
   - **Risk:** Without cap, memorySearch extraPaths bloat can degrade recall + cost. 
   - **Recommendation:** Implement a **configurable cap** in memory generator (e.g., per agent/role), with deterministic selection (prefer Gold-only, then Silver, ordered by manifest priority or recency). This is required for v0 to prevent recall explosion.

3) **Subprojects vs links/dependencies?**
   - **Risk:** Subprojects introduce recursive scanning + identity ambiguity. 
   - **Recommendation:** For v0, express subprojects as **links in project.yaml**; avoid nested Projects directories. Implement in v1 if a strong use case emerges.

### Additional Architectural Risks
- **Task ID collisions across projects:** Current TaskStore assumes global uniqueness. Either enforce **global uniqueness** (hard), or include `projectId` in task IDs or lookups.
- **Status directory casing mismatch:** Spec uses `Backlog/Ready/In-Progress`; code uses lowercase. Decide now or risk pervasive churn. Strongly recommend **lowercase** for v0 to minimize code churn and case-sensitivity errors on macOS/Linux.
- **Protocol envelope lacks project context:** Completion/handoff/resume become ambiguous without projectId. This is a must-fix before Projects v0.
- **Run artifacts location:** Spec’s `State/` is intended for deterministic state (locks, cursors, checkpoints). Current run artifacts live under `<dataDir>/runs/<taskId>` tied to the TaskStore root. We need a clear, project-scoped mapping.
- **Views + MCP resource URIs:** Current URIs (`aof://tasks/<id>`) do not include project scope. This will break if project-scoped tasks are introduced.
- **Migration risk:** Existing tasks in `dataDir/tasks` must map to `_Inbox` or be migrated to `Projects/<id>/Tasks`. Any automated migration should be reversible and logged.

### Design Decisions Requiring Clarification
1) **Canonical status directory casing** (lowercase vs Titlecase) — impacts TaskStore, scheduler, docs, tests.
2) **ProjectId inclusion in task IDs or protocol envelopes** — must avoid ambiguity.
3) **Run artifact location** — stay in global `runs/` or move to project `State/`.
4) **Project root location** — align `dataDir` with `mock-vault/Projects` or support dual roots.

---

## Key Code References (for main agent)
- **TaskStore:** `src/store/task-store.ts` (global `dataDir/tasks/<status>/` layout)
- **Scheduler:** `src/dispatch/scheduler.ts` (global `store.list()`; `TaskContext`)
- **Executor interface:** `src/dispatch/executor.ts` (no project context)
- **AOFService:** `src/service/aof-service.ts` (single TaskStore)
- **Protocol router:** `src/protocol/router.ts` (taskId-only routing)
- **Run artifacts:** `src/recovery/run-artifacts.ts` (`<dataDir>/runs/<taskId>`)
- **Context assembly:** `src/context/assembler.ts` (hardcoded `tasks/<status>/` fallback)
- **Memory generator:** `src/memory/generator.ts` (org-chart only; no project enrollment)

---

## Final Notes
Projects v0 is a **foundational primitive** that requires a **systemic refactor** of AOF’s storage and routing model. It is not a thin overlay. To keep risk controlled, implement **project registry + scoped TaskStore** first, then **scheduler/dispatcher integration**, then **protocol and memory enrollment updates**.
