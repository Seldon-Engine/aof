# Phase 7: Projects - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Close gaps in the existing project primitive so multiple projects run on one AOF instance with complete isolation. Tool scoping, dispatch filtering, and memory pool boundaries all work end-to-end. Includes CLI commands for humans and OpenClaw tools for agents, plus a companion skill documenting project tool usage.

</domain>

<decisions>
## Implementation Decisions

### Project scaffold (`aof project create --template`)
- Full structure upfront: manifest + empty task directory + memory config + README template
- YAML manifest format (consistent with existing org-chart.yaml pattern)
- Interactive CLI wizard for humans (prompts for name, description, initial participants)
- Must also expose project operations as OpenClaw tools so agents can create/manage projects programmatically through the plugin
- Companion skill (`.agents/skills/projects/SKILL.md` or similar) should provide clear, concise instructions on how agents leverage project tools
- `aof project list` shows ALL projects on the instance — project isolation applies to tasks and memory, not project awareness

### Participant assignment
- Participant list lives in the project manifest (project.yaml `participants:` field)
- Agents can be in multiple projects simultaneously
- Unassigned agents have global access — projects are opt-in isolation, not mandatory
- `aof project add-participant <project> <agent>` CLI command + matching OpenClaw tool for agents

### Cross-project boundaries
- Tasks without a project ID land in the existing global task store — backward compatible, any agent can pick them up
- Separate HNSW index per project for memory isolation — complete storage-level separation, no chance of cross-contamination
- Memory search requires specifying a project context — agents must choose which project's memory to query
- ToolContext auto-populates `projectId` from the task being executed — tools scope operations automatically without agents needing to pass it explicitly

### Claude's Discretion
- Exact manifest fields beyond name, description, participants
- Directory structure naming conventions
- Integration test design and assertion patterns
- How existing project code in the codebase maps to these decisions
- Memory index file naming/location per project

</decisions>

<specifics>
## Specific Ideas

- The interactive wizard should follow the same pattern as the installer wizard from Phase 6
- Agent tools for project management must go through the OpenClaw plugin interface — same mechanism existing AOF tools use
- The companion skill is important: agents should understand project context without needing human instruction

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 07-projects*
*Context gathered: 2026-02-26*
