# Projects v0 — Architecture Review (v2)
**Author:** swe-architect  
**Date:** 2026-02-11  
**Scope:** Review of `PROJECTS-V0-SPEC-v2.md` vs prior assessment and v1 spec.

---

## 1) Prior concerns addressed? (from 2026-02-10 assessment)

Below maps prior concerns to v2 changes.

### ✅ Addressed well
1. **Canonical paths are project-scoped**  
   - v2 §0.1 explicitly locks canonical task state under `Projects/<project_id>/tasks/<status>/`. This aligns with my prior note that Projects must be foundational and not an overlay.

2. **Status directory casing**  
   - v2 §0.2 makes status directories **lowercase**. This directly resolves the earlier mismatch risk with existing TaskStore and avoids cross-platform case issues.

3. **Task identity includes project_id**  
   - v2 §0.3 + §4.3 explicitly require project-scoped identity and protocol envelopes to carry `project_id`. This addresses the protocol ambiguity concern.

4. **Artifacts + run logs are project-scoped**  
   - v2 §0.4 places run logs/checkpoints under each project’s `state/`. This addresses the prior run artifacts misalignment with `dataDir/runs/<taskId>`.

5. **Vault root alignment**  
   - v2 §0.5 explicitly says canonical project roots live in the vault, not `dataDir`. This clarifies the “source of truth” alignment.

6. **Lowercase `_inbox`**  
   - v2 §1.2 normalizes the default project name to `_inbox` (lowercase), reducing casing churn.

7. **Views are derived-only**  
   - v2 §7 restates views as caches. This reinforces “no second source of truth.”

8. **Lint rules now include `_inbox` and no wildcard extraPaths**  
   - v2 §11 includes explicit `_inbox` check and `Projects/**` wildcard ban. This matches my guardrails concern.

### ✅ Addressed partially
1. **Memory enrollment caps**  
   - In v1 assessment I recommended a cap to prevent recall bloat. v2 mentions enrollment and warm paths but does **not** specify caps (open question moved to v1). This is a partial acknowledgement but still missing enforcement in v0.

2. **Governance of gold→_Core promotion**  
   - v2 keeps this as an open question (v1 style). It doesn’t add governance mechanics, which is fine for v0, but still needs a deferral note in implementation planning.

### ❌ Not addressed / still outstanding
1. **Migration/backcompat strategy**  
   - v2 §12 still says “no migration,” but does not define how legacy `dataDir/tasks` are handled. A bridging or one-time import path is still required for actual rollout.

2. **Tooling assumptions (URIs / CLI / context assembler)**  
   - The spec now says project-scoped addressing is canonical, but no mention of updating task URIs (`aof://tasks/<id>`) or CLI defaults. This remains implementation-critical.

---

## 2) New concerns introduced in v2 (not in v1)

1. **Project roots are in vault, not dataDir (§0.5)**  
   - This is an explicit decision; it introduces operational complexity (permissions, backup, performance) and requires the scheduler + TaskStore to work against the vault path instead of local `dataDir`. The implementation impact is larger than v1 implied.

2. **`views/` and `cold/` required in each project (§2.3)**  
   - v1 allowed views optional. v2 makes `views/` and `cold/` required. This is fine but will require updates to any bootstrap/lint routines.

3. **Protocol envelope fields are now explicitly defined (§4.3)**  
   - This adds pressure to update protocol types and router routing. It’s good clarity, but it means the protocol schema and any persistent envelopes must evolve.

4. **Default project name `_inbox` (lowercase)**  
   - v2 changes from `_Inbox`. This reduces casing issues but requires updates in any existing code/docs/configs that mention `_Inbox`.

---

## 3) Filesystem topology (Section 2): implementable with current TaskStore + Scheduler?

**Short answer: not without refactor.**

- Current TaskStore hardcodes `dataDir/tasks/<status>/`. v2 requires `mock-vault/Projects/<id>/tasks/<status>/` as **canonical**.
- The scheduler assumes a **single global store** and `store.list()` for all tasks. v2 requires a **per-project scan** with a registry.

**Implementation path (consistent with prior assessment):**
- Introduce **ProjectRegistry** for `Projects/*/project.yaml` discovery.
- Refactor TaskStore into **project-scoped stores**, or parametrize its root.
- Scheduler loops projects and invokes the project-scoped store.

**Therefore:** v2 topology is implementable, but **not** with the current TaskStore/Scheduler without changes.

---

## 4) Dispatcher integration (Section 8): multi-project scanning vs current scheduler architecture

**Current scheduler architecture is single-root; v2 expects multi-root.**

- v2’s multi-project scanning is feasible if the scheduler is updated to iterate over ProjectRegistry results.
- The TaskContext and DispatchExecutor must carry `project_id` and `task_relpath` (v2 §4.3) to avoid ambiguity.

**Conclusion:** multi-project scanning is compatible **only after** adding project-aware scheduling and task context changes. No inherent architectural blocker, but it’s a required refactor.

---

## 5) Task identity is project-scoped (§4.3): impact on protocol envelopes, router, lock manager

### Protocol envelopes
- Must **add `project_id`** to all protocol messages (completion, handoff, resume).
- Any stored envelopes or replay logs need versioning or fallback handling.

### Router
- Router must resolve tasks **by (project_id, task_relpath)** rather than `task_id` alone.
- This requires a project-aware TaskStore or a registry lookup.

### Lock manager / state
- Locks/checkpoints are now under `Projects/<id>/state/`. The lock manager must accept a project root or project id when creating paths.

**Net:** project-scoped identity is the right call, but it forces **protocol schema + routing + state IO updates** across the system.

---

## 6) Vault root alignment (§0.5): practical implications for dataDir vs vault paths

- **Canonical state lives in vault**, not `dataDir`. This reverses the current assumption that `dataDir` is canonical.
- AOF will need to accept a **vaultRoot** (or equivalent) for all canonical paths and treat `dataDir` as operational cache only.
- Implications:
  - **Permissions/IO:** vault may be on different volume; path validation and symlink safety become more important.
  - **Backups:** canonical data now rides with vault backup strategy.
  - **Testing:** current test harness likely uses `dataDir` fixtures; tests need to model vault root instead.

**Recommendation:** explicitly add `vaultRoot` config to service init and avoid using `dataDir` for any canonical paths except caches/logs.

---

## 7) Implementation complexity estimate (tasks, tests, blockers)

### Rough task breakdown (similar to prior assessment)
1. Project manifest schema + loader
2. Project registry discovery + `_inbox` enforcement
3. Project filesystem bootstrap + linter updates
4. Project-scoped TaskStore (rooted at vault)
5. Scheduler/dispatcher project loop + TaskContext updates
6. Protocol router/project-aware envelope + run artifacts in project state
7. Memory enrollment generator (project warm paths)
8. Tooling/context/URI updates (CLI, assembler, MCP)
9. Backcompat bridge or migration from legacy `dataDir/tasks`

### Test estimate
- **~90–130 new tests** (comparable to prior estimate) due to widespread path/routing changes.

### Likely blockers
- Protocol envelope versioning (if downstream consumers assume taskId-only).
- Vault root access in test + runtime configuration.
- Backcompat decision for existing `dataDir/tasks`.

---

## 8) Changes recommended before implementation begins

1. **Define migration/backcompat plan**  
   - Decide if legacy `dataDir/tasks` gets migrated to `_inbox`, or if a compatibility adapter will exist temporarily. This should be in v0 spec or an implementation addendum.

2. **Define `vaultRoot` in config explicitly**  
   - Make it a first-class config separate from `dataDir`. Avoid ambiguity in tooling.

3. **Protocol envelope versioning strategy**  
   - Add a version field or schema evolution plan so project_id changes don’t break existing logs or integrations.

4. **Memory enrollment caps for v0**  
   - Add a hard cap in v0 (even if default is high). This prevents recall explosion by default.

5. **Explicit updates for URIs and tooling**  
   - Document that task URIs, CLI shortcuts, and context assembly must include project_id or project path.

6. **Security hardening for vault paths**  
   - Add lint rule for symlink escape or path traversal to protect canonical vault root.

---

## Overall conclusion
v2 resolves the core architectural mismatches from my prior assessment (status casing, project-scoped identity, canonical vault placement, protocol envelope fields). It clarifies that Projects are foundational rather than an overlay. The remaining risks are **implementation-level**: migration/backcompat, protocol schema evolution, and vault root handling.

**Readiness:** v2 is a strong baseline for implementation, but **should not begin** until migration and config decisions are explicitly resolved.
