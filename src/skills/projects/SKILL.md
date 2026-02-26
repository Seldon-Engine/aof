# AOF Projects Skill

## Overview

AOF supports multi-project isolation. Each project has its own task store, memory pool, and participant list. Use these tools to create and manage projects.

## Tools

### aof_project_create
Create a new project with isolated task and memory storage.

**Parameters:**
- `id` (required): Project ID (lowercase, hyphens, underscores only)
- `title`: Human-readable name
- `type`: One of swe, ops, research, admin, personal, other
- `participants`: Array of agent IDs with exclusive access

**Example:**
```json
{ "id": "frontend-redesign", "title": "Frontend Redesign", "type": "swe", "participants": ["swe-frontend", "swe-ux"] }
```

### aof_project_list
List all projects on the instance. No parameters required. Returns project IDs, paths, and any discovery errors.

### aof_project_add_participant
Add an agent to a project's participant list.

**Parameters:**
- `project` (required): Project ID
- `agent` (required): Agent ID to add

**Example:**
```json
{ "project": "frontend-redesign", "agent": "swe-qa" }
```

## Project Isolation Rules

1. **Tasks**: Tasks with a `project` field are stored in that project's task directory. Tasks without a project go to the global store.
2. **Memory**: Use the `project` parameter in memory_search/memory_store to scope to a project's isolated memory pool. Without it, you access global memory.
3. **Participants**: If a project has participants listed, only those agents receive tasks from that project. Empty participants = any agent can work on it.
4. **Visibility**: `aof_project_list` shows ALL projects regardless of participant status. Isolation applies to tasks and memory, not project awareness.

## When to Use Projects

- Separate client work that should not cross-contaminate
- Isolate research experiments from production tasks
- Organize teams with distinct memory pools
- Any scenario where task and memory isolation matters
