---
phase: 17-migration-foundation-framework-hardening
verified: 2026-03-03T20:00:00Z
status: passed
score: 16/16 must-haves verified
re_verification: false
---

# Phase 17: Migration Foundation & Framework Hardening Verification Report

**Phase Goal:** Users upgrading from pre-v1.2 or v1.2 installations get their config and task data migrated automatically, atomically, and safely -- with snapshot-based rollback on any failure
**Verified:** 2026-03-03
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| #   | Truth                                                                                      | Status     | Evidence                                                                 |
|-----|--------------------------------------------------------------------------------------------|------------|--------------------------------------------------------------------------|
| 1   | Pre-migration snapshot created before any migration runs                                   | VERIFIED   | setup.ts:278 `createSnapshot(dataDir)` before `runMigrations()`          |
| 2   | Snapshot is automatically restored and error displayed on migration failure                | VERIFIED   | setup.ts:301 `restoreSnapshot(dataDir, snapshotPath)` in catch block     |
| 3   | Only last 2 snapshots retained (pruned after create)                                      | VERIFIED   | setup.ts:282 `pruneSnapshots(dataDir, 2)` after snapshot creation         |
| 4   | In-progress marker detects interrupted migrations with warning on next run                | VERIFIED   | setup.ts:267-275 marker check + `warn()` + writeFileAtomic write          |
| 5   | schemaVersion accepts both 1 and 2 across all schemas                                    | VERIFIED   | config.ts:66, task.ts:93, org-chart.ts:313 all use `z.union([z.literal(1), z.literal(2)])` |
| 6   | defaultWorkflow is a valid optional field on ProjectManifest                              | VERIFIED   | project.ts:140 `defaultWorkflow: z.string().optional()`                  |
| 7   | Migration 001 adds defaultWorkflow pointing to first workflowTemplate, preserving comments| VERIFIED   | 001-default-workflow-template.ts uses `parseDocument()` + `setIn()`; test passes |
| 8   | Migration 001 skips projects with no workflowTemplates                                    | VERIFIED   | 001-default-workflow-template.ts:62 guards on templateMap presence; test passes |
| 9   | Migration 001 skips projects that already have defaultWorkflow (idempotent)               | VERIFIED   | 001-default-workflow-template.ts:58 `if (doc.getIn(["defaultWorkflow"])) continue`; test passes |
| 10  | Migration 002 batch-converts gate tasks across all 8 status dirs in all projects          | VERIFIED   | 002-gate-to-dag-batch.ts:21-30 STATUS_DIRS, nested loop; test passes     |
| 11  | Migration 002 skips tasks that already have workflow field (idempotent)                   | VERIFIED   | 002-gate-to-dag-batch.ts:90 `if (!fm.gate \|\| fm.workflow) continue`; test passes |
| 12  | Migration 003 writes channel.json with version, channel, and timestamp                   | VERIFIED   | 003-version-metadata.ts writes `{ version, channel: "stable", installedAt/upgradedAt }` |
| 13  | Migration 003 handles fresh installs (installedAt) and upgrades (upgradedAt, previousVersion) | VERIFIED | 003-version-metadata.ts:54-68 branches for existing vs fresh; tests pass |
| 14  | All three migrations wired into getAllMigrations() and run during upgrade                 | VERIFIED   | setup.ts:18-20 imports, setup.ts:62-64 `return [migration001, migration002, migration003]` |
| 15  | getByPrefix() applies gate-to-DAG migration consistently with get() and list()           | VERIFIED   | task-store.ts:287-294 identical pattern to get(); `migrateGateToDAG` called |
| 16  | Installer backup scope includes Projects/ directory tree                                  | VERIFIED   | install.sh lines 284, 309, 342 all include `Projects` in backup loops    |

**Score:** 16/16 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/packaging/snapshot.ts` | createSnapshot, restoreSnapshot, pruneSnapshots | VERIFIED | 117 lines, all 3 functions exported, substantive implementations |
| `src/packaging/__tests__/snapshot.test.ts` | Tests for all three snapshot functions (min 60 lines) | VERIFIED | 182 lines, 10 tests, all pass |
| `src/cli/commands/setup.ts` | Snapshot-wrapped migration runner with marker file | VERIFIED | Contains `migration-in-progress`, `createSnapshot`, `restoreSnapshot`, `pruneSnapshots` |
| `src/schemas/config.ts` | schemaVersion relaxed to z.union | VERIFIED | Line 66: `z.union([z.literal(1), z.literal(2)])` |
| `src/schemas/task.ts` | schemaVersion relaxed to z.union | VERIFIED | Line 93: `z.union([z.literal(1), z.literal(2)])` |
| `src/schemas/org-chart.ts` | schemaVersion relaxed to z.union | VERIFIED | Line 313: `z.union([z.literal(1), z.literal(2)])` |
| `src/schemas/project.ts` | defaultWorkflow optional field | VERIFIED | Line 140: `defaultWorkflow: z.string().optional()` |
| `src/packaging/migrations/001-default-workflow-template.ts` | Migration adding defaultWorkflow | VERIFIED | Exports `migration001`, id `"001-default-workflow-template"`, version `"1.3.0"` |
| `src/packaging/migrations/002-gate-to-dag-batch.ts` | Migration batch-converting gate tasks | VERIFIED | Exports `migration002`, imports `migrateGateToDAG`, walks all 8 STATUS_DIRS |
| `src/packaging/migrations/003-version-metadata.ts` | Migration writing channel.json | VERIFIED | Exports `migration003`, handles fresh/upgrade/idempotent paths |
| `src/packaging/__tests__/migrations-impl.test.ts` | Tests for all three migrations (min 100 lines) | VERIFIED | 443 lines, 10 tests, all pass |
| `src/store/task-store.ts` | getByPrefix with gate-to-DAG lazy migration | VERIFIED | Lines 287-294 contain the exact migration block |
| `scripts/install.sh` | Backup scope including Projects | VERIFIED | All 3 loops (lines 284, 309, 342) include `Projects` |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/cli/commands/setup.ts` | `src/packaging/snapshot.ts` | `import createSnapshot, restoreSnapshot, pruneSnapshots` | WIRED | setup.ts line 17 imports all three; all called in upgrade block |
| `src/cli/commands/setup.ts` | `src/packaging/migrations.ts` | `runMigrations call wrapped in snapshot try/catch` | WIRED | setup.ts line 289 `runMigrations()` inside try/catch with snapshot restore on catch |
| `src/packaging/migrations/001-default-workflow-template.ts` | `project.yaml files` | `parseDocument + setIn + writeFileAtomic` | WIRED | Line 55 `parseDocument(raw)`, line 70 `doc.setIn(...)`, line 71 `writeFileAtomic(...)` |
| `src/packaging/migrations/002-gate-to-dag-batch.ts` | `src/migration/gate-to-dag.ts` | `import migrateGateToDAG` | WIRED | Line 17 `import { migrateGateToDAG } from "../../migration/gate-to-dag.js"` |
| `src/cli/commands/setup.ts` | `src/packaging/migrations/` | `import and return from getAllMigrations()` | WIRED | Lines 18-20 import migration001/002/003; lines 62-64 `getAllMigrations()` returns all three |
| `src/store/task-store.ts getByPrefix()` | `src/migration/gate-to-dag.ts` | `migrateGateToDAG call` | WIRED | task-store.ts line 290 `migrateGateToDAG(task, workflowConfig)` in getByPrefix |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| MIGR-01 | 17-01 | Atomic writes (write-file-atomic) for all file mutations | SATISFIED | `writeFileAtomic` used in snapshot.ts (marker), 001-default-workflow-template.ts, 002-gate-to-dag-batch.ts, 003-version-metadata.ts |
| MIGR-02 | 17-01 | In-progress state tracking for interrupted migrations | SATISFIED | setup.ts:267-286 marker file written with writeFileAtomic, checked on next run |
| MIGR-03 | 17-01 | Pre-migration snapshot captures full data dir, restores on failure | SATISFIED | setup.ts:278-304 createSnapshot before runMigrations, restoreSnapshot in catch |
| MIGR-04 | 17-02 | YAML config modifications preserve user comments (parseDocument API) | SATISFIED | 001-default-workflow-template.ts uses `parseDocument()` + `doc.setIn()`; test verifies comments preserved |
| MIGR-05 | 17-01 | schemaVersion relaxed to support version 2 | SATISFIED | config.ts:66, task.ts:93, org-chart.ts:313 all use z.union |
| CONF-01 | 17-02 | Migration 001 adds defaultWorkflow to project.yaml | SATISFIED | migration001 implemented and tested; getAllMigrations() includes it |
| CONF-02 | 17-02 | Migration 002 batch-converts gate tasks to DAG | SATISFIED | migration002 walks all 8 STATUS_DIRS across all projects, calls migrateGateToDAG |
| CONF-03 | 17-02 | Migration 003 writes version metadata to .aof/channel.json | SATISFIED | migration003 writes channel.json for fresh and upgrade paths |
| CONF-04 | 17-01, 17-02 | Migrations wired into getAllMigrations() and run during installer upgrade | SATISFIED | setup.ts getAllMigrations() returns [migration001, migration002, migration003]; runMigrations() called with these |
| BUGF-01 | 17-03 | getByPrefix() runs gate-to-DAG migration (parity with get() and list()) | SATISFIED | task-store.ts:287-294 identical migration block in getByPrefix() |
| BUGF-02 | 17-03 | Installer backup scope includes Projects/ directory tree | SATISFIED | install.sh lines 284, 309, 342 all include Projects in loop |

All 11 requirement IDs from phase plans are accounted for. No orphaned requirements found.

---

### Anti-Patterns Found

No anti-patterns detected across modified files. No TODO/FIXME/HACK markers. No stub implementations (empty returns, placeholder comments). All handlers and functions contain substantive logic.

---

### Human Verification Required

#### 1. Snapshot restore on real migration failure (end-to-end)

**Test:** Run `bd setup --upgrade` with a deliberately broken migration (e.g., inject a throw) and verify data is restored to pre-migration state.
**Expected:** Data directory matches pre-migration snapshot after failure; "Data restored from pre-migration snapshot" message appears.
**Why human:** Requires a live install and a controlled failure injection; cannot verify the full I/O chain programmatically without running the actual installer.

#### 2. Migration 001 first-template-key ordering in real YAML

**Test:** Create a project.yaml with multiple workflowTemplates in a specific order. Run `bd setup --upgrade`. Verify `defaultWorkflow` is set to the first key as written in the file.
**Expected:** YAML map key ordering is respected (parseDocument preserves insertion order).
**Why human:** YAML map key ordering behavior in `yaml` library's AST under various edge cases (anchors, merge keys) is environment-dependent.

#### 3. Install.sh backup behavior with real upgrade tarball

**Test:** Run installer upgrade on a system with Projects/ content. Verify Projects/ is preserved in backup and survives extraction failure.
**Expected:** Projects/ directory tree intact after failed upgrade roll-back.
**Why human:** Requires full shell environment with bash, tar, and a real data directory.

---

### Gaps Summary

None. All 16 observable truths verified, all 13 artifacts pass all three levels (exists, substantive, wired), all 6 key links confirmed wired, all 11 requirement IDs satisfied. TypeScript compiles without errors. 20 tests pass (10 snapshot, 10 migration implementations).

---

_Verified: 2026-03-03_
_Verifier: Claude (gsd-verifier)_
