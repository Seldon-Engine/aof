# AOF — Project Instructions

## Context
Deterministic orchestration for multi-agent systems. No LLMs in the control plane; tasks are Markdown+YAML files in `tasks/<status>/` that physically move on transitions. Plugin mode (in-process via OpenClaw) and standalone mode (HTTP daemon) converge on `AOFService` → `poll()` → dispatch. **See `CODE_MAP.md` for architecture, module layering, IPC contracts, and subsystem details — don't duplicate that here.**

## Engineering Standards
- **TDD**: Failing test first. Tests describe behavior, not implementation details. Integration over scattered unit tests.
- **TBD**: Small atomic commits to main. No long-lived branches. Feature flags over feature branches.
- **Root causes over bandaids, always.** No workarounds that paper over the issue.
- **Mistakes that get corrected** → document in `lessons.md`.

## Conventions
- **Config**: `getConfig()` from `src/config/registry.ts`. No `process.env` elsewhere (exception: `AOF_CALLBACK_DEPTH` cross-process).
- **Logging**: `createLogger('component')`. No `console.*` in core modules (CLI output OK).
- **Store**: `ITaskStore` methods only. Never `serializeTask` + `writeFileAtomic` directly.
- **Schemas**: Zod source of truth. `const Foo = z.object({...})` + `type Foo = z.infer<typeof Foo>`.
- **Tools**: Register in `src/tools/tool-registry.ts`. Both adapters consume the shared registry.
- **No circular deps**: Shared types → `types.ts` leaf files. Verify: `npx madge --circular --extensions ts src/`.
- **Naming**: PascalCase types, camelCase functions, `I` prefix for store interfaces. `.js` in import paths.
- **Barrels**: `index.ts` = pure re-exports only. No logic.

## Feature Anatomy
Schema (`src/schemas/`) → store (if task-related) → logic (`src/dispatch/` or domain module) → tool handler (`src/tools/*-tools.ts`) → registry (`tool-registry.ts`) → tests (colocated `__tests__/`). CLI command optional. Adapter-specific overrides in `mcp/tools.ts` or `openclaw/adapter.ts`.

## Fragile — Tread Carefully
- **Plugin/standalone executor wiring** (`plugin.ts`, `openclaw/adapter.ts`, `daemon/daemon.ts`): two separate code paths. Changes risk breaking one mode while testing the other.
- **MCP tool skip-list** (`mcp/tools.ts:326`): hardcoded 5-name array. Update manually when adding MCP-specific overrides.
- **Dispatch chain** (`scheduler.ts` → `task-dispatcher.ts` → `action-executor.ts` → `assign-executor.ts`): tightly coupled, changes cascade.
- **`AOF_CALLBACK_DEPTH`** env mutation (`dispatch/callback-delivery.ts`): only exception to config-only env access. Don't add more.
- **Chat-delivery cross-process chain** (full pipeline in CODE_MAP.md → "Chat-delivery pipeline"): the daemon-side notifier's `messageTool.send()` BLOCKS on plugin ACK — a slow/broken plugin stalls the EventLogger callback (caught, but visible as latency). Don't add async work to that chain without understanding this.
- **Conversation-access hook gate** (OpenClaw ≥ 2026.4.23): non-bundled plugins must set `plugins.entries.aof.hooks.allowConversationAccess=true` or `agent_end`/`llm_input`/`llm_output` registrations are silently dropped. Symptom: dispatch latency regresses to `pollIntervalMs` (30s) because `triggerPoll("agent_end")` never fires. Gateway log shows `typed hook ... blocked` at boot.

## Code Navigation — tool preference order
**Always Serena first, then ripgrep, then the boring old tools.**

| Task | Preferred | Fallback |
|---|---|---|
| Understand a new file | `get_symbols_overview` | `Read` (last resort) |
| Read a specific function/class | `find_symbol(include_body=true)` | `Read` with offset |
| Find who calls / references X | `find_referencing_symbols` | `rg 'X\b' -t ts` |
| Edit a whole function/class | `replace_symbol_body` | `Edit` |
| Edit a few lines inside a symbol | `replace_content` (regex) | `Edit` |
| Text/literal/regex search | `search_for_pattern` | `rg` |
| Existing project context | `read_memory` | — |

Rules that catch common reflexes:
- **"Is this symbol used in production?"** is `find_referencing_symbols`, *never* `grep | grep -v __tests__`. One call, structured answer, no re-export blind spots.
- **Never `Read` a whole file before you know which symbol you want.** Overview first.
- **Never `cat`/`sed`/`awk` source files via Bash.** Use Serena or Read. `rg` beats `grep` for everything.

Serena parser gaps (use `Read` only): `events/logger.ts`, `events/notifier.ts`, `views/kanban.ts`, `views/mailbox.ts`, `events/notification-policy/engine.ts`. Refresh Serena memories after structural changes (new modules, moved files, renamed interfaces) — stale memories actively mislead.

## Build & Test
```bash
npm run typecheck && npm test     # gates a commit
npm run test:e2e                  # E2E suite (sequential, single fork)
npm run build                     # full build
npm run docs:generate             # CLI doc regen (pre-commit hook enforces)
```

## Deploy & Restart
`npm run deploy` builds and deploys to `~/.aof` + symlinks plugin. After deploy, **restart both** launchd jobs:
```bash
launchctl kickstart -k "gui/$(id -u)/ai.openclaw.aof"        # standalone daemon (owns /v1/* routes)
launchctl kickstart -k "gui/$(id -u)/ai.openclaw.gateway"    # OpenClaw gateway + plugin
```
Restarting only the gateway is a trap: the plugin reloads with new code and starts polling new IPC routes, but the daemon keeps the old code in memory and 404s — silent 30s-backoff loop.

Before kickstart, verify the `op run` wrapper survived (upgrades have stripped it; backups at `*.plist.bak-pre-oprun-restore-*`). Without it, processes start with no 1Password env vars and the failure cascades:
```bash
rg "oprun|op run" ~/Library/LaunchAgents/ai.openclaw.{gateway,aof}.plist
```

## Stale OpenClaw Processes
After any OpenClaw upgrade or AOF deploy, two flavors of stale process can persist (clean both):

- **Flavor 1 — `openclaw-agent` zombies** (per-session, hold old AOF plugin code from startup): `ps -eo pid,lstart,command | grep openclaw-agent` → kill any with `lstart` predating the deploy. Symptom: interleaved eventId sequences in `events/YYYY-MM-DD.jsonl`, transitions that never reach the new daemon's notifier.
- **Flavor 2 — `openclaw` worker zombies** (gateway worker pool, hold old OpenClaw module-cache hashes after `npm install -g openclaw@latest`): `stat -f %m /opt/homebrew/lib/node_modules/openclaw/` vs each worker's `lstart` → kill workers older than the install. Symptom: intermittent `Cannot find module './send-*.js'` errors. `launchctl kickstart` does NOT recycle workers. Phase 999.5 backlog automates this in `scripts/deploy.sh`.

## Release
```bash
npm run release:patch|minor|major   # GitHub-only. NEVER pass --no-npm — it silently skips the version bump.
```

**Release notes are hand-crafted.** Auto-generated `@release-it/conventional-changelog` dumps don't ship to users. After `release-it` succeeds, overwrite via `gh release edit v<version> --notes-file /tmp/v<version>-notes.md`. Required structure:

1. **TL;DR** — what changed, what user does to upgrade
2. **What's New** / **Bug Fixed** — user-visible behavior, not commit titles
3. **Upgrade Notes** — required actions (migrations, deprecations, config changes)
4. **Internals** — brief, only for minor+
5. **Full Changelog** — `v<prev>...v<this>` link

Hard rules: no GSD phase internals (`43-08`, `D-01`) in user copy; no bare commit-title dumps; cite concrete commands and paths users will run; "Who is affected" paragraph for user-visible bugfixes.

## End-to-End Debugging via OpenClaw Agent Channel
When a bug only surfaces through the full plugin → daemon → tool-call pipeline, drive the user's running `main` agent from this conversation.

- **Send:** `openclaw agent --agent main --session-id <sid> --message "…"`. Find candidates via `openclaw sessions --agent main --active 1440 --json` — pick `kind:"direct"` with low `contextTokens`.
- **Receive:** the CLI's stdout hangs unreliably on OpenClaw ≥ 2026.4.22. Read transcripts at `~/.openclaw/agents/<agent>/sessions/<session-id>.jsonl` — assistant replies are records with `.type=="message" && .message.role=="assistant" && .message.stopReason=="stop"`.
- **Use for:** repro requiring real MCP→daemon path (parallel tool_use races, envelope forwarding, completion enforcement); end-to-end smoke after a deploy.
- **Don't use for:** unit-testable logic (write a vitest test); reads satisfiable via direct IPC `curl --unix-socket ~/.aof/data/daemon.sock http://localhost/v1/tool/invoke` (faster, isolates plugin vs daemon).

Stale `openclaw-agent` processes (Flavor 1 above) cache plugin code from their start time — confirm session agent `lstart` is newer than the deploy or you'll fake-reproduce.

## Orphan Vitest Workers
After **any** aborted/timed-out test run, immediately:
```bash
ps -eo pid,command | grep -E "node \(vitest" | grep -v grep | awk '{print $1}' | xargs -r kill -9
```
Vitest's tinypool leaks workers on SIGTERM. Verify with `ps -eo pid,pcpu,command | grep vitest | grep -v grep` (should be empty) before another run.
