# AOF Tool Adoption Checklist
Quick decision tree for when to use each AOF tool vs legacy alternatives.

## Decision Flow: Task Delegation

```
Need to delegate work?
  ↓
Are AOF tools available? (check tool list)
  ↓
YES → Use aof_dispatch
  ├─ Will take >10 seconds? → aof_dispatch
  ├─ Needs tracking/status? → aof_dispatch
  ├─ Has deliverables/AC? → aof_dispatch
  └─ Async work? → aof_dispatch
  ↓
NO → Fallback to sessions_spawn
```

## When to Use `aof_dispatch`

### ✅ ALWAYS use for:
- **Delegating to another agent/team** — work that needs assignment
- **Work with acceptance criteria** — clear deliverables to verify
- **Multi-step tasks** — anything requiring >1 interaction
- **Async work** — tasks that will complete later
- **Tracked deliverables** — need to know status/progress
- **Work taking >10 seconds** — substantial effort

### ❌ NEVER use for:
- **Quick synchronous queries** — use `sessions_send` instead
- **Exploratory questions** — no deliverable, just information
- **One-off immediate requests** — response needed now
- **AOF tools unavailable** — fallback to `sessions_spawn`

### Example scenarios:

**✅ Use aof_dispatch:**
```json
{
  "title": "Build user authentication endpoints",
  "brief": "Implement login/logout REST APIs with JWT. AC: secure hashing, tests pass, docs updated.",
  "agent": "swe-backend",
  "priority": "high"
}
```

**❌ Don't use aof_dispatch (use sessions_send instead):**
- "What's the current database schema?"
- "Can you check if the service is running?"
- "What files changed in the last commit?"

---

## When to Use `aof_task_update`

### ✅ Use when:
- **Starting work** — transition from `ready` to `in-progress`
- **Hit a blocker** — set `status: "blocked"` with `blockedReason`
- **Major milestone** — add to `workLog` (e.g., "Completed design phase")
- **Produced outputs** — add file paths to `outputs` array
- **Status change** — any state transition
- **Ready for review** — set `status: "review"`

### ❌ Don't use when:
- Task not started yet (no update needed)
- No meaningful progress to report
- Just reading/exploring (not producing work)

### Example scenarios:

**✅ Starting work:**
```json
{
  "taskId": "AOF-042",
  "status": "in-progress",
  "workLog": "Starting implementation; reviewed requirements"
}
```

**✅ Blocked:**
```json
{
  "taskId": "AOF-042",
  "status": "blocked",
  "blockedReason": "Need database schema approval before migration",
  "workLog": "Data model complete; waiting on architect review"
}
```

**✅ Progress milestone:**
```json
{
  "taskId": "AOF-042",
  "workLog": "Auth endpoints complete; starting test suite",
  "outputs": ["src/api/auth.ts"]
}
```

---

## When to Use `aof_task_complete`

### ✅ Use when:
- **All acceptance criteria met** — every AC checked off
- **All outputs delivered** — files/artifacts produced
- **Verification done** — tests pass, manual checks complete
- **Ready to close** — no follow-up work needed

### ❌ Don't use when:
- Task partially complete (use `aof_task_update` with progress instead)
- Acceptance criteria not met
- Awaiting review (use `status: "review"` instead)
- Follow-up work needed (dispatch new task for follow-up)

### Example:

**✅ Complete with summary:**
```json
{
  "taskId": "AOF-042",
  "summary": "Auth API complete: login/logout endpoints, JWT impl, secure password hashing, 15 tests passing, API docs updated",
  "outputs": [
    "src/api/auth.ts",
    "tests/auth.test.ts",
    "docs/api/auth.md"
  ]
}
```

---

## When to Use `aof_status_report`

### ✅ Use when:
- **Session start** — check your task queue
- **Status check** — find tasks by status (e.g., all blocked tasks)
- **Workload check** — see what's assigned to an agent
- **Quick overview** — need summary without full board

### ❌ Don't use when:
- Need full team kanban view (use `aof_board` instead)
- Looking for specific task details (read task file directly)
- Want to update status (use `aof_task_update` instead)

### Example:

**Check your queue:**
```json
{
  "agent": "swe-backend",
  "status": "in-progress"
}
```

**Find blocked tasks:**
```json
{
  "status": "blocked"
}
```

---

## Common Mistakes to Avoid

1. **Using `sessions_spawn` when AOF tools available**
   - ❌ `sessions_spawn({ agent: "swe-backend", task: "fix bug" })`
   - ✅ `aof_dispatch({ title: "Fix login bug", brief: "...", agent: "swe-backend" })`

2. **Missing acceptance criteria in dispatch**
   - ❌ `brief: "Fix the login bug"`
   - ✅ `brief: "Fix login redirect bug. AC: redirects to /dashboard after successful auth, existing tests pass, added regression test"`

3. **Setting status=blocked without reason**
   - ❌ `{ taskId: "AOF-042", status: "blocked" }`
   - ✅ `{ taskId: "AOF-042", status: "blocked", blockedReason: "Need schema approval" }`

4. **Completing without summary**
   - ❌ `{ taskId: "AOF-042" }` (with implicit complete)
   - ✅ `{ taskId: "AOF-042", summary: "Fixed redirect; tests pass; docs updated" }`

5. **Vague task titles**
   - ❌ `title: "Fix bug"`
   - ✅ `title: "Fix login redirect to dashboard"`

6. **Editing task files directly**
   - ❌ Manually editing `tasks/ready/AOF-042.md`
   - ✅ Using `aof_task_update` to modify task state

---

## Quick Reference Table

| Need to... | Use this tool | Parameters |
|------------|---------------|------------|
| Delegate work | `aof_dispatch` | `title`, `brief`, `agent`/`team` |
| Start a task | `aof_task_update` | `taskId`, `status: "in-progress"` |
| Report progress | `aof_task_update` | `taskId`, `workLog` |
| Hit a blocker | `aof_task_update` | `taskId`, `status: "blocked"`, `blockedReason` |
| Mark done | `aof_task_complete` | `taskId`, `summary`, `outputs` |
| Check queue | `aof_status_report` | `agent`, `status` |
| View board | `aof_board` | `team` |

---

## Fallback Strategy

If AOF tools are **not available** (tool list doesn't include `aof_dispatch`):
1. Use `sessions_spawn` for delegation
2. Use `sessions_send` for status updates
3. No AOF task tracking needed
4. Document work in session context as usual

**Note:** The goal is to prefer AOF tools when available, but never block work if they're not.
