# Phase 36: Config Registry - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Single typed config registry for all environment variable configuration. Replaces scattered process.env reads with a Zod-validated, frozen singleton. Covers AOF_* vars, OPENCLAW_* vars, and OPENAI_API_KEY. Structured logging (Phase 37) will consume AOF_LOG_LEVEL from this registry.

</domain>

<decisions>
## Implementation Decisions

### Startup Validation
- Fail hard on invalid config — getConfig() throws a single ConfigError listing ALL validation failures
- Lazy initialization: first getConfig() call reads env, validates via Zod, caches frozen result. No explicit init step
- Warn on unknown AOF_* env vars (typo detection, e.g., "AOF_DAAT_DIR — did you mean AOF_DATA_DIR?"). Warning, not fatal

### Config Shape
- Nested by domain: `core`, `dispatch`, `daemon`, `openclaw`, `integrations`
- core: dataDir, logLevel
- dispatch: defaultLeaseTtlMs, spawnTimeoutMs, maxConcurrency, maxDispatchesPerPoll
- daemon: pollIntervalMs
- openclaw: gatewayUrl, gatewayToken, stateDir (replaces dead OPENCLAW_*/CLAWDBOT_* env reads)
- integrations: openaiApiKey (replaces direct OPENAI_API_KEY read in memory/)
- Env vars only — no CLI flag override layer. CLI passes values explicitly where needed
- resetConfig() accepts partial overrides for test isolation (deep-merged with defaults)

### paths.ts Integration
- Registry owns AOF_DATA_DIR value. resolveDataDir() in paths.ts drops its process.env read and sources from getConfig()
- paths.ts stays as pure path-resolution functions, registry is single source of truth for env config

### File Organization
- Rename existing config/manager.ts → config/org-chart-config.ts (it handles org-chart YAML, not env vars)
- New file: config/registry.ts — the env var config registry
- Update config/index.ts barrel exports for both

### Env Var Scope
- Registry covers ALL process.env reads in src/ (not just AOF_*):
  - AOF_DATA_DIR, AOF_LOG_LEVEL, and other AOF_* vars
  - OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN, OPENCLAW_STATE_DIR (currently dead fallbacks — nothing sets them, but making them explicit and typed)
  - CLAWDBOT_STATE_DIR removed (legacy alias, dead code)
  - OPENAI_API_KEY from memory/index.ts
- AOF_CALLBACK_DEPTH stays as direct process.env mutation — documented cross-process exception per CFG-03

### Claude's Discretion
- Exact Zod schema field names (camelCase mapping from SCREAMING_SNAKE env vars)
- Default values for optional fields
- ConfigError class implementation details
- Typo suggestion algorithm for unknown AOF_* vars

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/config/paths.ts`: resolveDataDir() pattern — will be refactored to read from registry
- `src/config/manager.ts`: validateConfig() pattern with Zod safeParse — similar validation approach for registry
- Zod already a project dependency (used extensively in schemas/)

### Established Patterns
- Frozen objects: Object.freeze used in schemas for immutable data
- Singleton pattern: EventLogger, TaskLockManager instances created once in AOFService
- Module-scoped caching: Used in lease-manager.ts, throttle.ts

### Integration Points
- `src/config/paths.ts` — resolveDataDir() will source from registry instead of process.env
- `src/daemon/standalone-adapter.ts` — constructor will read from getConfig().openclaw
- `src/openclaw/openclaw-executor.ts` — resolveGatewayDistDir() will read from getConfig().openclaw
- `src/memory/index.ts` — embeddings apiKey will read from getConfig().integrations
- `src/mcp/shared.ts` — AOF_CALLBACK_DEPTH stays as-is (exception)
- `src/dispatch/callback-delivery.ts` — AOF_CALLBACK_DEPTH stays as-is (exception)

</code_context>

<specifics>
## Specific Ideas

- ConfigError should list every invalid field with expected vs actual value, formatted for terminal readability
- Unknown AOF_* var warnings should suggest the closest known var name (Levenshtein or simple prefix match)
- CLAWDBOT_STATE_DIR legacy alias should be removed entirely (dead code), not migrated to registry

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 36-config-registry*
*Context gathered: 2026-03-12*
