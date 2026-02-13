# AOF Agent Operating Manual
AOF is a filesystem-first task orchestration layer. Tasks are on-disk cards tracked by tools.

**Core workflow:** Receive task → `aof_task_update` as you work → `aof_task_complete` when done.

**Delegation:** Use `aof_dispatch` to create/assign tasks; fallback to `sessions_spawn` only if AOF tools unavailable.

**Task lifecycle states:** backlog (not ready) · ready (queued) · in-progress (active) · blocked (can't proceed) · review (awaiting verification) · done (complete).

**Task context:** Read acceptance criteria first. Context in task card + `inputs/`; write results to `outputs/`.

**Progress:** Call `aof_task_update` with status changes, work log entries, outputs. Set `status=blocked` with reason if stuck.

**Completion:** Call `aof_task_complete` with concise summary and outputs.

**Status check:** `aof_status_report` (filter by agent/status) or `aof_board` (team kanban).

**Org chart:** `<AOF_DATA_DIR>/org/org-chart.yaml` governs routing/permissions.

**Don't:** Bypass task cards, edit `tasks/` directly, skip acceptance criteria, or invent status values.

---

## Tool Adoption Checklist

### When to use `aof_dispatch` (task creation)
✅ **Use when:**
- Delegating work to another agent/team
- Creating async work that needs tracking
- Establishing deliverables with acceptance criteria
- Work will take >10 seconds or requires multiple steps
- You need to track progress/status over time

❌ **Don't use when:**
- Quick synchronous requests (use `sessions_send`)
- One-off queries that need immediate response
- Exploratory work with no deliverable
- AOF tools are unavailable (fallback to `sessions_spawn`)

**Example:**
```json
{
  "title": "Implement user authentication API",
  "brief": "Build REST endpoints for login/logout. AC: JWT tokens, secure password hash, tests pass.",
  "agent": "swe-backend",
  "priority": "high"
}
```

### When to use `aof_task_update` (progress tracking)
✅ **Use when:**
- Starting work on a task (`status: "in-progress"`)
- Hit a blocker (`status: "blocked"`, include `blockedReason`)
- Reached a milestone (add `workLog` entry)
- Produced intermediate outputs (add to `outputs` array)
- Ready for review (`status: "review"`)

**Example:**
```json
{
  "taskId": "AOF-042",
  "status": "blocked",
  "blockedReason": "Need database schema approval before migration",
  "workLog": "Completed data model design, awaiting architect review"
}
```

### When to use `aof_task_complete` (task closure)
✅ **Use when:**
- Task fully complete with all acceptance criteria met
- All outputs delivered
- Verification/testing done

**Example:**
```json
{
  "taskId": "AOF-042",
  "summary": "Auth API complete: 4 endpoints, JWT impl, 15 tests passing, docs updated",
  "outputs": ["src/api/auth.ts", "tests/auth.test.ts", "docs/api/auth.md"]
}
```

### When to use `aof_status_report` (status overview)
✅ **Use when:**
- Checking your task queue at session start
- Finding tasks by status (e.g., all blocked tasks)
- Quick team workload check

**Example:**
```json
{
  "agent": "swe-backend",
  "status": "in-progress"
}
```

---

## Quick Reference: Parameter Basics

### `aof_dispatch`
- **Required:** `title`, `brief` (include acceptance criteria)
- **Returns:** `taskId`, `status`, `filePath`
- **Routing:** `agent` (specific agent), `team` (any agent on team), `role` (any with role)
- **Priority:** `low` | `medium` | `high` | `critical` (default: medium)
- **Dependencies:** `dependsOn` (array of taskIds), `parentId` (subtask of)

### `aof_task_update`
- **Required:** `taskId`
- **Optional:** `status`, `workLog`, `outputs`, `blockedReason` (required if blocked)
- **Note:** `status=blocked` MUST include `blockedReason`

### `aof_task_complete`
- **Required:** `taskId`, `summary`
- **Optional:** `outputs` (array of file paths)

### `aof_status_report`
- **Optional:** `agent`, `status`, `compact`, `limit`
- **Returns:** Task list with frontmatter details
