# Feature Landscape: Centralized Config Registry & Structured Logging

**Domain:** Infrastructure hardening for agent orchestration platform (AOF v1.10)
**Researched:** 2026-03-12

## Context

This is a SUBSEQUENT MILESTONE (v1.10 codebase cleanups). AOF already has:
- `EventLogger` for structured audit events (JSONL, append-only, daily rotation) -- this is for **audit trail**, not operational logging
- `console.*` calls (751 across 60 source files) for operational logging -- raw, unstructured, no levels, no context
- `src/config/paths.ts` for well-known path resolution (pure functions, good)
- `src/config/manager.ts` for org chart config CRUD (reads/writes YAML, validates with Zod)
- `process.env` reads scattered across 11+ non-config source files (AOF_DATA_DIR, AOF_ROOT, AOF_CALLBACK_DEPTH, OPENAI_API_KEY, OPENCLAW_GATEWAY_URL, etc.)
- Zod as the existing schema/validation library (already a dependency)
- Zero external database constraint (filesystem-only persistence)
- 12 runtime dependencies total -- the project is lean and should stay that way

**The core problems:**

1. **Config:** Environment variables are read at point-of-use across 11+ files with inconsistent fallback chains. No validation at startup. No typed access. Changing a config value means grep-and-pray.

2. **Logging:** Core modules (`dispatch/`, `service/`, `protocol/`) use raw `console.*` calls that produce unstructured output. When the daemon runs under launchd/systemd, these go to syslog as opaque strings. No log levels, no correlation IDs, no structured fields. Meanwhile, 36 `catch {}` blocks silently swallow errors with zero visibility.

---

## Table Stakes

Features that are expected for config and logging in a production Node.js daemon. Missing any of these means the infrastructure remains half-baked.

### Config Registry

#### C1. Single-Point Environment Variable Resolution

| Aspect | Detail |
|--------|--------|
| Why Expected | Every production Node.js app consolidates env var reads to one place. Scattered `process.env` access is a known anti-pattern -- it is untestable, undiscoverable, and produces runtime surprises when vars are missing. |
| Complexity | LOW |
| Depends On | `src/config/paths.ts` (already has `resolveDataDir` with env fallback) |

**What it means:** All `process.env` reads move to a single config module. Every other module receives resolved values via injection or import. `process.env` never appears outside `src/config/`.

**Current scattered reads (11 files):**
- `AOF_ROOT` -- daemon/index.ts, cli/program.ts, mcp/server.ts, projects/resolver.ts
- `AOF_DATA_DIR` -- config/paths.ts
- `AOF_CALLBACK_DEPTH` -- mcp/shared.ts, dispatch/callback-delivery.ts
- `OPENAI_API_KEY` -- memory/index.ts
- `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN` -- daemon/standalone-adapter.ts
- `AOF_VAULT_ROOT`, `OPENCLAW_VAULT_ROOT`, `OPENCLAW_CONFIG` -- cli/commands/memory.ts
- `OPENCLAW_STATE_DIR`, `CLAWDBOT_STATE_DIR` -- openclaw/openclaw-executor.ts
- `AOF_DAEMON_SOCKET` -- daemon/index.ts

**Confidence:** HIGH -- standard practice, codebase already partially does this in `paths.ts`.

---

#### C2. Zod-Validated Config Schema

| Aspect | Detail |
|--------|--------|
| Why Expected | AOF already uses Zod for every other schema (tasks, org charts, events, protocols, workflows). Config should be no different. Validates at startup, catches typos early, provides TypeScript types for free. |
| Complexity | LOW |
| Depends On | Zod (already a dependency) |

**What it means:** A Zod schema defining every config key with types, defaults, and descriptions. Parsed once at startup. Invalid config fails fast with a clear error message listing every problem.

```typescript
const AofConfig = z.object({
  dataDir: z.string().default("~/.openclaw/aof"),
  daemon: z.object({
    pollIntervalMs: z.number().int().min(500).default(5000),
    socketPath: z.string().optional(),
  }),
  dispatch: z.object({
    maxConcurrent: z.number().int().min(1).default(5),
    maxRetries: z.number().int().min(0).default(3),
    leaseTimeoutMs: z.number().int().min(5000).default(300_000),
  }),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }),
  // ... etc
});
```

No new dependency needed. Zod gives validation, defaults, and type inference in one pass.

**Confidence:** HIGH -- Zod-based config is the obvious choice given AOF's existing patterns.

---

#### C3. Typed Config Access (No Stringly-Typed Lookups)

| Aspect | Detail |
|--------|--------|
| Why Expected | Type-safe access means IDE autocomplete, compile-time errors for misspelled keys, and refactoring that does not silently break. Dot-notation string lookups (like convict's `config.get("server.port")`) lose all TypeScript benefits. |
| Complexity | LOW |
| Depends On | C2 (Zod schema provides the type) |

**What it means:** Config access is a typed object, not string-based lookups:

```typescript
// Good: compile-time checked
const interval = config.daemon.pollIntervalMs;

// Bad: runtime error if key changes
const interval = config.get("daemon.pollIntervalMs");
```

The Zod `z.infer<typeof AofConfig>` type gives this for free. No getter/setter API needed. Just export a frozen object.

**Confidence:** HIGH -- Zod inference is well-established.

---

#### C4. Startup-Time Validation with Fail-Fast

| Aspect | Detail |
|--------|--------|
| Why Expected | A daemon that runs with invalid config for hours before hitting a code path that reads a bad value is worse than a daemon that refuses to start. Every production system validates config at boot. |
| Complexity | LOW |
| Depends On | C2 (Zod schema), daemon entry point |

**What it means:** `loadConfig()` is called once at daemon startup (and CLI startup). If Zod parsing fails, print a clear error with all validation issues and exit with code 1. No partial starts.

**Confidence:** HIGH -- standard pattern, Zod `safeParse` already provides structured error messages.

---

#### C5. Environment Variable Override Chain

| Aspect | Detail |
|--------|--------|
| Why Expected | Config comes from multiple sources: hardcoded defaults, config file (if any), environment variables. Standard priority is: env vars > config file > defaults. AOF already does this for `AOF_DATA_DIR` in `paths.ts` -- generalize the pattern. |
| Complexity | MED |
| Depends On | C2 (Zod schema) |

**What it means:** Each config key can be overridden by an env var with a conventional prefix:

- `AOF_DATA_DIR` overrides `config.dataDir`
- `AOF_POLL_INTERVAL` overrides `config.daemon.pollIntervalMs`
- `AOF_LOG_LEVEL` overrides `config.logging.level`

The mapping is explicit in the config module (no magic prefix stripping). Zod coerces string env values to the correct types.

**Confidence:** HIGH -- `paths.ts` already does this for one key.

---

### Structured Logging

#### L1. Leveled Logger (debug/info/warn/error)

| Aspect | Detail |
|--------|--------|
| Why Expected | The most basic logging feature. Core modules need log levels so that operators can control verbosity. A daemon running under launchd should not produce debug output by default, but operators must be able to enable it for troubleshooting. |
| Complexity | LOW |
| Depends On | Config (L1 reads log level from C2) |

**What it means:** Replace `console.log/warn/error/info` in core modules with a logger that respects a configured level. When level is `info`, `debug()` calls are no-ops.

**Scope of replacement (core modules only for v1.10):**
- `src/dispatch/` -- 110 console.* calls across 14 files (scheduler, executor, DAG handler)
- `src/service/` -- 15 console.* calls (AOFService lifecycle)
- `src/protocol/` -- operational log calls in router
- `src/daemon/` -- startup/shutdown logging

**NOT in scope for v1.10:**
- `src/cli/` -- 192+ console.* calls, but CLI output IS the user interface. These are intentional stdout writes, not log messages.
- `src/mcp/` -- MCP server logging has its own conventions

**Confidence:** HIGH -- universally expected in any daemon.

---

#### L2. Structured JSON Output for Daemon Mode

| Aspect | Detail |
|--------|--------|
| Why Expected | When the daemon runs under launchd/systemd, logs are captured to syslog or journal. Raw `console.error("[AOF] Spawn failed for task-123...")` loses all structure. JSON output enables log aggregation, filtering, and alerting. |
| Complexity | LOW |
| Depends On | L1 (logger abstraction) |

**What it means:** In daemon mode, log output is JSON-per-line (matching EventLogger's JSONL pattern). Each line includes:

```json
{"ts":"2026-03-12T10:30:00.000Z","level":"error","msg":"Spawn failed","taskId":"task-123","correlationId":"abc-def","module":"dispatch","err":"Gateway timeout"}
```

In CLI mode, human-readable output is fine (or even plain console.*). The logger detects context (daemon vs CLI) or is told via config.

**Confidence:** HIGH -- standard daemon logging practice.

---

#### L3. Contextual Fields (taskId, correlationId, module)

| Aspect | Detail |
|--------|--------|
| Why Expected | Structured logging without context is just JSON-formatted `console.log`. The value comes from searchable fields. AOF already has correlation IDs threaded through dispatch -- these must appear in log entries. |
| Complexity | LOW |
| Depends On | L1 (logger), existing correlation ID tracking |

**What it means:** The logger accepts structured context fields. Different modules bind their own context:

```typescript
const log = logger.child({ module: "dispatch" });
log.info({ taskId, correlationId }, "Spawning agent session");
```

This mirrors how `EventLogger.log()` already takes `actor`, `taskId`, and `payload` -- same concept, different audience (operators vs audit trail).

**Confidence:** HIGH -- standard structured logging pattern.

---

#### L4. Replace Silent Catch Blocks with Logged Fallbacks

| Aspect | Detail |
|--------|--------|
| Why Expected | 36 empty catch blocks in dispatch/ alone with the comment "Logging errors should not crash the scheduler." The intent is correct (logging failures should not be fatal), but the execution is wrong (complete invisibility). A persistent filesystem error silently breaking all logging is a real operational risk. |
| Complexity | LOW |
| Depends On | L1 (logger) |

**What it means:** Create a `safeTry(fn, label)` utility or equivalent pattern:

```typescript
// Before: completely silent
try { await logger.logDispatch(...); } catch { }

// After: non-fatal but visible
safeTry(() => logger.logDispatch(...), "dispatch-event-log");
// On failure: writes to stderr as last resort, increments error counter
```

At minimum, a failed log write should produce a stderr line and bump a counter visible in `/healthz`. It should never crash the scheduler, but it should never be invisible either.

**Confidence:** HIGH -- directly addresses documented quality issue (QUALITY.md #7a).

---

#### L5. Separation from EventLogger (Audit vs Operations)

| Aspect | Detail |
|--------|--------|
| Why Expected | EventLogger is AOF's audit trail -- append-only JSONL recording task state transitions, dispatch events, SLA violations. It writes to `events/YYYY-MM-DD.jsonl` and feeds notification rules. Operational logging (debug traces, warnings, error diagnostics) is a completely different concern. Mixing them degrades both: audit logs become noisy, operational logs lose their audience. |
| Complexity | LOW (it is about NOT merging the two, not building something new) |
| Depends On | Clear documentation of which logger to use when |

**What it means:** Two distinct systems, two distinct purposes:

| Concern | EventLogger | Operational Logger |
|---------|-------------|-------------------|
| Audience | Audit trail, notification rules, CLI queries | Operators, debugging, monitoring |
| Format | Structured JSONL events with eventId, type, actor, taskId, payload | Structured JSON logs with level, message, context fields |
| Persistence | `events/YYYY-MM-DD.jsonl` -- permanent, queryable | stdout/stderr -- captured by OS supervisor |
| Retention | Permanent (daily rotation, symlink to current) | Managed by launchd/systemd log rotation |
| When to use | State transitions, dispatch events, SLA violations | Debug traces, error diagnostics, startup/shutdown, performance warnings |

**Confidence:** HIGH -- the separation already exists conceptually; it just needs to be enforced consistently.

---

## Differentiators

Features that go beyond basic expectations. Not required for v1.10 MVP but add meaningful value to operators.

| Feature | Value Proposition | Complexity | Dependencies | Notes |
|---------|-------------------|------------|--------------|-------|
| **Log level hot-reload via health endpoint** | Change log level without restarting the daemon. `curl --unix-socket daemon.sock /loglevel?level=debug`. Essential for debugging production issues. | LOW | Health endpoint (already exists), config registry | Natural extension of existing Unix socket health endpoint. |
| **Module-scoped log levels** | `dispatch=debug,service=info` -- different verbosity per module. Debug a specific subsystem without flooding. | MED | Logger child context, config schema extension | Useful but not critical for v1.10. Default to global level. |
| **Config diff on startup** | Print resolved config (with env overrides highlighted) at daemon startup. Shows exactly what config the daemon is running with. | LOW | Config registry | Aids debugging "why is this behaving differently in production?" |
| **Config validation CLI command** | `aof config validate` -- check config without starting daemon. | LOW | Config schema, CLI command | Natural extension of existing `aof smoke` health check. Could be a new smoke check. |
| **Metrics integration for log errors** | Increment `aof_log_errors_total` counter when operational logging fails. Visible in `/status` endpoint. | LOW | Existing prom-client metrics, L4 (safeTry) | Connects logging health to existing observability. |
| **Request-scoped logging context** | Use `AsyncLocalStorage` to propagate taskId/correlationId through the call stack without passing logger instances everywhere. | MED | Node.js AsyncLocalStorage (built-in) | Elegant but potentially over-engineered for AOF's stateless poll loop. Each poll cycle is short-lived. |

---

## Anti-Features

Features to explicitly NOT build for v1.10.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Add pino or winston as a dependency** | AOF has 12 runtime deps and values being lean. The logging needs (leveled output, JSON format, child loggers) are simple enough to implement in ~100 lines using Zod for config and `process.stdout.write` for output. Pino's worker-thread async model adds complexity AOF does not need for its poll-loop architecture. | Build a thin custom logger. AOF's logging volume is low (scheduler polls every 5s, not thousands of requests/sec). Raw throughput is irrelevant. |
| **Log to files from the logger** | AOF runs under launchd/systemd which capture stdout/stderr. Adding file rotation, file descriptors, and cleanup logic to the logger duplicates what the OS already does. EventLogger already handles file-based persistence for audit events. | Write to stdout/stderr. Let the OS supervisor handle capture and rotation. |
| **Merge operational logs into EventLogger** | EventLogger is the audit trail. It has a specific schema (eventId, type, actor, taskId, payload), specific consumers (notification rules, CLI queries, trace), and specific retention requirements. Dumping debug/info/warn messages into it would degrade its usefulness and bloat event files. | Keep them separate. EventLogger for audit events. Operational logger for everything else. |
| **OpenTelemetry integration** | Explicitly deferred to v2 in PROJECT.md. Adding OTLP exporters, span context, trace propagation is a larger initiative. | Structured JSON logs are a stepping stone. When OTel comes in v2, the structured logger becomes an OTel-compatible log source with minimal changes. |
| **Log aggregation or shipping** | No Elasticsearch, Loki, or CloudWatch integration. AOF is a single-machine daemon. | JSON logs to stdout. Operators who want aggregation can pipe daemon output to their preferred tool. |
| **Replace CLI console.* calls** | CLI commands use `console.log` to print output for humans. This IS the intended behavior -- the CLI is a user interface, not a logging concern. Replacing it with a structured logger would make CLI output unusable. | Only replace console.* in core modules (dispatch, service, protocol, daemon). Leave CLI alone. |
| **Config file on disk** | AOF has no config file today. All config is env vars + defaults + org chart. Adding a `config.yaml` or `config.json` introduces a new file to manage, new migration concerns, and a new failure mode. | Stick with env vars + defaults for now. The registry centralizes reading and validates at startup. A config file can be added later as an additional source in the override chain. |
| **Convict or node-config dependency** | These libraries add dependencies for something Zod already does (schema definition, validation, defaults, type coercion). Convict's TypeScript support has known limitations with nested dotted paths. node-config is explicitly warned against for TypeScript use. | Zod schema + simple env var mapping. Zero new dependencies. |
| **Dynamic config reloading (beyond log level)** | Hot-reloading arbitrary config values (poll interval, max retries, etc.) introduces state consistency risks. What happens to in-flight dispatches if maxConcurrent changes mid-poll? | Only log level gets hot-reload (via health endpoint). Everything else requires daemon restart. This is safe and simple. |

---

## Feature Dependencies

```
C2 (Zod Config Schema)
  |
  +--> C1 (Consolidate env var reads into config module)
  |      |
  |      +--> C3 (Typed access -- comes free from Zod inference)
  |      |
  |      +--> C5 (Env override chain -- mapping env vars to schema keys)
  |
  +--> C4 (Startup validation -- parse schema at boot, fail fast)
  |
  +--> L1 (Leveled logger reads log level from config)
         |
         +--> L2 (JSON output mode for daemon -- config controls format)
         |
         +--> L3 (Contextual fields -- child logger pattern)
         |
         +--> L4 (safeTry utility -- uses logger for fallback writes)
         |
         +--> L5 (Separation docs -- guidelines for when to use which logger)

EventLogger (existing, unchanged)
  |
  +--> L5 explicitly documents the boundary between EventLogger and operational logger
```

### Build Order Implications

1. **Config schema (C2) must come first** -- the logger reads its level from config, and all env consolidation depends on the schema existing.
2. **Env consolidation (C1) and validation (C4) come next** -- once the schema exists, move all process.env reads and wire up startup validation.
3. **Logger (L1-L3) depends on config being done** -- needs to read log level and output format from config.
4. **safeTry (L4) and separation docs (L5) are independent polish** -- can be done in parallel with or after logger.
5. **Config must be done before dispatch/service refactoring** -- other v1.10 cleanup work (extracting god functions, breaking circular deps) will be easier with proper logging in place.

---

## MVP Recommendation

### Phase 1: Config Registry

1. **Zod config schema** (C2) -- Define `AofConfig` schema with all known config keys, types, defaults.
2. **Env var consolidation** (C1) -- Move all `process.env` reads to config module. Map env vars to schema keys.
3. **Typed access** (C3) -- Export frozen typed config object. Update all consumers to import from config.
4. **Startup validation** (C4) -- Parse and validate in daemon and CLI entry points. Fail fast on invalid config.
5. **Override chain** (C5) -- Env vars override defaults. Document the mapping.

Rationale: Config is a prerequisite for logging (log level comes from config) and for the broader v1.10 cleanup (refactored modules should read config from registry, not from env vars scattered in closures).

### Phase 2: Structured Logging

6. **Logger implementation** (L1) -- Thin leveled logger. ~100 lines. JSON output for daemon, human-readable for CLI/dev.
7. **Structured output** (L2) -- JSON-per-line with timestamp, level, message, and arbitrary context fields.
8. **Contextual fields** (L3) -- `logger.child({ module })` pattern. Bind taskId and correlationId at dispatch sites.
9. **safeTry utility** (L4) -- Replace 36+ silent catch blocks with non-fatal-but-visible error handling.
10. **Separation documentation** (L5) -- Clear guidelines: EventLogger for audit events, operational logger for everything else.

Rationale: Logger depends on config for its level. Replacing console.* in dispatch/ and service/ gives immediate value -- structured daemon logs, visible error handling, correlation IDs in every log entry.

### Defer:
- **Log level hot-reload** -- Nice to have, add when operators request it
- **Module-scoped levels** -- Premature granularity for a ~6800 LOC dispatch module
- **AsyncLocalStorage context** -- Over-engineered for AOF's short-lived poll cycles
- **Config file on disk** -- Env vars + defaults sufficient for single-machine daemon

---

## Key Observations from Codebase

1. **`src/config/paths.ts` is the right foundation.** It already follows the pattern of "pure functions resolving well-known paths" with env var fallback. The config registry extends this to all config values, not just paths.

2. **`src/config/manager.ts` is for org chart CRUD, not app config.** It reads/writes YAML org charts with Zod validation. The config registry is a separate concern -- app runtime configuration, not user-facing org chart management. They should coexist in `src/config/` but remain distinct.

3. **EventLogger is NOT the operational logger.** It is the audit trail with specific schema, specific consumers (notification rules, trace CLI), and specific retention. Operational logging must be a separate system writing to stdout/stderr for OS supervisor capture. This distinction is critical and already implied by the architecture but not enforced.

4. **751 console.* calls, but only ~140 need replacement.** CLI commands (192+ calls in cli/) are intentional user-facing output. Only core modules (dispatch: 110, service: 15, protocol/daemon: ~15) need structured logging. This is a manageable scope.

5. **36 silent catch blocks are the highest-value logging fix.** These are not just style issues -- they represent invisible failure modes. A filesystem error breaking all event logging would be completely silent today. Adding safeTry with stderr fallback and metrics counters is the single highest-impact change.

6. **process.env reads follow no naming convention.** Some use `AOF_` prefix (AOF_ROOT, AOF_DATA_DIR), some use `OPENCLAW_` prefix (OPENCLAW_GATEWAY_URL), some have no prefix (OPENAI_API_KEY). The config registry should map all of these with clear documentation of which env var controls what.

7. **No config file exists today -- and that is fine.** AOF uses env vars + defaults + org chart. The config registry validates and centralizes env var reads without introducing a new file. A config file is a future enhancement, not a v1.10 requirement.

8. **Existing prom-client metrics should track logging health.** AOF already uses prom-client for dispatch metrics. Adding `aof_log_errors_total` and `aof_config_validation_errors` counters connects config/logging health to the existing observability surface.

---

## Sources

- AOF codebase: `src/config/paths.ts` -- current env var resolution pattern with `resolveDataDir()` (HIGH confidence)
- AOF codebase: `src/config/manager.ts` -- org chart config CRUD, separate concern from app config (HIGH confidence)
- AOF codebase: `src/events/logger.ts` -- EventLogger audit trail, JSONL format, event callbacks (HIGH confidence)
- AOF codebase: QUALITY.md #2b -- 751 console.* calls across 60 files, core module counts (HIGH confidence)
- AOF codebase: QUALITY.md #7a -- 36 silent catch blocks in dispatch, invisible failures (HIGH confidence)
- AOF codebase: ARCHITECTURE.md #10 -- process.env scattered across 11 files (HIGH confidence)
- AOF codebase: PROJECT.md -- OpenTelemetry deferred to v2, zero-DB constraint, existing dependencies (HIGH confidence)
- [Node.js config library should not be used in TypeScript](https://jessewarden.com/2025/05/node-js-config-library-shouldnt-be-used-in-typescript.html) -- rationale against node-config in TS (MEDIUM confidence)
- [Pino vs Winston comparison](https://betterstack.com/community/comparisons/pino-vs-winston/) -- performance comparison, feature differences (MEDIUM confidence)
- [Top Node.js Logging Libraries 2025](https://www.dash0.com/faq/the-top-5-best-node-js-and-javascript-logging-frameworks-in-2025-a-complete-guide) -- ecosystem overview (MEDIUM confidence)
- [LogTape: zero-dependency logging](https://logtape.org/comparison) -- zero-dep structured logging patterns (MEDIUM confidence)
- [Configuration Management for TypeScript Apps](https://medium.com/@andrei-trukhin/configuration-management-for-typescript-node-js-apps-60b6c99d6331) -- centralized config class pattern (LOW confidence)

---
*Feature research for: AOF v1.10 Centralized Config Registry & Structured Logging*
*Researched: 2026-03-12*
