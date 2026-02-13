# Projects v0 Spec (AOF / Deterministic Ops Fabric)
Status: **PROPOSED (v0)**
Last updated: 2026-02-11
Goal: Introduce a **Project** primitive that supports multi-project work without a later refactor/migration, while aligning with **Memory v2 (Hot/Warm/Cold)** and a **Medallion architecture** for artifacts + recall.

This revision incorporates implementation feedback: **Projects are foundational (not additive)**, so v0 defines **project-scoped canonical state** as the default storage model from day 1.

---

## 0. Executive decisions (locked for v0)

### 0.1 Canonical paths are project-scoped (no global `tasks/` root)
- Canonical task state lives at: `Projects/<project_id>/tasks/<status>/...`
- Any global "views" are derived caches only (never canonical).

### 0.2 Status directories are lowercase
To minimize churn and reduce cross-platform issues:
- `backlog/ ready/ in-progress/ blocked/ review/ done/ _templates/`

### 0.3 Task identity is **project-scoped**
- A task's identity always includes `project_id`.
- IDs must be unique only within a project, but protocol envelopes always carry `project_id`.

### 0.4 Run artifacts are project-scoped by default
- All run logs/checkpoints belong under each project's `state/` subtree.
- AOF may also maintain a **global** system log (append-only) for observability, but it is never the canonical run record.

### 0.5 Vault root alignment
- **Project roots live in the vault**, not in AOF's internal data dir.
- AOF's `dataDir` stores operational state only (optional); canonical artifacts/tasks live in the vault.
- If OpenClaw is already treating the vault as the data lake, AOF should treat it as the **source of truth**.

---

## 1. Definitions

### 1.1 Project
A **Project** is a durable, named container for work that:
- owns **tasks**, **artifacts**, and **state**
- can be **multi-agent** and **multi-team**
- provides stable filesystem topology for deterministic orchestration

### 1.2 Default project
AOF defines a default project named:
- **`_inbox`** - the landing zone for untriaged work

Rationale: all-lowercase keeps conventions consistent with status dirs.

### 1.3 Medallion architecture (content maturity)
Medallion tiers apply to **project artifacts**:
- **Bronze (raw):** messy/transient/high-volume
- **Silver (refined):** normalized/deduped/summarized
- **Gold (canonical):** compact, authoritative references

### 1.4 Memory v2 tiers (indexing surface)
Memory v2 controls **what gets indexed/recalled**:
- **Hot:** `Resources/OpenClaw/_Core/` (tiny canonical docs; always indexed)
- **Warm:** selected domain directories (indexed per role)
- **Cold:** excluded from indexing (noise + prompt-injection surface reduction)

Projects must be arranged so that:
- Silver/Gold are naturally "warm"
- Bronze/logs/approvals remain "cold" by omission

---

## 2. Filesystem topology

### 2.1 Canonical project root
All canonical projects live under:

`mock-vault/Projects/<project_id>/`

Constraints:
- `<project_id>` is filesystem-safe: `[a-z0-9][a-z0-9-]{1,63}`
- Stable identifier; title can change without renaming the folder

Example:
`mock-vault/Projects/email-autopilot/`

### 2.2 Default project
`mock-vault/Projects/_inbox/` exists and is always present.

### 2.3 Required substructure (v0)
Each project MUST contain:

```
Projects/<project_id>/
  project.yaml
  README.md

  tasks/                      # canonical task state machine (deterministic)
  artifacts/                  # medallion-tier outputs (feeds memory)
  state/                      # locks, cursors, checkpoints, run logs
  views/                      # derived views (read-only by default)
  cold/                       # explicitly cold (excluded by default from memory)
```

#### Notes
- `tasks/` and `state/` are operational substrate; treat as **cold** for memory recall.
- `artifacts/silver` and `artifacts/gold` are the warm recall surface.

---

## 3. Project manifest (`project.yaml`)

### 3.1 Schema (v0)
`project.yaml` is required and is the source of truth for:
- routing defaults
- enrollment (who is allowed to index project warm artifacts)
- metadata for UI/rollups

```yaml
id: email-autopilot
title: Email Autopilot
status: active            # active | paused | archived
type: swe                 # swe | ops | research | admin | personal | other

owner:
  team: swe               # org-chart team id
  lead: swe-pm            # agent id (or human id)

participants:
  agents:
    - swe-architect
    - swe-backend
    - swe-qa
  teams:
    - swe                 # optional extra enrollment beyond participants

routing:
  intake: backlog         # default landing column within tasks/
  mailboxes: true         # whether mailbox view is enabled for this project

memory:
  # Enrollment: who gets this project's warm artifacts in memorySearch.extraPaths
  enroll:
    teams: [swe]
    agents: [swe-pm]      # optional explicit allowlist additions
  # Index intent by tier/path (AOF uses this to build extraPaths)
  warm_paths:
    - artifacts/silver
    - artifacts/gold
  cold_paths:
    - tasks
    - state
    - cold
    - artifacts/bronze

links:
  repo: ""                # optional
  dashboards: []          # optional
  docs: []                # optional
```

### 3.2 Stability rules
- `id` must match directory name
- changes should be append-logged (recommended): `state/project-changelog.md`

---

## 4. Deterministic task mapping (project-scoped)

### 4.1 Canonical task state machine
Within each project:

```
tasks/
  backlog/
  ready/
  in-progress/
  blocked/
  review/
  done/
  _templates/
```

Rules:
- **Move = status** (atomic rename within same filesystem)
- Task files should remain small; use checklists to encode process.

### 4.2 Task file format (v0)
A task is a single markdown file with YAML frontmatter.

Required fields:
```yaml
id: t-20260211-0007        # unique within project
project: email-autopilot   # MUST match project.yaml id (redundant for safety)
title: "Implement OAuth refresh path"
status: in-progress        # derived from directory; must match (linted)
assigned_to: swe-backend   # optional
owner_team: swe            # optional
priority: p1               # p0|p1|p2|p3
created_at: 2026-02-11T00:00:00Z
updated_at: 2026-02-11T00:00:00Z
```

### 4.3 Task identity and addressing
**Canonical address** of a task:
- `Projects/<project_id>/tasks/<status>/<task_id>.md`

**Protocol envelope fields** (used by dispatcher/executor):
- `project_id`
- `task_relpath` (relative to project root)
- `task_id` (frontmatter)

No global uniqueness assumptions.

---

## 5. Medallion mapping (project artifacts)

### 5.1 Artifact tiers
```
artifacts/
  bronze/        # raw outputs, dumps, scrape results, verbose logs
  silver/        # refined, deduped, normalized
  gold/          # canonical, short, stable references
  _promotion-log.md  # optional append-only log
```

### 5.2 Promotion rules (v0; filesystem-first)
Promotion is performed by moving a file:
- Bronze → Silver: `mv artifacts/bronze/foo.md artifacts/silver/foo.md`
- Silver → Gold: `mv artifacts/silver/foo.md artifacts/gold/foo.md`

Promotion should include:
- `promoted_from: bronze|silver` in frontmatter (optional but recommended)
- an append entry in `_promotion-log.md` (recommended)

No scoring thresholds; no post-filter scripts.

---

## 6. Memory v2 alignment (indexing by topology)

### 6.1 Principle
**Control what gets indexed by controlling paths**, not scoring.

### 6.2 Default indexing intent
Warm index candidates (per enrollment):
- `Projects/<id>/artifacts/silver/**`
- `Projects/<id>/artifacts/gold/**`

Cold by omission:
- `Projects/<id>/artifacts/bronze/**`
- `Projects/<id>/tasks/**`
- `Projects/<id>/state/**`
- `Projects/<id>/cold/**`

### 6.3 Ownership boundary: AOF vs OpenClaw config
- **AOF owns**: generating per-agent project enrollment and emitting the intended warm paths list (for humans/agents to apply).
- **OpenClaw owns**: the actual `memorySearch.extraPaths` setting per agent.

v0 expectation: AOF produces an **artifact** (and optionally a patch) that updates per-agent memory scopes, but it does not require OpenClaw core changes.

---

## 7. Views (project-scoped, derived)

Views MUST NOT become a second source of truth.

Recommended:
```
views/
  mailbox/                 # per-agent per-project mailbox view (if enabled)
  kanban/                  # derived snapshots/exports
  rollups/                 # weekly status etc.
```

Rule:
- canonical state is in `tasks/` + `artifacts/`
- views are caches and may be regenerated

---

## 8. Dispatcher integration (project-native)

### 8.1 Discovery
Dispatcher discovers projects by scanning:
- `mock-vault/Projects/*/project.yaml`

Rules:
- skip `status: archived` unless configured
- always include `_inbox`

### 8.2 Spawning rules
When spawning an agent for a task:
- pass `project_id`
- pass task path/address
- pass role-relevant runbooks (Hot/Warm pools)
- optionally include `README.md` excerpt (budgeted)

### 8.3 Idempotency
Mutations to canonical state are:
- atomic file moves (status transitions)
- append-only logs in `state/` (audit)

---

## 9. Governance and drift

### 9.1 Drift types
- project exists on disk but missing from org chart
- org chart references missing project
- participant agent missing in OpenClaw agents list
- too many enrolled projects causing recall bloat

### 9.2 Handling (v0)
- continue operating best-effort
- emit drift report artifact (example location):
  - `Resources/OpenClaw/Ops/Status/drift-projects.md`
- alert via Matrix for high-severity drift

No hard-fail unless configured.

---

## 10. Archiving

Archiving:
- set `project.yaml: status: archived`
- move to: `mock-vault/Projects/_archived/<project_id>/`

Archived projects are treated as cold by default:
- not enrolled into any agent warm memory paths

---

## 11. Lint rules (must-have)

AOF linter checks:
1. `project.yaml` exists and `id` matches folder
2. required dirs exist: `tasks/ artifacts/ state/ views/ cold/`
3. `artifacts/` has `bronze/ silver/ gold/`
4. task `status` matches directory (lint)
5. task `project` matches `project.yaml id`
6. no global wildcard extraPaths like `Projects/**` (prevent recall explosion)
7. `_inbox` exists and is not archived

---

## 12. Migration from Legacy Vault

AOF includes a migration tool to safely transition legacy single-project vaults to Projects v0.

**Legacy layout:**
```
tasks/
events/
views/
state/
```

**Migrated layout:**
```
Projects/_inbox/
  tasks/
  events/
  views/
  state/
  artifacts/
  cold/
  project.yaml
```

**Migration features:**
- Automatic backup to `tasks.backup-<timestamp>/`
- Preserves all files (task cards, companion directories, JSON artifacts, non-.md files)
- Updates task frontmatter to include `project: "_inbox"` (only task cards, not companion files)
- Idempotent (safe to re-run, skips already-migrated task cards)
- Supports dry-run and rollback

**Commands:**
```bash
# Migrate with backup
aof migrate

# Preview without changes
aof migrate --dry-run

# Rollback to legacy layout
aof rollback
```

See [migration.md](./migration.md) for detailed guide.

---

## 13. MVP to ship Projects v0

Minimum for v0:
- filesystem structure + linter
- manifest schema + discovery
- dispatcher support for multi-project scanning
- task addressing/protocol includes `project_id`
- enrollment logic outputs warm paths: `artifacts/silver` + `artifacts/gold`
- `_inbox` triage loop
- **migration tool** (legacy vault → `_inbox`)

Defer:
- UI visualization
- cross-project dependencies
- automatic promotion (keep "move semantics" manual first)

---

## 14. Open questions (v0 → v1)
- Promotion from `artifacts/gold` → shared `Resources/OpenClaw/_Core/` via approvals?
- Enrollment budgeting (cap projects per agent/role)?
- Subprojects vs. links/dependencies?
