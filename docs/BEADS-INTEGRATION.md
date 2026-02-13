# Beads Integration - SWE Suite

**Date:** 2026-02-13  
**Status:** Complete  
**Scope:** Local SWE suite only (not Mule)

## Overview

Beads (https://github.com/steveyegge/beads) is now the task management system for the AOF project and the local SWE agent suite. It provides dependency-aware graph-based issue tracking optimized for AI coding agents.

## Installation

- **Beads CLI:** Installed globally via `npm install -g @beads/bd` (version 0.49.6)
- **AOF Project:** Initialized with `bd init --quiet` in `~/Projects/AOF`
- **Database:** SQLite + JSONL at `~/Projects/AOF/.beads/`

## Task ID Format

All tasks use the `AOF-` prefix (e.g., `AOF-abc`, `AOF-12z`, `AOF-xyz`).

## Core Workflow

### For Architect (swe-architect)

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

### For Specialists (backend, frontend, qa, etc.)

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

## Key Features

- **`bd ready --json`** — Returns tasks with no open blockers (transitive dependency resolution)
- **`bd update <id> --claim --json`** — Atomic task claiming for multi-agent work
- **`bd dep add <task> <blocker> --json`** — Add dependency (task depends on blocker)
- **Hash-based IDs** — No merge collisions across branches/agents
- **Compaction** — Memory decay on old closed tasks (configurable)
- **MCP server** — Available for external tools (not yet integrated)
- **Git-backed** — When git is initialized, auto-syncs via JSONL + Dolt DB

## Validation Results

✅ Beads CLI installation successful  
✅ AOF project initialization complete  
✅ Task creation works (`bd create`)  
✅ Dependency management works (`bd dep add`)  
✅ Ready work detection works (`bd ready --json`)  
✅ Claim workflow works (`bd update --claim`)  
✅ Close workflow works (`bd close`)  
✅ JSON output is clean and parseable  
✅ JSONL persistence working (`.beads/issues.jsonl`)  
✅ Dependency resolution is transitive and correct  

## Agent Documentation Updates

Updated the following agent workspace files:

- **Shared AGENTS.md** (`mock-vault/Resources/OpenClaw/Agents/swe-suite/AGENTS.md`)
  - Added "Task Management (Beads)" section
  - Documented workflow integration for all roles

- **swe-architect**
  - `workspace/AGENTS.md` — Added beads workflow section
  - `workspace/SOUL.md` — Replaced kanban board references with beads
  - `workspace/TOOLS.md` — Added comprehensive beads usage guide

- **swe-backend, swe-frontend, swe-qa**
  - `workspace/TOOLS.md` — Added specialist beads workflow (claim/close pattern)

## Migrated Tasks

The following wishlist items were migrated from `tasks/backlog/` to beads:

- **AOF-zn7** — Claude Code + AOF MCP Integration
- **AOF-e6x** — OpenAI Codex + AOF Subagent Integration

The old `tasks/` directory structure remains for reference but is no longer actively used.

## Git Integration

Beads integrates with version control when it exists. If version control is not initialized, Beads works fine with SQLite + JSONL persistence, but emits warnings about "no git repository initialized - running without background sync."

**Semantic Approach:**
- **Phase 0 of SDLC** (Environment Readiness) requires version control to be initialized if Trunk-Based Development is specified.
- Agents verify prerequisites semantically: run diagnostic commands (e.g., `git status`), identify gaps, and initialize as needed.
- No prescriptive step-by-step commands—agents use judgment.

See `swe-process/SDLC.md` for the semantic guidance approach.

## References

- Beads repo: https://github.com/steveyegge/beads
- Agent instructions: https://raw.githubusercontent.com/steveyegge/beads/main/AGENT_INSTRUCTIONS.md
- FAQ: https://github.com/steveyegge/beads/blob/main/docs/FAQ.md
- AOF project: `~/Projects/AOF`
- Agent workspaces: `~/.openclaw/agents/swe-*/workspace/`

## Next Steps

1. Agents should now use `bd ready --json` to find work instead of scanning `tasks/backlog/`
2. Architect should create beads tasks when decomposing work
3. Specialists should claim tasks with `bd update <id> --claim` and close with `bd close <id>`
4. Consider initializing git in AOF to enable auto-sync (optional)
5. Explore MCP server integration for external tools (future enhancement)
