# Phase 37: Structured Logging - Research

**Researched:** 2026-03-12
**Domain:** Structured logging with Pino for Node.js/TypeScript
**Confidence:** HIGH

## Summary

Phase 37 replaces ~160 `console.*` calls across core modules (dispatch, daemon, service, protocol, store, mcp, openclaw, murmur, plugins) with Pino-based structured JSON logging to stderr. The work also remediates ~36 silent catch blocks in dispatch/ and additional silent catches in other core modules. CLI output (`src/cli/`, `src/commands/`) and EventLogger (audit JSONL in `src/events/`) remain completely untouched.

Pino v9 is the recommended version (v10 is very recent and may have breaking changes; v9 is the current stable widely-deployed version). Pino ships with built-in TypeScript types, supports child loggers natively, has a default error serializer that captures stack traces, and writes JSON to any writable stream (stderr via `pino.destination(2)` or `process.stderr`). The project already has the config registry with `AOF_LOG_LEVEL` validated via Zod, so the logger simply reads from `getConfig().core.logLevel`.

**Primary recommendation:** Create a thin `src/logging/index.ts` module exporting `createLogger(component: string)` that wraps Pino with project-standard defaults, then systematically replace console.* calls file-by-file across core modules.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- JSON only to stderr -- no human-readable dev mode, no pino-pretty
- Rich fields per log line: level, time, component, msg, pid, hostname
- Default log level: info (when AOF_LOG_LEVEL not set)
- stderr only -- no optional file output
- All caught errors logged at warn level -- including transient/expected errors
- Each catch block log line includes: error object (with stack trace), operation name, and identifiers (taskId, correlationId) where available
- Stack traces always included via Pino's default error serializer
- Remediate silent catches in ALL core modules, not just dispatch/
- Boundary drawn by directory: src/cli/, src/commands/ keep console.*, everything else gets structured logger
- All daemon startup/shutdown messages become structured logs -- no console.error exceptions
- Test files (__tests__/) keep console.*
- MCP server is core infrastructure -- uses structured logger
- Factory function: createLogger(component) returns a child logger with component field set
- Module lives in src/logging/ -- separate from config/ and distinct from EventLogger
- Ad-hoc context passing per call site: logger.warn({ err, taskId, op: 'acquireLease' }, 'lease acquisition failed')
- No AsyncLocalStorage context propagation

### Claude's Discretion
- How modules acquire their logger (module-level const vs injected) -- pick what fits the codebase
- Exact Pino configuration options (serializers, timestamp format, redaction)
- Whether to add a resetLogger() for test isolation (similar to resetConfig())
- Granular log level choices per catch block within the warn-level guideline

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| LOG-01 | Pino integrated as structured logging library with JSON output to stderr | Standard Stack section: Pino v9, `pino.destination(2)` for stderr, JSON is default format |
| LOG-02 | Log levels configurable via AOF_LOG_LEVEL env var (read from config registry) | Architecture Patterns: logger reads `getConfig().core.logLevel`, maps to Pino levels |
| LOG-03 | Child loggers created per module for contextual logging | Architecture Patterns: `createLogger(component)` returns `pino.child({ component })` |
| LOG-04 | Core module console.* calls replaced with structured logger (~160 calls across all core modules) | Code audit: 104 dispatch, 15 service, 8 daemon, 4 protocol, 15 openclaw, 3 murmur, 5 plugins, 2 store, 1 mcp = ~157 total (excluding test files and cli/) |
| LOG-05 | Silent catch blocks remediated -- errors logged instead of swallowed | Pitfalls section: 22 catch blocks in dispatch/ plus catches in protocol/task-lock.ts, callback-delivery.ts, daemon/health.ts, lease-manager.ts |
| LOG-06 | CLI console.* output unchanged | Architecture: boundary is directory-based, cli/ and commands/ excluded from migration |
| LOG-07 | EventLogger unchanged -- operational logging and audit events remain separate | Don't Hand-Roll: EventLogger in src/events/ is a completely separate system, zero changes |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| pino | ^9.6.0 | Structured JSON logger | De facto Node.js structured logging standard, 21M+ weekly npm downloads, built-in TypeScript types, fastest JSON logger |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none) | - | - | No transports or pretty-printing needed per user decision |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| pino | winston | Winston is slower, more complex, feature-heavy -- overkill for JSON-to-stderr |
| pino | bunyan | Bunyan is unmaintained, Pino is its spiritual successor |
| pino | console + JSON.stringify | Missing: levels, child loggers, error serialization, performance |

**Installation:**
```bash
npm install pino
```

Note: `@types/pino` is NOT needed -- Pino ships built-in TypeScript types since v7.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── logging/
│   └── index.ts          # createLogger(), resetLogger(), Pino config
├── config/
│   └── registry.ts       # AOF_LOG_LEVEL already defined here
├── dispatch/             # Uses createLogger('dispatch') or per-file child
├── daemon/               # Uses createLogger('daemon')
├── service/              # Uses createLogger('service')
├── protocol/             # Uses createLogger('protocol')
├── openclaw/             # Uses createLogger('openclaw')
├── murmur/               # Uses createLogger('murmur')
├── plugins/              # Uses createLogger('watchdog')
├── store/                # Uses createLogger('store')
├── mcp/                  # Uses createLogger('mcp')
├── cli/                  # EXCLUDED -- keeps console.*
├── commands/             # EXCLUDED -- keeps console.*
└── events/               # EXCLUDED -- EventLogger is separate
```

### Pattern 1: Logger Factory (src/logging/index.ts)
**What:** Single factory function creating Pino child loggers with component field
**When to use:** Every core module that needs logging

```typescript
import pino from "pino";
import { getConfig } from "../config/registry.js";

// Map AOF log levels to Pino levels (they match except 'silent')
const AOF_TO_PINO: Record<string, string> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
  silent: "silent",
};

let rootLogger: pino.Logger | null = null;

function getRootLogger(): pino.Logger {
  if (rootLogger) return rootLogger;
  const cfg = getConfig();
  const level = AOF_TO_PINO[cfg.core.logLevel] ?? "info";
  rootLogger = pino(
    {
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination({ fd: 2, sync: false }), // stderr, async
  );
  return rootLogger;
}

export function createLogger(component: string): pino.Logger {
  return getRootLogger().child({ component });
}

export function resetLogger(): void {
  rootLogger = null;
}
```

### Pattern 2: Module-Level Logger Acquisition
**What:** Each source file creates a module-scoped logger constant
**When to use:** All core module files -- consistent with existing getConfig() pattern

```typescript
// Top of each core module file
import { createLogger } from "../logging/index.js";

const log = createLogger("scheduler");

// Usage in code
log.info({ taskId, projectId }, "scheduling task for dispatch");
log.warn({ err, taskId, op: "acquireLease" }, "lease acquisition failed");
log.error({ err, taskId }, "fatal dispatch error");
log.debug({ candidates: candidates.length }, "filtered dispatch candidates");
```

### Pattern 3: Error Logging in Catch Blocks
**What:** Replacing silent catches and console.error catches with structured warn/error logs
**When to use:** Every catch block in core modules

```typescript
// BEFORE (silent catch):
} catch (_err) {
  // Best-effort, never propagate
}

// AFTER:
} catch (err) {
  log.warn({ err, taskId, op: "deliverCallback" }, "callback delivery failed (best-effort)");
}

// BEFORE (console.error catch):
} catch (err) {
  console.error(`[AOF] cascadeOnCompletion failed for ${taskId}:`, err);
}

// AFTER:
} catch (err) {
  log.warn({ err, taskId, op: "cascadeOnCompletion" }, "cascade on completion failed");
}
```

### Pattern 4: console.log/info Replacement
**What:** Replacing informational console.* calls with structured log calls
**When to use:** All console.log, console.info in core modules

```typescript
// BEFORE:
console.log(`[AOF] Dispatching ${count} tasks for project ${projectId}`);

// AFTER:
log.info({ count, projectId }, "dispatching tasks for project");

// BEFORE:
console.error(`[AOF] Enforcement transition failed for ${action.taskId}: ${msg}`);

// AFTER:
log.warn({ err: transitionErr, taskId: action.taskId, op: "enforcement" }, "enforcement transition failed");
```

### Anti-Patterns to Avoid
- **String interpolation in log messages:** Use structured fields `{ taskId, count }` not template literals in the message string -- Pino serializes objects efficiently, string concat defeats the purpose
- **Logging the error message separately:** Pass `err` as a field, Pino's error serializer extracts message + stack automatically. Do NOT do `log.warn({ message: err.message })`.
- **Creating loggers per function call:** Create once at module level, not inside functions. Child logger creation is cheap but unnecessary per-call.
- **Using log.fatal() for recoverable errors:** fatal is for process-termination scenarios only. Use warn for caught errors, error for unexpected failures that degrade service.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON serialization | Custom JSON.stringify wrapper | Pino's built-in serialization | Pino uses sonic-boom and fast-json-stringify for 5x faster serialization |
| Error serialization | Manual `err.message + err.stack` extraction | Pino's `err` serializer (built-in) | Handles nested errors, custom properties, circular references |
| Log level filtering | if-else level checks | Pino's level system | Built-in, zero-cost when level is disabled (no string formatting) |
| Child loggers | Manual field merging | `pino.child({ component })` | Efficient bindings, no per-call overhead for bound fields |
| Async writing | Manual buffer + flush | `pino.destination({ sync: false })` | sonic-boom handles backpressure, flushing on process exit |
| Timestamp formatting | Date.now() or new Date().toISOString() | `pino.stdTimeFunctions.isoTime` | Pre-optimized, consistent format across all log lines |

**Key insight:** Pino is specifically designed so that the hot path (logging at a level that's enabled) is extremely fast, and the cold path (logging at a disabled level) is nearly zero-cost. Hand-rolling any of these would be slower and buggier.

## Common Pitfalls

### Pitfall 1: Circular Reference in Log Objects
**What goes wrong:** Passing objects with circular references (e.g., full Task objects with back-references) causes serialization errors or infinite loops
**Why it happens:** Pino uses fast-json-stringify which doesn't handle circular refs by default
**How to avoid:** Only pass specific fields to log calls (taskId, status), never pass entire domain objects. Use Pino's `safe` option if needed but prefer selective field logging.
**Warning signs:** "Maximum call stack size exceeded" or truncated log output

### Pitfall 2: Forgetting err Field Name Convention
**What goes wrong:** The error serializer only activates when the field is named `err` (not `error`, not `e`)
**Why it happens:** Pino's default serializer is keyed to the field name `err`
**How to avoid:** Always use `{ err }` or `{ err: someError }` in log objects
**Warning signs:** Error logs showing `[object Object]` instead of message + stack

### Pitfall 3: Logger Initialization Before Config
**What goes wrong:** If createLogger() is called before config registry is initialized (e.g., at module import time in CLI), it could fail
**Why it happens:** Lazy singleton pattern means first call triggers initialization
**How to avoid:** The lazy pattern (getRootLogger() called on first log, not on import) handles this. createLogger() creates a child, but the root is lazy. The key is that getConfig() itself is lazy, so this chains correctly.
**Warning signs:** ConfigError thrown during module import

### Pitfall 4: Mixing console.* and Pino in Same File
**What goes wrong:** Some output goes to stdout (console.log), some to stderr (pino), creating confusing interleaved output
**Why it happens:** Partial migration or forgetting a console.* call
**How to avoid:** Migrate ALL console.* calls in each file. Use grep to verify zero console.* remaining in core modules after migration.
**Warning signs:** Non-JSON output mixed with JSON lines on the terminal

### Pitfall 5: Config Registry console.warn for Unknown Vars
**What goes wrong:** `registry.ts` line 194 uses `console.warn()` for unknown env var warnings -- this is in config/ which is "core" but runs before logger exists
**Why it happens:** Logger depends on config, config can't depend on logger (circular)
**How to avoid:** Keep this single console.warn in registry.ts as-is. It runs exactly once at startup before the logger is available. Document this as the one accepted exception.
**Warning signs:** N/A -- this is by design

### Pitfall 6: pino.destination Flush on Exit
**What goes wrong:** When using async destination (`sync: false`), logs may be lost on process crash
**Why it happens:** sonic-boom buffers writes for performance
**How to avoid:** Register `pino.destination().flushSync()` on process exit signals, or use `sync: true` for critical startup/shutdown paths. For this project, `sync: false` with `pino.final()` handler is the right approach.
**Warning signs:** Missing log lines when process crashes

## Code Examples

### Logger Factory Module (src/logging/index.ts)
```typescript
import pino, { type Logger } from "pino";
import { getConfig } from "../config/registry.js";

let root: Logger | null = null;

function getRoot(): Logger {
  if (root) return root;
  const { core } = getConfig();
  root = pino(
    {
      level: core.logLevel,                        // "debug"|"info"|"warn"|"error"|"silent"
      timestamp: pino.stdTimeFunctions.isoTime,    // ISO 8601 timestamps
      // Default serializers include err serializer -- no config needed
    },
    pino.destination({ fd: 2, sync: false }),       // stderr, async
  );
  return root;
}

/** Create a child logger with the given component name bound. */
export function createLogger(component: string): Logger {
  return getRoot().child({ component });
}

/** Reset logger singleton -- for test isolation (mirrors resetConfig()). */
export function resetLogger(): void {
  if (root) {
    // Flush remaining buffered logs
    const dest = root[pino.symbols.streamSym];
    if (dest && typeof (dest as { flushSync?: () => void }).flushSync === "function") {
      (dest as { flushSync: () => void }).flushSync();
    }
  }
  root = null;
}

export type { Logger } from "pino";
```

### Typical Module Migration (assign-executor.ts pattern)
```typescript
// Add at top of file:
import { createLogger } from "../logging/index.js";
const log = createLogger("assign-executor");

// Replace console.error("[AOF] Enforcement transition failed..."):
log.warn({ err: transitionErr, taskId: action.taskId, op: "enforcement" }, "enforcement transition failed");

// Replace console.error("[AOF] Failed to release lease..."):
log.warn({ err: releaseErr, taskId: action.taskId, op: "releaseLease" }, "failed to release lease");

// Replace console.log("[AOF] Dispatching..."):
log.info({ taskId, sessionId }, "dispatching task to gateway");
```

### Silent Catch Remediation Pattern
```typescript
// BEFORE (callback-delivery.ts):
} catch (_err) {
  // DLVR-04: best-effort, never propagate
}

// AFTER:
} catch (err) {
  log.warn({ err, taskId, op: "deliverCallbacks" }, "callback delivery failed (best-effort)");
}
```

### Test with Mocked Logger
```typescript
import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock the logging module
vi.mock("../logging/index.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| console.* with string formatting | Pino structured JSON | Standard since ~2018 | Machine-parseable logs, level filtering, child loggers |
| winston (v2/v3) | Pino (v7+) | ~2020 shift | 5x+ performance improvement, simpler API |
| pino v7 (CJS) | pino v9 (ESM+CJS) | 2024 | Full ESM support, improved TypeScript types |
| @types/pino | Built-in types | pino v7+ | No separate types package needed |

**Deprecated/outdated:**
- `pino-pretty` as runtime dependency: Use only in dev, but user decision is NO pretty-printing at all
- `pino.extreme()`: Removed in v7, replaced by `pino.destination({ sync: false })`

## Scope Audit: Files to Migrate

### dispatch/ (9 source files with console.*, 22 catch blocks)
- assign-executor.ts: 13 console.*, 4 catch blocks
- action-executor.ts: 15 console.*, 4 catch blocks
- scheduler.ts: 15 console.*, 3 catch blocks
- murmur-integration.ts: 11 console.*, 2 catch blocks
- task-dispatcher.ts: 9 console.*, 1 catch block (silent)
- failure-tracker.ts: 6 console.*
- dag-transition-handler.ts: 3 console.*, 1 catch block
- escalation.ts: 1 console.*
- murmur-hooks.ts: 1 console.*, 1 catch block
- lease-manager.ts: 0 console.*, 1 catch block (silent .catch())

### service/ (1 file)
- aof-service.ts: 15 console.*, 4 catch blocks

### daemon/ (3 files)
- standalone-adapter.ts: 4 console.*, 5 catch blocks
- index.ts: 3 console.*, 1 catch block
- daemon.ts: 1 console.*

### protocol/ (1 file)
- router.ts: 4 console.*, 4 catch blocks
- task-lock.ts: 0 console.*, 2 silent catch blocks

### openclaw/ (3 files)
- openclaw-executor.ts: 12 console.*, 4 catch blocks
- adapter.ts: 2 console.*, 1 catch block
- matrix-notifier.ts: 1 console.*, 1 catch block

### murmur/ (1 file)
- cleanup.ts: 3 console.*

### plugins/ (1 file)
- watchdog/index.ts: 5 console.*, 2 catch blocks

### store/ (1 file)
- task-store.ts: 2 console.*

### mcp/ (1 file)
- server.ts: 1 console.*, 1 catch block

### Other core modules
- memory/index.ts: 3 console.* (borderline -- may be CLI-adjacent)
- memory/project-memory.ts: 3 console.*
- config/registry.ts: 1 console.warn (KEEP -- circular dep, runs before logger)
- metrics/exporter.ts: 1 console.*

### EXCLUDED (keep console.*)
- src/cli/** (~400+ console.* calls)
- src/commands/** (~60+ console.* calls)
- src/**/__tests__/** (test files)
- src/events/** (EventLogger -- separate system)
- src/packaging/** (installer/updater -- CLI-facing)

**Total core module migration:** ~157 console.* replacements, ~36+ catch block remediations

## Open Questions

1. **memory/ module boundary**
   - What we know: memory/index.ts and memory/project-memory.ts have 6 console.* calls
   - What's unclear: Whether memory/ is "core" or CLI-adjacent (it's used by both daemon and CLI commands)
   - Recommendation: Treat as core (it runs in daemon context), migrate to structured logger

2. **config/registry.ts console.warn**
   - What we know: Line 194 warns about unknown env vars via console.warn
   - What's unclear: Whether to migrate this given the circular dependency (logger depends on config)
   - Recommendation: Keep as console.warn -- it's a one-time startup warning that runs before logger init. Document as accepted exception.

3. **Pino version: v9 vs v10**
   - What we know: v10.3.1 is latest, v9.6.0 is latest v9
   - What's unclear: What breaking changes v10 introduced
   - Recommendation: Use v9 (^9.6.0) for stability. v10 is only a month old and may have ecosystem compatibility issues. v9 is well-tested and fully featured.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 3.x |
| Config file | vitest.config.ts |
| Quick run command | `npx vitest run src/logging/` |
| Full suite command | `npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| LOG-01 | Pino produces JSON to stderr with level/time/component/msg | unit | `npx vitest run src/logging/__tests__/logger.test.ts -x` | No -- Wave 0 |
| LOG-02 | AOF_LOG_LEVEL controls log output (debug shows all, error suppresses info/warn) | unit | `npx vitest run src/logging/__tests__/logger.test.ts -x` | No -- Wave 0 |
| LOG-03 | Child loggers include component field | unit | `npx vitest run src/logging/__tests__/logger.test.ts -x` | No -- Wave 0 |
| LOG-04 | Console.* calls replaced in core modules | smoke | `grep -r "console\." src/dispatch src/daemon src/service src/protocol --include="*.ts" --exclude-dir=__tests__ \| wc -l` returns 0 (or config exception only) | Manual grep check |
| LOG-05 | Silent catch blocks emit warn-level logs | unit | `npx vitest run src/dispatch/__tests__/ -x` (existing tests still pass) | Existing tests cover behavior |
| LOG-06 | CLI console.* unchanged | smoke | `grep -c "console\." src/cli/index.ts` still nonzero | Manual verification |
| LOG-07 | EventLogger unchanged | smoke | `git diff src/events/` shows no changes | Manual verification |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/logging/__tests__/logger.test.ts` -- covers LOG-01, LOG-02, LOG-03
- [ ] `src/logging/index.ts` -- the logger factory module itself
- [ ] Install pino: `npm install pino`

## Sources

### Primary (HIGH confidence)
- Codebase analysis: `src/config/registry.ts` -- confirmed AOF_LOG_LEVEL schema, getConfig() pattern, resetConfig() pattern
- Codebase analysis: grep across all src/ -- confirmed console.* counts and catch block locations
- [npm pino package page](https://www.npmjs.com/package/pino) -- confirmed v9/v10 versions, 21M+ weekly downloads

### Secondary (MEDIUM confidence)
- [Pino GitHub releases](https://github.com/pinojs/pino/releases) -- version history
- [SigNoz Pino guide](https://signoz.io/guides/pino-logger/) -- API patterns, child logger usage
- [Better Stack Pino guide](https://betterstack.com/community/guides/logging/how-to-install-setup-and-use-pino-to-log-node-js-applications/) -- configuration options, stderr destination

### Tertiary (LOW confidence)
- Pino v10 breaking changes -- could not verify specific changes, recommending v9 as safer choice

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- Pino is the clear standard, verified via npm downloads and ecosystem consensus
- Architecture: HIGH -- pattern matches existing codebase conventions (lazy singleton, module-level const, resetX() for tests)
- Pitfalls: HIGH -- derived from direct codebase analysis of catch blocks and console.* patterns
- Scope audit: HIGH -- grep counts verified directly against source files

**Research date:** 2026-03-12
**Valid until:** 2026-04-12 (stable domain, Pino API is mature)
