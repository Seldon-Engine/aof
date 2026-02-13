# Projects v0 Spec (AOF / Deterministic Ops Fabric)
Status: **PROPOSED (v0)**  
Goal: Introduce a **Project** primitive that cleanly supports multi-project work (SWE and non-SWE teams), while aligning with **Memory v2 (Hot/Warm/Cold)** and a **Medallion architecture** for artifacts and recall.

---

## 1. Definitions

### 1.1 Project
A **Project** is a durable, named container for work that:
- owns **tasks**, **artifacts**, and **state**
- can be **multi-agent** and **multi-team**
- provides stable, low-drift filesystem topology for deterministic orchestration

### 1.2 Default project
AOF defines a default project named:

- **`_Inbox`** — the landing zone for untriaged work

### 1.3 Medallion architecture (for artifacts and recall)
We use **Bronze/Silver/Gold** tiers for *project artifacts*:

- **Bronze (Raw):** uncurated, high-volume, messy, or transient
- **Silver (Refined):** deduped, summarized, normalized, and usable
- **Gold (Canonical):** compact, authoritative “go-to” references

**Important:** Medallion tiers are *about content maturity*, not indexing. Indexing is handled by **Memory v2 Hot/Warm/Cold**.

### 1.4 Memory v2 tiers (indexing + retrieval surface)
Memory v2 is about **what gets indexed / recalled**:

- **Hot**: `Resources/OpenClaw/_Core/` (tiny canonical docs; always indexed)
- **Warm**: selective domain directories (indexed per agent role)
- **Cold**: excluded from indexing (noise + injection surface reduction)

Projects must be laid out so that:
- **Warm** “work product” is indexable for relevant roles
- **Cold** “logs / raw / approvals” can be excluded by omission
- **Gold** summaries can be elevated into Hot or Warm shared pools when appropriate

---

## 2. Filesystem Topology

### 2.1 Canonical project root
All canonical projects live under:

`mock-vault/Projects/<projectId>/`

Constraints:
- `<projectId>` is filesystem-safe: `[a-z0-9][a-z0-9-]{1,63}`
- Stable identifier; title can change without renaming the folder

Example:
`mock-vault/Projects/email-autopilot/`

### 2.2 Default project
`mock-vault/Projects/_Inbox/` exists and is always present.

### 2.3 Required project substructure
Each project MUST contain the following top-level directories (v0):

```
Projects/<projectId>/
  project.yaml                 # project manifest (required)
  README.md                    # short human-readable overview (required)

  Tasks/                       # canonical task state machine (deterministic)
  Artifacts/                   # medallion-tier artifacts produced by work
  Views/                       # optional derived views (read-only by default)
  State/                       # deterministic state: locks, cursors, checkpoints
  Cold/                        # explicitly cold: excluded by default from memory
```

#### Rationale
- **Tasks/** and **State/** are operational substrate (deterministic; drives orchestration)
- **Artifacts/** is the project’s knowledge production (feeds memory)
- **Views/** are derived/synthesized surfaces (kanban snapshots, rollups)
- **Cold/** centralizes non-indexed content (logs, raw dumps, approvals copies)

---

## 3. Project Manifest (`project.yaml`)

### 3.1 Schema (v0)
`project.yaml` is required and acts as the **source of truth** for metadata used by the dispatcher, UI, and memory routing tools.

```yaml
id: email-autopilot
title: Email Autopilot
status: active            # active | paused | archived
type: swe                 # swe | ops | research | admin | personal | other

owner:
  team: swe               # org-chart team id
  lead: swe-pm            # agent id (or human id)
participants:
  - swe-architect
  - swe-backend
  - swe-qa

parentId: platform-services  # optional: parent project for hierarchical organization

routing:
  intake:
    default: Tasks/Backlog
  mailboxes:
    enabled: true

memory:
  tiers:
    bronze: cold           # bronze artifacts default to cold
    silver: warm           # silver artifacts default to warm
    gold: warm             # gold artifacts default to warm (or promoted to _Core via governance)
  allowIndex:
    warmPaths:
      - Artifacts/Silver
      - Artifacts/Gold
  denyIndex:
    - Cold
    - Artifacts/Bronze
    - State
    - Tasks

links:
  repo: ""                 # optional
  dashboards: []           # optional
  docs: []                 # optional
```

### 3.2 Stability rules
- `id` must match directory name
- manifest changes are append-logged in `State/project-changelog.md` (recommended)
- archiving sets `status: archived` and moves project under an archive root (see §11)

### 3.3 Hierarchical projects (optional)
Projects can be organized hierarchically using the optional `parentId` field:

- **`parentId`** (optional): ID of the parent project for nested organization
- Child projects inherit no behavior from parents; hierarchy is purely organizational
- The linter validates:
  - **Warning**: if `parentId` references a non-existent project
  - **Error**: if circular parent references are detected (e.g., A→B→A or A→A)
- Use cases:
  - Platform projects with component sub-projects (e.g., `platform-services` → `email-autopilot`)
  - Program-level organization (e.g., `q1-2026` → individual initiatives)
  - Team-level grouping (e.g., `swe-team` → per-engineer projects)

**Example:**
```yaml
# Projects/platform-services/project.yaml
id: platform-services
title: Platform Services
...

# Projects/email-autopilot/project.yaml
id: email-autopilot
title: Email Autopilot
parentId: platform-services
...
```

---

## 4. Deterministic Task Mapping (project-scoped)

Projects provide **namespacing** and **visibility**, but the DOF task state machine remains deterministic and file-based.

### 4.1 Canonical task state directories
In each project:

```
Tasks/
  Backlog/
  Ready/
  In-Progress/
  Blocked/
  Review/
  Done/
  _Templates/
```

- “Move = status” rule applies (atomic rename within same filesystem)
- Task files should be small and checklist-driven

### 4.2 Assignment encoding (deterministic)
Assignment is encoded in the task file frontmatter:

```yaml
assignedTo: swe-backend
ownerTeam: swe
priority: P1
createdAt: 2026-02-10T00:00:00Z
```

The dispatcher uses `assignedTo` + filesystem location to decide spawning.

---

## 5. Medallion Mapping (Artifacts)

### 5.1 Artifact tiers
```
Artifacts/
  Bronze/        # raw outputs, dumps, scrape results, large logs
  Silver/        # refined, deduped, summarized, normalized
  Gold/          # canonical references: “the answer”, short + stable
```

### 5.2 What belongs in each tier

**Bronze examples**
- raw emails/threads dumps
- web scrape output
- verbose command output
- intermediate “notes” created during investigation

**Silver examples**
- “Findings” reports (deduped, structured)
- normalized tables / metrics snapshots
- validated procedures with steps
- weekly rollups produced from bronze

**Gold examples**
- the canonical runbook for “how we do X”
- architecture decision record (ADR) distilled and stable
- stable SOP with checks and escalation
- “One-pager” that agents should rely on repeatedly

### 5.3 Promotion rules (v0, filesystem-first)
Promotion is performed by **moving** a file:

- Bronze → Silver: `mv Artifacts/Bronze/foo.md Artifacts/Silver/foo.md`
- Silver → Gold: `mv Artifacts/Silver/foo.md Artifacts/Gold/foo.md`

Promotion should be accompanied by:
- a short note in the file frontmatter: `promotedFrom: bronze|silver`
- optional entry in `Artifacts/_promotion-log.md` (append-only)

No scoring thresholds; no post-filter scripts required.

---

## 6. Memory v2 Alignment (Indexing by Topology)

### 6.1 Principle
**Control what gets indexed by controlling paths.**  
Avoid brittle scoring thresholds and avoid custom post-filter logic.

### 6.2 Default indexing intent
By default, AOF treats these as **warm-index candidates** (per role/team policy):

- `Projects/<id>/Artifacts/Silver/**`
- `Projects/<id>/Artifacts/Gold/**`

And treats these as **cold** (not indexed):

- `Projects/<id>/Artifacts/Bronze/**`
- `Projects/<id>/Cold/**`
- `Projects/<id>/State/**`
- `Projects/<id>/Tasks/**`

### 6.3 How this works with OpenClaw (no core changes)
OpenClaw indexes what’s included in `memorySearch.extraPaths` + agent workspace content.

So AOF’s job is to ensure:
- **Warm** extraPaths include only the directories we want recall from
- **Cold** directories are omitted (never included)

Practical outcome:
- Add project-specific warm paths to specific agent roles (see §7)
- Do NOT include `Projects/**` blindly.

---

## 7. Per-role Memory Scope Plan (Projects)

### 7.1 Role-aware “project enrollment”
A project must explicitly declare which roles/teams should index it.

Options (v0):
- **Manifest field** `owner.team` and `participants` drive enrollment
- Or an explicit allowlist: `memory.enrolledAgents` / `memory.enrolledTeams`

Recommended v0: use `owner.team` + `participants` and allow explicit overrides.

### 7.2 ExtraPaths generation (AOF-owned)
AOF computes each agent’s memory `extraPaths` from:
- OpenClaw shared warm pools (Resources/OpenClaw…)
- Project enrollment + project warm paths (Silver/Gold)

Example computed additions for a SWE agent enrolled in `email-autopilot`:
- `mock-vault/Projects/email-autopilot/Artifacts/Silver`
- `mock-vault/Projects/email-autopilot/Artifacts/Gold`

### 7.3 Guardrails
- Hard cap number of enrolled projects per agent (configurable) to prevent recall bloat
- Prefer Gold over Silver when enrollment budget is constrained

---

## 8. Views (Project-scoped)

Views are derived; they must not become a second source of truth.

### 8.1 Recommended view roots (v0)
```
Views/
  Mailbox/                 # if mailbox view is enabled
  Kanban/                  # if kanban view is enabled
  Rollups/                 # e.g., weekly status
```

### 8.2 Rule
- The canonical state is in `Tasks/` and `Artifacts/`
- Views may be regenerated; treat as cache

---

## 9. Dispatcher Integration

### 9.1 Discovery
Dispatcher discovers projects by scanning:
- `mock-vault/Projects/*/project.yaml`

Rules:
- skip `status: archived` unless configured otherwise
- always include `_Inbox`

### 9.2 Spawning rules (project context)
When spawning an agent for a task in a project, pass:
- `projectId`
- task path
- relevant runbooks (from Hot/Warm)
- (optional) project README summary

### 9.3 Idempotency
Any agent action that mutates canonical state should be encoded as atomic file moves and append-only logs.

---

## 10. Governance and Drift

### 10.1 Drift types
- Project exists on disk but missing from org chart
- Org chart references project missing on disk
- Participant agent missing in OpenClaw agents list
- Project warm paths included in too many agents (memory bloat)

### 10.2 Handling (v0)
- AOF continues operating with best-effort behavior
- Emits a drift report artifact:
  - `Resources/OpenClaw/Ops/Status/drift-projects.md`
- Alerts via control-plane channel (matrix) if severity high

No “hard fail” unless explicitly configured.

---

## 11. Archiving

### 11.1 Archive policy
Archiving sets:
- `project.yaml: status: archived`
- moves folder to:
  - `mock-vault/Projects/_archived/<projectId>/` (recommended)

### 11.2 Memory implications
Archived projects are treated as cold by default:
- not enrolled in any agent’s warm extraPaths
- artifacts remain accessible by direct navigation

---

## 12. Lint Rules (must-have)

AOF linter checks:

1. `Projects/<id>/project.yaml` exists and `id` matches folder
2. Required folders exist: `Tasks/`, `Artifacts/`, `State/`, `Cold/`
3. `Artifacts/` has Bronze/Silver/Gold
4. No large/binary files in Silver/Gold unless allowlisted
5. No symlinks escaping vault root (optional security hardening)
6. No `Projects/**` wildcard in any agent’s `extraPaths` (prevent recall explosion)
7. `_Inbox` exists and is not archived

---

## 13. Immediate Value / v0 MVP

Minimum to ship v0:

- Filesystem structure + linter
- Project manifest schema
- Dispatcher discovery across projects
- Memory enrollment logic that adds only Silver/Gold paths for enrolled agents/teams
- `_Inbox` default project + simple triage loop

Defer:
- UI visualization
- cross-project dependency graphs
- automatic promotion (keep manual move semantics first)

---

## 14. Open Questions (v0 → v1)

- Should `Artifacts/Gold` be eligible for promotion into `Resources/OpenClaw/_Core/` via an approvals workflow?
- How to cap “enrolled project count” per role to avoid recall bloat?
- Should projects support “subprojects” (nested initiatives), or should that be expressed as links/dependencies?
