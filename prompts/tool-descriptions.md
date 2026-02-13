# AOF Tool Reference (Reference-Only – Do NOT Inject)
**Purpose:** Detailed tool usage guide for troubleshooting/training. Not for context window injection.
**For routine use:** Tool signatures in adapter.ts + agent-guide.md are sufficient.

## aof_dispatch
**Purpose:** Create new task card and route work to agent/team. **Use instead of `sessions_spawn` when AOF tools are available.** Fallback to `sessions_spawn` only if AOF tools are unavailable.

### Parameters
**Required:**
- `title` (string): Short task title (concise, <80 chars)
- `brief` or `description` (string): Full task description including acceptance criteria

**Optional routing (use one):**
- `agent` (string): Assign to specific agent (e.g., "swe-backend")
- `team` (string): Route to any agent on team (e.g., "swe")
- `role` (string): Route to any agent with role (e.g., "backend-engineer")

**Optional metadata:**
- `priority` (string): `low` | `medium` | `high` | `critical` (default: medium)
- `dependsOn` (string[]): Array of taskIds that must complete first
- `parentId` (string): Parent task ID (for subtasks)
- `metadata` (object): Custom key-value pairs for context
- `tags` (string[]): Tags for categorization/filtering
- `actor` (string): Agent creating the task (auto-populated if omitted)

### Returns
```json
{
  "taskId": "AOF-042",
  "status": "ready",
  "filePath": "/path/to/tasks/ready/AOF-042-fix-login-redirect.md"
}
```

### Examples
**Basic delegation:**
```json
{
  "title": "Fix login redirect",
  "brief": "Repro + fix. AC: redirect to /dashboard after auth.",
  "agent": "swe-backend",
  "priority": "high"
}
```

**With dependencies:**
```json
{
  "title": "Deploy auth API",
  "brief": "Deploy new endpoints to staging. AC: health checks pass, no errors.",
  "agent": "swe-cloud",
  "priority": "high",
  "dependsOn": ["AOF-041"]
}
```

**Team-routed with metadata:**
```json
{
  "title": "Review security audit",
  "brief": "Review findings from penetration test. AC: all critical issues triaged.",
  "team": "security",
  "priority": "critical",
  "tags": ["audit", "compliance"]
}
```

**Common mistakes:** Vague brief, missing acceptance criteria, using `sessions_spawn` when AOF available, `blocked` status without reason.

## aof_task_update
**Purpose:** Record progress, change status, add work log, attach outputs.
**Required:** `taskId`.
**Optional:** `status` (backlog/ready/in-progress/blocked/review/done), `workLog`, `outputs`, `blockedReason` (required if `status=blocked`), `body` (full override, use sparingly).
**Example:**
```json
{"taskId": "AOF-123", "status": "in-progress", "workLog": "Root-caused to session timeout", "outputs": ["reports/timeout.md"]}
```
**Common mistakes:** Editing task files directly, overwriting body unnecessarily, `blocked` without reason.

## aof_task_complete
**Purpose:** Mark task done with completion summary.
**Required:** `taskId`, `summary` (concise outcome + verification).
**Optional:** `outputs`, `skipReview`.
**Example:**
```json
{"taskId": "AOF-123", "summary": "Fixed redirect; added test; verified locally", "outputs": ["tests/login-redirect.test.ts"]}
```
**Common mistakes:** Done without summary, missing outputs/verification.

## aof_status_report
**Purpose:** Get task queue or status summary for team/agent.
**Optional:** `agentId`, `status`, `compact` (summary only), `limit`.
**Example:**
```json
{"agentId": "swe-architect", "status": "in-progress", "compact": true}
```
**Common mistakes:** Using for kanban (use `aof_board`), forgetting filters.

## aof_board
**Purpose:** Kanban-style view for team standups/sweeps (read-only).
**Optional:** `team` (default "swe"), `status`, `priority`.
**Example:**
```json
{"team": "swe", "status": "in-progress"}
```
**Common mistakes:** Expecting per-agent detail (use `aof_status_report`), assuming it dispatches/updates (read-only).
