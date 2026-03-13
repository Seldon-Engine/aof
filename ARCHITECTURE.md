# Architecture: Import Direction Rules

This document defines module layering constraints enforced in the AOF codebase.
Violations are caught by `madge --circular` in CI.

## Module Layering

Lower layers must not import from higher layers:

```
config/        (lowest — env vars, paths, registry)
schemas/       (Zod schemas, no runtime logic)
store/         (task persistence)
projects/      (project resolution, manifest, store factory)
org/           (org chart, linting)
dispatch/      (scheduler, executor, assignment)
context/       (context assembly, manifests)
memory/        (embedding, search, indexing)
mcp/           (MCP protocol server)
cli/           (commander commands — highest layer)
```

## Enforced Rules

1. **config/** must not import from domain modules (`org/`, `dispatch/`, `projects/`, `store/`, `tools/`, `mcp/`, `cli/`, `service/`). Use dependency inversion (pass callbacks/linters as parameters).

2. **mcp/** must not import from `cli/`. Shared logic (e.g., `createProjectStore`) lives in `projects/` or `store/`.

3. **store/** internals (`serializeTask`, `writeFileAtomic`) must not be imported outside `src/store/`. Use `ITaskStore` methods instead.

4. **Barrel files** (`index.ts`) must be pure re-exports with no function definitions.

5. **Sub-modules** must not import from their own barrel (`index.ts`). Import from sibling files or a shared `types.ts` instead.

## Cycle-Breaking Pattern

When two sibling files (e.g., `linter.ts` and `linter-helpers.ts`) share a type, extract it to a `types.ts` in the same directory. Both files import from `types.ts` instead of from each other.

## Examples (Fixed in Phase 39)

- `config/org-chart-config.ts` accepted `lintOrgChart` as an injected parameter instead of importing from `org/linter.ts`
- `createProjectStore` moved from `cli/project-utils.ts` to `projects/store-factory.ts`
- `loadProjectManifest` unified in `projects/manifest.ts` (was duplicated in `dispatch/` and `mcp/`)
- `memory/index.ts` reduced to pure barrel; logic moved to `memory/register.ts`
