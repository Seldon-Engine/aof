# Projects v0 - Product Management Review

**Reviewer:** swe-pm  
**Review Date:** 2026-02-10  
**Spec Version:** v0 (PROPOSED)  
**Status:** READY FOR STAKEHOLDER REVIEW

---

## Executive Summary

The Projects v0 spec introduces a **durable project primitive** that enables multi-project, multi-agent work while integrating cleanly with Memory v2 and the Medallion architecture. The spec is **85% implementation-ready** with clear filesystem topology, well-defined manifest schema, and deterministic semantics aligned with AOF's core principles.

**Key Strengths:**
- Clear separation of concerns (Tasks, Artifacts, Views, State, Cold)
- Medallion architecture aligns with content maturity goals
- Explicit memory indexing control via topology
- Backwards-compatible with single-project workflows

**Gaps Identified:**
1. Migration path from current flat task structure is underspecified
2. Agent UX for project context injection needs clarification
3. Memory enrollment cap enforcement mechanism missing
4. Linter implementation details incomplete

**Recommendation:** **APPROVE with conditions** - Address gaps 1-3 before implementation; gap 4 can be iterative.

---

## A. Requirements Validation

### A.1 Completeness Assessment

#### ✅ **Well-Defined (Implementation-Ready)**

| Component | Status | Notes |
|-----------|--------|-------|
| Filesystem topology | ✅ Complete | Clear directory structure with rationale |
| Project manifest schema | ✅ Complete | All required fields documented with types |
| Medallion tiers (Bronze/Silver/Gold) | ✅ Complete | Clear definitions with examples |
| Memory v2 alignment | ✅ Complete | Warm/Cold indexing intent well-specified |
| Task state machine (project-scoped) | ✅ Complete | Reuses existing deterministic semantics |
| Archiving flow | ✅ Complete | Clear status update + filesystem move |
| Dispatcher discovery | ✅ Complete | Scan `Projects/*/project.yaml` with status filter |

#### ⚠️ **Underspecified (Needs Clarification)**

| Component | Gap | Blocking? | Recommendation |
|-----------|-----|-----------|----------------|
| Migration path | No process for moving existing tasks into projects | **YES** | Add migration acceptance criteria (see §A.2) |
| Agent context injection | How does dispatcher pass project context to spawned agents? | **YES** | Specify environment/args passed to `sessions_spawn` |
| Memory enrollment cap | "Hard cap" mentioned but no enforcement mechanism | NO | Defer to v0.1; use soft warning initially |
| Linter implementation | Rules listed but no enforcement timing (pre-dispatch? cron?) | NO | Acceptable for v0; can iterate |
| Cross-project dependencies | Mentioned as deferred but no placeholder for future links | NO | Acceptable to defer |

#### ❌ **Missing (Requires Addition)**

| Requirement | Impact | Priority |
|-------------|--------|----------|
| **Migration acceptance criteria** | Cannot ship v0 without breaking existing AOF setup | **P0** |
| **Agent context injection spec** | Agents won't know which project they're working in | **P0** |
| **Error handling: invalid `project.yaml`** | Dispatcher may crash on malformed manifests | **P1** |
| **Rollback plan** | If projects cause issues in production | **P1** |
| **Performance impact** (scanning `Projects/*/project.yaml` at scale) | May slow dispatcher poll loop | **P2** |

### A.2 Acceptance Criteria Review (Section 13)

**Section 13: "Immediate Value / v0 MVP"**

Original criteria:
> - Filesystem structure + linter
> - Project manifest schema
> - Dispatcher discovery across projects
> - Memory enrollment logic that adds only Silver/Gold paths for enrolled agents/teams
> - `_Inbox` default project + simple triage loop

**Assessment:**

| Criterion | Clear? | Testable? | Gap |
|-----------|--------|-----------|-----|
| Filesystem structure + linter | ⚠️ Partial | ⚠️ Partial | Linter enforcement timing unclear; what happens on lint failure? |
| Project manifest schema | ✅ Yes | ✅ Yes | Schema is well-defined; validation logic needs implementation |
| Dispatcher discovery | ✅ Yes | ✅ Yes | Clear scan + filter logic |
| Memory enrollment logic | ✅ Yes | ⚠️ Partial | Silver/Gold path addition is clear; enrollment cap enforcement unclear |
| `_Inbox` default + triage | ⚠️ Partial | ❌ No | "Simple triage loop" not defined; what triggers triage? Manual? Automated? |

**Recommended Additions to §13:**

```markdown
### v0 MVP Acceptance Criteria (Revised)

1. **Filesystem Structure**
   - [ ] All new projects can be created with required directories (Tasks/, Artifacts/, State/, Cold/, Views/)
   - [ ] `_Inbox` project exists on AOF initialization
   - [ ] Linter validates structure on project creation (blocking)

2. **Project Manifest**
   - [ ] `project.yaml` schema validated on load (Zod or equivalent)
   - [ ] Invalid manifests emit `project.manifest.invalid` event and skip project in discovery
   - [ ] Manifest changes append to `State/project-changelog.md`

3. **Dispatcher Discovery**
   - [ ] Dispatcher discovers all `status: active` projects
   - [ ] `_Inbox` always included regardless of status
   - [ ] Discovery performance: <100ms for ≤50 projects

4. **Memory Enrollment**
   - [ ] Enrolled agents' `extraPaths` include only `Artifacts/Silver` and `Artifacts/Gold`
   - [ ] Cold directories explicitly excluded from indexing
   - [ ] (v0.1) Enrollment cap warning emitted if agent enrolled in >5 projects

5. **Migration**
   - [ ] Existing tasks in `~/.openclaw/aof/tasks/` moved to `Projects/_Inbox/Tasks/`
   - [ ] No data loss during migration
   - [ ] Migration idempotent (can be re-run safely)

6. **Agent Context Injection**
   - [ ] Spawned agents receive `projectId` via environment variable `AOF_PROJECT_ID`
   - [ ] Agents can read `project.yaml` from `AOF_PROJECT_ROOT`
   - [ ] Agent workspace includes project `README.md` in context

7. **Triage Loop** (Manual v0; automated v1)
   - [ ] Human or control agent can move tasks from `_Inbox/Backlog` to project-specific `Tasks/Backlog`
   - [ ] Task file updated with `projectId` in frontmatter
   - [ ] Event logged: `task.triaged` with source=_Inbox, dest=<projectId>
```

### A.3 Open Questions Assessment (Section 14)

**Original Questions:**

1. **Should `Artifacts/Gold` be eligible for promotion into `Resources/OpenClaw/_Core/`?**
   - **Assessment:** NOT a blocker. This is a governance/approval workflow question.
   - **Recommendation:** Defer to v1. Start with manual `cp` workflow; add approval protocol later.

2. **How to cap "enrolled project count" per role?**
   - **Assessment:** Soft blocker. Without this, memory bloat is a real risk.
   - **Recommendation:** Implement soft cap (warning) in v0; hard cap (rejection) in v0.1.
   - **Acceptance Criteria:** Log `memory.enrollment.warning` if agent enrolled in >5 projects.

3. **Should projects support "subprojects" (nested initiatives)?**
   - **Assessment:** NOT a blocker. This is a v2+ feature.
   - **Recommendation:** Defer. Document explicitly in spec that v0 does NOT support nesting.

---

## B. BDD Scenarios (Preliminary)

### Feature 1: Project Creation and Discovery

#### Scenario: Create a new project with valid manifest
```gherkin
Given the AOF system is initialized
And the user provides a valid projectId "email-autopilot"
And a valid project.yaml manifest with title="Email Autopilot", status="active", owner.team="swe"
When the project is created
Then a directory exists at "Projects/email-autopilot/"
And all required subdirectories exist: Tasks/, Artifacts/, State/, Cold/, Views/
And Artifacts/ contains subdirectories: Bronze/, Silver/, Gold/
And project.yaml exists and is valid
And README.md exists (placeholder or user-provided)
And project.created event is logged
```

#### Scenario: Reject project creation with invalid projectId
```gherkin
Given the user attempts to create a project with projectId="Email Autopilot!" (contains invalid chars)
When the project creation is attempted
Then the operation fails with error "invalid_project_id"
And no directory is created
And project.creation.rejected event is logged
```

#### Scenario: Reject project creation with missing required manifest fields
```gherkin
Given a project.yaml missing the "owner.team" field
When the project is created and manifest is validated
Then validation fails with error "missing_required_field: owner.team"
And project.creation.rejected event is logged
```

#### Scenario: Discover all active projects
```gherkin
Given projects exist: "email-autopilot" (status=active), "legacy-cleanup" (status=active), "archived-q1" (status=archived)
When the dispatcher runs discovery
Then "email-autopilot" and "legacy-cleanup" are included
And "archived-q1" is excluded
And "_Inbox" is always included
```

#### Scenario: Discovery skips projects with invalid manifests
```gherkin
Given a project "broken-project" exists on disk
But project.yaml is malformed (invalid YAML)
When the dispatcher runs discovery
Then "broken-project" is skipped
And project.manifest.invalid event is logged with projectId and parse error
And discovery continues for other projects
```

---

### Feature 2: _Inbox Default Project

#### Scenario: _Inbox exists on AOF initialization
```gherkin
Given AOF is initialized for the first time
When initialization completes
Then a project "_Inbox" exists at "Projects/_Inbox/"
And _Inbox has all required subdirectories
And project.yaml exists with status="active", title="_Inbox", type="admin"
```

#### Scenario: _Inbox is always included in discovery
```gherkin
Given _Inbox has status="archived" (unusual but possible)
When the dispatcher runs discovery
Then _Inbox is still included in the active projects list
```

#### Scenario: Tasks land in _Inbox by default when no projectId specified
```gherkin
Given a new task is created via dispatcher without explicit projectId
When the task file is written
Then the task is created at "Projects/_Inbox/Tasks/Backlog/<taskId>.md"
And the task frontmatter includes "projectId: _Inbox"
```

#### Scenario: Triage task from _Inbox to target project
```gherkin
Given a task "TASK-2026-02-10-001" in "_Inbox/Tasks/Backlog/"
And a target project "email-autopilot" exists and is active
When the task is triaged to "email-autopilot"
Then the task file is moved to "Projects/email-autopilot/Tasks/Backlog/TASK-2026-02-10-001.md"
And task frontmatter "projectId" is updated to "email-autopilot"
And task.triaged event is logged with source="_Inbox", dest="email-autopilot"
```

#### Scenario: Triage fails if target project does not exist
```gherkin
Given a task in "_Inbox/Tasks/Backlog/"
And target projectId="nonexistent-project"
When triage is attempted
Then the operation fails with error "project_not_found"
And the task remains in _Inbox
And task.triage.failed event is logged
```

---

### Feature 3: Dispatcher Multi-Project Discovery

#### Scenario: Dispatcher scans all active projects for ready tasks
```gherkin
Given active projects "email-autopilot" and "sre-runbooks"
And "email-autopilot/Tasks/Ready/" contains "TASK-2026-02-10-001.md"
And "sre-runbooks/Tasks/Ready/" contains "TASK-2026-02-10-002.md"
When the dispatcher polls
Then both tasks are discovered
And each task context includes its respective projectId
```

#### Scenario: Dispatcher filters tasks by agent role per project participants
```gherkin
Given project "email-autopilot" with participants=["swe-backend", "swe-qa"]
And a task in "email-autopilot/Tasks/Ready/" assigned to "swe-backend"
When dispatcher evaluates candidacy for "swe-backend"
Then the task is a valid candidate
When dispatcher evaluates candidacy for "sre-oncall" (not a participant)
Then the task is NOT a valid candidate (filtered out)
```

#### Scenario: Dispatcher passes project context to spawned agent
```gherkin
Given a task "TASK-2026-02-10-001" in project "email-autopilot"
And the dispatcher spawns "swe-backend" for this task
When sessions_spawn is invoked
Then environment variable "AOF_PROJECT_ID=email-autopilot" is set
And "AOF_PROJECT_ROOT=<dataDir>/Projects/email-autopilot" is set
And the agent workspace context includes "Projects/email-autopilot/README.md"
```

#### Scenario: Dispatcher discovery performance with many projects
```gherkin
Given 50 active projects exist
When the dispatcher runs discovery (scan all project.yaml files)
Then discovery completes in <100ms
And all valid projects are discovered
```

---

### Feature 4: Memory Enrollment (Silver/Gold Paths)

#### Scenario: Enrolled agent gets Silver and Gold paths added
```gherkin
Given agent "swe-backend" is enrolled in project "email-autopilot"
And project.yaml includes "swe-backend" in participants
When memory extraPaths are computed for "swe-backend"
Then extraPaths includes "Projects/email-autopilot/Artifacts/Silver"
And extraPaths includes "Projects/email-autopilot/Artifacts/Gold"
And extraPaths does NOT include "Projects/email-autopilot/Artifacts/Bronze"
And extraPaths does NOT include "Projects/email-autopilot/Cold"
```

#### Scenario: Non-enrolled agent does not get project paths
```gherkin
Given agent "sre-oncall" is NOT in project "email-autopilot" participants
When memory extraPaths are computed for "sre-oncall"
Then extraPaths does NOT include any paths from "Projects/email-autopilot/"
```

#### Scenario: Enrollment computed from owner.team and participants
```gherkin
Given project "email-autopilot" with owner.team="swe" and participants=["swe-backend", "swe-qa"]
And agent "swe-backend" has team="swe" (matches owner.team)
When enrollment is computed
Then "swe-backend" is enrolled (explicit participant)
And "swe-pm" is enrolled (team match with owner.team)
And "sre-oncall" is NOT enrolled (no match)
```

#### Scenario: Memory enrollment cap warning (soft limit v0)
```gherkin
Given agent "swe-backend" is enrolled in 6 projects
And the soft cap is set to 5
When memory extraPaths are computed
Then extraPaths includes all 6 projects (no hard enforcement in v0)
But memory.enrollment.warning event is logged with agentId and enrolledCount=6
```

#### Scenario: Bronze artifacts excluded from indexing by default
```gherkin
Given project "email-autopilot" with default memory.tiers.bronze="cold"
And a file exists at "Projects/email-autopilot/Artifacts/Bronze/raw-dump.md"
When memory indexing paths are computed for any enrolled agent
Then "Artifacts/Bronze" is NOT included in warm paths
And the file is not indexed
```

#### Scenario: Gold artifacts are indexed for enrolled agents
```gherkin
Given project "email-autopilot" with default memory.tiers.gold="warm"
And a file exists at "Projects/email-autopilot/Artifacts/Gold/runbook.md"
And agent "swe-backend" is enrolled
When memory indexing occurs
Then "Projects/email-autopilot/Artifacts/Gold" is included in warm paths
And "runbook.md" is indexed for recall
```

---

### Feature 5: Artifact Medallion Tiers and Promotion

#### Scenario: Create Bronze artifact (raw, high-volume)
```gherkin
Given a project "email-autopilot" exists
When an agent produces a raw output file "scrape-results.json"
Then the file is written to "Projects/email-autopilot/Artifacts/Bronze/scrape-results.json"
And the file is NOT indexed by default (cold tier)
```

#### Scenario: Create Silver artifact (refined, normalized)
```gherkin
Given an agent produces a refined report "findings-summary.md"
When the file is written
Then it is placed in "Projects/email-autopilot/Artifacts/Silver/findings-summary.md"
And the file IS indexed for enrolled agents (warm tier)
```

#### Scenario: Create Gold artifact (canonical, stable)
```gherkin
Given an agent produces a canonical runbook "email-setup-runbook.md"
When the file is written
Then it is placed in "Projects/email-autopilot/Artifacts/Gold/email-setup-runbook.md"
And the file IS indexed for enrolled agents (warm tier)
And the file is stable and intended for repeated recall
```

#### Scenario: Promote Bronze to Silver (manual move)
```gherkin
Given a Bronze artifact "raw-findings.md" exists
When an agent promotes the artifact via filesystem move
Then the file is moved to "Artifacts/Silver/raw-findings.md"
And frontmatter is updated: "promotedFrom: bronze"
And an entry is appended to "Artifacts/_promotion-log.md"
And artifact.promoted event is logged with tier="bronze→silver"
```

#### Scenario: Promote Silver to Gold (manual move)
```gherkin
Given a Silver artifact "findings.md" exists
When an agent promotes the artifact via filesystem move
Then the file is moved to "Artifacts/Gold/findings.md"
And frontmatter is updated: "promotedFrom: silver"
And an entry is appended to "Artifacts/_promotion-log.md"
And artifact.promoted event is logged with tier="silver→gold"
```

#### Scenario: Promotion log tracks artifact history
```gherkin
Given an artifact has been promoted from Bronze → Silver → Gold
When "_promotion-log.md" is read
Then it contains entries for both promotions
And each entry includes: timestamp, artifact path, source tier, dest tier, promoted by (agent/human)
```

#### Scenario: Promotion is idempotent (move same file twice)
```gherkin
Given a Bronze artifact "foo.md" is promoted to Silver
When the promotion command is run again for the same file (now in Silver)
Then the file remains in Silver (no error)
And promotion log may log duplicate entry (or detect + skip)
```

---

### Feature 6: Project Archiving

#### Scenario: Archive a project (set status=archived)
```gherkin
Given an active project "legacy-cleanup" with status="active"
When the project is archived
Then project.yaml is updated: status="archived"
And the project directory is moved to "Projects/_archived/legacy-cleanup/"
And project.archived event is logged
```

#### Scenario: Archived projects excluded from dispatcher discovery
```gherkin
Given a project "legacy-cleanup" is archived
When the dispatcher runs discovery
Then "legacy-cleanup" is NOT included in active projects
And no tasks from "legacy-cleanup" are dispatched
```

#### Scenario: Archived projects excluded from memory enrollment
```gherkin
Given agent "swe-backend" was enrolled in project "legacy-cleanup"
And "legacy-cleanup" is now archived
When memory extraPaths are computed
Then "legacy-cleanup" paths are NOT included
And the agent cannot recall artifacts from archived project
```

#### Scenario: Archived project artifacts remain accessible by direct navigation
```gherkin
Given an archived project "legacy-cleanup" at "Projects/_archived/legacy-cleanup/"
When a human or agent navigates directly to "Projects/_archived/legacy-cleanup/Artifacts/Gold/summary.md"
Then the file is readable
And the filesystem structure is intact (no deletion)
```

#### Scenario: Unarchive a project (revert status)
```gherkin
Given an archived project "legacy-cleanup" with status="archived"
When the project is unarchived (manual or automated)
Then project.yaml is updated: status="active"
And the project directory is moved back to "Projects/legacy-cleanup/"
And dispatcher discovery includes it again
And project.unarchived event is logged
```

---

### Feature 7: Linter Rules

#### Scenario: Lint passes for valid project structure
```gherkin
Given a project "email-autopilot" with all required directories (Tasks/, Artifacts/, State/, Cold/)
And Artifacts/ has Bronze/, Silver/, Gold/
And project.yaml exists with id="email-autopilot" matching folder name
When the linter runs
Then no errors are reported
And linter.passed event is logged
```

#### Scenario: Lint fails if project.yaml missing
```gherkin
Given a project directory "email-autopilot" exists
But project.yaml is missing
When the linter runs
Then an error is reported: "missing_project_manifest"
And linter.failed event is logged with projectId and error details
```

#### Scenario: Lint fails if project.yaml id mismatches folder name
```gherkin
Given a project directory "email-autopilot"
But project.yaml has id="email_pilot" (underscore instead of hyphen)
When the linter runs
Then an error is reported: "project_id_mismatch"
And the error includes expected="email-autopilot", actual="email_pilot"
```

#### Scenario: Lint fails if required directories missing
```gherkin
Given a project "email-autopilot"
But the "Tasks/" directory is missing
When the linter runs
Then an error is reported: "missing_required_directory: Tasks"
And linter.failed event is logged
```

#### Scenario: Lint fails if Artifacts/ lacks Bronze/Silver/Gold
```gherkin
Given a project "email-autopilot" with Artifacts/ directory
But "Artifacts/Silver/" is missing
When the linter runs
Then an error is reported: "missing_artifact_tier: Silver"
And linter.failed event is logged
```

#### Scenario: Lint warning if large binary file in Silver or Gold
```gherkin
Given a project "email-autopilot"
And "Artifacts/Gold/video.mp4" exists (10MB file)
And the linter allowlist does not include "*.mp4"
When the linter runs
Then a warning is emitted: "large_file_in_warm_tier: Artifacts/Gold/video.mp4"
But the lint does not fail (warning only in v0)
```

#### Scenario: Lint fails if symlink escapes vault root (security)
```gherkin
Given a project "email-autopilot"
And "Tasks/Backlog/link.md" is a symlink pointing to "/etc/passwd"
When the linter runs with security hardening enabled
Then an error is reported: "symlink_escape_detected"
And linter.failed event is logged
And the project is flagged for review
```

#### Scenario: Lint fails if agent extraPaths includes wildcard "Projects/**"
```gherkin
Given agent "swe-backend" config includes memorySearch.extraPaths=["Projects/**"]
When the linter runs (global AOF config check)
Then an error is reported: "wildcard_path_prohibited: Projects/**"
And the error explains risk: "memory recall explosion"
```

#### Scenario: Lint enforced at project creation (blocking)
```gherkin
Given a user attempts to create a project "email-autopilot"
But the creation script fails to create required directories
When the project creation completes and linter runs
Then the creation is rolled back (project directory removed)
And project.creation.failed event is logged with lint errors
```

#### Scenario: Lint runs on-demand (manual invocation)
```gherkin
Given a human or agent runs "aof lint projects"
When the command executes
Then all projects in "Projects/" are validated
And a lint report is written to "Resources/OpenClaw/Ops/Status/project-lint-report.md"
And summary includes: total projects, passed, failed, warnings
```

---

## C. Stakeholder Concerns

### C.1 Impact on Existing Workflows

#### Current State (Pre-Projects)
- Tasks live in flat directory: `~/.openclaw/aof/tasks/{backlog,ready,in-progress,blocked,review,done}/`
- Single implicit "project" (the AOF workspace itself)
- No scoping mechanism for multi-team or multi-initiative work
- Memory extraPaths manually configured per agent

#### Post-Projects State
- Tasks live in project-scoped directories: `Projects/<projectId>/Tasks/{backlog,ready,...}/`
- `_Inbox` acts as default landing zone (backwards compatible)
- Projects provide scoping, memory enrollment, and artifact organization
- Memory extraPaths computed automatically from project enrollment

#### **Will Current AOF Setups Break?**

| Scenario | Impact | Mitigation |
|----------|--------|-----------|
| Existing tasks in flat `tasks/` directory | ❌ **BREAKS** if tasks not migrated | **REQUIRED:** Migration script to move tasks to `_Inbox` |
| Agents with hardcoded task paths | ❌ **BREAKS** if paths not updated | **REQUIRED:** Update dispatcher + agent context to use project-scoped paths |
| Memory extraPaths manually configured | ⚠️ **PARTIAL BREAK** - manual paths still work but project paths won't auto-add | **RECOMMENDED:** Document migration to project-based enrollment |
| Single-project workflows | ✅ **NO BREAK** - `_Inbox` provides backward compatibility | None needed |

**Critical Dependency:** Migration MUST be complete and tested before v0 ships.

### C.2 Migration Path

#### **Problem Statement**
Existing AOF deployments have tasks in `~/.openclaw/aof/tasks/` (flat structure). Projects v0 requires tasks to live in `Projects/<projectId>/Tasks/`.

#### **Proposed Migration Flow**

```gherkin
Feature: Migrate existing tasks to _Inbox project

Scenario: One-time migration on AOF upgrade to Projects v0
Given AOF is upgraded from pre-Projects version to v0
And existing tasks exist in "~/.openclaw/aof/tasks/{backlog,ready,in-progress,blocked,review,done}/"
When the migration script runs
Then a "_Inbox" project is created if it doesn't exist
And all tasks are moved to "Projects/_Inbox/Tasks/{same-status}/"
And each task frontmatter is updated: "projectId: _Inbox"
And original "tasks/" directory is backed up to "tasks.backup-<timestamp>/"
And migration.completed event is logged with taskCount
```

#### **Acceptance Criteria for Migration**

1. **Data Integrity**
   - [ ] All task files moved (no data loss)
   - [ ] Task frontmatter updated with `projectId: _Inbox`
   - [ ] Task state preserved (status directory mapping)
   - [ ] Metadata intact (assignedTo, priority, createdAt)

2. **Idempotency**
   - [ ] Migration can be re-run safely (detect already-migrated tasks)
   - [ ] No duplicate tasks created

3. **Rollback**
   - [ ] Backup of original `tasks/` directory created
   - [ ] Rollback script available (restore from backup)

4. **Performance**
   - [ ] Migration completes in <5 seconds for 1000 tasks

5. **Logging**
   - [ ] Migration start/end events logged
   - [ ] Per-task migration logged at debug level
   - [ ] Errors logged with task path + reason

#### **Migration Script Outline**

```typescript
async function migrateTasksToInbox(dataDir: string): Promise<void> {
  const oldTasksDir = path.join(dataDir, 'tasks');
  const inboxDir = path.join(dataDir, 'Projects', '_Inbox', 'Tasks');

  // 1. Check if migration already done
  if (!fs.existsSync(oldTasksDir)) {
    logger.info('No tasks/ directory found; skipping migration');
    return;
  }

  // 2. Create _Inbox project
  await ensureInboxProject(dataDir);

  // 3. Backup old tasks directory
  const backupDir = `${oldTasksDir}.backup-${Date.now()}`;
  await fs.copy(oldTasksDir, backupDir);

  // 4. Move tasks status-by-status
  for (const status of ['backlog', 'ready', 'in-progress', 'blocked', 'review', 'done']) {
    const srcDir = path.join(oldTasksDir, status);
    const destDir = path.join(inboxDir, status);
    
    const tasks = await fs.readdir(srcDir).filter(f => f.endsWith('.md'));
    for (const taskFile of tasks) {
      const srcPath = path.join(srcDir, taskFile);
      const destPath = path.join(destDir, taskFile);
      
      // Read, update frontmatter, write
      const content = await fs.readFile(srcPath, 'utf-8');
      const updated = updateFrontmatter(content, { projectId: '_Inbox' });
      await fs.writeFile(destPath, updated);
      
      logger.debug(`Migrated ${taskFile} to _Inbox/${status}`);
    }
  }

  // 5. Log completion
  logger.info('Migration to _Inbox completed', { taskCount });
}
```

### C.3 Agent User Experience in Projects

#### **UX Concern: Agent Context Awareness**

**Problem:** Agents need to know which project they're working in to:
- Reference correct artifact paths
- Understand scope and constraints
- Route outputs to the right directories

**Solution (Proposed):**
1. **Environment variables:**
   - `AOF_PROJECT_ID=email-autopilot`
   - `AOF_PROJECT_ROOT=<dataDir>/Projects/email-autopilot`

2. **Workspace context injection:**
   - Dispatcher adds `Projects/email-autopilot/README.md` to agent workspace context
   - Agent can read project manifest: `cat $AOF_PROJECT_ROOT/project.yaml`

3. **Task frontmatter:**
   - Every task includes `projectId: email-autopilot` in frontmatter
   - Agent reads task file and knows project scope

**Acceptance Criteria:**
```gherkin
Scenario: Agent reads project context on spawn
Given a task in project "email-autopilot"
When the agent is spawned by dispatcher
Then the agent can access $AOF_PROJECT_ID environment variable
And the agent can read "$AOF_PROJECT_ROOT/README.md"
And the agent's initial prompt includes project context summary
```

#### **UX Concern: Multi-Project Agents**

**Problem:** An agent enrolled in multiple projects needs to know which artifacts are relevant for the current task.

**Solution:**
- Agent only works on one task (one project) at a time
- Memory recall surfaces artifacts from ALL enrolled projects, but project context is filtered by dispatcher
- Agent can reference artifacts from other enrolled projects if needed (cross-project collaboration)

**Edge Case:** What if an agent needs to access artifacts from a non-enrolled project?
- **v0 Answer:** Agent must be enrolled (added to participants) first
- **v1 Option:** Allow read-only "guest" access with explicit permission grant

---

## D. Priority and Sequencing Recommendations

### D.1 Sequencing Relative to Security Fixes

**Context:** There are pending security fixes (likely related to symlink escapes, injection surfaces, or memory indexing vulnerabilities).

**Recommendation:** **Security fixes FIRST, then Projects v0**

**Rationale:**
1. **Security is P0, new features are P1.** Always ship fixes before features.
2. **Projects v0 introduces NEW attack surfaces** (project manifests, linter rules, memory enrollment paths) that should be reviewed AFTER core security is hardened.
3. **Migration risk:** Projects v0 is a structural change; better to migrate on a secure foundation.

**Sequencing:**
```
Phase 1 (Immediate): Ship security fixes
  ├─ Fix symlink escapes (if applicable)
  ├─ Harden memory indexing (prevent wildcard paths)
  └─ Validate task frontmatter schema (prevent injection)

Phase 2 (Next): Ship Projects v0
  ├─ Implement filesystem structure + linter
  ├─ Implement migration script
  ├─ Test on staging with real tasks
  └─ Ship to production with rollback plan

Phase 3 (Follow-up): Iterate on Projects
  ├─ Memory enrollment cap (hard limit)
  ├─ Automated triage from _Inbox
  └─ Cross-project dependency tracking (v1)
```

### D.2 Minimum Viable First Task (Proof of Concept)

**Goal:** Prove Projects v0 concept with smallest implementation that demonstrates value.

**Recommended First Task:**

```markdown
TASK-2026-02-10-XXX: Projects v0 - _Inbox + Single Project Creation

**Scope:**
- Create _Inbox default project on AOF init
- Create one test project "test-project" via script
- Linter validates required directories + project.yaml schema
- Dispatcher discovers both projects (hardcoded; no full scan yet)

**Acceptance Criteria:**
- [ ] `Projects/_Inbox/` exists with all required directories
- [ ] `Projects/test-project/` can be created via `aof create-project` command
- [ ] Linter validates both projects (pass/fail)
- [ ] Dispatcher logs both project IDs during discovery

**Out of Scope:**
- Migration script (defer to next task)
- Memory enrollment logic (defer)
- Multi-project task routing (defer)

**Why This Task?**
Proves filesystem topology and linter work without requiring full migration or dispatcher changes. Can be reviewed and tested in isolation.
```

**Follow-up Tasks (Sequenced):**

1. **TASK-XXX+1:** Migration script (move existing tasks to _Inbox)
2. **TASK-XXX+2:** Dispatcher multi-project discovery (full scan)
3. **TASK-XXX+3:** Memory enrollment logic (Silver/Gold path computation)
4. **TASK-XXX+4:** Agent context injection (env vars + workspace context)
5. **TASK-XXX+5:** Artifact promotion (Bronze → Silver → Gold manual flow)
6. **TASK-XXX+6:** Project archiving (status update + filesystem move)

---

## E. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Migration fails, data loss** | Medium | Critical | Require backup step; make migration idempotent; test on staging |
| **Dispatcher performance degrades with many projects** | Medium | High | Implement discovery caching; benchmark at 50+ projects |
| **Memory enrollment bloat (agent enrolled in too many projects)** | High | Medium | Implement soft cap warning in v0; hard cap in v0.1 |
| **Agent confusion (doesn't know which project context to use)** | Medium | Medium | Require `AOF_PROJECT_ID` env var; inject README into context |
| **Linter false positives block valid projects** | Low | Medium | Make linter strict but configurable; add override mechanism |
| **Breaking change to existing AOF workflows** | High | Critical | **MUST HAVE** migration script + rollback plan |

---

## F. Recommendations Summary

### **APPROVE with Conditions:**

1. **[P0 - BLOCKING]** Add migration acceptance criteria to §13 (see §A.2)
2. **[P0 - BLOCKING]** Specify agent context injection mechanism (env vars + workspace context)
3. **[P1 - HIGH PRIORITY]** Document error handling for invalid `project.yaml` manifests
4. **[P1 - HIGH PRIORITY]** Add rollback plan to spec
5. **[P2 - NICE TO HAVE]** Benchmark dispatcher discovery performance at scale (50+ projects)

### **Ship Sequence:**
1. Security fixes (if pending) → **SHIP FIRST**
2. Projects v0 (with conditions addressed) → **SHIP SECOND**
3. Enrollment cap hard limit + triage automation → **SHIP THIRD** (v0.1)

### **Minimum Viable First Task:**
**TASK-XXX: _Inbox + Single Project Creation + Linter** (see §D.2)

---

## G. Appendix: BDD Scenario Coverage Summary

| Feature | Scenarios | Happy Path | Edge Cases | Error Cases |
|---------|-----------|------------|------------|-------------|
| Project Creation & Discovery | 5 | 2 | 1 | 2 |
| _Inbox Default Project | 5 | 3 | 1 | 1 |
| Dispatcher Multi-Project | 4 | 3 | 0 | 1 |
| Memory Enrollment | 6 | 4 | 1 | 1 |
| Medallion Tiers & Promotion | 7 | 5 | 1 | 1 |
| Project Archiving | 5 | 3 | 1 | 1 |
| Linter Rules | 10 | 2 | 3 | 5 |
| **TOTAL** | **42** | **22** | **8** | **12** |

**Coverage Assessment:**
- ✅ Happy paths well-covered (52% of scenarios)
- ✅ Error cases covered (29% of scenarios)
- ⚠️ Edge cases could be expanded (19% of scenarios)

**Recommended Additional Scenarios:**
- Concurrent project creation (filesystem race conditions)
- Project creation with same ID as archived project (collision handling)
- Memory enrollment when agent config changes (dynamic re-enrollment)
- Large artifact promotion (>10MB files)

---

## H. Stakeholder Sign-Off

| Stakeholder | Role | Status | Comments |
|-------------|------|--------|----------|
| swe-pm | Product Manager | ✅ APPROVED (with conditions) | See §F for blocking conditions |
| swe-architect | System Architect | ⏳ PENDING | Need review of memory enrollment mechanism |
| swe-backend | Implementation Lead | ⏳ PENDING | Need review of migration script feasibility |
| swe-qa | QA Lead | ⏳ PENDING | Need test plan for 42 BDD scenarios |

---

**Next Steps:**
1. **swe-pm** (this review) → Share with stakeholders
2. **swe-architect** → Review §6 (Memory v2 Alignment) and agent context injection proposal
3. **swe-backend** → Review migration script outline (§C.2) and confirm feasibility
4. **swe-qa** → Draft test plan for BDD scenarios (§B)
5. **All stakeholders** → Sign off on revised spec with conditions addressed

**Target Timeline:**
- Stakeholder reviews: 2026-02-11 (1 day)
- Spec revisions: 2026-02-12 (1 day)
- Implementation start: 2026-02-13 (if approved)

---

**END OF REVIEW**
