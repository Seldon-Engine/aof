---
phase: 14-templates-ad-hoc-api-and-artifacts
verified: 2026-03-03T13:50:00Z
status: passed
score: 9/9 must-haves verified
re_verification: false
---

# Phase 14: Templates, Ad-Hoc API & Artifacts Verification Report

**Phase Goal:** Templates, Ad-Hoc API & Artifacts — Enable workflow template schema, ad-hoc workflow creation with auto-validation, CLI template resolution, and per-hop artifact directories.
**Verified:** 2026-03-03T13:50:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Workflow templates can be defined in the project manifest as named WorkflowDefinition objects | VERIFIED | `ProjectManifest.workflowTemplates: z.record(TemplateNameKey, WorkflowDefinition).optional()` at line 138 of `src/schemas/project.ts` |
| 2 | Templates are validated via validateDAG() at manifest load time (lint) | VERIFIED | `validateWorkflowTemplates()` calls `validateDAG(definition)` for each entry in `manifest.workflowTemplates` in `src/projects/lint.ts` lines 101-118 |
| 3 | Project lint reports invalid workflow templates with template name | VERIFIED | Error format `Workflow template "${name}": ${error}` in lint.ts line 113; 20 lint tests pass |
| 4 | TaskWorkflow has an optional templateName field for traceability | VERIFIED | `templateName: z.string().optional()` on TaskWorkflow at line 243 of `src/schemas/workflow-dag.ts` |
| 5 | Each dispatched hop gets a per-hop artifact directory created before agent spawn | VERIFIED | `mkdir(hopWorkDir, { recursive: true })` at lines 300-301 of `src/dispatch/dag-transition-handler.ts`, called BEFORE `buildHopContext`; 16 dispatch tests pass including ordering test |
| 6 | Downstream hops receive artifact paths for all completed predecessor hops in their context | VERIFIED | `artifactPaths: Record<string, string>` on `HopContext` interface, populated for completed predecessors in `buildHopContext()` (lines 78-86 of `dag-context-builder.ts`); 15 context-builder tests pass |
| 7 | Artifact directories follow the convention tasks/<id>/work/<hop-id>/ | VERIFIED | `join(dirname(task.path), "work", predId)` in dag-context-builder.ts line 85; `join(dirname(task.path!), "work", hopId)` in dag-transition-handler.ts line 300 |
| 8 | An agent can compose an ad-hoc workflow DAG inline and it is auto-validated and auto-initialized at creation | VERIFIED | `store.create()` calls `validateDAG()` then `initializeWorkflowState()` in task-store.ts lines 169-173; 6 store workflow tests pass |
| 9 | CLI --workflow flag resolves a template name to a full WorkflowDefinition snapshot on the task | VERIFIED | `--workflow <template>` option in task.ts line 26; `resolveWorkflowTemplate()` in `task-create-workflow.ts` loads manifest, looks up template, validates, returns definition+templateName; 5 CLI workflow tests pass |

**Score:** 9/9 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/schemas/project.ts` | workflowTemplates field on ProjectManifest | VERIFIED | Line 138: `workflowTemplates: z.record(TemplateNameKey, WorkflowDefinition).optional()`. Imports WorkflowDefinition from workflow-dag.ts. |
| `src/schemas/workflow-dag.ts` | templateName field on TaskWorkflow | VERIFIED | Line 243: `templateName: z.string().optional()` with JSDoc comment. |
| `src/projects/lint.ts` | Workflow template DAG validation check | VERIFIED | `validateWorkflowTemplates()` function (lines 101-118) imported `validateDAG`, integrated into `lintProject()` pipeline at line 80. |
| `src/dispatch/dag-transition-handler.ts` | mkdir -p for hop artifact directory before spawn | VERIFIED | Lines 299-302: `const hopWorkDir = join(...)`, `await mkdir(hopWorkDir, { recursive: true })`, called before `buildHopContext`. |
| `src/dispatch/dag-context-builder.ts` | artifactPaths field in HopContext | VERIFIED | Line 39: `artifactPaths: Record<string, string>` on interface; populated at lines 78-86; returned at line 94. |
| `src/store/task-store.ts` | Workflow handling in task creation: auto-validate + auto-init | VERIFIED | Lines 167-179: validateDAG + initializeWorkflowState on opts.workflow.definition before TaskFrontmatter.parse(). |
| `src/cli/commands/task.ts` | --workflow CLI flag with template resolution | VERIFIED | Line 26: `.option('-w, --workflow <template>', 'Workflow template name from project manifest')`; lines 34-38 resolve via resolveWorkflowTemplate(). |
| `src/cli/commands/task-create-workflow.ts` | resolveWorkflowTemplate helper module | VERIFIED | New file: loads project.yaml, parses ProjectManifest, looks up workflowTemplates[name], validates via validateDAG, returns {definition, templateName}. |
| `src/store/interfaces.ts` | workflow parameter on ITaskStore.create() opts | VERIFIED | Lines 44-47: `workflow?: { definition: WorkflowDefinition; templateName?: string }` with JSDoc. |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/schemas/project.ts` | `src/schemas/workflow-dag.ts` | `import.*WorkflowDefinition.*workflow-dag` | WIRED | Line 10: `import { WorkflowDefinition } from "./workflow-dag.js"` — exact pattern match |
| `src/dispatch/dag-transition-handler.ts` | filesystem | `mkdir(hopWorkDir, { recursive: true })` before spawnSession | WIRED | Lines 300-301: mkdir called with recursive:true, then buildHopContext at line 305, then spawnSession at line 320 — ordering confirmed |
| `src/dispatch/dag-context-builder.ts` | HopContext | `artifactPaths` record in returned object | WIRED | artifactPaths built at lines 78-86, returned as part of HopContext object at line 94 |
| `src/cli/commands/task.ts` | `src/schemas/workflow-dag.ts` | Template resolution via workflowTemplates + validateDAG | WIRED | task-create-workflow.ts (imported dynamically) contains both `manifest.workflowTemplates` lookup and `validateDAG()` call; resolveWorkflowTemplate returns to task.ts which passes to store.create() |
| `src/store/task-store.ts` | `src/schemas/workflow-dag.ts` | `validateDAG` + `initializeWorkflowState` on opts.workflow.definition | WIRED | Line 19 imports both; line 169 calls validateDAG; line 173 calls initializeWorkflowState — both in same if-block |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| TMPL-01 | 14-01 | Workflow templates can be defined in project configuration | SATISFIED | `workflowTemplates: z.record(TemplateNameKey, WorkflowDefinition).optional()` on ProjectManifest; 29 project schema tests pass |
| TMPL-02 | 14-03 | Agent can compose an ad-hoc workflow DAG at task creation time | SATISFIED | `store.create({ workflow: { definition } })` auto-validates and auto-initializes; 6 store workflow tests pass |
| TMPL-03 | 14-01, 14-03 | Both templates and ad-hoc workflows resolve to the same runtime WorkflowDAG schema | SATISFIED | Both paths produce identical `TaskWorkflow` (definition + state + optional templateName); store.create() handles both; round-trip test in task-store-workflow.test.ts |
| ARTF-01 | 14-02 | Each hop writes output to a per-hop subdirectory in the task work directory | SATISFIED | `mkdir(join(dirname(task.path!), 'work', hopId), { recursive: true })` in dispatchDAGHop before spawn |
| ARTF-02 | 14-02 | Downstream hops can read upstream hop outputs via documented directory conventions | SATISFIED | `artifactPaths` in HopContext maps completed predecessor hop IDs to `join(dirname(task.path), 'work', predId)` paths |

All 5 requirement IDs (TMPL-01, TMPL-02, TMPL-03, ARTF-01, ARTF-02) accounted for. No orphaned requirements found.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/schemas/workflow-dag.ts` | 122, 124 | "Schema placeholder — logic in Phase 13" | Info | Pre-existing from prior phase (canReject, rejectionStrategy fields). Not introduced by Phase 14. No impact. |

No blockers or warnings found in Phase 14 modified files.

---

### Human Verification Required

None. All observable behaviors are verifiable programmatically:
- Schema shape: verified via direct code inspection
- Test coverage: all relevant test suites pass (240 test files, 2765 tests)
- TypeScript: `tsc --noEmit` clean
- Key links: all wiring confirmed via grep and code inspection

---

### Test Suite Summary

| Test File | Tests | Status |
|-----------|-------|--------|
| `src/schemas/__tests__/project.test.ts` | 29 | PASSED |
| `src/projects/__tests__/lint.test.ts` | 20 | PASSED |
| `src/dispatch/__tests__/dag-context-builder.test.ts` | 15 | PASSED |
| `src/dispatch/__tests__/dag-transition-handler.test.ts` | 16 | PASSED |
| `src/store/__tests__/task-store-workflow.test.ts` | 6 | PASSED |
| `src/cli/commands/__tests__/task-create-workflow.test.ts` | 5 | PASSED |
| **Full suite** | **2765** | **PASSED** |

TypeScript: `tsc --noEmit` — no errors.

---

## Overall Assessment

Phase 14 goal is fully achieved. All 9 observable truths are verified, all 5 required artifacts exist and are substantive and wired, all 5 key links are confirmed, and all 5 requirement IDs are satisfied. The full test suite passes with no regressions (2765 tests across 240 files).

**Design quality observations:**
- `TemplateNameKey` is exported and reusable (future phases can reference it)
- Template resolution is correctly in the CLI layer, not the store (clean separation)
- Belt-and-suspenders `validateDAG` in both `resolveWorkflowTemplate` and `store.create()` — defense-in-depth
- `task.path` guard in `buildHopContext` throws early with a descriptive error, preventing silent path corruption
- mkdir called before buildHopContext and spawnSession — correct ordering for fail-fast directory creation

---

_Verified: 2026-03-03T13:50:00Z_
_Verifier: Claude (gsd-verifier)_
