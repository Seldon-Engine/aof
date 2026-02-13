# AOF Integration Guide (Agent-Executable)
Goal: integrate AOF prompts + workflow into an OpenClaw deployment, deprecating conflicting instructions to prevent contradictory guidance.

## 0) Pre-checks (stop if any fail)
1. Verify the AOF plugin is loaded in OpenClaw (config/logs show `aof-scheduler`).
2. Verify AOF tools are available to your agent: `aof_dispatch`, `aof_task_update`, `aof_task_complete`, `aof_status_report`, `aof_board`.
3. Confirm you can edit workspace files (AGENTS.md, SOUL.md, MEMORY.md) and per-agent workspace files.
4. Confirm the current agent list (IDs) for org chart mapping.

## 1) State directory + org chart
Create the AOF state layout:
```bash
mkdir -p ~/.openclaw/aof/{tasks,events,runs,views,org}
```
Seed the org chart:
```bash
cp ~/Projects/AOF/templates/org-chart-full.yaml ~/.openclaw/aof/org/org-chart.yaml
```
Edit the agents list to match current OpenClaw agents (IDs, teams, roles).
Validate:
```bash
npx aof org validate ~/.openclaw/aof/org/org-chart.yaml
npx aof org lint ~/.openclaw/aof/org/org-chart.yaml
```
(If OpenClaw CLI is available, also run `openclaw aof drift live` after plugin load.)

## 2) Deprecate conflicting instructions
**Critical:** Before adding new AOF directives, comment out existing instructions that conflict with AOF workflow to prevent agents receiving contradictory guidance.

**Deprecation marker format:** Use `<!-- AOF-SUPERSEDED: [original text] -->` for multi-line blocks or inline `<!-- DEPRECATED(aof): ... -->` for single lines.

### Search patterns and replacements

#### AGENTS.md
**Pattern 1:** Look for "Delegate slow work" or "spawn sub-agents for tasks"
```diff
-2. **Delegate slow work** — spawn sub-agents for tasks >10 seconds
+<!-- AOF-SUPERSEDED: Delegate slow work — spawn sub-agents for tasks >10 seconds -->
+2. **Delegate slow work** — if AOF tools are available, create/dispatch a task via `aof_dispatch`; otherwise use `sessions_spawn`.
```

**Pattern 2:** Look for "sessions_spawn" in delegation context
Replace delegation-related `sessions_spawn` references:
```diff
-Use `sessions_spawn` for task delegation
+<!-- DEPRECATED(aof): Use sessions_spawn for task delegation -->
+Use `aof_dispatch` for task delegation when AOF tools available; fallback to `sessions_spawn` only if AOF tools unavailable
```

**Pattern 3:** Update Interaction Contract table (if present)
```diff
-| ACK | What + where outputs land |
+| ACK | What + where outputs land (include AOF taskId if present) |
-| PROGRESS | At boundaries or every 2+ min |
+| PROGRESS | At boundaries or every 2+ min (and `aof_task_update` if available) |
-| DONE | Artifacts + validation |
+| DONE | Artifacts + validation (and `aof_task_complete` if available) |
```

**Append** this stanza under the Interaction Contract:
```md
### AOF Task Workflow (phased)
- If AOF tools are available: dispatch via `aof_dispatch`, update via `aof_task_update`, complete via `aof_task_complete`.
- If AOF tools are not available: use `sessions_spawn` and leave the task card in `ready`.
```

#### SOUL.md
**Pattern:** Look for spawn/delegation routing rules
```diff
-Spawn sub-agents for implementation work
+<!-- AOF-SUPERSEDED: Spawn sub-agents for implementation work -->
+When AOF tools enabled: create/dispatch a task via `aof_dispatch` instead of ad‑hoc spawn. Fallback to `sessions_spawn` only if AOF tools aren't available.
```

**Append** under Boundaries section:
```md
- Don't bypass AOF task cards when AOF tools are available (exceptions: emergency/one‑off with explicit note).
```

#### MEMORY.md
**Pattern 1:** Look for "sessions_spawn" in preferences or task tracking
```diff
-- **sessions_spawn vs sessions_send**: ... Use `sessions_spawn` for task delegation...
+<!-- DEPRECATED(aof): sessions_spawn for task delegation -->
+- **Task delegation (AOF-aware)**: Use `aof_dispatch` when AOF tools available; fallback to `sessions_spawn` only when unavailable. Use `sessions_send` for ongoing conversations.
```

**Pattern 2:** Look for ad-hoc task tracking notes
If you find any manual task tracking patterns like "track tasks in MEMORY.md" or "maintain task list":
```diff
-- Track active tasks in MEMORY.md under "Current work"
+<!-- DEPRECATED(aof): Manual task tracking superseded by AOF task cards -->
```

**Append** under "Preferences (stable defaults)":
```md
- **AOF task workflow (phased)**: When AOF tools are available, prefer `aof_dispatch` for delegation; update tasks with `aof_task_update`/`aof_task_complete`; use `aof_status_report`/`aof_board` for summaries. Fallback to `sessions_spawn` only when AOF tools are unavailable.
```

**Append** under "Infrastructure (stable config)":
```md
- **AOF state**: `~/.openclaw/aof/` (tasks/, events/, runs/, views/, org/)
- **Org chart**: `~/.openclaw/aof/org/org-chart.yaml` (SSOT for roles/permissions)
```

## 3) Per-agent setup (AOF quickstart)
Phase C1 (pilot agents only): add `AOF.md` to each pilot agent workspace (e.g., swe-architect, swe-qa).
Phase C3 (all agents): copy the same `AOF.md` to every SWE agent workspace.
Typical path: `~/.openclaw/agents/<agent>/workspace/AOF.md`.
**Content (exact):**
```md
# AOF Quickstart
- Prefer `aof_dispatch` for new tasks; avoid `sessions_spawn` unless AOF tools are missing.
- Update progress with `aof_task_update` (status/body/work log).
- Mark completion with `aof_task_complete` (summary + outputs).
- Use `aof_status_report` or `aof_board` for quick status.
- Task context lives in task card + inputs/; write outputs to outputs/.
```

## 4) Phased rollout (tools enablement)
1. Phase C1: enable AOF tools for 2–3 pilot agents via OpenClaw config patch (tools allow-list).
2. Observe for 24–48h (tool usage, errors, context bloat).
3. Phase C3: enable for remaining agents in a second patch.

## 5) Verification (smoke tests)
Run these as a pilot agent:
1. `aof_status_report` → returns without error.
2. `aof_dispatch` a test task assigned to yourself (title prefixed with `TEST:`).
3. `aof_task_update` → set status to `in-progress` and add a work log entry.
4. `aof_task_complete` → summary + mark done.
5. `aof_board` → shows the task in done.
If any step fails, stop and rollback.

## 6) Rollback
To restore pre-AOF state:
1. **Uncomment deprecated instructions:** Search for `<!-- AOF-SUPERSEDED:` and `<!-- DEPRECATED(aof):` markers in AGENTS.md, SOUL.md, MEMORY.md.
2. For multi-line blocks: Remove the comment wrapper and delete the AOF replacement.
   ```diff
   -<!-- AOF-SUPERSEDED: Original instruction here -->
   -New AOF instruction here
   +Original instruction here
   ```
3. For inline comments: Remove the marker and restore the original text.
   ```diff
   -<!-- DEPRECATED(aof): Original text --> New AOF text
   +Original text
   ```
4. **Remove AOF additions:** Delete the "AOF Task Workflow" stanzas and "AOF state" entries added in step 2.
5. **Delete per-agent quickstarts:** Remove all `AOF.md` files from agent workspaces.
6. **Disable AOF tools:** Remove AOF tools from the OpenClaw tool allow-list (config patch).
7. **Preserve state for audit:** Keep `~/.openclaw/aof/` directory unless explicitly approved to delete (contains task history/events).

## Done Criteria
- Conflicting instructions commented out with deprecation markers.
- Workspace files updated with AOF-aware directives.
- Quickstarts installed for pilots.
- Org chart validated.
- Smoke tests pass.
- Rollback procedure documented and tested on a non-pilot agent.
