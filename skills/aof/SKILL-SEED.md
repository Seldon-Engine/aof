---
name: aof
description: AOF agent skill -- minimal seed for simple task operations
version: 3.1.0
---

# AOF -- Agentic Ops Fabric

Deterministic orchestration for multi-agent systems. Agents use MCP tools below.

---

## Agent Tools

| Tool | Purpose | Returns |
|------|---------|---------|
| `aof_dispatch` | Create task and assign to agent/team. Accepts `workflow`, `subscribe`, `notifyOnCompletion`, and `timeoutMs` (ms; 5min default, 4h max — opt in for long-running research tasks) params. | `{ taskId, status, assignedAgent, filePath, sessionId, subscriptionId, notificationSubscriptionId }` |
| `aof_task_update` | Log work, change status, mark blocked | `{ success, taskId, newStatus, updatedAt }` |
| `aof_task_complete` | Mark task done with summary and deliverables | `{ success, taskId, finalStatus, completedAt }` |
| `aof_status_report` | Query task counts filtered by agent/status | `{ total, byStatus, tasks[], summary }` |
| `aof_board` | Kanban board view for a team | `{ team, timestamp, columns, stats }` |
| `aof_task_edit` | Edit task frontmatter (title, priority, routing) | `{ success, taskId, updatedFields }` |
| `aof_task_cancel` | Cancel a task with optional reason | `{ success, taskId, status, reason }` |
| `aof_task_block` | Block a task with a reason | `{ success, taskId, status, reason }` |
| `aof_task_unblock` | Unblock a task, move back to ready | `{ success, taskId, status }` |
| `aof_task_dep_add` | Add dependency (task blocked until blocker completes) | `{ success, taskId, blockerId, dependsOn }` |
| `aof_task_dep_remove` | Remove a dependency from a task | `{ success, taskId, blockerId, dependsOn }` |
| `aof_task_subscribe` | Subscribe to task outcome notifications | `{ subscriptionId, taskId, granularity, status }` |
| `aof_task_unsubscribe` | Cancel a task outcome subscription | `{ subscriptionId, status }` |
| `aof_project_create` | Create isolated project with own task store | `{ projectId, projectRoot, directoriesCreated }` |
| `aof_project_list` | List all projects on the instance | `{ projects[] }` |

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

## Notifications — two mechanisms

- `subscribe: "completion" | "all"` on dispatch — **spawns a new agent session** to the subscriber on terminal state. Use for supervision (architect gets pinged when each subtask finishes).
- `notifyOnCompletion` on dispatch — **plugin-driven chat message** (no new session). OpenClaw auto-captures the originating chat session by default; pass `false` to opt out, or `{ kind: "openclaw-chat", target: "<addr>" }` to target explicitly from cron/CLI.

Both can coexist on the same task.

---

## Need More Context?

For DAG workflow composition, org chart setup, or project management, dispatch with `contextTier: 'full'` or call `aof_context_load` mid-session.
