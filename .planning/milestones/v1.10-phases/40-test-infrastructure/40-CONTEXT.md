# Phase 40: Test Infrastructure - Context

**Gathered:** 2026-03-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Standardize test utilities across the codebase: shared harness for setup/teardown, typed mock factories for store/logger, expanded coverage config tracking all source modules, and temp dir cleanup fixes. No new test coverage — this phase improves the testing infrastructure itself.

</domain>

<decisions>
## Implementation Decisions

### Harness Scope & API
- Full project setup: `createTestHarness()` returns `{ store, logger, tmpDir, cleanup, readEvents, getMetric, readTasks }` — everything needed for a typical AOF test
- `withTestProject(async ({ store, logger, ... }) => { ... })` wraps harness with auto-cleanup via `afterEach` for simple tests
- `createTestHarness()` available for complex tests needing manual control over cleanup timing
- Fold existing `src/testing/` utilities (event-log-reader, metrics-reader, task-reader) into the harness return value — one-stop shop
- All utilities re-exported from `src/testing/index.ts`

### Mock Factory Design
- `createMockStore()` returns a full `ITaskStore` implementation with all methods as `vi.fn()` stubs — zero `as any` casts needed
- `createMockLogger()` returns a full `EventLogger` implementation with stubs
- Tests override specific methods as needed: `store.get.mockResolvedValue(task)`

### Claude's Discretion
- Whether `createMockStore()` supports pre-seeded data (e.g., `{ tasks: [task1] }`) — decide based on how common the pattern is
- Whether `createMockLogger()` captures calls for assertion — decide based on how tests currently assert on logging
- Whether harness supports optional project fixtures (`project.yaml`, `org-chart.yaml`) — decide based on how many tests need them

### Coverage Strategy
- Expand coverage from 6 files to all `src/` modules (excluding tests, schemas, testing utilities)
- Soft thresholds: warn on coverage regression but don't fail CI
- Coverage report generated in CI only (not on every local test run) — avoids ~30% slowdown
- Keep `npm test` fast; add `npm run test:coverage` for CI

### Adoption Approach
- Migrate ALL test files with duplicated setup/teardown (not just the minimum 10)
- Fix the 8 test files with missing temp dir cleanup as part of harness adoption (harness handles cleanup automatically)
- Promote existing `src/testing/` utilities by integrating into harness return value

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/testing/index.ts`: Barrel exporting event-log-reader, metrics-reader, task-reader — will be extended with harness and mock factories
- `src/testing/event-log-reader.ts`: `readEventLogEntries()`, `findEvents()`, `expectEvent()` — integrate into harness
- `src/testing/metrics-reader.ts`: `getMetricValue()` — integrate into harness
- `src/testing/task-reader.ts`: `readTasksInDir()` — integrate into harness

### Established Patterns
- Vitest with co-located `__tests__/` directories
- `mkdtemp()` + `FilesystemTaskStore(tmpDir)` is the most common setup pattern
- `afterAll(() => rm(tmpDir, { recursive: true }))` for cleanup (when it exists)
- Mock stores built as partial objects with `as any` casts (~15 test files)
- Mock loggers built as `{ logDispatch: vi.fn(), ... } as any`

### Integration Points
- `ITaskStore` interface at `src/store/interfaces.ts` — mock factory must implement all methods including new `save()`/`saveToPath()`
- `EventLogger` at `src/events/logger.ts` — mock factory must match its interface
- `vitest.config.ts` — coverage config lives here, needs `include` expanded
- `package.json` — may need `test:coverage` script

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

*Phase: 40-test-infrastructure*
*Context gathered: 2026-03-13*
