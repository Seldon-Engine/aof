# Architecture Patterns

**Domain:** Centralized config registry + structured logging integration into existing agent orchestration platform
**Researched:** 2026-03-12

## Recommended Architecture

### High-Level Integration Map

```
                        EXISTING                              NEW
                        -------                              ---
  src/schemas/          (leaf -- no deps)
       |
  src/config/paths.ts   (pure path functions)
       |
  src/config/registry.ts --------------------------------> NEW: Config Registry
       |                                                   (typed, cached, validated)
  src/logging/          ---------------------------------> NEW: Structured Logger
       |                                                   (leveled, contextual)
  src/events/logger.ts  (audit JSONL -- unchanged)
       |
  src/store/            (persistence)
       |
  src/dispatch/         (orchestration core)
  src/protocol/         (agent comms)
  src/service/          (lifecycle)
       |
  src/daemon/           (entry point)
  src/cli/              (entry point)
  src/mcp/              (entry point)
```

### Design Principle: Two Logging Systems, Not One

The structured logger and EventLogger serve fundamentally different purposes and must remain separate:

| Concern | EventLogger (existing) | Structured Logger (new) |
|---------|----------------------|------------------------|
| **Purpose** | Audit trail + notification trigger | Operational observability |
| **Audience** | Post-hoc analysis, notification engine, future UI | Operators watching daemon logs, debugging |
| **Format** | Append-only JSONL files (daily rotation) | Leveled text/JSON to stderr |
| **Persistence** | Always written to disk | Ephemeral (stderr/stdout) |
| **Schema** | Typed `BaseEvent` with `EventType` enum (60+ event types) | Freeform structured fields |
| **Replaces** | Nothing (stays as-is) | ~120 `console.*` calls in core modules |

Do NOT merge these. EventLogger is a domain audit log (task.transitioned, dispatch.matched). The structured logger is operational logging (debug, info, warn, error for operators).

### Component Boundaries

| Component | Location | Responsibility | Communicates With |
|-----------|----------|---------------|-------------------|
| **Config Schema** | `src/config/config-schema.ts` | Zod schemas for all config keys | Config Registry |
| **Config Registry** | `src/config/registry.ts` | Typed env var access, defaults, validation, caching | Every module that reads process.env |
| **Structured Logger** | `src/logging/logger.ts` | Leveled logging with structured context | Every module that calls console.* |
| **Log Formatters** | `src/logging/formatters.ts` | Human-readable + JSON output | Logger |
| **EventLogger** | `src/events/logger.ts` (existing) | Audit JSONL -- NO CHANGES | Notification engine, metrics |

## New Module: Config Registry (`src/config/`)

### Why a Registry, Not Just Consolidating process.env

The 11 files with `process.env` access have different patterns:
- `paths.ts`: fallback chain (explicit arg > env > default)
- `resolver.ts`: env with computed default
- `standalone-adapter.ts`: env with hardcoded default
- `mcp/shared.ts`: env with parseInt and fallback
- `memory/index.ts`: pass-through to library
- `callback-delivery.ts`: env MUTATION (sets/deletes process.env)
- `cli/memory.ts`: multiple env vars with different fallback chains

A registry provides: one place for defaults, one place for validation, one place for typing, zero process.env reads at call sites.

### Placement in Module Hierarchy

```
src/config/
  paths.ts             <-- exists, no change (pure path functions)
  manager.ts           <-- exists, no change (org chart CRUD)
  config-schema.ts     <-- NEW: Zod schemas for all config keys
  registry.ts          <-- NEW: ConfigRegistry class
  index.ts             <-- NEW or updated: barrel export
```

The config registry sits at the same layer as `paths.ts` -- below store, events, dispatch. It depends only on Zod (already a dependency) and Node.js builtins. Everything above can import it.

### Config Registry Design

```typescript
// src/config/config-schema.ts
import { z } from "zod";

export const AofConfigSchema = z.object({
  // Data directories
  dataDir: z.string().default("~/.openclaw/aof"),
  aofRoot: z.string().optional(),
  vaultRoot: z.string().optional(),

  // Daemon
  daemonSocket: z.string().optional(),
  pollIntervalMs: z.number().int().positive().default(30_000),
  pollTimeoutMs: z.number().int().positive().default(30_000),
  maxConcurrentDispatches: z.number().int().positive().default(3),

  // Gateway (standalone mode)
  gatewayUrl: z.string().url().default("http://localhost:3000"),
  gatewayToken: z.string().optional(),

  // External services
  openaiApiKey: z.string().optional(),

  // Callback safety
  callbackDepth: z.number().int().min(0).default(0),

  // Logging
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // OpenClaw integration
  openclawStateDir: z.string().optional(),
});

export type AofConfig = z.infer<typeof AofConfigSchema>;
```

```typescript
// src/config/registry.ts
import { AofConfigSchema, type AofConfig } from "./config-schema.js";

// ENV_MAP: config key -> env var name(s), tried in order
const ENV_MAP: Record<string, string[]> = {
  dataDir: ["AOF_DATA_DIR"],
  aofRoot: ["AOF_ROOT"],
  vaultRoot: ["AOF_VAULT_ROOT", "OPENCLAW_VAULT_ROOT"],
  daemonSocket: ["AOF_DAEMON_SOCKET"],
  gatewayUrl: ["OPENCLAW_GATEWAY_URL"],
  gatewayToken: ["OPENCLAW_GATEWAY_TOKEN"],
  openaiApiKey: ["OPENAI_API_KEY"],
  callbackDepth: ["AOF_CALLBACK_DEPTH"],
  openclawStateDir: ["OPENCLAW_STATE_DIR", "CLAWDBOT_STATE_DIR"],
  logLevel: ["AOF_LOG_LEVEL"],
};

export class ConfigRegistry {
  private readonly config: AofConfig;

  constructor(overrides?: Partial<AofConfig>) {
    const fromEnv = this.readEnvVars();
    const merged = { ...fromEnv, ...overrides };
    this.config = AofConfigSchema.parse(merged);
  }

  get<K extends keyof AofConfig>(key: K): AofConfig[K] {
    return this.config[key];
  }

  private readEnvVars(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, envNames] of Object.entries(ENV_MAP)) {
      for (const envName of envNames) {
        const val = process.env[envName];
        if (val !== undefined) {
          result[key] = this.coerce(key, val);
          break;
        }
      }
    }
    return result;
  }

  private coerce(key: string, value: string): unknown {
    // Numeric fields
    if (["pollIntervalMs", "pollTimeoutMs", "maxConcurrentDispatches",
         "callbackDepth"].includes(key)) {
      const n = parseInt(value, 10);
      return isNaN(n) ? undefined : n;
    }
    return value;
  }
}

// Singleton
let _instance: ConfigRegistry | undefined;

export function initConfig(overrides?: Partial<AofConfig>): ConfigRegistry {
  _instance = new ConfigRegistry(overrides);
  return _instance;
}

export function getConfig(): ConfigRegistry {
  if (!_instance) {
    _instance = new ConfigRegistry();
  }
  return _instance;
}

/** Reset for testing */
export function resetConfig(): void {
  _instance = undefined;
}
```

### Key Design Decisions

**Singleton with explicit init.** Entry points (daemon, CLI, MCP) call `initConfig()` with their CLI flag overrides. Everything else calls `getConfig()`. This matches the existing pattern where `resolveDataDir()` in paths.ts already centralizes one env var.

**Lazy initialization.** `getConfig()` creates a default instance if `initConfig()` was never called. This means existing code that imports config functions continues to work even if an entry point forgets to call `initConfig()`.

**Env var mutation for AOF_CALLBACK_DEPTH.** `callback-delivery.ts` currently SETS `process.env.AOF_CALLBACK_DEPTH` to propagate depth across the MCP boundary (inter-process communication). The registry does NOT replace this -- it is a cross-process mechanism, not config. Document this as a known exception.

**Fallback chains preserved.** `cli/memory.ts` reads `AOF_VAULT_ROOT` then `OPENCLAW_VAULT_ROOT`. The ENV_MAP supports multiple env var names per key, tried in order.

**No runtime config reloading.** AOF is a daemon with clean restart. Config changes require restart. This is the existing behavior and matches the deterministic control plane philosophy.

### Integration with Existing paths.ts

`paths.ts` stays as pure path functions. `resolveDataDir()` evolves to use the registry:

```typescript
// Updated paths.ts -- resolveDataDir becomes thinner
export function resolveDataDir(explicit?: string): string {
  const raw = explicit ?? getConfig().get("dataDir");
  return normalizePath(raw);
}
```

All other functions in paths.ts (orgChartPath, eventsDir, etc.) remain pure functions taking a base directory -- no changes needed.

### Migration Strategy for process.env Access

| File | Current | After | Notes |
|------|---------|-------|-------|
| `src/config/paths.ts` | `process.env["AOF_DATA_DIR"]` | `getConfig().get("dataDir")` | |
| `src/projects/resolver.ts` | `process.env["AOF_ROOT"]` | `getConfig().get("aofRoot")` | |
| `src/daemon/index.ts` | `process.env["AOF_ROOT"]`, `process.env["AOF_DAEMON_SOCKET"]` | `getConfig().get(...)` | Entry point calls `initConfig()` |
| `src/daemon/standalone-adapter.ts` | `process.env.OPENCLAW_GATEWAY_URL` | Constructor reads from `getConfig()` | |
| `src/mcp/server.ts` | `process.env["AOF_ROOT"]` | `getConfig().get("aofRoot")` | Entry point calls `initConfig()` |
| `src/mcp/shared.ts` | `process.env.AOF_CALLBACK_DEPTH` | `getConfig().get("callbackDepth")` | |
| `src/memory/index.ts` | `process.env.OPENAI_API_KEY` | `getConfig().get("openaiApiKey")` | |
| `src/openclaw/openclaw-executor.ts` | `process.env.OPENCLAW_STATE_DIR` | `getConfig().get("openclawStateDir")` | |
| `src/cli/program.ts` | `process.env["AOF_ROOT"]` | `getConfig().get("aofRoot")` | Entry point calls `initConfig()` |
| `src/cli/commands/memory.ts` | Multiple env vars | `getConfig().get("vaultRoot")` | Collapse 3 env reads into 1 |
| `src/dispatch/callback-delivery.ts` | Sets/deletes `process.env` | **EXCEPTION -- keeps direct env mutation** | Cross-process IPC, not config |

Each migration is independent and can be done one file at a time with its own test run.

## New Module: Structured Logger (`src/logging/`)

### Why a New Module, Not Extending EventLogger

EventLogger is a domain audit log with:
- Typed `EventType` enum (60+ event types like task.transitioned, dispatch.matched)
- Append-only JSONL to disk with daily rotation and symlink management
- Event callbacks wired to notification policy engine
- Query interface for event replay

Operational logging needs:
- Log levels (debug/info/warn/error)
- Contextual fields (component, taskId, correlationId)
- Output to stderr (not files)
- Cheap to call (synchronous, no I/O on filtered-out levels)
- Different output format for daemon (JSON) vs CLI (human-readable)

These are orthogonal concerns. Merging them would bloat EventLogger and conflate audit events with debug output.

### Placement in Module Hierarchy

```
src/logging/
  logger.ts           <-- Logger interface + createLogger factory
  formatters.ts       <-- Human-readable + JSON formatters
  index.ts            <-- barrel
```

`src/logging/` sits at the same layer as `src/events/` -- above schemas and config, below store and dispatch. It depends on `src/config/registry.ts` for log level only.

### Logger Design

```typescript
// src/logging/logger.ts
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  component?: string;    // "scheduler", "protocol-router", "assign-executor"
  taskId?: string;
  projectId?: string;
  correlationId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  child(defaultCtx: LogContext): Logger;
}

export type LogFormat = "json" | "human";

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  output?: (line: string) => void;  // Default: process.stderr.write
}

export function createLogger(opts?: LoggerOptions): Logger {
  // Implementation: level filtering, format selection, child() merging
}
```

**Synchronous API.** `console.*` calls are synchronous. The replacement must be too -- no async overhead for debug-level logging that gets filtered out. Write to stderr via `process.stderr.write()`.

**`child()` for component scoping.** Each module creates a child logger with its component name baked in:

```typescript
// In src/dispatch/scheduler.ts
const log = logger.child({ component: "scheduler" });
// ...
log.info("Poll complete", { taskCount: 5, durationMs: 120 });
```

**Formatter output examples:**

JSON format (daemon/MCP mode):
```json
{"ts":"2026-03-12T10:00:00.123Z","level":"info","component":"scheduler","msg":"Poll complete","taskCount":5,"durationMs":120}
```

Human format (CLI mode):
```
2026-03-12 10:00:00 INFO  [scheduler] Poll complete taskCount=5 durationMs=120
```

### How Logger Flows Through the System

The logger is NOT a global singleton. It flows through dependency injection, matching the existing pattern where `EventLogger` is passed through constructors:

1. **Entry points create the root logger:**
   - `src/daemon/daemon.ts`: `createLogger({ format: "json", level: getConfig().get("logLevel") })`
   - `src/cli/program.ts`: `createLogger({ format: "human", level: "info" })`
   - `src/mcp/server.ts`: `createLogger({ format: "json", level: getConfig().get("logLevel") })`

2. **AOFService accepts logger in dependencies:**
   ```typescript
   export interface AOFServiceDependencies {
     logger?: EventLogger;           // audit (existing)
     operationalLogger?: Logger;     // structured (new)
     // ... other existing deps
   }
   ```

3. **Scheduler, ProtocolRouter, etc. receive child loggers:**
   Already dependency-injected -- `SchedulerConfig` and `ProtocolRouterDependencies` accept deps. Add `Logger` to these interfaces.

4. **CLI commands keep console.log for user output:**
   CLI output (console.log for user-facing messages) stays as console.log. Only diagnostic/error output in CLI internals migrates to logger.

### Interaction with EventLogger

They coexist, not compete:

```typescript
// BEFORE (in action-executor.ts):
console.error(`[AOF] Spawn failed for ${action.taskId}: ${error}`);
await logger.logDispatch("dispatch.error", "scheduler", action.taskId, { error });

// AFTER:
log.error("Spawn failed", { taskId: action.taskId, error });
await eventLogger.logDispatch("dispatch.error", "scheduler", action.taskId, { error });
```

Both fire. The structured logger goes to stderr for operators. The EventLogger goes to JSONL for audit/notifications. The `[AOF]` prefix in console calls becomes the `component` field in structured output.

### Migration Path for 751 console.* Calls

**Triage by module type:**

| Module Type | console.* Count | Migration Strategy |
|-------------|----------------|--------------------|
| CLI commands | ~540 | **Keep most as console.log** -- user-facing output. Only migrate error/diagnostic calls. |
| dispatch/ | ~76 (non-test) | **Full migration** to structured logger |
| service/ | ~15 | **Full migration** to structured logger |
| daemon/ | ~8 | **Full migration** to structured logger |
| protocol/ | ~4 | **Full migration** to structured logger |
| memory/ | varies | **Partial** -- user-facing stays, internal migrates |
| packaging/ | varies | **Keep** -- installer output is user-facing |

**Realistic scope: ~120 console.* calls in core modules need migration.** The remaining ~630 in CLI are intentional user output and stay as-is. Do not boil the ocean.

**Migration is mechanical:**
```
console.info(`[AOF] ${message}`)  -->  log.info(message, { component: "aof" })
console.warn(`[AOF] ${message}`)  -->  log.warn(message)
console.error(`[AOF] ${message}`) -->  log.error(message)
```

### Handling the 36 Silent Catch Blocks

The silent catches in dispatch/ (`catch { // Logging errors should not crash the scheduler }`) are specifically about EventLogger failures. With a structured logger, these become visible:

```typescript
try {
  await eventLogger.logDispatch("dispatch.error", ...);
} catch (logErr) {
  log.warn("EventLogger write failed", { error: String(logErr), taskId });
}
```

The structured logger write to stderr is synchronous and will not fail in normal operation (stderr is always available). This makes previously invisible failures visible without changing error handling semantics.

## Data Flow

### Config Registry Data Flow

```
Process start
  |
  v
Entry point (daemon/CLI/MCP) calls initConfig({ overrides from CLI flags })
  |
  v
ConfigRegistry reads process.env for all mapped keys via ENV_MAP
  |
  v
Zod schema validates + applies defaults
  |
  v
Cached AofConfig object stored in singleton
  |
  v
All modules call getConfig().get("key") instead of process.env
```

### Logger Data Flow

```
Entry point creates root Logger (format + level from config)
  |
  +-- AOFService receives Logger in deps
  |     |
  |     +-- Scheduler gets child({ component: "scheduler" })
  |     +-- ProtocolRouter gets child({ component: "protocol" })
  |     +-- ActionExecutor gets child({ component: "action-executor" })
  |     +-- AssignExecutor gets child({ component: "assign-executor" })
  |
  +-- Per-call context enrichment: log.info("msg", { taskId, correlationId })
  |
  v
Formatter serializes to stderr
  - daemon: JSON line per message
  - CLI: human-readable with timestamp + level + component
```

## Patterns to Follow

### Pattern 1: Config Access via Registry

**What:** All environment variable reads go through `getConfig().get(key)`.
**When:** Any module needs runtime configuration from environment.
**Example:**
```typescript
import { getConfig } from "../config/registry.js";

// Instead of: const root = process.env["AOF_ROOT"] ?? DEFAULT_AOF_ROOT;
const root = getConfig().get("aofRoot") ?? DEFAULT_AOF_ROOT;
```

### Pattern 2: Child Logger per Component

**What:** Each module/class creates a child logger with baked-in component name.
**When:** Any class or module that logs operationally.
**Example:**
```typescript
import type { Logger } from "../logging/logger.js";

export class ProtocolRouter {
  private readonly log: Logger;

  constructor(deps: ProtocolRouterDependencies) {
    this.log = deps.operationalLogger?.child({ component: "protocol-router" })
      ?? createNullLogger();
  }

  async route(envelope: ProtocolEnvelope): Promise<void> {
    this.log.debug("Routing message", { type: envelope.type, taskId: envelope.taskId });
  }
}
```

### Pattern 3: Dual Logging (Audit + Operational)

**What:** Important events are logged to BOTH EventLogger (audit) and structured logger (operational).
**When:** Dispatch errors, state transitions, system events.
**Example:**
```typescript
// Audit log (persisted JSONL, triggers notifications)
await eventLogger.logDispatch("dispatch.error", "scheduler", taskId, { error: msg });

// Operational log (stderr for operators)
log.error("Dispatch failed", { taskId, error: msg, agent });
```

### Pattern 4: CLI Output vs Logger Output

**What:** User-facing CLI output stays as `console.log()`. Diagnostic output uses logger.
**When:** CLI commands producing user-visible output.
**Example:**
```typescript
// User-facing output -- stays as console.log
console.log(`Task ${taskId} created successfully`);

// Diagnostic -- uses logger
log.debug("Store initialized", { projectRoot, taskCount: 42 });
```

### Pattern 5: Graceful Logger Fallback

**What:** Components that receive an optional logger fall back to a null/no-op logger.
**When:** Any component that may be used without a logger (tests, standalone usage).
**Example:**
```typescript
this.log = deps.operationalLogger?.child({ component: "scheduler" })
  ?? createNullLogger();
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: Global Logger Singleton

**What:** Making the logger a global singleton like `getLogger()`.
**Why bad:** Breaks testability, hides dependencies, makes it impossible to set different log levels per test. The existing codebase correctly uses dependency injection for EventLogger -- follow the same pattern.
**Instead:** Pass logger through constructors/config objects. Entry points create it, pass it down.

### Anti-Pattern 2: Merging Structured Logger into EventLogger

**What:** Adding log levels to EventLogger or making it handle operational logging.
**Why bad:** EventLogger has specific semantics: typed event schema, JSONL persistence, notification callbacks, query interface. Operational logging has none of these. Merging conflates audit with debug output, bloats the event log with noise, and couples notification triggering to log level.
**Instead:** Keep them separate. They serve different audiences and have different lifecycles.

### Anti-Pattern 3: Async Logger API

**What:** Making `log.info()` return a Promise.
**Why bad:** console.* is synchronous. Replacing it with async calls changes control flow, risks unhandled rejections, and adds overhead for filtered-out log levels. The primary output target (stderr) is synchronous.
**Instead:** Synchronous API. Write to stderr with `process.stderr.write()`.

### Anti-Pattern 4: Replacing CLI console.log with Logger

**What:** Migrating all 540 CLI console.* calls to the structured logger.
**Why bad:** CLI commands intentionally write user-facing output to stdout. `console.log("Task created")` IS the user interface. Routing it through a leveled logger adds complexity for zero benefit.
**Instead:** Only migrate diagnostic/error output in CLI internals. Leave user-facing output as console.log.

### Anti-Pattern 5: Config Registry Watching for Changes

**What:** Adding file watchers or env polling to detect config changes at runtime.
**Why bad:** AOF is a daemon that restarts cleanly. Config changes should require restart (current behavior). Runtime config watching adds complexity, race conditions, and is unnecessary for a single-machine system supervised by launchd/systemd.
**Instead:** Read-once at startup, cache forever. Restart to pick up changes.

### Anti-Pattern 6: Using Third-Party Logging Libraries

**What:** Pulling in pino, winston, bunyan, or similar.
**Why bad:** AOF has zero external dependencies for core infrastructure (filesystem store, EventLogger, etc.). The logging needs are simple: level filter, format, write to stderr. This is ~100 lines of code. A third-party library adds dependency weight, API surface, and configuration complexity for no benefit.
**Instead:** Build a minimal Logger in-house. The interface is 6 methods (debug/info/warn/error/child + createLogger factory).

## Integration Points with Existing Architecture

### AOFService (composition root)

AOFService is the natural wiring point. It already creates EventLogger, store, scheduler config, and protocol router. Extension is additive:

```typescript
export interface AOFServiceDependencies {
  // ... existing fields unchanged
  operationalLogger?: Logger;  // NEW -- optional for backward compat
}
```

AOFService creates child loggers for each subsystem it wires:

```typescript
constructor(deps: AOFServiceDependencies, config: AOFServiceConfig) {
  // Existing
  this.logger = deps.logger ?? new EventLogger(...);

  // New: operational logger (no-op if not provided)
  this.log = deps.operationalLogger?.child({ component: "aof-service" })
    ?? createNullLogger();

  // Pass to scheduler config
  this.schedulerConfig = {
    ...existingConfig,
    operationalLogger: this.log,
  };

  // Pass to protocol router
  this.protocolRouter = new ProtocolRouter({
    ...existingDeps,
    operationalLogger: this.log,
  });
}
```

### SchedulerConfig Extension

```typescript
export interface SchedulerConfig {
  // ... existing fields unchanged
  operationalLogger?: Logger;  // NEW
}
```

### ProtocolRouterDependencies Extension

```typescript
export interface ProtocolRouterDependencies {
  // ... existing fields unchanged
  operationalLogger?: Logger;  // NEW
}
```

### Daemon Entry Point (`src/daemon/daemon.ts`)

```typescript
import { initConfig } from "../config/registry.js";
import { createLogger } from "../logging/logger.js";

// Init config from CLI flags + env
const config = initConfig({ aofRoot: opts.root });

// Create daemon logger (JSON to stderr)
const log = createLogger({
  format: "json",
  level: config.get("logLevel"),
});

const { service } = await startAofDaemon({
  ...opts,
  operationalLogger: log,
});
```

### MCP Entry Point (`src/mcp/server.ts`)

```typescript
import { initConfig } from "../config/registry.js";

const config = initConfig();
const dataDir = config.get("aofRoot") ?? config.get("dataDir");
```

### CLI Entry Point (`src/cli/program.ts`)

```typescript
import { initConfig } from "../config/registry.js";
import { createLogger } from "../logging/logger.js";

const config = initConfig({ aofRoot: opts.root });

// CLI logger: human-readable, only for internal diagnostics
const log = createLogger({ format: "human", level: "warn" });
```

## Suggested Build Order

Based on the dependency graph, build bottom-up. Each phase is independently testable.

### Phase 1: Config Registry (no dependencies on logger)

1. `src/config/config-schema.ts` -- Zod schema for all config keys
2. `src/config/registry.ts` -- ConfigRegistry class with env reading, validation, caching
3. Update `src/config/index.ts` barrel
4. Tests for registry (env reading, defaults, overrides, coercion, reset)
5. Wire into entry points (daemon/index.ts, cli/program.ts, mcp/server.ts call `initConfig()`)
6. Migrate 11 process.env files one at a time (each is independent, each gets its own test run)

**Why first:** Zero risk. Registry is additive -- existing code keeps working until call sites are migrated. Each migration is a single-file change.

### Phase 2: Structured Logger (depends on config for log level)

1. `src/logging/formatters.ts` -- human and JSON formatters
2. `src/logging/logger.ts` -- Logger implementation with child(), level filtering, null logger
3. `src/logging/index.ts` -- barrel
4. Tests for logger (level filtering, child context merging, both formatters, null logger)
5. Wire into AOFServiceDependencies, SchedulerConfig, ProtocolRouterDependencies (all optional fields)
6. Wire into daemon entry point (creates root logger, passes to AOFService)

**Why second:** Depends on config registry for log level. Infrastructure first, then consumers.

### Phase 3: Core Module Migration (~120 console.* calls)

1. `src/service/aof-service.ts` (15 calls) -- highest visibility, composition root
2. `src/dispatch/action-executor.ts` (15 calls) -- core scheduler
3. `src/dispatch/scheduler.ts` (15 calls)
4. `src/dispatch/assign-executor.ts` (13 calls)
5. `src/dispatch/task-dispatcher.ts` (9 calls)
6. `src/dispatch/murmur-integration.ts` (11 calls)
7. `src/dispatch/failure-tracker.ts` (6 calls)
8. `src/protocol/router.ts` (4 calls)
9. `src/daemon/*.ts` (8 calls)
10. Remaining dispatch files (escalation, dag-transition-handler, etc.)

**Why this order:** Start with AOFService (composition root, validates wiring works), then dispatch (highest call count), then protocol/daemon.

### Phase 4: Silent Catch Remediation (depends on logger)

1. Replace 36 empty catch blocks in dispatch/ with `log.warn("EventLogger write failed", ...)`
2. Add catch-and-log to other bare catches where failure indicates real problems
3. Leave intentional suppression (e.g., symlink doesn't exist, file not found) with explicit comments

**Why last:** This is the highest-value application of the structured logger -- making invisible failures visible. But it depends on logger being wired through all dispatch modules first.

### Build Dependency Graph

```
Phase 1 (config registry) -- no deps, safe to start
  |
  v
Phase 2 (logger implementation) -- depends on config for level
  |
  v
Phase 3 (console.* migration) -- depends on logger wired into modules
  |
  v
Phase 4 (silent catch remediation) -- depends on logger in dispatch
```

All phases are strictly sequential. Within each phase, individual file migrations are independent.

## Scalability Considerations

| Concern | Current (v1.x) | Future (v2) |
|---------|----------------|-------------|
| Config source | process.env only | Could add config file, registry abstracts the source |
| Log output | stderr only | Could add file rotation, remote shipping via custom output fn |
| Log volume | ~120 calls in core | Stable -- not expected to grow significantly |
| Config key count | ~15 keys | May grow with new features, Zod schema scales fine |
| Performance | Cached config, sync logging | No bottlenecks at single-machine scale |
| Testing | `resetConfig()` + constructor injection | Full isolation in parallel tests |

## Sources

- Direct codebase analysis of AOF `src/` directory (HIGH confidence -- primary source)
- `.planning/codebase/ARCHITECTURE.md` -- existing module hierarchy and dependency analysis
- `.planning/codebase/QUALITY.md` -- identified console.* distribution and silent catch patterns
- `process.env` grep across 11 source files (verified all env var names and fallback patterns)
- `console.*` grep counts: dispatch/ 76 non-test, service/ 15, protocol/ 4, daemon/ 8, CLI/ 540
- EventLogger implementation review (`src/events/logger.ts`) -- confirmed audit-only semantics
- AOFService constructor review -- confirmed dependency injection pattern for all subsystems

---

*Architecture analysis: 2026-03-12*
