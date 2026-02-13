# Projects v0 — Implementation Design (AOF)
**Date:** 2026-02-11  
**Author:** swe-architect  
**Status:** Draft for implementation

## 1) Purpose
Implement Projects v0 as the canonical storage model for AOF, aligning with the v2 spec while keeping the system deterministic, filesystem-first, and project-scoped from day one.

This design incorporates PO feedback (agent context injection, invalid project.yaml handling, testable acceptance criteria) and explicitly excludes migration/rollback (greenfield).

## 2) Goals
- Canonical task state is **project-scoped** under `Projects/<project_id>/tasks/<status>/...`.
- Project manifests (`project.yaml`) are required, validated, and used for discovery.
- Scheduler/dispatcher scan **multiple projects** and operate per-project.
- Protocol envelopes include `project_id` and task addressing uses project-relative paths.
- Run artifacts and state are **project-scoped** under `Projects/<project_id>/state/`.
- Memory enrollment output is computed from project manifests (warm paths only).
- Agents receive explicit **project context** on spawn (env + README/manifest summary).
- Invalid `project.yaml` files are handled safely (skip + logged error).

## 3) Non-Goals (v0)
- **Migration tooling / rollback** (greenfield only per directive).
- **Automatic project creation** (no LLM routing).
- **Cross-project task dependencies**.
- **Project ACLs/permissions** (single-tenant assumption).
- **Subprojects / nested projects**.
- **Automatic artifact promotion** (manual move semantics only).
- **UI/visualization**.

## 4) Current Architecture (Summary)
- `TaskStore` is single-rooted at `dataDir/tasks/`.
- Scheduler scans a single `TaskStore` and assumes global task IDs.
- Protocol envelopes do **not** include `project_id`.
- Run artifacts are stored under `dataDir/runs/<taskId>/`.
- Views (mailbox/kanban) are derived under `dataDir/Agents/...`.
- Memory config generation uses org chart pools only.

## 5) Target Architecture

### 5.1 Canonical Paths
Rooted in vault:
```
<Vault>/Projects/<project_id>/
  project.yaml
  README.md
  tasks/<status>/
  artifacts/{bronze,silver,gold}/
  state/
  views/
  cold/
```

### 5.2 Config Updates
Add vault-aware configuration:
- `AofConfig.vaultRoot` (new) — absolute or relative path to vault root.
- `AOFServiceConfig.vaultRoot` (new) — runtime root for project discovery.
- `dataDir` remains for operational logs/metrics only.

### 5.3 Project Manifest Schema (`project.yaml`)
Introduce `ProjectManifest` in `src/schemas/project.ts` (Zod) matching spec v2:
- id, title, status, type
- owner, participants
- routing defaults
- memory enrollment (warm/cold paths)
- links

Validation rules:
- `id` matches directory name
- project IDs match regex `[a-z0-9][a-z0-9-]{1,63}`

### 5.4 Project Registry
New module: `src/projects/registry.ts`
- Discover projects by scanning `<vaultRoot>/Projects/*/project.yaml`
- Always include `_inbox` (create if missing)
- Skip `status: archived` by default
- Invalid manifests: log `project.validation.failed` + record error
- API returns `ProjectRecord[]` with `id`, `root`, `manifest`, `errors`, `warnings`

### 5.5 Project Linter
New module: `src/projects/lint.ts`
- Lints required dirs + medallion tiers
- Validates task frontmatter `project` matches project id
- Validates task status matches directory
- Ensures `_inbox` exists and not archived
- Checks that memory extraPaths do not include `Projects/**`

### 5.6 Project-Scoped TaskStore
Refactor `TaskStore` to accept a project root:
- `TaskStore` gains `rootDir` or `projectRoot` option
- `tasksDir` becomes `<projectRoot>/tasks`
- add `projectId` property for task creation

Task frontmatter update:
- Add required `project` field to `TaskFrontmatter`
- Lint tasks missing `project` or mismatched id

### 5.7 Run Artifacts + State
Run artifacts move to project state:
- `Projects/<id>/state/runs/<taskId>/run.json`
- `run_result.json`, `run_heartbeat.json` colocated

Update recovery/run-artifacts to resolve via store.projectRoot/state.

### 5.8 Protocol Envelope + Router
Update `ProtocolEnvelope`:
- Add `projectId` (alias: accept `project_id` inbound)
- Add `taskRelpath` (relative to project root)

Router changes:
- Resolve project store by `projectId`
- Enforce project/task match
- Invalid project_id → log reject

### 5.9 Scheduler / Service
New multi-project polling:
- Use `ProjectRegistry` to list active projects
- For each project, create a scoped `TaskStore` and poll
- Aggregate per-project stats

### 5.10 Agent Context Injection
Dispatcher must pass project context:
- Env vars: `AOF_PROJECT_ID`, `AOF_PROJECT_ROOT`
- TaskContext includes `projectId` + `taskRelpath`
- Inject `README.md` excerpt + manifest summary into initial context

### 5.11 Memory Enrollment Output
Extend memory generator to include project warm paths:
- For each project, enrolled agents get:
  - `Projects/<id>/artifacts/silver`
  - `Projects/<id>/artifacts/gold`
- Produce artifact: `Resources/OpenClaw/Ops/Config/recommended-memory-paths.yaml`

## 6) Error Handling Strategy
- Invalid `project.yaml`:
  - Record error in registry result
  - Emit `project.validation.failed` event
  - Skip project (does not crash scheduler)
- Project missing required dirs:
  - Linter report written under `Projects/<id>/state/lint-report.md`
  - Scheduler continues best-effort

## 7) Testing Strategy (3-gate)
Each task adds unit tests (Gate 1). QA validation includes BDD scenarios (Gate 2). Mule integration covers end-to-end project dispatch (Gate 3).

## 8) Implementation Plan (Sequenced Tasks)

1. **TASK-2026-02-11-065** — Project manifest schema + registry + config vaultRoot
2. **TASK-2026-02-11-066** — Project bootstrap + linter + invalid manifest handling
3. **TASK-2026-02-11-067** — Project-scoped TaskStore + task frontmatter project field + run artifacts path
4. **TASK-2026-02-11-068** — Protocol envelope + router updates (projectId + taskRelpath)
5. **TASK-2026-02-11-069** — Scheduler/AOFService multi-project polling + agent context injection
6. **TASK-2026-02-11-070** — CLI/tools/views project awareness + views under `Projects/<id>/views/`
7. **TASK-2026-02-11-071** — Memory enrollment generation from project manifests

## 9) Open Decisions (Confirmed for v0)
- **Lowercase status dirs**: matches current `TaskStatus` enums; proceed.
- **Migration**: explicitly out of scope (greenfield directive).
- **VaultRoot**: new config field required; default must be explicit (no silent fallback to dataDir).

## 10) Risks & Mitigations
- **Wide surface change**: mitigate via staged tasks and unit coverage.
- **Protocol schema evolution**: accept both `projectId` and `project_id` in parsing.
- **Performance of discovery**: cache project list in registry; re-scan on interval.

---

## Appendix A — Acceptance Criteria (Summary by Capability)
(Full BDD scenarios from PM review are referenced in QA.)
- Project discovery returns all active projects and always includes `_inbox`.
- Invalid `project.yaml` is skipped and logged.
- Task files include `project` frontmatter matching project id.
- Protocol envelopes require projectId; router rejects missing/invalid.
- Scheduler dispatches across projects with per-project stores.
- Agents receive `AOF_PROJECT_ID` and `AOF_PROJECT_ROOT` on spawn.
- Memory extraPaths include only silver/gold per enrolled agents.
