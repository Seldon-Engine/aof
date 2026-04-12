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

## Serena MCP
**Use Serena as primary code navigation.** `get_symbols_overview` before reading files, `find_symbol(include_body=true)` for code, `find_referencing_symbols` for callers, `replace_symbol_body` for edits. Check `read_memory` before investigating unfamiliar areas. After structural changes, update stale memories. Serena can't parse: `events/logger.ts`, `events/notifier.ts`, `views/kanban.ts`, `views/mailbox.ts`, `events/notification-policy/engine.ts` — use Read for those.

## Build & Release
```bash
npm run typecheck && npm test     # Must pass before commit
npm run test:e2e                  # E2E suite
npm run build                     # Full build
npm run docs:generate             # Regen CLI docs (pre-commit hook enforces)
npm run release:patch|minor|major # GitHub-only. NEVER pass --no-npm (skips version bump, not just publish).
npm run deploy                    # Build + deploy to ~/.aof + symlink plugin
```
