---
id: WISH-002
title: "OpenAI Codex + AOF Subagent Integration"
type: wishlist
priority: low
phase: future
created: 2026-02-07
tags: [codex, openai, runtime-integration, subagents]
---

# OpenAI Codex + AOF Subagent Integration

Codex recently added subagent support. Same pattern as WISH-001: AOF as governance layer, Codex as execution runtime. Evaluate whether Codex's subagent API allows deterministic dispatch (vs. model-decided) and whether MCP or another protocol is the right bridge.

## Key Questions
- What's Codex's subagent API surface? Can it be driven externally?
- Does Codex support MCP natively or need a different integration path?
- Compare constraints vs. Claude Code integration (WISH-001)
