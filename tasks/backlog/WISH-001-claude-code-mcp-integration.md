---
id: WISH-001
title: "Claude Code + AOF MCP Integration"
type: wishlist
priority: low
phase: future
created: 2026-02-07
tags: [mcp, claude-code, runtime-integration]
---

# Claude Code + AOF MCP Integration

AOF exposes MCP server → Claude Code connects as client → uses AOF tools to pick up tasks, get context from `inputs/`, spawn subagents to execute, write to `outputs/`. AOF handles governance (kanban, runbooks, dispatch), Claude Code handles execution (LLM loop, tool use, subagents).

## Key Questions
- Can Claude Code subagent spawning be programmatically controlled from MCP tool responses, or does the model just decide?
- Session persistence — Claude Code sessions are ephemeral; AOF resume protocol assumes durable state
- No cron/channel equivalent — this would be developer-facing, not always-on ops

## Minimum Viable Spike
AOF MCP server → one Claude Code instance → reads task → spawns subagent → completes → AOF records transition. ~1 day to prove concept.
