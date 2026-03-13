# Phase 39: Architecture Fixes - Research

**Researched:** 2026-03-13
**Domain:** TypeScript module dependency graph cleanup, circular dependency resolution, layering enforcement
**Confidence:** HIGH

## Summary

This phase addresses 17 circular dependency cycles (confirmed by `madge --circular --extensions ts src/`), 14+ store abstraction bypass sites, 3 module layering violations, and a barrel/registration entanglement in memory/index.ts. The codebase uses TypeScript 5.7+ with NodeNext module resolution, vitest 3.2 for testing, and write-file-atomic for safe file writes.

All issues are well-characterized from direct codebase analysis. The circular dependencies cluster into four groups: (1) dispatch/ type cycles (7 cycles) caused by `SchedulerConfig`/`SchedulerAction`/`DispatchConfig` types defined in implementation files and imported back by helpers, (2) tools/ barrel cycles (5 cycles) caused by `ToolContext` defined in `aof-tools.ts` which re-exports from sub-modules that import `ToolContext`, (3) simple A-B mutual imports (4 cycles in config/, org/, store/, projects/, context/), and (4) one service bypass site. Store bypass sites are concentrated in dispatch/ (7 files) with additional sites in protocol/, service/, and store-internal modules.

**Primary recommendation:** Extract shared types to dedicated `*/types.ts` files to break cycles, then route all external `serializeTask()+writeFileAtomic()` calls through new ITaskStore methods or dependency injection.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Fix ALL 17 circular dependency cycles -- not just the original dispatch/protocol cycle
- Target: zero cycles from `madge --circular src/`
- Dispatch handler cycles: break with extracted shared types/interfaces in dispatch/types.ts or similar
- Tools barrel cycles: fix import direction only -- sub-modules import from siblings, not from the barrel
- Route ALL 14 bypass sites through ITaskStore -- including internal store sub-modules
- Add new ITaskStore methods as needed for operations that don't have existing store methods
- External modules (dispatch/) receive ITaskStore via dependency injection (consistent with Phase 35 lock manager pattern)
- After all bypass sites are fixed, restrict exports of serializeTask() and writeFileAtomic() -- remove from barrel exports so only store module can use them directly
- Fix violations AND document import direction rules
- ARCH-03 (config->org): Invert dependency -- org/ calls config/ for validation, not the other way
- ARCH-04 (MCP->CLI): Move createProjectStore() to projects/ module -- both MCP and CLI import from projects/
- ARCH-05 (duplicate loadProjectManifest): Unify into projects/ module
- ARCH-06 (memory/index.ts): Extract registerMemoryModule() and all helpers/types to memory/register.ts; index.ts becomes pure barrel

### Claude's Discretion
- Exact naming of extracted type files (dispatch/types.ts, dispatch/interfaces.ts, etc.)
- Per-cycle fix approach for the non-dispatch cycles (type extraction vs import direction fix)
- Which new ITaskStore methods to add vs reusing existing ones
- Format and location of architecture rules documentation

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| ARCH-01 | Circular dependency between dispatch/ and protocol/ broken | 7 dispatch cycles identified; root cause is shared types (SchedulerConfig, SchedulerAction, DispatchConfig) defined in implementation files; fix via dispatch/types.ts extraction |
| ARCH-02 | Store abstraction bypass fixed -- 14 direct serializeTask+writeFileAtomic call sites routed through ITaskStore | All bypass sites catalogued: dispatch/ (assign-executor, assign-helpers, lifecycle-handlers, failure-tracker, dag-transition-handler, escalation, scheduler), protocol/router.ts, service/aof-service.ts; store-internal sites in task-lifecycle, task-deps, task-mutations, lease already use ITaskStore indirectly |
| ARCH-03 | Config->org upward import fixed | config/org-chart-config.ts imports lintOrgChart from org/linter.ts; fix by moving validation call to org/ or accepting a validator function |
| ARCH-04 | MCP->CLI hidden dependency fixed | mcp/shared.ts dynamically imports createProjectStore from cli/project-utils.ts; fix by moving createProjectStore to projects/ module |
| ARCH-05 | Duplicate loadProjectManifest() unified | Two implementations: dispatch/assign-executor.ts (exported, re-exported via task-dispatcher.ts) and mcp/shared.ts (inline); unify in projects/ module |
| ARCH-06 | memory/index.ts split | 329-line file mixing 30 lines of re-exports with 270 lines of registerMemoryModule() setup logic; extract to memory/register.ts |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| madge | (devDep via npx) | Circular dependency detection | Standard tool for JS/TS dependency graph analysis |
| write-file-atomic | (existing) | Atomic file writes | Already used throughout codebase for safe task persistence |
| vitest | 3.2 | Test runner | Existing test framework |
| TypeScript | 5.7+ | Language | NodeNext module resolution, .js extensions in imports |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| zod | (existing) | Schema validation | Used for config, task schemas -- no changes needed |

### Alternatives Considered
None -- this phase works entirely with existing dependencies.

**Installation:**
No new packages needed.

## Architecture Patterns

### Recommended Project Structure for Extracted Types
```
src/
├── dispatch/
│   ├── types.ts              # NEW: SchedulerConfig, SchedulerAction, DispatchConfig
│   ├── scheduler.ts          # imports from ./types.ts instead of defining
│   ├── task-dispatcher.ts    # imports from ./types.ts instead of defining
│   ├── action-executor.ts    # imports from ./types.ts
│   └── ...handlers.ts        # imports from ./types.ts
├── tools/
│   ├── types.ts              # NEW: ToolContext interface
│   ├── aof-tools.ts          # pure barrel, imports ToolContext from ./types.ts
│   ├── tool-registry.ts      # imports ToolContext from ./types.ts
│   └── *-tools.ts            # import ToolContext from ./types.ts
├── store/
│   ├── interfaces.ts         # ITaskStore + new methods
│   ├── task-parser.ts        # serializeTask stays here (NOT re-exported from barrel)
│   └── ...
├── projects/
│   ├── store-factory.ts      # NEW: createProjectStore (moved from cli/project-utils.ts)
│   ├── manifest.ts           # NEW or extended: loadProjectManifest unified
│   └── ...
├── memory/
│   ├── index.ts              # MODIFIED: pure barrel re-exports only
│   ├── register.ts           # NEW: registerMemoryModule() + all helper types
│   └── ...
└── config/
    └── org-chart-config.ts   # MODIFIED: accepts validator function instead of importing linter
```

### Pattern 1: Type Extraction to Break Cycles
**What:** Move shared interfaces/types to a dedicated `types.ts` file that has no implementation imports
**When to use:** When A exports a type that B imports, but A also imports from B
**Example:**
```typescript
// dispatch/types.ts (NEW -- no implementation imports)
import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import type { GatewayAdapter, TaskContext } from "./executor.js";
import type { TaskLockManager } from "../protocol/task-lock.js";

export interface SchedulerConfig {
  store: ITaskStore;
  logger: EventLogger;
  executor: GatewayAdapter;
  // ... all fields from current scheduler.ts definition
}

export interface SchedulerAction {
  type: string;
  taskId: string;
  // ... all fields from current scheduler.ts definition
}

export interface DispatchConfig {
  store: ITaskStore;
  logger: EventLogger;
  executor: GatewayAdapter;
  // ... all fields from current task-dispatcher.ts definition
}
```

### Pattern 2: Import Direction Fix for Helper Cycles
**What:** Instead of helper importing types from parent, extract shared types or have parent pass types
**When to use:** A <-> B where B is a helper file of A and only needs a type from A
**Example:**
```typescript
// org/linter-helpers.ts -- instead of importing LintIssue from ./linter.ts
// Option A: Define LintIssue in a shared types file
// Option B: Accept LintIssue as a generic type parameter
// Best for this case: extract LintIssue to org/types.ts

// org/types.ts (NEW)
export interface LintIssue {
  severity: "error" | "warning";
  rule: string;
  message: string;
}
```

### Pattern 3: Dependency Inversion for Layering Violations
**What:** Lower-layer module accepts behavior via function parameter instead of importing upper-layer module
**When to use:** config/ importing from org/, MCP importing from CLI
**Example:**
```typescript
// config/org-chart-config.ts -- BEFORE:
import { lintOrgChart } from "../org/linter.js";
// validates using lintOrgChart(parseResult.data)

// AFTER: accept validator as parameter
export async function setConfigValue(
  configPath: string,
  key: string,
  value: string,
  dryRun: boolean = false,
  validator?: (data: unknown) => Array<{ severity: string; message: string }>
): Promise<...> {
  // use validator instead of directly calling lintOrgChart
}
```

### Pattern 4: Store Method Addition for Bypass Elimination
**What:** Add specific methods to ITaskStore so external code never directly serializes/writes tasks
**When to use:** When dispatch/ code does `serializeTask(task) + writeFileAtomic(path, serialized)`
**Example:**
```typescript
// store/interfaces.ts -- add to ITaskStore:
export interface ITaskStore {
  // ... existing methods ...

  /** Persist a task object to disk atomically. Used by dispatch modules. */
  save(task: Task): Promise<void>;

  /** Persist a task to a specific path (for session copies, metadata). */
  saveToPath(task: Task, path: string): Promise<void>;
}
```

### Anti-Patterns to Avoid
- **Defining types in implementation files:** Types that multiple modules import should live in dedicated type files
- **Barrel files importing from sub-modules that import back:** Barrel should re-export, sub-modules should import types from types.ts not the barrel
- **Dynamic imports to work around layering:** `await import("../cli/...")` in MCP is a code smell indicating misplaced code
- **Re-exporting types through implementation files:** `export type { X } from "./scheduler.js"` in escalation.ts just to avoid another import

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Circular dependency detection | Manual import tracing | `madge --circular --extensions ts src/` | Catches transitive cycles humans miss |
| Atomic file writes | Manual temp+rename | `write-file-atomic` (already in use) | Handles edge cases (permissions, symlinks) |
| Module dependency graphs | Manual analysis | `madge --image graph.svg src/` | Visual verification after fixes |

## Common Pitfalls

### Pitfall 1: Breaking Re-exports Without Updating Consumers
**What goes wrong:** Moving a type from `scheduler.ts` to `types.ts` breaks all files that import from `scheduler.ts`
**Why it happens:** TypeScript allows re-exports, but not finding and updating all import sites
**How to avoid:** After extracting types, add `export type { ... } from "./types.js"` to the original file temporarily, then update all consumers in the same PR
**Warning signs:** TypeScript compilation errors after moving types

### Pitfall 2: Type-Only vs Value Imports in Cycles
**What goes wrong:** Using `import type` doesn't break runtime cycles but does break madge detection
**Why it happens:** madge analyzes static imports without distinguishing type-only
**How to avoid:** Use `import type` for type-only imports (reduces false positives in madge), but also physically separate types into types.ts files for clarity
**Warning signs:** madge reports cycles that only involve `import type` -- these are false positives in madge (madge `--extensions ts` doesn't distinguish them by default)

### Pitfall 3: Store Bypass in Tests
**What goes wrong:** Test files also use `serializeTask + writeFileAtomic` directly for setup
**Why it happens:** Tests create task files on disk for integration testing
**How to avoid:** Test files are exempt from the bypass rule -- they're creating test fixtures, not production code. Focus on production source files only
**Warning signs:** Overzealous enforcement on test setup code

### Pitfall 4: Circular Dependency via Re-exports
**What goes wrong:** `aof-tools.ts` re-exports from `project-tools.ts` which imports `ToolContext` from `aof-tools.ts`
**Why it happens:** Barrel pattern where the barrel also defines types
**How to avoid:** Extract `ToolContext` to `tools/types.ts`, update all consumers
**Warning signs:** Sub-modules importing from the barrel file

### Pitfall 5: Incomplete Dependency Inversion
**What goes wrong:** Moving `createProjectStore` to `projects/` but keeping the EventLogger import creates a new cross-module dependency
**Why it happens:** The function has its own dependency chain
**How to avoid:** Check that the moved function's imports align with the target module's layer
**Warning signs:** New madge cycles appearing after the move

## Code Examples

### Current Bypass Pattern (to be eliminated)
```typescript
// dispatch/failure-tracker.ts -- CURRENT (bypass)
import { serializeTask } from "../store/task-store.js";
import writeFileAtomic from "write-file-atomic";

const filePath = task.path ?? join(store.tasksDir, task.frontmatter.status, `${taskId}.md`);
await writeFileAtomic(filePath, serializeTask(task));
```

### Target Pattern (after fix)
```typescript
// dispatch/failure-tracker.ts -- TARGET (through ITaskStore)
await store.save(task);
// or if path-specific:
await store.saveToPath(task, customPath);
```

### Current Config->Org Violation
```typescript
// config/org-chart-config.ts -- CURRENT
import { lintOrgChart } from "../org/linter.js";
const lintIssues = lintOrgChart(parseResult.data);
```

### Target Pattern (dependency inverted)
```typescript
// config/org-chart-config.ts -- TARGET
// No org/ import. Accepts validator as parameter.
export async function setConfigValue(
  configPath: string, key: string, value: string,
  dryRun = false,
  linter?: (data: unknown) => Array<{ severity: string; message: string }>
) {
  const lintIssues = linter ? linter(parseResult.data) : [];
  // ...
}

// org/ or CLI caller provides the linter:
import { lintOrgChart } from "../org/linter.js";
await setConfigValue(path, key, value, false, lintOrgChart);
```

### Current MCP->CLI Violation
```typescript
// mcp/shared.ts -- CURRENT
const { createProjectStore } = await import("../cli/project-utils.js");
```

### Target Pattern (moved to projects/)
```typescript
// mcp/shared.ts -- TARGET
import { createProjectStore } from "../projects/store-factory.js";
// or from projects/index.ts barrel
```

## Detailed Cycle Analysis

### Group 1: Dispatch Type Cycles (7 cycles, all share root cause)
**Root cause:** `SchedulerConfig` and `SchedulerAction` defined in `scheduler.ts`, `DispatchConfig` defined in `task-dispatcher.ts`. All handler files import these types, creating back-edges.
**Cycles:**
1. scheduler.ts -> action-executor.ts (imports SchedulerConfig/Action from scheduler)
2. scheduler.ts -> action-executor.ts -> alert-handlers.ts (imports from scheduler)
3. scheduler.ts -> action-executor.ts -> lifecycle-handlers.ts (imports from scheduler)
4. scheduler.ts -> action-executor.ts -> recovery-handlers.ts (imports from scheduler)
5. scheduler.ts -> action-executor.ts -> lifecycle-handlers.ts -> assign-executor.ts -> scheduler-helpers.ts (imports SchedulerAction from scheduler)
6. scheduler.ts -> escalation.ts (re-exports SchedulerConfig/Action from scheduler)
7. assign-executor.ts -> assign-helpers.ts -> task-dispatcher.ts (imports DispatchConfig from task-dispatcher)

**Fix:** Extract `SchedulerConfig`, `SchedulerAction`, `DispatchConfig` to `dispatch/types.ts`. Update all import sites.

### Group 2: Tools Barrel Cycles (5 cycles)
**Root cause:** `ToolContext` defined in `aof-tools.ts`. Sub-modules (project-tools, query-tools, task-crud-tools, task-workflow-tools, tool-registry) import `ToolContext` from `aof-tools.ts`. But `aof-tools.ts` re-exports from these sub-modules.
**Fix:** Move `ToolContext` to `tools/types.ts`. Update all sub-module imports. `aof-tools.ts` becomes a pure barrel.

### Group 3: Simple A-B Mutual Imports (4 cycles)
1. **config/paths.ts <-> config/registry.ts:** paths imports `getConfig` from registry, registry imports `normalizePath` from paths. Fix: move `normalizePath` to a shared utility or inline it in registry.
2. **org/linter.ts <-> org/linter-helpers.ts:** linter-helpers imports `LintIssue` type from linter. Fix: extract `LintIssue` to `org/types.ts`.
3. **store/task-store.ts <-> store/task-lifecycle.ts:** task-lifecycle imports `TaskStoreHooks` type from task-store. Fix: move `TaskStoreHooks` to `store/interfaces.ts` or a types file.
4. **projects/lint.ts <-> projects/lint-helpers.ts:** lint-helpers imports `LintIssue` type from lint. Fix: extract to `projects/types.ts`.
5. **context/assembler.ts <-> context/manifest.ts:** manifest imports `ContextManifest` type from assembler. Fix: extract to `context/types.ts`.

### Group 4: Store Bypass Sites (production code only)

| File | Lines | Operation | Suggested Fix |
|------|-------|-----------|---------------|
| dispatch/assign-executor.ts | 132-134, 179-181, 270-272 | Write leased task, session copy, updated task | New `store.save(task)` and `store.saveToPath(task, path)` |
| dispatch/assign-helpers.ts | 103-105 | Write task metadata | `store.saveToPath(task, metaPath)` |
| dispatch/lifecycle-handlers.ts | 43-45, 163-165 | Write expired/requeued task | `store.save(task)` |
| dispatch/failure-tracker.ts | 46, 132 | Write failed task | `store.save(task)` |
| dispatch/dag-transition-handler.ts | 162 | Write DAG state | `store.save(task)` |
| dispatch/escalation.ts | 181 | Write escalated task | `store.save(task)` |
| dispatch/scheduler.ts | 8 (import) | Imports serializeTask | Remove after bypass fixed |
| protocol/router.ts | 469 | Write child task | `store.save(childTask)` -- but this creates a task, may need `store.create()` instead |
| service/aof-service.ts | 329-330 | Startup reconciliation | `store.save(task)` |

**Store-internal bypass sites** (task-lifecycle.ts, task-deps.ts, task-mutations.ts, lease.ts): These are already inside the store module and call `serializeTask` from `task-parser.ts`. They are internal implementation detail -- the key change is to stop re-exporting `serializeTask` from `store/index.ts` barrel after external consumers are migrated.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Types defined in implementation files | Types in dedicated `types.ts` files | Standard TS pattern | Breaks circular deps |
| Direct file writes from any module | All writes through store interface | This phase | Enforces abstraction boundary |
| Barrel files defining + re-exporting | Barrel files as pure re-exports | Standard TS pattern | Eliminates barrel cycles |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 3.2.4 |
| Config file | vitest.config.ts |
| Quick run command | `npx vitest run --reporter=verbose` |
| Full suite command | `npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ARCH-01 | Zero circular dependencies | smoke | `npx madge --circular --extensions ts src/` | N/A (CLI check) |
| ARCH-02 | No serializeTask+writeFileAtomic outside store | smoke | `grep -r "serializeTask\|writeFileAtomic" src/ --include="*.ts" -l` filtered | N/A (grep check) |
| ARCH-03 | config/ has no org/ imports | smoke | `grep -r "from.*org/" src/config/ --include="*.ts"` | N/A (grep check) |
| ARCH-04 | MCP has no CLI imports | smoke | `grep -r "from.*cli/" src/mcp/ --include="*.ts"` | N/A (grep check) |
| ARCH-05 | Single loadProjectManifest | smoke | `grep -rn "loadProjectManifest" src/ --include="*.ts"` | N/A (grep check) |
| ARCH-06 | memory/index.ts is pure barrel | manual | Review file length < 40 lines, no function definitions | N/A |
| ALL | Existing tests still pass | regression | `npx vitest run` | Existing test suite |

### Sampling Rate
- **Per task commit:** `npx vitest run` + `npx madge --circular --extensions ts src/`
- **Per wave merge:** Full vitest suite + madge check
- **Phase gate:** `madge --circular --extensions ts src/` reports 0 cycles AND full test suite green

### Wave 0 Gaps
None -- this phase is refactoring with verification via madge and existing tests. No new test files needed; validation is structural (madge + grep).

## Open Questions

1. **New ITaskStore methods -- `save()` vs more specific names**
   - What we know: External modules need to persist modified tasks. Some write to the task's canonical path, others write to custom paths (session copies, metadata).
   - What's unclear: Whether a single `save(task)` method is sufficient or if `saveToPath(task, path)` is also needed for session copies.
   - Recommendation: Add both `save(task: Task): Promise<void>` (writes to task.path or computed path) and `saveToPath(task: Task, path: string): Promise<void>` (explicit path). The session copy use case in assign-executor needs an explicit path.

2. **protocol/router.ts child task creation (line 469)**
   - What we know: router.ts creates a child task by calling `writeFileAtomic(taskPath, serializeTask(childTask))` -- this is effectively a `store.create()` bypass.
   - What's unclear: Whether this should use the existing `store.create()` method or a lower-level `store.save()`.
   - Recommendation: Investigate if `store.create()` can be used here. If it generates IDs differently, use `store.save()` since the task object is already fully formed.

3. **Whether `import type` cycles should count**
   - What we know: madge with `--extensions ts` doesn't distinguish `import type` from value imports in all cases
   - What's unclear: Some cycles may only involve `import type` statements
   - Recommendation: Fix ALL cycles regardless -- cleaner architecture even if some are type-only. This avoids confusion about which cycles are "real".

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis via `madge --circular --extensions ts src/` -- 17 cycles confirmed
- Direct `grep` analysis of all `serializeTask` and `writeFileAtomic` call sites
- Direct file reading of all files involved in cycles and violations

### Secondary (MEDIUM confidence)
- TypeScript handbook on module resolution patterns (well-established)

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new dependencies, all existing tooling
- Architecture: HIGH - all cycle roots identified through direct import chain analysis
- Pitfalls: HIGH - based on direct codebase observation of actual import patterns
- Bypass sites: HIGH - comprehensive grep of all production source files

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (stable -- internal refactoring, no external dependency changes)
