# Project Research Summary

**Project:** AOF v1.10 — Centralized Config Registry & Structured Logging
**Domain:** Infrastructure hardening for TypeScript agent orchestration daemon
**Researched:** 2026-03-12
**Confidence:** HIGH

## Executive Summary

AOF v1.10 is a codebase quality milestone targeting two infrastructure gaps in an existing, production-running daemon: scattered `process.env` reads across 11+ files with no validation, and 751 unstructured `console.*` calls in core modules that become opaque syslog strings when the daemon runs under launchd. Both problems are well-understood, have established solutions, and require zero new runtime dependencies. The correct approach is a thin `ConfigRegistry` class built on Zod (already a dependency) and a custom ~100-line `Logger` class writing JSON to stderr — not external libraries like pino, winston, node-config, or convict.

The recommended implementation follows a strict four-phase build order driven by a hard dependency chain: the config registry must exist first (it supplies the log level to the logger), the logger infrastructure must exist before migrating `console.*` call sites, and silent catch block remediation must come last because it depends on the logger being wired through all dispatch modules. This is a purely internal refactor — no user-facing behavior changes, no new API surface, no schema changes. The primary risk is scope creep: 751 `console.*` calls sounds large, but only ~120 in core modules need migration; the other 630 in CLI commands are intentional user-facing output and must not change.

The two critical risks are boot-order coupling (config must not validate at module import time or it will break `aof --help`, unit tests, and partial process starts) and big-bang migration (replacing all console calls at once breaks test spies and CLI output). Both risks are fully mitigated by lazy initialization with `resetConfig()` for tests, and a module-by-module migration starting with daemon/scheduler and ending with CLI. The broader v1.10 milestone includes dead code removal (gate system, ~2900 lines), bug fixes, god function extraction, and test infrastructure improvements — config and logging are phases 3-4 within that larger context.

## Key Findings

### Recommended Stack

No new runtime dependencies are needed. Zod 3.24.x (already installed) handles schema definition, type inference, env var coercion, and startup validation for the config registry in one pass. A custom `Logger` class using `process.stderr.write()` provides leveled JSON output with child logger support in ~100-150 lines — covering AOF's actual needs without pino's 11 transitive dependencies or winston's transport architecture complexity.

**Core technologies:**
- **Zod 3.24.x** (existing): Config schema, validation, type inference, and `z.coerce.*` for string-to-number env vars — no new capability needed beyond what's installed
- **Node.js 22 built-ins** (`process.env`, `process.stderr.write()`): Config source and log output destination — sufficient for AOF's single-machine daemon architecture
- **Custom `ConfigRegistry` class** (internal, ~150 lines): Singleton with explicit `initConfig()` + lazy `getConfig()`, `ENV_MAP` for env var name mapping, `resetConfig()` for tests
- **Custom `Logger` class** (internal, ~100 lines): `debug/info/warn/error`, `child(ctx)`, synchronous API, JSON formatter for daemon, human formatter for CLI
- **TypeScript 5.7.x** (existing): `z.infer<typeof AofConfigSchema>` gives typed config access with IDE autocomplete at zero cost

**Explicitly rejected:** pino v10 (11 deps, 664kB, overkill for AOF's poll-loop volume), winston (even heavier), node-config (file-based, not env var-based), convict (Zod already does schema+validation+coercion), dotenv (AOF runs as a plugin/daemon with env set by runtime, not `.env` files).

### Expected Features

All features in scope are infrastructure — there is no user-visible feature surface for this milestone. The table stakes are operational correctness properties that the codebase currently lacks.

**Must have (table stakes):**
- **C1: Single-point env var resolution** — all `process.env` reads move to `src/config/registry.ts`; no `process.env` outside `src/config/`
- **C2: Zod-validated config schema** — `AofConfigSchema` with all known keys, types, defaults; parsed once at startup
- **C3: Typed config access** — frozen `AofConfig` object exported; dot-notation access with TypeScript inference, no string-based lookups
- **C4: Startup-time fail-fast validation** — invalid config produces clear error with all issues, exits with code 1
- **C5: Env override chain** — explicit `ENV_MAP` (e.g., `AOF_DATA_DIR -> dataDir`); Zod coerces string env values to correct types
- **L1: Leveled logger** — `debug/info/warn/error` respecting `AOF_LOG_LEVEL`; below-level calls are no-ops
- **L2: Structured JSON output** — one JSON object per line to stderr in daemon mode; human-readable for CLI/dev
- **L3: Contextual fields** — `logger.child({ component: "scheduler" })` with `taskId`, `correlationId` fields per call
- **L4: Replace silent catch blocks** — 36 empty catch blocks in dispatch become `log.warn("EventLogger write failed", { error })` — non-fatal but visible
- **L5: Audit vs operational separation** — documented and enforced boundary: `EventLogger` for audit JSONL, `Logger` for operational stderr

**Should have (differentiators):**
- Log level hot-reload via existing Unix socket health endpoint (`/loglevel?level=debug`) — no restart needed for production debugging
- Config diff at daemon startup — print resolved config with env overrides highlighted
- `aof config validate` CLI command — check config without starting daemon

**Defer (v2+):**
- Module-scoped log levels (`dispatch=debug,service=info`) — premature granularity for v1.10
- `AsyncLocalStorage` for automatic context propagation — over-engineered for AOF's short-lived poll cycles
- Config file on disk — env vars + defaults are sufficient; file adds a third config source
- OpenTelemetry integration — explicitly deferred to v2 in PROJECT.md

**Anti-features (never build for this milestone):**
- Replace CLI `console.*` with structured logger — CLI output is user interface, not logging
- Log to files from the Logger — OS supervisor (launchd/systemd) already captures stderr
- Merge operational logs into EventLogger — audit trail and operational logs are fundamentally different concerns

### Architecture Approach

The new modules slot into the existing bottom-up dependency hierarchy without disrupting it. Config registry lives at `src/config/` alongside the existing `paths.ts` and `manager.ts` (separate concerns that stay unchanged). The structured logger lives at `src/logging/` at the same layer as `src/events/` — above schemas and config, below store and dispatch. The logger is NOT a global singleton; it follows AOF's existing dependency injection pattern where `EventLogger` is passed through constructors. Entry points (`daemon.ts`, `cli/program.ts`, `mcp/server.ts`) call `initConfig()` and create the root logger, then pass it down through `AOFServiceDependencies`, `SchedulerConfig`, and `ProtocolRouterDependencies` as optional fields (backward-compatible addition).

**Major components:**
1. **`src/config/config-schema.ts`** — Zod schema (`AofConfigSchema`) defining all config keys with types, defaults, descriptions; single source of truth for `AofConfig` type
2. **`src/config/registry.ts`** — `ConfigRegistry` class with `ENV_MAP`, env reading, Zod validation, singleton management (`initConfig`, `getConfig`, `resetConfig`); exception: `callback-delivery.ts` keeps direct `process.env` mutation as cross-process IPC
3. **`src/logging/logger.ts`** — `Logger` interface, `createLogger` factory, `createNullLogger` for optional injection, synchronous `process.stderr.write()` output
4. **`src/logging/formatters.ts`** — JSON formatter (daemon/MCP) and human-readable formatter (CLI/dev)
5. **`src/events/logger.ts`** (existing, unchanged) — audit JSONL EventLogger; complementary to structured logger, not competing

**Key patterns to follow:**
- All env var reads via `getConfig().get(key)` — never `process.env` outside `src/config/`
- `logger.child({ component: "scheduler" })` — module-scoped loggers, not per-function
- Dual logging for important events — `eventLogger.logDispatch(...)` for audit + `log.error(...)` for operators
- CLI output stays as `console.log` — never route user-facing output through the logger
- `deps.operationalLogger?.child(...) ?? createNullLogger()` — graceful fallback when logger not injected

### Critical Pitfalls

1. **Config validates at import time, breaking tests and CLI help** — use lazy initialization (`getConfig()` initializes on first call, not module scope); provide `resetConfig()` for test isolation; validate only at startup boundaries (daemon start, CLI command execution). Detection: `aof --help` crashes, tests fail with "missing required config".

2. **Big-bang logging migration breaks CLI output and test assertions** — categorize every `console.*` call before replacing (CLI output vs. diagnostic logging vs. error reporting); never replace CLI command `console.log` calls; migrate module-by-module starting with daemon/scheduler; run full test suite after each module. Detection: CLI produces JSON output, tests using `vi.spyOn(console, 'error')` fail.

3. **Dead code removal breaks barrel exports and downstream imports** — delete gate source files, test files, and barrel re-exports (`schemas/index.ts`, `dispatch/index.ts`) in a single atomic commit; validate with `tsc --noEmit` before and after; grep for all gate symbol references including comments and JSDoc. Detection: `tsc --noEmit` fails, vitest reports "cannot find module".

4. **God function extraction breaks implicit state dependencies** — write characterization tests before refactoring `assign-executor.ts` (544 lines) and `action-executor.ts` (415 lines, zero tests today); extract one helper at a time; preserve exact try/catch boundaries; extract pure data transformations first. Detection: E2E dispatch tests fail under error conditions while happy-path tests pass.

5. **Circular dependency fixes change module load order** — use `madge` to map the dependency graph before changes; break cycles by extracting shared types to a new file (dependency inversion); replace barrel imports with direct file imports. Detection: module-level state reads as `undefined` at runtime without compilation error.

## Implications for Roadmap

Research consistently points to a 4-phase build sequence for config+logging, nested within AOF's 6-phase v1.10 cleanup milestone. The config/logging work is phases 3-4 of the larger cleanup because it depends on dead code removal (reduces codebase surface) and targeted bug fixes (stable baseline), and it must precede god function refactoring (extracted functions need proper logging to be debuggable).

### Phase 1: Dead Code Removal
**Rationale:** Removes ~2900 lines of gate system code that would otherwise complicate every subsequent refactor. Eliminates `new Function()` security risk. Establishes a clean TypeScript compilation baseline before any structural changes. PITFALLS.md is emphatic: do this first.
**Delivers:** Codebase reduced by ~2900 lines; clean `tsc --noEmit` green; no gate symbols remaining; dynamic imports resolved to static.
**Addresses:** Gate system files (`gate-evaluator.ts`, `gate-conditional.ts`, `gate-context-builder.ts`, `gate.ts`, `workflow.ts`), barrel re-exports in `schemas/index.ts` and `dispatch/index.ts`, ~2000 lines of gate test files, lazy migration in `task-store.ts` read path, stale JSDoc.
**Avoids:** Pitfall 3 (barrel export breakage if done carelessly), Pitfall 7 (migration framework for pre-v1.3 users — keep migration file as no-op stub), Pitfall 11 (redundant dynamic imports).

### Phase 2: Targeted Bug Fixes
**Rationale:** Small, isolated fixes to known bugs that would otherwise complicate later phases. Fixes `buildTaskStats` (wrong active task count), `startTime` tracking, `UpdatePatch.blockers`. Low risk because changes are surgical.
**Delivers:** Correct task statistics, correct start time tracking, unblocked task update paths.
**Avoids:** Pitfall 9 (TOCTOU race — assess complexity vs. benefit before committing; single-process Node.js makes this theoretical; if fixing, add behind a feature flag initially).

### Phase 3: Config Registry
**Rationale:** The config registry is a prerequisite for the logger (log level comes from config) and for all subsequent module refactoring (extracted functions should read config from registry, not from `process.env` scattered in closures). Zero breaking changes — additive pattern that existing code adopts incrementally, one file at a time.
**Delivers:** `src/config/config-schema.ts` with `AofConfigSchema`; `src/config/registry.ts` with `ConfigRegistry`, `initConfig`, `getConfig`, `resetConfig`; all 11 `process.env` files migrated to registry; startup validation wired into daemon, CLI, and MCP entry points.
**Addresses:** Features C1-C5; 11 scattered `process.env` files across daemon, CLI, MCP, memory, project resolver.
**Avoids:** Pitfall 4 (boot-order dependency) — lazy initialization, `resetConfig()` for tests, validate at startup boundaries only. Exception: `callback-delivery.ts` keeps direct `process.env` mutation (cross-process IPC, documented as intentional).
**Research flag:** Standard patterns, well-documented. Skip `research-phase`. Zod singleton pattern is established.

### Phase 4: Structured Logger
**Rationale:** Depends on config registry (reads log level). Build and test logger infrastructure before migrating call sites. Module-by-module migration (daemon first, CLI last or never) prevents the big-bang pitfall.
**Delivers:** `src/logging/logger.ts` with `Logger` interface, `createLogger`, `createNullLogger`; `src/logging/formatters.ts` with JSON and human formatters; logger wired into `AOFServiceDependencies`, `SchedulerConfig`, `ProtocolRouterDependencies` as optional fields; ~120 `console.*` calls in core modules migrated; 36 silent catch blocks replaced with `log.warn(...)`.
**Addresses:** Features L1-L5; 36 silent catch blocks (QUALITY.md #7a — highest-value single fix); ~120 core module `console.*` calls in dispatch, service, protocol, daemon.
**Uses:** Custom `Logger` class, `process.stderr.write()`, JSON + human formatters.
**Avoids:** Pitfall 3 (big-bang migration) — module-by-module, daemon first; EventLogger conflict — keep strictly separate, different consumers, different output targets.
**Research flag:** Standard patterns, well-documented. Skip `research-phase`. Leveled JSON logging to stderr is established practice.

### Phase 5: God Function Refactoring + Circular Dependency Fixes
**Rationale:** Now that config and logging are in place, extracted helper functions have proper logging. Dead code is removed, reducing the surface area. Characterization tests must be written before extracting from `assign-executor.ts` and `action-executor.ts`. Circular dependency fixes use `madge` analysis and dependency inversion.
**Delivers:** `assign-executor.ts` (544 lines) broken into focused helpers with characterization tests; `action-executor.ts` (415 lines, currently zero tests) with test coverage; circular deps broken via shared interface files; barrel imports replaced with direct file imports where needed.
**Avoids:** Pitfall 2 (god function implicit state — extract pure data transformations first, preserve try/catch scope boundaries), Pitfall 5 (circular dep load order — use `madge`, extract shared types).
**Research flag:** Needs `research-phase` for circular dependency mapping. The specific dependency cycles in AOF's dispatch module must be analyzed with `madge` before extraction order can be planned.

### Phase 6: Test Infrastructure
**Rationale:** Last because every prior phase produces test changes. Consolidating patterns after all refactoring is complete avoids having to rewrite a shared harness when interfaces change during phases 2-5.
**Delivers:** Shared `createTestHarness()` utility (add as option, migrate one file at a time); typed mock factories for `ITaskStore` and `EventLogger` (replacing 120 `as any` casts); full coverage config expanded beyond the current 6 files; cleanup in 8 test files lacking `afterEach`.
**Avoids:** Pitfall 6 (shared harness timing — migrate one file at a time, run full suite after each), Pitfall 8 (coverage expansion pressure — use as measurement, not gate; write characterization tests first), Pitfall 12 (`as any` interface drift — typed mock factories catch interface changes at compile time).
**Research flag:** Standard patterns. Skip `research-phase`.

### Phase Ordering Rationale

- **Dead code first** — gate system removal reduces codebase by ~2900 lines, eliminates `new Function()` security risk, and removes gate-related complexity from every subsequent phase
- **Bug fixes second** — small targeted fixes are lower risk before structural changes; correct `buildTaskStats` before logging migration avoids misleading log output during later phases
- **Config before logging** — hard dependency: the logger reads its log level from config; this is confirmed independently by all four research files
- **Logging before god function refactoring** — extracted helper functions need structured logging to be debuggable; migrating `console.*` after extraction means doing it twice
- **Test infrastructure last** — every prior phase touches test files; a shared harness built before refactoring would need to be rewritten after interface changes
- **Config and circular dep fixes can overlap** — breaking circular deps involves restructuring imports, which is compatible with config migration; both involve module boundary work and can be coordinated within Phase 3-5

### Research Flags

Phases needing deeper research during planning:
- **Phase 5 (God Function Refactoring):** Circular dependency graph requires `madge` analysis specific to AOF's module structure before extraction order can be planned. Research identified the pattern (dependency inversion via shared type files) but not the specific cycles.

Phases with standard patterns (skip `research-phase`):
- **Phase 1 (Dead Code Removal):** Standard TypeScript dead code deletion with `tsc --noEmit` validation. Pattern well-documented.
- **Phase 2 (Bug Fixes):** Targeted, isolated fixes to known issues. No pattern research needed.
- **Phase 3 (Config Registry):** Zod singleton with lazy init and `resetConfig()` is an established pattern. All decisions resolved in research.
- **Phase 4 (Structured Logger):** Leveled JSON logger to stderr is established practice. Custom implementation path is clear and fully specified.
- **Phase 6 (Test Infrastructure):** Standard vitest patterns. Shared harness and mock factories are well-documented.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Verified against installed package.json, Node.js 22 docs, existing Zod usage throughout codebase. Zero new dependencies confirmed. |
| Features | HIGH | All features derived from direct codebase analysis (QUALITY.md, ARCHITECTURE.md counts). No ambiguous requirements. |
| Architecture | HIGH | Primary source is direct code inspection of all affected modules with line-number precision. Integration points verified against actual interfaces. |
| Pitfalls | HIGH | Sourced from codebase-specific analysis (CONCERNS.md, TESTS.md) with file and line references. General TypeScript pitfalls corroborated by external sources. |

**Overall confidence:** HIGH

### Gaps to Address

- **`callback-delivery.ts` env mutation:** This file deliberately SETS `process.env.AOF_CALLBACK_DEPTH` as cross-process IPC across the MCP boundary. The read side can migrate to `getConfig()` but the write side cannot. Validate the exact mechanism during Phase 3 implementation and document as an intentional exception in the registry.

- **Exact circular dependency graph:** PITFALLS.md identifies `src/dispatch/index.ts` and `src/schemas/index.ts` barrel files as likely cycle sources, but the specific cycles require `madge` analysis before Phase 5 planning. Treat Phase 5 as requiring a pre-planning research step.

- **TOCTOU race complexity vs. benefit:** The TOCTOU race in `task-mutations.ts` and `lease.ts` is theoretical in single-process Node.js. Phase 2 planning should explicitly decide whether to fix it or document it as a known acceptable risk. Research does not resolve this trade-off.

- **`src/testing/` utility adoption:** Only 3 imports use the existing testing utilities despite 217 test files constructing `FilesystemTaskStore`/`EventLogger` directly. Investigate why before building more shared infrastructure in Phase 6 — there may be a reason these utilities were not adopted.

## Sources

### Primary (HIGH confidence)
- AOF `src/config/paths.ts` — existing env var resolution pattern, `resolveDataDir()` with fallback chain
- AOF `src/events/logger.ts` — EventLogger audit trail implementation; JSONL format, event callbacks, rotation
- AOF `src/dispatch/` (14 files) — direct console.* count (76 non-test), silent catch count (36), module structure
- AOF `src/service/aof-service.ts` — dependency injection pattern; `AOFServiceDependencies` interface
- AOF `.planning/codebase/QUALITY.md` — 751 console.* calls, 229 swallowed catches, 120 `as any` casts
- AOF `.planning/codebase/ARCHITECTURE.md` — 11 files with scattered process.env, module hierarchy
- AOF `.planning/codebase/CONCERNS.md` — gate system dead code, circular dependency details
- AOF `.planning/codebase/TESTS.md` — test infrastructure state, 8 files lacking cleanup
- AOF `package.json` — verified 12 runtime dependencies, no logging libs, zod 3.24.x installed
- Node.js 22 docs — `process.stderr.write()`, `process.env` semantics

### Secondary (MEDIUM confidence)
- Pino v10 npm page — 11 deps, 664kB confirmed; disproportionate for AOF's needs
- [Node.js config library should not be used in TypeScript](https://jessewarden.com/2025/05/node-js-config-library-shouldnt-be-used-in-typescript.html) — rationale against node-config in TypeScript
- [Ditch process.env, Use a Typed Config](https://echobind.com/post/ditch-process-env-use-a-typed-config) — centralized config singleton pattern
- [LogTape: zero-dependency logging](https://logtape.org/comparison) — zero-dep structured logging patterns; affirms custom implementation feasibility
- [Dead Code Detection: Knip vs ts-prune](https://levelup.gitconnected.com/dead-code-detection-in-typescript-projects-why-we-chose-knip-over-ts-prune-8feea827da35) — TypeScript dead code removal strategies

### Tertiary (LOW confidence)
- [Configuration Management for TypeScript Apps](https://medium.com/@andrei-trukhin/configuration-management-for-typescript-node-js-apps-60b6c99d6331) — centralized config class pattern; general, not AOF-specific
- [Refactoring by Breaking Functions Apart: TypeScript](https://auth0.com/blog/refactoring-breaking-functions-apart-typescript/) — god function extraction patterns; general, needs AOF-specific application in Phase 5

---
*Research completed: 2026-03-12*
*Ready for roadmap: yes*
