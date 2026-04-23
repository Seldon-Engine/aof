# AOF — Project Instructions

## Context
Deterministic orchestration for multi-agent systems. No LLMs in the control plane. Tasks are Markdown+YAML frontmatter files in `tasks/<status>/`, physically moved on transitions. Two entry points converge on one core: plugin mode (`src/plugin.ts` → OpenClawAdapter, in-process) and standalone mode (`src/daemon/` → StandaloneAdapter, HTTP). Both feed `AOFService` → `poll()` → dispatch pipeline. These paths never cross.
**Stack**: TypeScript ESM, Node >=22, Zod, Pino, better-sqlite3, hnswlib-node, Commander.js, Vitest.
**Tests**: ~3,017 unit (10s), 224 E2E (sequential, single fork, 60s). `createTestHarness()` for integration, `createMockStore()`/`createMockLogger()` for unit. Regression tests: `bug-NNN-description.test.ts`.
See `CODE_MAP.md` for full architecture, module layering, and subsystem details.

## Engineering Standards
- **TDD**: Failing test first. Tests describe behavior, not implementation details. Integration tests over scattered unit tests.
- **TBD**: Small, atomic commits to main. No long-lived branches. Feature flags over feature branches when gating.
- **Root causes over bandaids, always.** No side effects. No workarounds that paper over the issue.
- **When you make a mistake that gets corrected** → document it in `lessons.md`.

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
Schema (`src/schemas/`) → store (if task-related) → logic (`src/dispatch/` or domain module) → tool handler (`src/tools/*-tools.ts`) → registry (`tool-registry.ts`) → tests (colocated `__tests__/`). CLI command optional. Tools needing adapter-specific behavior get overrides in `mcp/tools.ts` or `openclaw/adapter.ts`.

## Fragile — Tread Carefully
- **Plugin/standalone executor wiring** (`plugin.ts`, `openclaw/adapter.ts`, `daemon/daemon.ts`): Two separate code paths. Changes risk breaking one mode while testing the other.
- **MCP tool skip-list** (`mcp/tools.ts:326`): Hardcoded 5-name array. Must update manually when adding MCP-specific overrides.
- **Dispatch chain** (`scheduler.ts` → `task-dispatcher.ts` → `action-executor.ts` → `assign-executor.ts`): Tightly coupled. Changes cascade.
- **`AOF_CALLBACK_DEPTH`** env mutation (`dispatch/callback-delivery.ts`): Only exception to config-only env access. Don't add more.
- **Chat-delivery cross-process chain**: `OpenClawChatDeliveryNotifier` (daemon) → `QueueBackedMessageTool` → `ChatDeliveryQueue` → `/v1/deliveries/wait` (plugin long-poll) → `sendChatDelivery` → OpenClaw `api.runtime.channel.<platform>.sendMessage<Platform>` → ACK back → queue resolves the awaiter → notifier updates subscription. The notifier's `messageTool.send()` BLOCKS on plugin ACK — a slow/broken plugin stalls the EventLogger callback. Not fatal (EventLogger catches thrown callbacks) but visible in log latency. Don't add async work to that chain without understanding this.

## Code Navigation — tool preference order
**Always Serena first, then ripgrep, then the boring old tools.** This is not a suggestion.

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
- **"Is this symbol used in production?"** is `find_referencing_symbols`, *never* `grep \| grep -v __tests__`. One call, structured answer, no re-export blind spots.
- **Never `Read` an entire file before you know which symbol you want.** Overview first.
- **Never `cat`/`sed`/`awk` source files via Bash.** Use Serena or Read.
- `rg` beats `grep` for everything. If you're typing `grep -rn`, stop and use `rg`.

Serena parser gaps (use `Read` for these only): `events/logger.ts`, `events/notifier.ts`, `views/kanban.ts`, `views/mailbox.ts`, `events/notification-policy/engine.ts`.

After structural changes (new modules, moved files, renamed interfaces), update Serena memories — stale memories actively mislead future sessions.

## Build & Release
```bash
npm run typecheck && npm test     # Must pass before commit
npm run test:e2e                  # E2E suite
npm run build                     # Full build
npm run docs:generate             # Regen CLI docs (pre-commit hook enforces)
npm run release:patch|minor|major # GitHub-only. NEVER pass --no-npm (skips version bump, not just publish).
npm run deploy                    # Build + deploy to ~/.aof + symlink plugin
```

**After `npm run deploy`, restart BOTH launchd jobs** — the gateway AND the standalone daemon:
```bash
launchctl kickstart -k "gui/$(id -u)/ai.openclaw.aof"       # standalone daemon (owns /v1/* routes)
launchctl kickstart -k "gui/$(id -u)/ai.openclaw.gateway"   # OpenClaw gateway (hosts the plugin)
```
Restarting only the gateway is a trap: the plugin reloads with new code and starts polling new IPC routes, but the daemon keeps the old code in memory and returns 404 until it's restarted. A silent 30s-backoff loop results.

**Before kickstarting, verify the `op run` wrapper is still present in the plists.** Upgrades and manual edits have historically stripped it out (see the `*.plist.bak-pre-oprun-restore-*` backups in `~/Library/LaunchAgents/`); without it the process runs with no 1Password-sourced env vars, and the failure mode (missing API keys, empty tokens) is usually a cascade of unrelated-looking errors. Quick check:
```bash
rg -A 1 "ProgramArguments" ~/Library/LaunchAgents/ai.openclaw.gateway.plist ~/Library/LaunchAgents/ai.openclaw.aof.plist | rg "oprun|op run|\.openclaw/bin/"
```
The gateway plist should invoke `openclaw-gateway-oprun.sh` (or equivalent `op run --env-file …` wrapper). If the line is missing, restore from the most recent `.bak-pre-oprun-restore-*` backup before kickstarting — otherwise the restart will bring the process up in a broken state. Do this check even when only restarting (not just deploying).

**Long-running OpenClaw agent processes cache plugin code in memory.** OpenClaw reloads the AOF plugin per-session, but process-resident agents (workspace processes started on some prior day) hold whatever plugin code they loaded at startup. After an AOF version bump that crosses an architectural boundary (e.g. Phase 43 thin-bridge, pre vs post), those agents continue running OLD plugin code — including a pre-thin-bridge in-process `AOFService` + `EventLogger` that appends to the same `events/YYYY-MM-DD.jsonl` as the new daemon. Symptoms: two interleaved `eventId` sequences in one file, `aof_dispatch` calls logged by an unexpected logger, transitions that never reach the new daemon's notifier callbacks. Restarting the gateway alone does not help — the zombie agents are separate processes. `ps aux | grep openclaw` and kill any agent process whose start time pre-dates the AOF install, or just **reboot**. There is no live plugin-reload mechanism.

**Release notes are ALWAYS hand-crafted — never ship the auto-generated `@release-it/conventional-changelog` dump to users.** Immediately after `release-it` completes, overwrite the GitHub release notes with a structured highlights document. A release is not "done" until this step runs.

```bash
# After release-it succeeds:
gh release edit v<version> --notes-file /tmp/v<version>-notes.md
```

Required sections, in this order:
1. **TL;DR** — 1–2 sentences: what changed, what the user needs to do to upgrade.
2. **What's New** (features) / **Bug Fixed** (patches) — user-visible behavior change, not commit titles. Tables for enumerable things (routes, flags, config keys).
3. **Upgrade Notes** — required upgrade actions (migrations, deprecations, config changes, compatibility breaks). Call out migration numbers and idempotence.
4. **Architecture Internals** (for minor+) OR **Test Infrastructure** (if infra work shipped) — for developers working on AOF itself; keep brief.
5. **Full Changelog** — link to the `v<prev>...v<this>` compare URL.

Hard rules for the notes body:
- No GSD phase internals (`43-08`, `D-01/D-04`, `WR-01`) in user-facing copy — those are internal references.
- No bare conventional-commit dumps (`feat(X): ...` lists) — readers shouldn't have to decode commit subjects to learn what changed.
- Cite concrete commands users will run (`aof setup --auto --upgrade`), concrete paths (`~/.aof/data/daemon.sock`), concrete error strings they might see in logs.
- "Who is affected" paragraph whenever a bug fix is user-visible.

If you're tempted to skip the notes pass because "it was a small release" or "the commits are self-explanatory": they aren't. Do it anyway.

## Orphan vitest workers
Vitest uses a tinypool worker pool. When a `npm test` / `npx vitest` invocation is aborted mid-run (timeout, Ctrl-C, tool cancellation), the pool's child `node (vitest N)` processes are frequently leaked — they keep running at 100% CPU, holding ports and file handles. Root cause isn't ours; vitest's pool cleanup on SIGTERM is unreliable under some circumstances.

**After ANY aborted or timed-out test run, immediately:**
```bash
ps -eo pid,command | grep -E "node \(vitest" | grep -v grep | awk '{print $1}' | xargs -r kill -9
```
Then verify with `ps -eo pid,pcpu,command | grep vitest | grep -v grep` — should be empty. Do this before starting a follow-up test run to avoid pool-contention flakes.
