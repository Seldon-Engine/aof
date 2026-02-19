# Codex + AOF Subagent Integration Evaluation

**Date**: 2026-02-19
**Bead**: AOF-e6x
**Status**: Spike recommended

## Current State

Codex CLI has subagent support, but dispatch is **model-decided** — there's no caller-controlled routing API. The model autonomously chooses which tools to call and when.

## MCP Compatibility

The existing AOF MCP server (`src/mcp/server.ts`) uses standard stdio transport and would wire up to Codex via `~/.codex/config.toml`:

```toml
[mcp.aof]
command = "node"
args = ["~/Projects/AOF/src/mcp/server.ts"]
```

All 5 AOF tools (task CRUD, dispatch, board) would be available. Resource subscriptions are ignored by Codex but degrade gracefully (no-op).

## Key Differences from Claude Code

| Aspect | Claude Code | Codex |
|--------|-------------|-------|
| Dispatch model | Deterministic — calls `aof_dispatch` with explicit `assignedAgent` | Model-decided — autonomous tool selection |
| Governance fidelity | High — AOF controls routing | Unknown — Codex may skip dispatch or self-assign |
| MCP support | Native, well-tested | Supported, less mature |
| Subagent control | Orchestrator-driven | Model-driven |

The critical difference: Claude Code integration relies on the orchestrator calling `aof_dispatch` with a specific agent assignment. Codex decides autonomously which tools to call, so the governance contract (task-per-work-unit, deterministic routing) may degrade.

## Recommendation: Spike, Don't Ship

1. **MCP wiring is trivially cheap** — config-only, no code changes needed
2. **The unknown is behavioral** — will Codex reliably call `aof_dispatch` with correct parameters?
3. **Spike plan**: Run Codex `--full-auto` against AOF MCP for 5-10 tasks, measure:
   - Does it call `aof_dispatch` consistently?
   - Does it respect task assignments or self-route?
   - Does it follow gate outcomes?
4. **If behavioral fidelity is good**: Promote to `codex` executor type
5. **If not**: Close as "community-supported/best-effort" — MCP still works, just no governance guarantee

## Next Steps

- [ ] Install Codex CLI (`npm i -g @openai/codex`)
- [ ] Wire AOF MCP server in `~/.codex/config.toml`
- [ ] Run 5-10 task dispatches, log tool call traces
- [ ] Decide ship/close based on results
