# Phase 15: Migration and Documentation - Context

**Gathered:** 2026-03-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Migrate existing gate-format workflows to DAG format and document the entire v1.2 workflow system for users, contributors, and agents. Covers: lazy gate→DAG migration (SAFE-05), user guide (DOCS-01), developer docs (DOCS-02), companion skill (DOCS-03), gate reference cleanup (DOCS-04), and CLI reference update (DOCS-05).

</domain>

<decisions>
## Implementation Decisions

### Migration strategy
- Lazy migration on task load: detect gate format, convert to DAG, write back to disk
- One-time conversion per task — next load sees DAG format natively
- In-flight gate tasks get migrated with position mapping: current gate step maps to equivalent hop status, task continues from where it was
- Gate evaluation code kept with deprecation markers (not removed) — safety net for edge cases, remove in v1.3
- Dual-mode evaluator (Phase 12) remains as fallback during migration period

### User guide documentation
- Replace gate docs entirely: delete workflow-gates.md and custom-gates.md, create new workflow-dags.md
- Tutorial-style approach: conceptual overview → step-by-step "create your first DAG workflow" walkthrough → reference section for all hop options
- Enough detail for a new user to create their first workflow without prior gate knowledge

### Example workflows
- Rewrite all 3 existing examples (simple-review.yaml, swe-sdlc.yaml, sales-pipeline.yaml) from gate format to DAG format
- Add 1-2 new examples showing DAG-specific features (conditional branching, parallel hops)
- Examples become canonical "how to write a workflow" references

### Developer documentation
- Replace workflow-gates-design.md with DAG design doc
- Cover: schema model, evaluator pipeline, condition DSL, extension points (adding operators, custom hop types)
- Enough depth for a contributor to extend the evaluator or add new condition operators

### Companion skill
- Single SKILL.md file at project root — agents read it when working with AOF
- Teach: how to use --workflow flag for templates, how to compose ad-hoc DAGs in YAML frontmatter, common patterns (linear, review-cycle, parallel-fan-out), pitfalls to avoid
- Include brief "if you encounter gate-format" section explaining auto-migration and that agents should use DAG format for new tasks

### Gate cleanup
- Full cleanup in documentation: all gate references replaced with DAG equivalents across ~14 doc files
- Source code: keep gate evaluation code with deprecation markers, don't remove
- Update migration.md with gate→DAG migration section for users upgrading from v1.1
- CLI reference: ensure auto-gen picks up --workflow flag from Phase 14, no new CLI commands needed
- Document existing CLI commands only (no new bd workflow subcommands)

### Claude's Discretion
- Exact DAG example scenarios beyond the 3 rewrites
- Companion skill example count and complexity progression
- Deprecation marker format in source code
- migration.md section length and detail level

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `docs/guide/workflow-gates.md`: Existing structure to replace with DAG equivalent
- `docs/guide/custom-gates.md`: Gate customization docs to replace
- `docs/dev/workflow-gates-design.md`: Design doc to replace with DAG architecture
- `docs/examples/*.yaml`: 3 gate-format examples to rewrite (simple-review, swe-sdlc, sales-pipeline)
- `docs/guide/migration.md`: Existing migration guide to extend with gate→DAG section
- `docs/guide/agent-tools.md`: Existing agent tooling docs (companion skill supplements this)
- Pre-commit doc hook (Phase 9): Prevents doc drift — new docs must pass 4 checks

### Established Patterns
- Audience-segmented docs: `docs/guide/` for users, `docs/dev/` for contributors
- Auto-generated CLI reference from Commander.js command tree
- YAML-based configuration (org chart, project manifest, workflow definitions)
- Zod schemas as source of truth with TypeScript types derived

### Integration Points
- `src/store/task-store.ts`: Task load path where migration hook would intercept gate-format frontmatter
- `src/schemas/workflow-dag.ts`: DAG schema (WorkflowDefinition, TaskWorkflow, validateDAG, initializeWorkflowState)
- `src/schemas/task.ts`: TaskFrontmatter schema where gate vs DAG format is detected
- `src/dispatch/scheduler.ts`: Contains both gate and DAG dispatch paths
- Gate-related source files (~15 files): Keep with deprecation markers

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 15-migration-and-documentation*
*Context gathered: 2026-03-03*
