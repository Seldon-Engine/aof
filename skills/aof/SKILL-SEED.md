---
name: aof
description: AOF agent skill -- minimal seed for simple task operations
version: 3.0.0
---

# AOF -- Agentic Ops Fabric

Deterministic orchestration for multi-agent systems. Agents use MCP tools below.

---

## Agent Tools

| Tool | Purpose | Returns |
|------|---------|---------|
| `aof_dispatch` | Create task and assign to agent/team | `{ taskId, status, assignedAgent, filePath, sessionId }` |
| `aof_task_update` | Log work, change status, mark blocked | `{ success, taskId, newStatus, updatedAt }` |
| `aof_task_complete` | Mark task done with summary and deliverables | `{ success, taskId, finalStatus, completedAt }` |
| `aof_status_report` | Query task counts filtered by agent/status | `{ total, byStatus, tasks[], summary }` |
| `aof_board` | Kanban board view for a team | `{ team, timestamp, columns, stats }` |
| `aof_project_create` | Create isolated project with own task store | `{ projectId, path }` |
| `aof_project_list` | List all projects on the instance | `{ projects[] }` |
| `aof_project_add_participant` | Add agent to project participant list | `{ success }` |

No parameter tables here -- tool JSON schemas provide full parameter docs at call time.

---

## Inter-Agent Protocols

AOF/1 envelope: `AOF/1 {"protocol":"aof","version":1,"type":"...","taskId":"...","fromAgent":"...","toAgent":"...","payload":{...}}`

### Protocol Types

| Type | Direction | When |
|------|-----------|------|
| `completion.report` | Worker -> Dispatcher | Task done/blocked/needs review |
| `status.update` | Worker -> Dispatcher | Mid-task progress |
| `handoff.request` | Coordinator -> Worker | Delegating subtask |
| `handoff.accepted` | Worker -> Coordinator | Accepting delegation |
| `handoff.rejected` | Worker -> Coordinator | Declining (with reason) |

### Completion Outcomes

| Outcome | Effect |
|---------|--------|
| `done` | Task -> review -> done; cascades dependencies |
| `blocked` | Task -> blocked; notifies coordinator |
| `needs_review` | Task -> review; awaits review |
| `partial` | Task -> review; partial completion logged |

---

## Need More Context?

For DAG workflow composition, org chart setup, or project management, dispatch with `contextTier: 'full'` or call `aof_context_load` mid-session.
