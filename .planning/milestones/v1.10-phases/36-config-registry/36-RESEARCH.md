# Phase 36: Config Registry - Research

**Researched:** 2026-03-12
**Domain:** Environment variable configuration consolidation, Zod validation
**Confidence:** HIGH

## Summary

Phase 36 consolidates all scattered `process.env` reads across `src/` into a single typed config registry backed by Zod validation. The codebase currently has 17 non-test `process.env` reads across 9 files, covering AOF_*, OPENCLAW_*, and OPENAI_API_KEY environment variables. Two of these (in callback-delivery.ts) are the documented AOF_CALLBACK_DEPTH exception that stays as-is.

Zod 3.25.76 is already installed and used extensively throughout the codebase (schemas/, mcp/, memory/, drift/). The project uses `z.object()` with `.safeParse()` pattern in config/manager.ts, which serves as a direct template for the registry's validation approach. The registry will be a lazy-initialized, frozen singleton with `resetConfig()` for test isolation.

**Primary recommendation:** Create `src/config/registry.ts` with a Zod schema covering all env vars, lazy singleton with Object.freeze, and `resetConfig(partial)` for tests. Rename `manager.ts` to `org-chart-config.ts`. Update all 15 non-exception `process.env` call sites.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Fail hard on invalid config -- getConfig() throws ConfigError listing ALL validation failures
- Lazy initialization: first getConfig() call reads env, validates via Zod, caches frozen result
- Warn on unknown AOF_* env vars (typo detection with closest-match suggestion)
- Nested config shape by domain: core, dispatch, daemon, openclaw, integrations
- Env vars only -- no CLI flag override layer
- resetConfig() accepts partial overrides for test isolation (deep-merged with defaults)
- Registry owns AOF_DATA_DIR value; resolveDataDir() sources from getConfig()
- Rename manager.ts to org-chart-config.ts; new file registry.ts
- Update config/index.ts barrel exports
- Registry covers ALL process.env reads in src/ (not just AOF_*)
- AOF_CALLBACK_DEPTH stays as direct process.env mutation (documented exception)
- CLAWDBOT_STATE_DIR removed entirely (dead code)

### Claude's Discretion
- Exact Zod schema field names (camelCase mapping from SCREAMING_SNAKE env vars)
- Default values for optional fields
- ConfigError class implementation details
- Typo suggestion algorithm for unknown AOF_* vars

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CFG-01 | Zod-based ConfigRegistry singleton with typed schema covering all AOF_* env vars | Zod 3.25.76 already in use; z.object + safeParse pattern established in manager.ts; full env var inventory documented below |
| CFG-02 | Lazy initialization with resetConfig() for test isolation | Module-scoped caching pattern exists (lease-manager.ts, throttle.ts); Object.freeze used in schemas; resetConfig clears cached singleton and deep-merges partial overrides |
| CFG-03 | All 11 scattered process.env reads consolidated into registry (except AOF_CALLBACK_DEPTH) | Full inventory of 17 process.env reads documented; 15 to consolidate, 2 are exception |
| CFG-04 | Config module has zero upward dependencies -- sits at bottom of module hierarchy alongside schemas | manager.ts currently imports from org/ and schemas/org-chart -- rename separates concerns; new registry.ts imports only from node:os, node:path, zod |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | 3.25.76 | Schema validation for env vars | Already in project dependencies, used in 15+ source files |

### Supporting
No additional libraries needed. The registry is pure TypeScript + Zod + Node built-ins.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Zod | envalid, env-schema | Zod already used everywhere; adding another validator is pointless |
| Custom Levenshtein | fastest-levenshtein npm | Simple prefix match + manual edit distance for ~10 var names is fine; no need for a dependency |

## Architecture Patterns

### Recommended Project Structure
```
src/config/
  registry.ts          # NEW: env var config registry (getConfig, resetConfig, ConfigError)
  org-chart-config.ts  # RENAMED from manager.ts: org chart YAML config management
  paths.ts             # MODIFIED: resolveDataDir() reads from getConfig() instead of process.env
  sla-defaults.ts      # UNCHANGED
  index.ts             # MODIFIED: updated barrel exports
  __tests__/
    registry.test.ts   # NEW: registry tests
    manager.test.ts    # RENAMED to org-chart-config.test.ts
```

### Pattern 1: Lazy Singleton with Frozen Result
**What:** Module-scoped `let cached: AofConfig | null = null`. `getConfig()` checks cache, reads env, validates, freezes, caches, returns. `resetConfig()` sets cached to null (or to a deep-merged partial override).
**When to use:** Always -- this is the only pattern for the registry.
**Example:**
```typescript
import { z } from "zod";

const AofConfigSchema = z.object({
  core: z.object({
    dataDir: z.string().default("~/.aof"),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }),
  dispatch: z.object({
    defaultLeaseTtlMs: z.coerce.number().positive().default(600_000),
    spawnTimeoutMs: z.coerce.number().positive().default(120_000),
    maxConcurrency: z.coerce.number().int().positive().default(3),
    maxDispatchesPerPoll: z.coerce.number().int().positive().default(10),
  }),
  // ... other domains
});

export type AofConfig = z.infer<typeof AofConfigSchema>;

let cached: Readonly<AofConfig> | null = null;

export function getConfig(): Readonly<AofConfig> {
  if (cached) return cached;
  // read env, validate, freeze, cache
  // ...
  return cached;
}

export function resetConfig(overrides?: Partial<...>): void {
  cached = null;
  if (overrides) {
    // deep-merge overrides with defaults, cache result
  }
}
```

### Pattern 2: Env-to-Schema Mapping
**What:** Map SCREAMING_SNAKE env var names to camelCase schema fields manually in a `readEnv()` function. Use `z.coerce.number()` for numeric env vars (they arrive as strings).
**When to use:** The mapping function that sits between `process.env` and the Zod schema.
**Example:**
```typescript
function readEnvInput(): Record<string, unknown> {
  return {
    core: {
      dataDir: process.env.AOF_DATA_DIR,
      logLevel: process.env.AOF_LOG_LEVEL,
    },
    dispatch: {
      defaultLeaseTtlMs: process.env.AOF_DEFAULT_LEASE_TTL_MS,
      // ...
    },
    openclaw: {
      gatewayUrl: process.env.OPENCLAW_GATEWAY_URL,
      gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN,
      stateDir: process.env.OPENCLAW_STATE_DIR,
    },
    integrations: {
      openaiApiKey: process.env.OPENAI_API_KEY,
    },
  };
}
```

### Pattern 3: ConfigError with Multi-Error Reporting
**What:** Custom error class that collects all Zod validation issues and formats them for terminal display.
**Example:**
```typescript
export class ConfigError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    const lines = issues.map(i =>
      `  - ${i.path.join(".")}: ${i.message}`
    );
    super(`Invalid AOF configuration:\n${lines.join("\n")}`);
    this.name = "ConfigError";
  }
}
```

### Pattern 4: Unknown AOF_* Var Detection
**What:** After reading known vars, scan `process.env` for any `AOF_*` keys not in the known set. Emit warning with closest match.
**Example:**
```typescript
const KNOWN_AOF_VARS = new Set([
  "AOF_DATA_DIR", "AOF_LOG_LEVEL", "AOF_ROOT",
  "AOF_DAEMON_SOCKET", "AOF_CALLBACK_DEPTH",
  // ...
]);

function warnUnknownVars(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("AOF_") && !KNOWN_AOF_VARS.has(key)) {
      const closest = findClosest(key, KNOWN_AOF_VARS);
      console.warn(`Unknown env var ${key}${closest ? ` -- did you mean ${closest}?` : ""}`);
    }
  }
}
```

### Anti-Patterns to Avoid
- **Reading process.env outside registry:** The entire point of this phase. Every `process.env` read in `src/` (except AOF_CALLBACK_DEPTH) must go through `getConfig()`.
- **Eagerly initializing config at module load:** Causes test ordering issues. Must be lazy (first `getConfig()` call).
- **Mutable config object:** The returned config must be `Object.freeze` (deep) to prevent accidental mutation.
- **Circular dependency via paths.ts:** `registry.ts` must NOT import from `paths.ts`. Instead, `paths.ts` imports from `registry.ts`. The registry does its own `normalizePath` inline or imports the pure `normalizePath` function from paths.ts (since that function has no env dependency). Actually -- `normalizePath` in paths.ts uses only `homedir()` and `resolve()`, so registry can safely import it.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Env var validation | Manual type checking | Zod `z.coerce.number()`, `.default()`, `.optional()` | Handles string-to-number coercion, defaults, error aggregation |
| Deep freeze | Recursive Object.freeze | Zod `Object.freeze` on the final parsed result | One level of freeze is sufficient for this flat-ish config |
| Error formatting | Custom error parser | Zod's `ZodError.issues` array | Already structured with path, message, expected, received |

**Key insight:** Zod's `.safeParse()` returns all errors at once (not just the first), which is exactly what CFG-01 requires for "clear error listing all issues."

## Common Pitfalls

### Pitfall 1: Circular Dependency with paths.ts
**What goes wrong:** registry.ts imports paths.ts for `resolveDataDir`, but paths.ts needs to read from registry for the env var value.
**Why it happens:** resolveDataDir currently reads process.env directly.
**How to avoid:** Registry imports only `normalizePath` from paths.ts (pure function, no env reads). Registry does its own dataDir resolution. Then paths.ts's `resolveDataDir()` calls `getConfig().core.dataDir` for the default instead of reading process.env.
**Warning signs:** Import cycle errors at runtime.

### Pitfall 2: CLI Entrypoint Env Reads
**What goes wrong:** CLI (program.ts, daemon/index.ts, mcp/server.ts) read AOF_ROOT at module-level (top-level const). These can't easily call getConfig() at module load time.
**Why it happens:** Module-level const evaluation happens at import time.
**How to avoid:** These are CLI entrypoints that read AOF_ROOT to set Commander defaults. The CONTEXT.md says "CLI passes values explicitly where needed" -- so these entrypoint files can call `getConfig().core.dataDir` inside their action handlers rather than at module top level. OR, the top-level const can stay since these are entrypoints, not library code. Decision: move the reads into action handlers or Commander option default callbacks.
**Warning signs:** Config not yet initialized when module loads.

### Pitfall 3: Test Isolation with resetConfig
**What goes wrong:** Tests leak config state between test files.
**Why it happens:** Singleton cache persists across tests.
**How to avoid:** `resetConfig()` clears cache. Tests call it in `beforeEach`/`afterEach`. When called with overrides, it creates a new frozen config from defaults + overrides without reading process.env.
**Warning signs:** Tests pass individually but fail when run together.

### Pitfall 4: z.coerce vs z.string for Env Vars
**What goes wrong:** Using `z.number()` fails because env vars are always strings.
**Why it happens:** `process.env` values are always `string | undefined`.
**How to avoid:** Use `z.coerce.number()` for numeric fields. This coerces string "30000" to number 30000.
**Warning signs:** Zod validation errors on valid numeric env vars.

### Pitfall 5: Deep Freeze vs Shallow Freeze
**What goes wrong:** Nested objects in the config can still be mutated after Object.freeze.
**Why it happens:** Object.freeze is shallow.
**How to avoid:** Use a recursive deepFreeze utility, or rely on TypeScript's `Readonly<>` for compile-time safety and shallow freeze for runtime. For this config shape (2 levels deep), a simple recursive freeze is sufficient.
**Warning signs:** Tests mutating config sub-objects and affecting other tests.

## Code Examples

### Complete Env Var Inventory (source: codebase grep)

**To consolidate into registry (15 reads across 9 files):**

| File | Env Var | Current Default | Registry Domain |
|------|---------|-----------------|-----------------|
| `config/paths.ts:35` | AOF_DATA_DIR | `~/.aof` | core.dataDir |
| `projects/resolver.ts:34` | AOF_ROOT | `~/.aof` | core.dataDir (same purpose) |
| `cli/program.ts:42` | AOF_ROOT | `~/.aof` | core.dataDir (entrypoint) |
| `daemon/index.ts:8` | AOF_ROOT | `~/.aof` | core.dataDir (entrypoint) |
| `daemon/index.ts:26` | AOF_DAEMON_SOCKET | undefined | daemon.socketPath |
| `mcp/server.ts:7` | AOF_ROOT | `~/.aof` | core.dataDir (entrypoint) |
| `daemon/standalone-adapter.ts:29` | OPENCLAW_GATEWAY_URL | `http://localhost:3000` | openclaw.gatewayUrl |
| `daemon/standalone-adapter.ts:32` | OPENCLAW_GATEWAY_TOKEN | undefined | openclaw.gatewayToken |
| `openclaw/openclaw-executor.ts:383` | OPENCLAW_STATE_DIR | `~/.openclaw` | openclaw.stateDir |
| `openclaw/openclaw-executor.ts:384` | CLAWDBOT_STATE_DIR | `~/.openclaw` | REMOVE (dead legacy) |
| `memory/index.ts:158` | OPENAI_API_KEY | undefined | integrations.openaiApiKey |
| `cli/commands/memory.ts:133` | AOF_VAULT_ROOT | undefined | core.vaultRoot |
| `cli/commands/memory.ts:133` | OPENCLAW_VAULT_ROOT | undefined | core.vaultRoot (alias) |
| `cli/commands/memory.ts:150` | AOF_VAULT_ROOT | undefined | core.vaultRoot |
| `cli/commands/memory.ts:152` | OPENCLAW_CONFIG | `~/.openclaw/openclaw.json` | openclaw.configPath |
| `cli/commands/memory.ts:300` | AOF_VAULT_ROOT | root | core.vaultRoot |
| `cli/commands/memory.ts:300` | OPENCLAW_VAULT_ROOT | root | core.vaultRoot (alias) |

**Exceptions (stay as-is):**
| File | Env Var | Reason |
|------|---------|--------|
| `dispatch/callback-delivery.ts:348` | AOF_CALLBACK_DEPTH (write) | Cross-process mutation |
| `dispatch/callback-delivery.ts:396` | AOF_CALLBACK_DEPTH (delete) | Cross-process mutation |
| `mcp/shared.ts:95` | AOF_CALLBACK_DEPTH (read) | Cross-process communication |

**Note on AOF_ROOT vs AOF_DATA_DIR:** These serve the same purpose (root data directory). The registry should unify them under `core.dataDir`, reading `AOF_DATA_DIR` first, then `AOF_ROOT` as fallback for backward compatibility.

### Recommended Zod Schema Shape
```typescript
import { z } from "zod";

export const AofConfigSchema = z.object({
  core: z.object({
    dataDir: z.string().default("~/.aof"),
    logLevel: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
    vaultRoot: z.string().optional(),
  }),
  dispatch: z.object({
    defaultLeaseTtlMs: z.coerce.number().positive().default(600_000),
    spawnTimeoutMs: z.coerce.number().positive().default(120_000),
    maxConcurrency: z.coerce.number().int().positive().default(3),
    maxDispatchesPerPoll: z.coerce.number().int().positive().default(10),
  }),
  daemon: z.object({
    pollIntervalMs: z.coerce.number().positive().default(30_000),
    socketPath: z.string().optional(),
  }),
  openclaw: z.object({
    gatewayUrl: z.string().default("http://localhost:3000"),
    gatewayToken: z.string().optional(),
    stateDir: z.string().default("~/.openclaw"),
    configPath: z.string().optional(),
  }),
  integrations: z.object({
    openaiApiKey: z.string().optional(),
  }),
});
```

### Deep Freeze Utility
```typescript
function deepFreeze<T extends object>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}
```

### Levenshtein Distance (Simple Implementation)
```typescript
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Scattered process.env reads | Centralized config registries | Standard practice | Type safety, validation, test isolation |
| Zod 3.x transforms | Zod 3.x coerce (z.coerce.number) | Zod 3.20+ | Better string-to-number coercion for env vars |

**Deprecated/outdated:**
- CLAWDBOT_STATE_DIR: Dead legacy alias for OPENCLAW_STATE_DIR. Remove entirely.
- AOF_ROOT and AOF_DATA_DIR duplication: Unify under registry, maintain backward compat by checking both.

## Open Questions

1. **AOF_ROOT vs AOF_DATA_DIR precedence**
   - What we know: Both are used for the same purpose (~/.aof). AOF_DATA_DIR is in paths.ts, AOF_ROOT is in CLI/daemon/MCP entrypoints.
   - What's unclear: Which takes precedence if both are set?
   - Recommendation: Read `AOF_DATA_DIR` first (more specific), fall back to `AOF_ROOT`. Document this in the schema.

2. **CLI entrypoint module-level reads**
   - What we know: program.ts, daemon/index.ts, mcp/server.ts read AOF_ROOT at module top level for Commander defaults.
   - What's unclear: Can these be deferred to action time?
   - Recommendation: For Commander `.option("--root", default)` the default evaluates at parse time anyway. Replace the top-level const with a call to `getConfig().core.dataDir` inside the option default factory, or keep the pattern and just route through registry. Since Commander evaluates defaults lazily when displaying help, calling `getConfig()` inline should work.

3. **AOF_VAULT_ROOT and OPENCLAW_VAULT_ROOT in CLI commands**
   - What we know: Used in cli/commands/memory.ts (3 locations). Also OPENCLAW_CONFIG.
   - What's unclear: Whether these should be in the registry since they're CLI-only.
   - Recommendation: Include them in the registry (core.vaultRoot, openclaw.configPath). The CONTEXT.md says "Registry covers ALL process.env reads in src/."

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 3.x |
| Config file | vitest.config.ts |
| Quick run command | `npx vitest run src/config/__tests__/registry.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CFG-01 | getConfig() returns frozen Zod-validated object; invalid config throws ConfigError listing all issues | unit | `npx vitest run src/config/__tests__/registry.test.ts -t "validation"` | Wave 0 |
| CFG-02 | resetConfig() provides test isolation; overrides work | unit | `npx vitest run src/config/__tests__/registry.test.ts -t "reset"` | Wave 0 |
| CFG-03 | grep -r "process.env" src/ returns zero hits outside config/ (except AOF_CALLBACK_DEPTH) | smoke | `grep -r "process.env" src/ --include="*.ts" \| grep -v __tests__ \| grep -v config/ \| grep -v callback-delivery \| grep -v shared.ts` | N/A (shell check) |
| CFG-04 | Config module has zero upward imports | smoke | `grep -r "from.*dispatch\|from.*service\|from.*store" src/config/registry.ts` | N/A (shell check) |

### Sampling Rate
- **Per task commit:** `npx vitest run src/config/__tests__/registry.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green + grep verification for CFG-03 and CFG-04

### Wave 0 Gaps
- [ ] `src/config/__tests__/registry.test.ts` -- covers CFG-01, CFG-02
- [ ] Rename `src/config/__tests__/manager.test.ts` to `src/config/__tests__/org-chart-config.test.ts`

## Sources

### Primary (HIGH confidence)
- Project codebase: `grep -rn "process.env" src/` -- full env var inventory
- `src/config/manager.ts` -- existing Zod safeParse pattern
- `package.json` -- Zod 3.24.0 (3.25.76 installed)
- `vitest.config.ts` -- test framework configuration

### Secondary (MEDIUM confidence)
- Zod documentation for `z.coerce` usage -- verified via installed version 3.25.76

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Zod already in use, no new dependencies
- Architecture: HIGH - Clear pattern from existing codebase, CONTEXT.md locked decisions
- Pitfalls: HIGH - Identified from actual codebase analysis (circular deps, module-level reads)

**Research date:** 2026-03-12
**Valid until:** 2026-04-12 (stable domain, no external dependencies changing)
