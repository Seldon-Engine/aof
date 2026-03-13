# Phase 37: Structured Logging - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Core modules emit leveled, structured JSON logs to stderr. Replaces ~120 console.* calls in core modules with Pino-based structured logger. Remediates silent catch blocks across all core modules. CLI console output and EventLogger (audit JSONL) remain unchanged.

</domain>

<decisions>
## Implementation Decisions

### Log Output Format
- JSON only to stderr — no human-readable dev mode, no pino-pretty
- Rich fields per log line: level, time, component, msg, pid, hostname
- Default log level: info (when AOF_LOG_LEVEL not set)
- stderr only — no optional file output. Users redirect if needed (2>aof.log)

### Silent Catch Remediation
- All caught errors logged at warn level — including transient/expected errors (rate limits, gateway failures)
- Each catch block log line includes: error object (with stack trace), operation name, and identifiers (taskId, correlationId) where available
- Stack traces always included via Pino's default error serializer
- Remediate silent catches in ALL core modules (dispatch, daemon, protocol, service, scheduler), not just dispatch/

### CLI vs Core Boundary
- Boundary drawn by directory:
  - `src/cli/`, `src/commands/` → console.* stays (user-facing output)
  - Everything else (dispatch/, daemon/, protocol/, service/, store/, mcp/, openclaw/, murmur/, plugins/) → structured logger
- All daemon startup/shutdown messages become structured logs — no console.error exceptions
- Test files (__tests__/) keep console.* — tests are developer-facing, not operational
- MCP server is core infrastructure — uses structured logger

### Logger API Surface
- Factory function: `createLogger(component)` returns a child logger with component field set
- Module lives in `src/logging/` — separate from config/ and clearly distinct from EventLogger
- Ad-hoc context passing per call site: `logger.warn({ err, taskId, op: 'acquireLease' }, 'lease acquisition failed')`
- No AsyncLocalStorage context propagation — keep it simple

### Claude's Discretion
- How modules acquire their logger (module-level const vs injected) — pick what fits the codebase
- Exact Pino configuration options (serializers, timestamp format, redaction)
- Whether to add a resetLogger() for test isolation (similar to resetConfig())
- Granular log level choices per catch block within the warn-level guideline

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/config/registry.ts`: getConfig() singleton with AOF_LOG_LEVEL field — logger reads level from here
- Zod already validates AOF_LOG_LEVEL as string with default in config schema
- EventLogger pattern in `src/events/` — separate audit system, should NOT be touched

### Established Patterns
- Module-scoped singletons: getConfig(), EventLogger, TaskLockManager — logger follows same pattern
- Config registry at bottom of module hierarchy — logging/ should sit alongside it (no upward deps)
- Error serialization in trace-writer.ts — existing pattern for structured error capture

### Integration Points
- `src/config/registry.ts` — AOF_LOG_LEVEL already defined, logger reads from getConfig().core.logLevel
- 104 console.* calls in dispatch/ (9 source files) — bulk of migration work
- 8 console.* calls in daemon/ (3 files)
- 15 console.* calls in service/aof-service.ts
- 22+ catch blocks in dispatch/ to remediate (across 9 files)
- EventLogger referenced in 105 files — must remain completely untouched

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard Pino approaches.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 37-structured-logging*
*Context gathered: 2026-03-12*
