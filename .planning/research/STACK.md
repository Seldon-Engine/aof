# Technology Stack

**Project:** AOF v1.10 — Centralized Config Registry & Structured Logging
**Researched:** 2026-03-12
**Scope:** Stack additions/changes for replacing scattered `process.env` access with a typed config registry and replacing 751 `console.*` calls with structured logging

## Executive Assessment

**No new runtime dependencies required.** Both the config registry and structured logging should be built as zero-dependency internal modules using Node.js 22 built-ins and existing Zod schemas. This is the correct choice for AOF because:

1. **Config registry** is a Zod schema + singleton pattern -- no library exists that adds value over what Zod already provides. The "registry" is a typed object populated at startup from env vars, CLI args, and defaults, validated by Zod, and frozen. External config libraries (node-config, convict, env-schema) add dependencies for functionality Zod already delivers.

2. **Structured logging** should NOT use pino, winston, or any external logger. AOF already has `EventLogger` for structured JSONL audit events. What it lacks is a leveled operational logger for the `console.*` replacement. Pino v10 brings 11 transitive dependencies and 664kB -- disproportionate for a project that avoids unnecessary deps. A thin `Logger` class wrapping `process.stderr.write()` with JSON output, log levels, and child logger support is ~100 lines and covers the actual need.

**Confidence:** HIGH -- verified against installed packages, Node.js 22 APIs, existing codebase patterns, and AOF's zero-external-service constraint.

## Existing Stack (Confirmed Sufficient)

| Technology | Installed | Purpose for Config/Logging | Status |
|------------|-----------|---------------------------|--------|
| Node.js | 22.22.0 (pinned) | `process.env`, `process.stderr.write()`, `performance.now()` | Sufficient |
| TypeScript | 5.7.x | Typed config schema, logger interfaces | Sufficient |
| zod | 3.24.x | Config schema validation, env var parsing | Sufficient |
| vitest | 3.0.x | Unit tests for registry and logger | Sufficient |

## Recommended Stack

### Config Registry

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Zod | 3.24.x (existing) | Config schema definition, env var coercion, validation | Already AOF's schema layer. `z.coerce.number()` handles string-to-number for env vars. No new dep needed. |
| Node.js `process.env` | 22.x (built-in) | Env var source | Already used in 11+ files -- consolidation, not replacement |
| Custom `ConfigRegistry` class | N/A (internal) | Typed singleton with `.get()` accessor | ~150 lines. Zod parse at startup, freeze object, export typed accessors |

**Architecture:**

```typescript
// src/config/registry.ts — the entire config surface in one place

import { z } from "zod";

const AofConfigSchema = z.object({
  // Paths
  dataDir: z.string().default("~/.openclaw/aof"),
  aofRoot: z.string().optional(),

  // Daemon
  pollIntervalMs: z.coerce.number().default(5000),
  defaultLeaseTtlMs: z.coerce.number().default(300_000),
  heartbeatTtlMs: z.coerce.number().default(60_000),
  maxConcurrentDispatches: z.coerce.number().min(1).max(50).default(5),
  daemonSocketPath: z.string().optional(),

  // Feature flags
  dryRun: z.coerce.boolean().default(false),
  modules: z.object({
    memory: z.object({ enabled: z.coerce.boolean().default(true) }),
    dispatch: z.object({ enabled: z.coerce.boolean().default(true) }),
    murmur: z.object({ enabled: z.coerce.boolean().default(true) }),
    linter: z.object({ enabled: z.coerce.boolean().default(true) }),
  }).default({}),

  // Memory / embedding
  openaiApiKey: z.string().optional(),

  // Runtime (set programmatically, not from env)
  callbackDepth: z.coerce.number().default(0),

  // Logging
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export type AofConfig = z.infer<typeof AofConfigSchema>;
```

**Key design decisions:**

1. **Single Zod schema** defines all config with defaults -- replaces 11+ scattered `process.env` reads
2. **Populated at startup** from env vars + explicit overrides (CLI flags, plugin config) -- NOT lazily on each access
3. **Frozen after init** -- `Object.freeze()` prevents runtime mutation
4. **Testable** -- `createConfig(overrides)` factory for tests, no global singleton in test code
5. **Env var mapping** is explicit: `AOF_DATA_DIR -> dataDir`, `AOF_ROOT -> aofRoot`, etc. -- a simple mapping object, not convention-based

**Why NOT external config libraries:**

| Library | Why Not |
|---------|---------|
| `node-config` | YAML/JSON file-based config meant for multi-environment deployments. AOF config comes from env vars + plugin config object, not config files. |
| `convict` | Schema+validation+coercion -- but Zod already does all three. Adds 5+ deps for no new capability. |
| `@fastify/env-schema` | Fastify ecosystem dependency. Thin wrapper around ajv. Zod is already AOF's validator. |
| `dotenv` | AOF runs as an OpenClaw plugin or daemon -- env vars are set by the runtime, not a `.env` file. |
| `typed-config` | Wraps node-config with TypeScript decorators. Unnecessary indirection over Zod. |

### Structured Logging

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Custom `Logger` class | N/A (internal) | Leveled JSON logger for operational logs | ~100-150 lines. Replaces `console.*` in core modules. Zero deps. |
| `process.stderr` | Node.js built-in | Output stream | Operational logs to stderr (not stdout). Stdout reserved for CLI output. |

**Architecture:**

```typescript
// src/logging/logger.ts — structured operational logger

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  level: LogLevel;
  time: number;        // epoch ms
  msg: string;
  module?: string;     // e.g., "scheduler", "dispatch", "daemon"
  taskId?: string;     // correlation
  [key: string]: unknown;
}

export class Logger {
  private readonly module: string;
  private readonly minLevel: number;
  private readonly fields: Record<string, unknown>;

  constructor(module: string, level?: LogLevel, fields?: Record<string, unknown>);

  // Core methods
  trace(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  fatal(msg: string, data?: Record<string, unknown>): void;

  // Child logger (inherits module + fields, adds new fields)
  child(fields: Record<string, unknown>): Logger;
}
```

**Key design decisions:**

1. **JSON to stderr** -- operational logs are structured JSON, one object per line, written to stderr. This is the same format pino/bunyan use, compatible with any log aggregator. Stdout remains clean for CLI output.
2. **Module-scoped loggers** -- each module creates `new Logger("scheduler")`, `new Logger("dispatch")`. No global logger instance (except a default for convenience).
3. **Child loggers** for request context -- `logger.child({ taskId, correlationId })` carries correlation through a dispatch cycle.
4. **Level filtering at creation** -- level comes from config registry. Below-level calls are no-ops (no string formatting, no object allocation).
5. **NOT replacing EventLogger** -- `EventLogger` writes structured audit events to JSONL files for the event pipeline. The new `Logger` writes operational logs to stderr. Different purpose, different output, different consumers.
6. **NOT replacing CLI `console.*`** -- CLI commands (`src/cli/`) use `console.log` for user-facing output (tables, progress, results). This is correct and should not change. Only core modules (`dispatch/`, `service/`, `protocol/`, `daemon/`, `store/`) get the structured logger.

**Why NOT external logging libraries:**

| Library | Why Not |
|---------|---------|
| `pino` v10 | 11 transitive dependencies, 664kB. High quality but disproportionate for AOF's needs. AOF doesn't need pino's worker-thread async transport, HTTP serializers, or redaction. The actual need is "JSON to stderr with levels." |
| `winston` | 9 dependencies, even heavier. Transport architecture is overkill -- AOF writes to stderr and optionally a file. |
| `bunyan` | Unmaintained since 2019. |
| `log4js` | Complex appender/category system. Java-style API. |
| `roarr` | Clever but unconventional. Small community. |
| `logtape` | Zero-dep and library-first (good properties), but still an external dependency for ~100 lines of functionality. Would consider if AOF were a library consumed by others. |
| `console.*` with `util.formatWithOptions` | Not structured. The whole point is moving from unstructured to structured. |

**Migration scope (where structured logger replaces console.*):**

| Module | Current `console.*` calls | Action |
|--------|--------------------------|--------|
| `src/dispatch/action-executor.ts` | 15 | Replace with `Logger("dispatch")` |
| `src/dispatch/assign-executor.ts` | ~10 | Replace with `Logger("dispatch")` |
| `src/dispatch/scheduler.ts` | ~8 | Replace with `Logger("scheduler")` |
| `src/service/aof-service.ts` | 15 | Replace with `Logger("service")` |
| `src/daemon/daemon.ts` | ~10 | Replace with `Logger("daemon")` |
| `src/daemon/index.ts` | ~5 | Replace with `Logger("daemon")` |
| `src/protocol/router.ts` | ~8 | Replace with `Logger("protocol")` |
| `src/store/task-store.ts` | ~5 | Replace with `Logger("store")` |
| `src/mcp/server.ts` | ~5 | Replace with `Logger("mcp")` |
| `src/openclaw/adapter.ts` | ~8 | Replace with `Logger("openclaw")` |
| `src/cli/commands/*.ts` | 200+ | **Keep as console.\*** -- CLI output is for humans |

## What NOT to Add

| Library | Why Not |
|---------|---------|
| `pino` | 11 deps, 664kB. AOF needs ~100 lines of logging, not a logging framework. |
| `winston` | Even heavier than pino. Transport system unnecessary. |
| `dotenv` | AOF is a plugin/daemon, not a standalone app with `.env` files. |
| `node-config` | File-based config for multi-environment. AOF uses env vars + plugin config. |
| `convict` | Zod already does schema + validation + coercion. |
| `@opentelemetry/*` | Explicitly deferred to v2 in PROJECT.md. |
| `debug` | The `DEBUG=*` pattern is for development tracing. AOF needs production structured logging. |
| `cls-hooked` / `AsyncLocalStorage` | Tempting for automatic context propagation, but AOF's dispatch loop is explicit -- `taskId` and `correlationId` are passed through function args, not ambient context. Adding ALS would be over-engineering for the current single-process architecture. |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Config schema | Zod (existing) | JSON Schema + ajv | Already have Zod everywhere. Two validators is worse than one. |
| Config source | Env vars + explicit overrides | YAML config file | AOF config comes from OpenClaw plugin config (JSON) or env vars. Adding a config file format creates a third source. |
| Config access | Typed singleton with `.get()` | Global `process.env` reads (status quo) | No validation, no defaults, no typing. Current state causes bugs. |
| Config access | Typed singleton with `.get()` | Dependency-injected config object | DI is cleaner but requires threading config through 20+ call sites. Singleton is pragmatic for a single-process app. |
| Log output | JSON to stderr | JSON to file | stderr is captured by launchd/systemd. File rotation adds complexity. Can pipe stderr to file if needed. |
| Log output | JSON to stderr | Human-readable to stderr | Structured is greppable and parseable. Use `pino-pretty` or `jq` for human reading. |
| Logger scope | Module-scoped (`new Logger("dispatch")`) | Single global logger | Module scope enables per-module log levels and clear origin tagging. |
| Logger scope | Module-scoped | Per-function logger | Too granular. Module is the right boundary. |

## Integration Points with Existing AOF

### Config Registry Integration

**Replace `process.env` in 11 files:**

| File | Current | After |
|------|---------|-------|
| `src/config/paths.ts` | `process.env["AOF_DATA_DIR"]` | `config.dataDir` (or keep env fallback in `resolveDataDir` for backward compat) |
| `src/projects/resolver.ts` | `process.env["AOF_ROOT"]` | `config.aofRoot` |
| `src/mcp/server.ts` | `process.env["AOF_ROOT"]` | `config.aofRoot` |
| `src/daemon/index.ts` | `process.env["AOF_ROOT"]`, `process.env["AOF_DAEMON_SOCKET"]` | `config.aofRoot`, `config.daemonSocketPath` |
| `src/cli/program.ts` | `process.env["AOF_ROOT"]` | `config.aofRoot` |
| `src/mcp/shared.ts` | `process.env.AOF_CALLBACK_DEPTH` | `config.callbackDepth` |
| `src/memory/index.ts` | `process.env.OPENAI_API_KEY` | `config.openaiApiKey` |
| `src/openclaw/openclaw-executor.ts` | `process.env.OPENCLAW_STATE_DIR` etc. | Keep as-is (OpenClaw env vars, not AOF config) |
| `src/daemon/standalone-adapter.ts` | `process.env.OPENCLAW_GATEWAY_URL` etc. | Keep as-is (OpenClaw env vars) |
| `src/dispatch/callback-delivery.ts` | Sets `process.env.AOF_CALLBACK_DEPTH` | Sets on config or uses a different mechanism |
| `src/cli/commands/memory.ts` | `process.env["AOF_VAULT_ROOT"]` etc. | `config.vaultRoot` or keep (OpenClaw env var) |

**Note:** OpenClaw-specific env vars (`OPENCLAW_STATE_DIR`, `OPENCLAW_GATEWAY_URL`, etc.) should NOT be in AOF's config registry. They belong to the OpenClaw runtime. Only AOF-owned env vars (`AOF_*`) go in the registry.

**Bootstrap order:**

1. Parse CLI args (if CLI entry) or receive plugin config (if OpenClaw entry)
2. Read env vars
3. Merge: CLI args > env vars > defaults
4. Validate with Zod schema
5. Freeze config object
6. Export for module consumption

### Structured Logger Integration

**Relationship to EventLogger:**

| Concern | EventLogger | New Logger |
|---------|-------------|------------|
| Purpose | Audit trail (task lifecycle events) | Operational logs (debug, errors, progress) |
| Output | `events/YYYY-MM-DD.jsonl` files | stderr (JSON) |
| Consumer | Event pipeline, notification rules, `aof trace` | Operators, log aggregation, debugging |
| Format | `BaseEvent` schema (eventId, type, actor, taskId, payload) | `LogEntry` (level, time, msg, module, fields) |
| Lifecycle | Per-project, lives in data directory | Process-wide, lives in process stderr |

These are complementary, not competing. A dispatch cycle produces both:
- EventLogger: `dispatch.assigned`, `dispatch.completed` (auditable business events)
- Logger: `info("Spawning session", { taskId, agentId, correlationId })` (operational detail)

**Injection pattern:**

Core modules that currently accept `logger: EventLogger` will gain a second logger parameter or use the module-scoped singleton:

```typescript
// Before (action-executor.ts)
console.error(`[AOF] Spawn failed for ${action.taskId}`);
await logger.logDispatch("dispatch.error", "scheduler", ...);

// After
log.error("Spawn failed", { taskId: action.taskId, error: err.message });
await eventLogger.logDispatch("dispatch.error", "scheduler", ...);
```

### Silent Catch Block Fix

The 36 `catch { // Logging errors should not crash }` blocks in dispatch become:

```typescript
// Before
try { await logger.logDispatch(...); } catch { /* Logging errors should not crash */ }

// After
try { await eventLogger.logDispatch(...); } catch (err) {
  log.warn("Event logging failed", { error: String(err) });
}
```

This addresses quality issue #7a (swallowed errors) as a natural consequence of having a fallback logger.

## File Organization (Recommended)

```
src/
  config/
    paths.ts          # Existing — keep, but have it read from registry
    manager.ts        # Existing — org chart config CRUD (separate concern)
    registry.ts       # NEW — AofConfigSchema, createConfig(), getConfig()
    env-map.ts        # NEW — AOF_DATA_DIR -> dataDir mapping
    __tests__/
      registry.test.ts
      env-map.test.ts

  logging/
    logger.ts         # NEW — Logger class, LogLevel, LogEntry
    index.ts          # NEW — barrel export + default logger factory
    __tests__/
      logger.test.ts
```

## Performance Considerations

**Config registry:** Zero runtime cost after startup. Frozen object access is a property lookup -- faster than `process.env["KEY"]` (which is a libc `getenv()` call on each access).

**Structured logger:** `process.stderr.write()` with `JSON.stringify()` is comparable to pino's synchronous mode. For AOF's volume (hundreds of log lines per poll cycle, not thousands per second), the performance difference between a custom logger and pino is unmeasurable. If AOF ever needs pino-level throughput (async worker thread logging), the `Logger` interface is compatible -- swap the implementation without changing call sites.

## Sources

- Pino v10 npm page: https://www.npmjs.com/package/pino -- 11 deps, 664kB, 21M weekly downloads
- AOF package.json: verified existing dependencies (zod 3.24.x, no logging deps)
- AOF `src/config/paths.ts`: current `process.env` access pattern
- AOF `src/events/logger.ts`: existing EventLogger JSONL audit system
- AOF `.planning/codebase/QUALITY.md`: 751 `console.*` calls, 150+ silent catch blocks
- AOF `.planning/codebase/ARCHITECTURE.md`: 11 files with scattered `process.env` access
- Node.js 22 docs: `process.stderr.write()`, `process.env` semantics
