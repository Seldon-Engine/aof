# Phase 16: Deferred Items

## Pre-existing E2E Gate Test Failures

**Found during:** Plan 16-01 overall verification
**Status:** Pre-existing (verified by running tests on code before any changes)

The following E2E test suites have pre-existing failures related to deprecated gate workflow behavior:

- `tests/e2e/suites/12-gate-validation-errors.test.ts` (2 failures)
- `tests/e2e/suites/13-workflow-gate-integration.test.ts` (7 failures)
- Other gate E2E suites (18 failures total across 5 files)

These tests exercise the legacy gate pathway which is being phased out in favor of DAG workflows.
The gate-to-DAG lazy migration (Phase 15-01) converts gate tasks to DAG on load, causing
`handleGateTransition` to see no gate field and throw. This is correct migration behavior.

**Recommendation:** These tests should be updated or removed as part of v1.3 gate deprecation cleanup.
