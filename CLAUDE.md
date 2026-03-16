# AOF — Project Instructions

## Serena MCP (MANDATORY)

**Always use Serena's symbolic tools as the primary code navigation and editing approach.** The Serena MCP server is configured for this project and has rich memories about AOF architecture.

### Required Workflow
1. **Before reading any source file**, use `get_symbols_overview` to see its structure
2. **To read a specific function/class**, use `find_symbol` with `include_body=true` — do NOT read the entire file
3. **To find callers/references**, use `find_referencing_symbols` — do NOT grep for function names
4. **To edit a function**, use `replace_symbol_body` — do NOT use string-match Edit on large blocks
5. **To add code**, use `insert_after_symbol` or `insert_before_symbol`
6. **Check Serena memories** (`read_memory`) before investigating unfamiliar areas — project context is stored there

### When NOT to use Serena
- Non-code files (JSON, YAML, Markdown, config)
- Raw text pattern searches across many files (Grep is fine)
- File existence checks (Glob is fine)
- Shell commands and builds (Bash is fine)

### Keeping Serena Knowledge Current
After any session that modifies AOF structure (new files, moved modules, changed interfaces, new conventions):
1. `list_memories` → check which might be stale
2. `read_memory` → verify content matches current code
3. `write_memory` → update any stale memories
4. Key memories: `project_overview`, `style_conventions`, `v1.10-architecture-changes`

## Code Conventions

- **Config**: Use `getConfig()` from `src/config/registry.ts`. Never read `process.env` directly outside `src/config/`.
- **Logging**: Use `createLogger('component')` from `src/logging/index.ts`. Never use `console.*` in core modules (CLI output is OK).
- **Store**: Always use `ITaskStore` methods. Never call `serializeTask` + `writeFileAtomic` directly.
- **Schemas**: Zod is source of truth. Types are derived via `z.infer<>`.
- **Tools**: Register handlers in `src/tools/tool-registry.ts`. MCP and OpenClaw adapters consume the shared registry.
- **No circular deps**: Extract shared types to leaf files. Verify with `npx madge --circular src/`.
- **Tests**: Use `createTestHarness()` for integration tests, `createMockStore()`/`createMockLogger()` for unit tests.

## Build & Test

```bash
npm run typecheck    # Type check (must pass before commit)
npm test             # Unit tests (~3,017 tests)
npm run test:e2e     # E2E tests (224 tests)
npm run build        # Full build
npm run docs:generate # Regenerate CLI docs (pre-commit hook enforces)
```

## Release Process

- GitHub-only releases (NOT on npm). Never reference npm publishing.
- `npm run release:patch` / `release:minor` / `release:major`
- release-it handles: version bump, changelog, git tag, GitHub release
- Tarball layout: `~/.aof/dist/` contains compiled code, `~/.aof/package.json` at root

## Architecture Notes

- **Two execution modes**: Plugin mode (inside OpenClaw gateway via `src/plugin.ts`) and Standalone mode (CLI daemon via `src/daemon/`)
- **Plugin mode** uses `OpenClawAdapter` (in-process agent dispatch)
- **Standalone mode** uses `StandaloneAdapter` (HTTP dispatch to external gateway)
- These paths never cross — see Serena memory `plugin-executor-path-analysis` for details
