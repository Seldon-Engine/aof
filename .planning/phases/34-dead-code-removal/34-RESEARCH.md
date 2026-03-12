# Phase 34: Dead Code Removal - Research

**Researched:** 2026-03-12
**Domain:** TypeScript codebase cleanup (file deletion, import pruning, schema surgery)
**Confidence:** HIGH

## Summary

Phase 34 removes approximately 2,900 lines of deprecated gate workflow system code, unused imports/schemas, deprecated type aliases, and commented-out code. The work is purely subtractive -- no new features, no new code.

The primary complexity lies in **schema dependencies**: `task.ts` imports `GateHistoryEntry`, `ReviewContext`, and `TestSpec` from `gate.ts`, and `project.ts` imports `WorkflowConfig` from `workflow.ts`. These types are embedded in production schemas (`TaskFrontmatter` and `ProjectManifest`). The gate source files (`gate-evaluator.ts`, `gate-conditional.ts`, `gate-context-builder.ts`) and their dispatch integration points are cleanly isolated and can be deleted outright. But `gate.ts` and `workflow.ts` schema files require careful handling -- their types are still structurally referenced by the task and project schemas.

Additionally, the `migration/gate-to-dag.ts` module is imported by both the lazy migration in `task-store.ts` (to be removed) AND the batch migration `002-gate-to-dag-batch.ts` (still registered in `setup.ts`). The batch migration must be preserved since it is part of the installer migration chain.

**Primary recommendation:** Follow the incremental commit strategy from CONTEXT.md, but treat gate schema types as "inline into consuming schemas" rather than "delete wholesale." Each commit must leave `tsc --noEmit` clean and `vitest` green.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- No pre-removal scan for gate-format tasks -- just remove the lazy migration code
- v1.3 shipped months ago; any gate tasks would have been migrated through normal reads by now
- The migration code in task-store.ts (get, getByPrefix, list) and migration/gate-to-dag.ts is removed outright
- Incremental commits by category for bisect-ability:
  1. Gate source files (gate-evaluator.ts, gate-conditional.ts, gate-context-builder.ts, gate.ts schema, workflow.ts schema)
  2. Gate test files (gate-evaluator.test.ts, gate-enforcement.test.ts, gate-conditional.test.ts, gate-context-builder.test.ts, gate-timeout.test.ts, gate.test.ts, task-gate-extensions.test.ts)
  3. Barrel re-exports from schemas/index.ts and dispatch/index.ts
  4. Lazy gate-to-DAG migration code from task-store.ts and migration/gate-to-dag.ts
  5. Unused imports in scheduler.ts (18+ symbols)
  6. Unused MCP output schemas (13 schemas in mcp/tools.ts)
  7. Deprecated type aliases (DispatchResult, Executor, MockExecutor) + commented-out code + deprecated notifier param
- Each commit should leave the codebase in a compiling, test-passing state

### Claude's Discretion
- Exact ordering within categories (which files first)
- Whether to combine small related deletions within a category
- How to handle any unexpected compile errors from removal cascades

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DEAD-01 | Legacy gate system removed -- gate-evaluator.ts, gate-conditional.ts, gate-context-builder.ts, gate.ts schema, workflow.ts schema (~900 lines source) | Verified all 5 files exist, totaling 1,276 lines. Critical dependency: task.ts imports 3 types from gate.ts; project.ts imports WorkflowConfig from workflow.ts. See Architecture Patterns for handling. |
| DEAD-02 | Legacy gate test files removed (~2,000 lines tests) | Verified 7 test files exist, totaling 2,803 lines. All import only from gate modules being deleted -- clean removal once source files are gone. |
| DEAD-03 | Gate barrel re-exports removed from schemas/index.ts and dispatch/index.ts | schemas/index.ts lines 94-107 re-export gate.js and workflow.js. dispatch/index.ts lines 11-18 re-export gate-conditional.js and gate-evaluator.js. |
| DEAD-04 | Lazy gate-to-DAG migration removed from FilesystemTaskStore and migration/gate-to-dag.ts | task-store.ts has migration blocks at lines 251-258 (get), 292-298 (getByPrefix), 343-352 (list). migration/gate-to-dag.ts (240 lines) is also used by 002-gate-to-dag-batch.ts -- see Pitfall 1. |
| DEAD-05 | Unused imports cleaned from scheduler.ts (18+ symbols) | Verified: lines 8-27 import 20+ symbols. Gate-specific imports (lines 22, 23, 25, 27) will be invalid after DEAD-01. Other unused imports (lines 8, 11, 12, 13, 15, 19, 20, 24, 26) must be checked individually. |
| DEAD-06 | 13 unused MCP output schemas removed from mcp/tools.ts | Verified: 13 output schemas defined but never used (MCP SDK does not require output schemas). Lines: 31, 50, 65, 80, 99, 334, 368, 401, 433, 463, 496, 529, 592. |
| DEAD-07 | Deprecated type aliases removed (DispatchResult, Executor, MockExecutor) | executor.ts lines 49-50 (ExecutorResult), 115-116 (DispatchExecutor), 284-285 (MockExecutor). Re-exported from dispatch/index.ts lines 3, 5-8. |
| DEAD-08 | Commented-out code removed (event.ts import, promotion.ts Phase 2 block, stale JSDoc references) | event.ts lines 13-14 (commented import), promotion.ts lines 72-76 (commented Phase 2 block), dag-transition-handler.ts line 5 (stale reference to non-existent gate-transition-handler.ts). |
| DEAD-09 | Deprecated notifier param removed from AOFService constructor | aof-service.ts lines 42-43 (deprecated notifier in deps interface), line 64 (private field), line 100 (assignment), line 113 (pass-through to ProtocolRouter). No callers pass notifier -- all use engine instead. |
</phase_requirements>

## Architecture Patterns

### Critical Dependency: Gate Types in TaskFrontmatter

**This is the most important finding.** The CONTEXT.md lists "gate.ts schema" as a file to remove in category 1. However, `src/schemas/task.ts` line 10 imports three Zod schemas from `gate.ts`:

```typescript
import { GateHistoryEntry, ReviewContext, TestSpec } from "./gate.js";
```

These are used in `TaskFrontmatter` (lines 119-121):
- `gateHistory: z.array(GateHistoryEntry).default([])`
- `reviewContext: ReviewContext.optional()`
- `tests: z.array(TestSpec).default([])`

**You cannot delete gate.ts without breaking task.ts.** Two approaches:

**Approach A (Recommended): Inline the three referenced schemas into task.ts before deleting gate.ts.**
Move `GateHistoryEntry`, `ReviewContext`, and `TestSpec` definitions directly into `task.ts` (they are pure Zod schemas with no external imports beyond `z`). Then delete `gate.ts`. This preserves backward compatibility for any existing task files that have these fields while removing the deprecated module.

**Approach B: Delete the optional gate fields from TaskFrontmatter entirely.**
This would break parsing of any task files that still have `gateHistory`, `reviewContext`, or `tests` fields. Given the user's locked decision that "no pre-removal scan for gate-format tasks" is needed, Approach A is safer -- it keeps the schema accepting legacy fields without requiring the deprecated module.

Also inline `GateState` -- it is already defined in `task.ts` (lines 49-55), so no action needed there.

### Critical Dependency: WorkflowConfig in ProjectManifest

`src/schemas/project.ts` line 9 imports `WorkflowConfig` from `workflow.ts`, used at line 136:
```typescript
workflow: WorkflowConfig.optional(),
```

**You cannot delete workflow.ts without breaking project.ts.** Same approach: inline the `WorkflowConfig` and `RejectionStrategy` schemas (plus the `Gate` schema they depend on) into either `project.ts` or a new minimal location. Since `Gate` is also used by `workflow.ts`, the `Gate` schema definition would need to be inlined too.

However, if Approach A is taken for gate.ts (inline `GateHistoryEntry`, `ReviewContext`, `TestSpec` into `task.ts`), and the `Gate` schema is only needed by `WorkflowConfig` (used only in `project.ts`), then:
1. Inline `Gate` + `RejectionStrategy` + `WorkflowConfig` into `project.ts`
2. Delete `gate.ts` and `workflow.ts`

### Critical Dependency: migration/gate-to-dag.ts

The CONTEXT.md says "migration/gate-to-dag.ts is removed outright." However:

- `src/packaging/migrations/002-gate-to-dag-batch.ts` imports `migrateGateToDAG` and `WorkflowConfig` from `../../migration/gate-to-dag.js` (lines 17-18)
- `002-gate-to-dag-batch` is registered in `src/cli/commands/setup.ts` line 65 as part of the installer migration chain

**Option 1:** Remove both `migration/gate-to-dag.ts` AND `packaging/migrations/002-gate-to-dag-batch.ts`, and unregister from `setup.ts`. Since v1.3 shipped months ago, the batch migration has already run for all users.

**Option 2:** Keep `002-gate-to-dag-batch.ts` as-is. This means `migration/gate-to-dag.ts` cannot be deleted.

**Recommendation:** Option 1 -- remove both. The migration is idempotent and was designed for v1.3. Users on v1.10 have already run it. Also remove the associated test file `src/migration/__tests__/gate-to-dag.test.ts` (257 lines). But note this changes the migration chain in setup.ts, which may affect the packaging upgrade tests.

### Cascade Removal Map

After gate source files are deleted, these files need import cleanup:

| File | What to Remove | Why |
|------|---------------|-----|
| `src/schemas/task.ts` | Inline `GateHistoryEntry`, `ReviewContext`, `TestSpec` from gate.js; remove import line | task.ts depends on these types |
| `src/schemas/project.ts` | Inline `WorkflowConfig` + dependencies; remove import line | project.ts depends on WorkflowConfig |
| `src/dispatch/executor.ts` | Remove `import type { GateContext }` (line 9), remove `gateContext?` field (line 32) from `TaskContext` | No more gate context |
| `src/dispatch/assign-executor.ts` | Remove `import { buildGateContext }` (line 16), remove gate context injection block (lines 150-169) | No more gate context building |
| `src/dispatch/scheduler.ts` | Remove gate imports (lines 22, 23, 25, 27), remove `checkGateTimeouts` call (line 248) | Gate timeout checking removed |
| `src/dispatch/escalation.ts` | Remove `escalateGateTimeout` function (lines 51-167), `checkGateTimeouts` function (lines 169-229), `WorkflowConfig` import. Keep `checkHopTimeouts` (DAG path). | ~180 lines removed from 493-line file |
| `src/store/task-store.ts` | Remove lazy migration blocks in get/getByPrefix/list, remove `migrateGateToDAG` import (line 26) | DEAD-04 |
| `src/dispatch/index.ts` | Remove gate re-exports (lines 11-18) | DEAD-03 |
| `src/schemas/index.ts` | Remove gate.js and workflow.js re-exports (lines 94-107) | DEAD-03 |

### Recommended Commit Ordering (Revised from CONTEXT.md)

The CONTEXT.md ordering puts gate source file deletion first, but this causes immediate compile errors due to the schema dependencies. Revised order that keeps each commit compiling:

1. **Prep: Inline gate schemas** -- Move `GateHistoryEntry`, `ReviewContext`, `TestSpec` into `task.ts`; move `Gate`, `RejectionStrategy`, `WorkflowConfig`, `validateWorkflow` into `project.ts` (or a `schemas/legacy-gate-types.ts` temporary file). Remove the import lines. This commit changes no behavior, only moves type definitions.

2. **Delete gate source files** -- Remove `gate-evaluator.ts`, `gate-conditional.ts`, `gate-context-builder.ts`, `gate.ts`, `workflow.ts`. Clean up all imports in `executor.ts`, `assign-executor.ts`, `scheduler.ts`, `escalation.ts` that reference these files.

3. **Delete gate test files** -- Remove all 7 gate test files (2,803 lines) plus `workflow.test.ts` (334 lines) and `gate-to-dag.test.ts` (257 lines).

4. **Remove barrel re-exports** -- Clean `schemas/index.ts` and `dispatch/index.ts`.

5. **Remove lazy migration + batch migration** -- Remove migration blocks from `task-store.ts`, delete `migration/gate-to-dag.ts`, delete `packaging/migrations/002-gate-to-dag-batch.ts`, update `setup.ts`.

6. **Clean unused imports in scheduler.ts** -- Remove 18+ unused imports.

7. **Remove unused MCP output schemas** -- Delete 13 output schema definitions from `mcp/tools.ts`.

8. **Remove deprecated type aliases + commented code + notifier param** -- Clean `executor.ts`, `dispatch/index.ts`, `event.ts`, `promotion.ts`, `dag-transition-handler.ts`, `aof-service.ts`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Detecting unused imports | Manual grep | `tsc --noEmit` after deletion | TypeScript compiler catches all dangling references |
| Verifying no runtime breakage | Manual testing | `vitest` full suite | Existing test coverage validates all paths |
| Finding remaining gate references | Manual search | `grep -r` for gate symbols | Success criteria #2 requires zero hits |

**Key insight:** This is purely mechanical deletion. The TypeScript compiler and existing test suite are the primary validation tools. No new tooling needed.

## Common Pitfalls

### Pitfall 1: Packaging Migration Chain Dependency
**What goes wrong:** Deleting `migration/gate-to-dag.ts` breaks `002-gate-to-dag-batch.ts` which is registered in the installer migration chain.
**Why it happens:** The batch migration imports `migrateGateToDAG` from the lazy migration module.
**How to avoid:** Remove both `migration/gate-to-dag.ts` AND `packaging/migrations/002-gate-to-dag-batch.ts` together. Update `setup.ts` to remove `migration002` from the array. Verify `packaging/__tests__/upgrade-scenarios.test.ts` still passes (it also imports `migration002`).
**Warning signs:** `tsc --noEmit` error pointing to 002-gate-to-dag-batch.ts.

### Pitfall 2: Schema Types Embedded in Production Schemas
**What goes wrong:** Deleting `gate.ts` breaks `task.ts`; deleting `workflow.ts` breaks `project.ts`.
**Why it happens:** `TaskFrontmatter` uses `GateHistoryEntry`, `ReviewContext`, `TestSpec` from gate.ts. `ProjectManifest` uses `WorkflowConfig` from workflow.ts.
**How to avoid:** Inline the required type definitions into the consuming files before deleting the deprecated modules.
**Warning signs:** Immediate `tsc --noEmit` failures on task.ts and project.ts.

### Pitfall 3: Removing Gate Context from TaskContext Interface
**What goes wrong:** The `TaskContext` interface in `executor.ts` has a `gateContext?: GateContext` field (line 32). Removing this field is safe IF no code reads it. But if any downstream consumer (OpenClaw adapter, test files) checks `context.gateContext`, removing it could cause test failures.
**How to avoid:** Remove the field and the import. The type is optional, so removing it won't break callers that set it -- they'll just get a TypeScript error if they try. Run `tsc --noEmit` and fix any cascading errors.
**Warning signs:** Test failures in OpenClaw or integration tests.

### Pitfall 4: Escalation.ts Partial Removal
**What goes wrong:** `escalation.ts` contains BOTH gate timeout functions (to remove) and DAG hop timeout functions (to keep). Accidentally deleting the whole file removes production functionality.
**Why it happens:** The file mixes legacy and current code.
**How to avoid:** Remove only `escalateGateTimeout` (lines 51-167) and `checkGateTimeouts` (lines 169-229). Keep `checkHopTimeouts` and its helpers. Remove the `WorkflowConfig` import. Keep the DAG-related imports.

### Pitfall 5: task.ts superRefine Mutual Exclusivity Check
**What goes wrong:** `TaskFrontmatter` has a `.superRefine()` (lines 126-134) that validates `gate` and `workflow` are mutually exclusive. After removing all gate code, the `gate` field and this validation may no longer be needed.
**How to avoid:** The `gate` field in `TaskFrontmatter` (via `GateState`) is defined in `task.ts` itself (not imported from gate.ts). Consider whether to remove the `gate` field entirely. If removed, also remove the `superRefine` block. If kept for backward compat, leave the `superRefine` in place.
**Recommendation:** Keep the `gate` optional field and `superRefine` for now -- existing task files might have it. This is a schema concern, not dead code.

### Pitfall 6: The notifier Removal Cascade
**What goes wrong:** Removing the deprecated `notifier` param from `AOFServiceDependencies` could break test files that pass it.
**How to avoid:** Grep for `notifier` in test files. The aof-service.test.ts imports `MockNotificationAdapter` -- verify it's not passed to `new AOFService()`. Based on research, no callers pass notifier to AOFService directly (they use `engine` now), but test files for ProtocolRouter do use notifier directly.
**Warning signs:** Test compilation errors.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^3.0.0 |
| Config file | `vitest.config.ts` |
| Quick run command | `./scripts/test-lock.sh run` |
| Full suite command | `./scripts/test-lock.sh run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DEAD-01 | Gate source files removed, no compile errors | smoke | `npx tsc --noEmit` | N/A (compile check) |
| DEAD-02 | Gate test files removed | smoke | `ls src/dispatch/__tests__/gate-*.test.ts 2>/dev/null; echo $?` | N/A (file absence check) |
| DEAD-03 | No gate re-exports in barrels | smoke | `grep -c 'gate' src/schemas/index.ts src/dispatch/index.ts` | N/A (grep check) |
| DEAD-04 | No lazy migration in task-store | unit | `./scripts/test-lock.sh run -- --run src/store/__tests__/` | Existing tests cover task-store |
| DEAD-05 | No unused imports in scheduler.ts | smoke | `npx tsc --noEmit` | N/A (compile check) |
| DEAD-06 | Unused MCP schemas removed | smoke | `npx tsc --noEmit` | N/A (compile check) |
| DEAD-07 | No deprecated type aliases | smoke | `grep -c 'DispatchExecutor\|ExecutorResult\|MockExecutor' src/dispatch/executor.ts` | N/A (grep check) |
| DEAD-08 | No commented-out code in event.ts, promotion.ts | smoke | Manual inspection | N/A |
| DEAD-09 | No deprecated notifier param | smoke | `grep -c '@deprecated.*notifier' src/service/aof-service.ts` | N/A |

### Sampling Rate
- **Per task commit:** `npx tsc --noEmit && ./scripts/test-lock.sh run`
- **Per wave merge:** Full vitest suite
- **Phase gate:** `tsc --noEmit` zero errors + `vitest` full suite green + `grep -r` zero gate symbol hits

### Wave 0 Gaps
None -- existing test infrastructure covers all phase requirements. No new tests need to be written. This phase only deletes code and tests.

## Open Questions

1. **Should `gate` field remain in TaskFrontmatter?**
   - What we know: The `gate` field (GateState type) is defined in task.ts itself, not imported from gate.ts. Existing task files on disk may have this field.
   - What's unclear: Whether any real task files still have gate fields after months of lazy migration.
   - Recommendation: Keep the `gate` optional field and `GateState` type in task.ts for now. Removing schema fields that may exist in persisted data is risky. This can be a future cleanup.

2. **Should `gateHistory`, `reviewContext`, `tests` fields remain in TaskFrontmatter?**
   - What we know: These fields use types from gate.ts. After inlining, the fields remain valid but no code writes to them.
   - What's unclear: Whether any persisted task files have data in these fields.
   - Recommendation: Keep the fields (with inlined types) for backward compat. They are optional/defaulted and cause no harm.

3. **Should 002-gate-to-dag-batch migration be preserved?**
   - What we know: It is part of the installer migration chain in setup.ts. Removing it changes the migration sequence.
   - What's unclear: Whether installer upgrades rely on migration ordering/numbering.
   - Recommendation: Remove it. The migration is idempotent and v1.3+ users have already run it. Update upgrade-scenarios.test.ts accordingly.

## Sources

### Primary (HIGH confidence)
- Direct codebase inspection of all files listed in CONTEXT.md and CONCERNS.md
- `src/schemas/task.ts` -- verified gate type imports at line 10, usage at lines 119-121
- `src/schemas/project.ts` -- verified WorkflowConfig import at line 9, usage at line 136
- `src/dispatch/executor.ts` -- verified GateContext import at line 9, field at line 32
- `src/store/task-store.ts` -- verified lazy migration blocks at lines 251-258, 292-298, 343-352
- `src/packaging/migrations/002-gate-to-dag-batch.ts` -- verified dependency on migration/gate-to-dag.ts
- `src/cli/commands/setup.ts` -- verified migration002 registration at line 65

### Secondary (MEDIUM confidence)
- `.planning/codebase/CONCERNS.md` -- codebase analysis from 2026-03-12
- `.planning/codebase/QUALITY.md` -- quality analysis from 2026-03-12

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- this is pure deletion, no new libraries needed
- Architecture: HIGH -- all dependency chains verified by reading actual source files
- Pitfalls: HIGH -- critical pitfalls (schema dependencies, migration chain) discovered and documented with exact line numbers

**Research date:** 2026-03-12
**Valid until:** No expiry -- findings are codebase-specific, not library-version-dependent
