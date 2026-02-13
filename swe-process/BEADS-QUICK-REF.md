# Beads Quick Reference - Agent Guide

**Version:** 2.0 (Semantic Prerequisites)  
**Status:** Active  
**Scope:** All AOF task management

## Overview

Beads is the task tracking system for AOF. This guide provides workflow patterns and prerequisites for agents working with Beads-managed projects.

## Prerequisites

Your development environment must support the practices used in this project:

- **Version control (usually git) must be initialized**
  - Beads uses version control for task database synchronization
  - Verify version control exists before claiming tasks
  - If missing, Phase 0 of SDLC.md requires initialization

- **Task tracking (beads) must be initialized**
  - Verify `.beads/` directory exists in project root
  - Confirm task database is accessible
  - If missing, initialize with `bd init --quiet`

- **Beads CLI must be installed**
  - Verify `bd` command is available
  - If missing, install globally: `npm install -g @beads/bd`

**Verify these work BEFORE claiming a task.** Do not assume prerequisites exist.

---

## Core Workflows

### For Architects (Task Creation)

```bash
cd ~/Projects/AOF

# Create work
bd create "Task title" --description "Details" --json

# Add dependencies (task depends on blocker)
bd dep add AOF-xyz AOF-abc  # xyz blocked by abc

# Find next ready work
bd ready --json

# View task details
bd show AOF-xyz --json
```

**Pattern:** Architects create tasks, define dependencies, and orchestrate specialists.

---

### For Specialists (Task Execution)

```bash
cd ~/Projects/AOF

# View task (architect passes you the ID)
bd show AOF-xyz --json

# Claim task (sets status=in_progress, assignee=you)
bd update AOF-xyz --claim --json

# When complete, close it
bd close AOF-xyz --json

# Check for more work
bd ready --json
```

**Pattern:** Specialists claim tasks, implement, then close when acceptance criteria are met.

---

## Task ID Format

All tasks use the `AOF-` prefix (e.g., `AOF-abc`, `AOF-12z`, `AOF-xyz`).

Task IDs are hash-based: no merge collisions across branches or agents.

---

## Key Commands

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `bd create` | Create new task | Architect decomposing work |
| `bd dep add` | Add dependency | Architect defining task graph |
| `bd ready` | Find unblocked work | Any agent looking for next task |
| `bd update --claim` | Claim task | Specialist starting work |
| `bd close` | Mark complete | Specialist finishing work |
| `bd show` | View task details | Anyone needing task context |

Always use `--json` flag for programmatic parsing.

---

## Dependency Management

Dependencies are **transitive**: if A depends on B, and B depends on C, then A is blocked until both B and C are closed.

```bash
# Task A depends on Task B (B blocks A)
bd dep add AOF-aaa AOF-bbb

# Find next ready work (no open blockers)
bd ready --json
```

**Pattern:** Architect defines dependency graph, specialists work on ready tasks.

---

## Integration with SDLC

Beads integrates with the Software Development Lifecycle (SDLC.md):

- **Phase 0 (Environment Readiness):** Verify beads is initialized
- **Phase 1 (Design & Planning):** Architect creates tasks and dependencies
- **Phase 2 (Implementation):** Specialists claim and close tasks
- **Phase 3 (Verification):** QA creates bug tasks if issues found
- **Phase 4 (Deployment):** Ops tracks deployment tasks

---

## Common Patterns

### Multi-Step Work Decomposition

```bash
# Architect creates parent and child tasks
bd create "Implement user auth" --description "JWT-based authentication" --json
bd create "Add auth middleware" --description "JWT validation middleware" --json
bd create "Add login endpoint" --description "POST /auth/login" --json

# Define dependencies
bd dep add AOF-login AOF-middleware  # login depends on middleware
```

### Finding Next Work

```bash
# Specialist checks for ready work
bd ready --json

# Claim first available task
bd update AOF-xyz --claim --json
```

### Task Lifecycle

1. **Created** → Architect creates task
2. **Ready** → No open blockers (appears in `bd ready` output)
3. **Claimed** → Specialist runs `bd update --claim`
4. **In Progress** → Specialist implements
5. **Closed** → Specialist runs `bd close` when acceptance criteria met

---

## Features

- **Hash-based IDs:** No merge collisions
- **Transitive dependencies:** Automatically blocks tasks with indirect dependencies
- **Compaction:** Memory decay on old closed tasks (configurable)
- **Git-backed sync:** Automatic synchronization when version control is initialized
- **JSON output:** All commands support `--json` for programmatic use

---

## Troubleshooting

### "No git repository initialized" warning

**Symptom:** Beads emits warning about missing git repository.

**Cause:** Version control is not initialized (required for beads sync).

**Fix:** Phase 0 of SDLC.md requires version control initialization. Verify and fix.

### "Task not found" error

**Symptom:** `bd show AOF-xyz` returns error.

**Cause:** Task ID doesn't exist or is misspelled.

**Fix:** Verify task ID with `bd ready --json` or check task creation output.

### Can't claim task

**Symptom:** `bd update --claim` fails or task doesn't appear in `bd ready` output.

**Cause:** Task has open blockers (dependencies not yet closed).

**Fix:** Check task dependencies with `bd show <id> --json`, work on blocker tasks first.

---

## Anti-Patterns (What NOT to Do)

### ❌ Prescriptive Git Setup

**Wrong:**
```
STEP 1: Run `git init`
STEP 2: Run `git add .beads/`
STEP 3: Run `git commit -m "Initial beads database"`
```

**Right:**
```
Prerequisites: Version control must be initialized.
Verify with diagnostic commands. If missing, initialize it.
```

**Why:** Agents should understand prerequisites and verify them with judgment, not follow rote instructions.

### ❌ Assuming Beads Exists

**Wrong:**
```
# Directly run bd commands without checking
bd ready --json
```

**Right:**
```
# Phase 0 verification
Verify `.beads/` directory exists and `bd` command is available.
If missing, initialize with `bd init --quiet`.
```

**Why:** Agents should verify prerequisites before using tools.

---

## References

- Beads repository: https://github.com/steveyegge/beads
- Agent instructions: https://raw.githubusercontent.com/steveyegge/beads/main/AGENT_INSTRUCTIONS.md
- SDLC phases: See `swe-process/SDLC.md`
- AOF project: `~/Projects/AOF`
- Beads database: `~/Projects/AOF/.beads/`
