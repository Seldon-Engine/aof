---
name: aof
description: >
  AOF agent skill — deterministic multi-agent orchestration with tool-based
  task management, org-chart governance, DAG workflows, and structured
  inter-agent protocols.
version: 3.1.0
requires:
  bins: [node]
---

# AOF — Agentic Ops Fabric

Deterministic orchestration for multi-agent systems. No LLMs in the control plane.
Agents use MCP tools below. CLI (`aof`) is for human operators only (setup, debugging).

---

## Agent Tools

| Tool | Purpose | Returns |
|------|---------|---------|
| `aof_dispatch` | Create task and assign to agent/team. Accepts `workflow` (DAG), `subscribe`, `notifyOnCompletion`, and `timeoutMs` (ms; default 5min, max 4h — opt in for long research). | `{ taskId, status, assignedAgent, filePath, sessionId, subscriptionId, notificationSubscriptionId }` |
| `aof_task_update` | Log work, change status, mark blocked, append outputs | `{ success, taskId, newStatus, updatedAt }` |
| `aof_task_complete` | Mark task done with summary and deliverables | `{ success, taskId, finalStatus, completedAt }` |
| `aof_status_report` | Query task counts filtered by agent/status | `{ total, byStatus, tasks[], summary }` |
| `aof_board` | Kanban board view for a team | `{ team, timestamp, columns, stats }` |
| `aof_task_edit` | Edit task frontmatter (title, priority, routing) without changing status | `{ success, taskId, updatedFields }` |
| `aof_task_cancel` | Cancel a task with optional reason | `{ success, taskId, status, reason }` |
| `aof_task_block` | Block a task with a reason, preventing dispatch until unblocked | `{ success, taskId, status, reason }` |
| `aof_task_unblock` | Unblock a previously blocked task, moving it back to ready | `{ success, taskId, status }` |
| `aof_task_dep_add` | Add dependency — task blocked until blocker completes | `{ success, taskId, blockerId, dependsOn }` |
| `aof_task_dep_remove` | Remove a dependency from a task | `{ success, taskId, blockerId, dependsOn }` |
| `aof_task_subscribe` | Subscribe to task outcome notifications | `{ subscriptionId, taskId, granularity, status }` |
| `aof_task_unsubscribe` | Cancel a task outcome subscription | `{ subscriptionId, status }` |
| `aof_project_create` | Create isolated project with own task store | `{ projectId, projectRoot, directoriesCreated }` |
| `aof_project_list` | List all projects on the instance | `{ projects[] }` |
| `aof_project_add_participant` | Add agent to project participant list | `{ success }` |

No parameter tables here -- tool JSON schemas provide full parameter docs at call time.

---

## DAG Workflows

Tasks progress through **hops** in a workflow DAG. Each hop is a step (implement, review, QA) assigned to a `role` from the org chart, with optional conditions and rejection strategies.

### Composing workflows via `aof_dispatch`

The `workflow` parameter on `aof_dispatch` controls workflow attachment:

- **String** -- template name from `project.yaml` `workflowTemplates` (e.g. `"standard-review"`)
- **Object** -- inline `WorkflowDefinition` with `{ name, hops[] }` (see examples below)
- **`false`** -- explicit skip (no workflow even if project has defaults)
- **Omitted** -- no workflow (backward compatible)

### Example: Linear pipeline

```yaml
workflow:
  name: linear-review
  hops:
    - id: implement
      role: swe-backend
    - id: review
      role: swe-architect
      dependsOn: [implement]
```

### Example: Review cycle with rejection

```yaml
workflow:
  name: review-cycle
  hops:
    - id: implement
      role: swe-backend
    - id: review
      role: swe-architect
      dependsOn: [implement]
      canReject: true
      rejectionStrategy: origin   # rejection restarts from implement
```

### Example: Parallel fan-out with join

```yaml
workflow:
  name: parallel-verify
  hops:
    - id: implement
      role: swe-backend
    - id: unit-test
      role: swe-qa
      dependsOn: [implement]
    - id: security-scan
      role: swe-security
      dependsOn: [implement]
    - id: approve
      role: swe-architect
      dependsOn: [unit-test, security-scan]
      joinType: all   # waits for ALL predecessors (default). "any" = OR-join.
```

### Key hop fields

Each hop has: `id` (unique), `role` (agent role from org chart), `dependsOn` (predecessor IDs, empty = root hop), `joinType` (`all` | `any` for multi-predecessor joins), `canReject` (boolean), `rejectionStrategy` (`origin` = restart from first hop, `predecessors` = restart immediate predecessors), `condition` (activation guard), `autoAdvance` (default true), `timeout`/`escalateTo` (escalation on stall).

### Condition DSL

Hop `condition` uses a JSON expression tree: operators `has_tag`, `hop_status`, `eq`, `neq`, `gt`, `lt`, `in`; combinators `and`, `or`, `not`. Example: `{ op: "has_tag", value: "needs-security-review" }`.

### Pitfalls

- Cycles in `dependsOn` are rejected at validation time
- At least one root hop (no `dependsOn`) is required
- Condition expressions exceeding depth/node limits are rejected at parse time

---

## Workflow Patterns

- **Coordinator dispatches:** Check workload with `aof_status_report`, then `aof_dispatch` subtasks with `assignedAgent` and `checklist`. Monitor progress periodically.
- **Worker executes:** Read task brief/checklist, do work, log progress via `aof_task_update`, finish with `aof_task_complete`.
- **Blocked task:** Call `aof_task_update` with `status: "blocked"` and `blockedReason`. Coordinator is notified; task re-dispatches when unblocked.
- **Dependency chains:** Dispatch sequential tasks with `inputs` referencing prior task IDs. Downstream tasks auto-block until predecessors complete, then cascade to ready.

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

## Org Chart

The org chart (`org/org-chart.yaml`) defines agents, teams, and routing. Source of truth for the scheduler.

```yaml
schemaVersion: 1

agents:
  - id: main                    # Must match OpenClaw agent name
    name: Coordinator
    canDelegate: true
    capabilities:
      tags: [coordination, delegation]
      concurrency: 3
    comms:
      preferred: send

  - id: swe-backend
    reportsTo: main
    capabilities:
      tags: [backend, typescript, api]
      concurrency: 1
    comms:
      preferred: send
      sessionKey: "agent:main:swe-backend"

teams:
  - id: swe
    name: Engineering
    lead: main

routing:
  - matchTags: [backend, api]
    targetAgent: swe-backend
    weight: 10
```

Agent `id` values must match OpenClaw agent names. Run `aof init` to auto-sync from existing OpenClaw config.

---

## Projects

- `aof_project_create` / `aof_project_list` / `aof_project_add_participant` manage isolated project spaces
- Tasks with a `project` field are scoped to that project's directory; without it, global store
- Memory is scoped per-project via the `project` parameter
- If participants are listed, only those agents receive tasks from that project

---

## Completion Protocol

Always call `aof_task_complete` with a brief summary when done. Exiting without this call fails the task and triggers retry.

---

## Subscriptions & Callbacks

Two distinct notification mechanisms — pick by intent, both can coexist on the same task.

### 1. Agent-callback subscriptions (supervision)

Spawn a **new agent session** to a subscriber agent when the task reaches a terminal state. Use for agent-to-agent supervision (e.g. an architect wanting to react to each subtask finishing).

- **Subscribe at dispatch:** `subscribe: "completion"` or `subscribe: "all"` on `aof_dispatch` — subscriber is the dispatching `actor`
- **Subscribe later:** `aof_task_subscribe` (subscriberId must be a valid org chart agent ID)
- **Unsubscribe:** `aof_task_unsubscribe` with the subscriptionId

| Granularity | Fires | Use for |
|-------------|-------|---------|
| `completion` | Once on terminal state (done/cancelled/deadletter) | React-on-done workflows |
| `all` | Every status change, batched per poll cycle | Progress monitoring |

`all` is a superset of `completion` -- no need for both on the same task.

**Callback handler contract:**
- You receive a session with task results as context. Process it and exit.
- Delivery is at-least-once. Design handlers to be idempotent.
- Callback chains are depth-limited to 3. Sessions have a 2-minute timeout — keep handlers lightweight.

### 2. Chat-message notifications (plugin-driven)

The hosting plugin (e.g. OpenClaw) can send a single chat message when a task reaches an actionable status (blocked/review/done/cancelled/deadletter). Use for pinging humans back in the chat they dispatched from.

- **Default (OpenClaw):** on — the originating chat session is auto-captured and pinged on completion.
- **Explicit opt-out:** pass `notifyOnCompletion: false` on `aof_dispatch`.
- **Explicit target** (cron/CLI or cross-channel routing): pass `notifyOnCompletion: { kind: "<plugin-kind>", target: "<address>" }`. For OpenClaw: `{ kind: "openclaw-chat", target: "telegram:-12345" }`.

Chat delivery is a single message, dedup'd per-status, best-effort. It does **not** spawn a new agent session. Use agent-callback (#1) when you need an agent to react programmatically.
