# AOF E2E Test Suite

End-to-end tests for AOF (Agentic Ops Fabric) — **library-level E2E tests** that verify core functionality through direct function calls. No HTTP server or OpenClaw gateway process required.

---

## Overview

**Status:** ✅ Production Ready (133 tests, 7.08s runtime)

The E2E test suite verifies AOF's core functionality through library-level integration tests:
- ✅ **TaskStore operations** — CRUD, transitions, lease management, concurrent access
- ✅ **Event logging** — JSONL format, appending, daily rotation, schema validation
- ✅ **Tool execution** — aof_task_update, aof_task_complete, aof_status_report
- ✅ **Dispatch flows** — Task assignment, spawn triggers, completion workflows
- ✅ **View updates** — Mailbox, Kanban board, status filters
- ✅ **Context engineering** — Task context generation, depth controls
- ✅ **Metrics export** — Prometheus format, gauges, labels
- ✅ **Gateway handlers** — HTTP endpoints for /metrics and /aof/status
- ✅ **Concurrent dispatch** — Lease management, race condition prevention
- ✅ **Drift detection** — Org chart vs live agents comparison

---

## Prerequisites

- **Node.js 22+**
- **AOF built:** `npm run build`

**Note:** These are **library-level E2E tests**. They test AOF components directly without requiring a running OpenClaw gateway process or HTTP server. This makes them fast, deterministic, and CI-friendly.

---

## Running Tests

```bash
# Build AOF first (always run this before E2E tests)
npm run build

# Run all E2E tests
npm run test:e2e

# Run E2E tests in watch mode (for development)
npm run test:e2e:watch

# Run E2E tests with verbose output
npm run test:e2e:verbose

# Run specific test suite
npm run test:e2e -- tests/e2e/suites/04-dispatch-flow.test.ts

# Run all tests (unit + E2E)
npm run test:all
```

---

## Test Coverage

| Test Suite | Tests | Description | Runtime |
|------------|-------|-------------|---------|
| **01-taskstore-operations** | 9 | TaskStore CRUD, transitions, lease management | ~493ms |
| **02-event-logging** | 5 | Event appending, JSONL format, schema validation | ~16ms |
| **03-tool-execution** | 14 | Tool calls (update, complete, status report) | ~437ms |
| **04-dispatch-flow** | 15 | Task dispatch, assignment, completion workflows | ~893ms |
| **05-view-updates** | 12 | Mailbox, Kanban board, status filters | ~618ms |
| **06-context-engineering** | 19 | Context generation, depth controls, token limits | ~235ms |
| **07-metrics-export** | 15 | Prometheus metrics, gauges, labels | ~465ms |
| **08-gateway-handlers** | 12 | HTTP endpoints (/metrics, /aof/status) | ~93ms |
| **09-concurrent-dispatch** | 15 | Lease management, race conditions | ~1610ms |
| **10-drift-detection** | 17 | Org chart vs live agents, missing agents | ~2572ms |
| **TOTAL** | **133 tests** | All passing | **~7.08s** |

---

## Test Infrastructure

### Directory Structure

```
tests/e2e/
├── setup/
│   ├── gateway-manager.ts      # Gateway subprocess management (future use)
│   └── cleanup.ts              # Artifact preservation on failure
├── utils/
│   └── test-data.ts            # Test data seeding utilities
├── fixtures/
│   ├── tasks/                  # Sample task files
│   │   └── task-001-simple.md
│   └── org-chart-test.yaml     # Test org chart
├── suites/
│   ├── 01-taskstore-operations.test.ts
│   ├── 02-event-logging.test.ts
│   ├── 03-tool-execution.test.ts
│   ├── 04-dispatch-flow.test.ts
│   ├── 05-view-updates.test.ts
│   ├── 06-context-engineering.test.ts
│   ├── 07-metrics-export.test.ts
│   ├── 08-gateway-handlers.test.ts
│   ├── 09-concurrent-dispatch.test.ts
│   └── 10-drift-detection.test.ts
├── failures/                    # Preserved failure artifacts
│   └── <test-name>-<timestamp>/
│       ├── aof-data/           # Task files, events, org chart
│       ├── openclaw-state/     # Gateway config, sessions (if applicable)
│       └── metadata.json       # Test metadata
├── COMPLETION-SUMMARY.md        # Phase completion summary
├── FINDINGS.md                  # Implementation findings
└── README.md                    # This file
```

### Test Data Management

**Test data directory:** `~/.openclaw-aof-e2e-test/aof-test-data/`

The test suite uses isolated test data directories to avoid polluting production AOF state:

```typescript
import { seedTestData, cleanupTestData } from "../utils/test-data.js";

beforeAll(async () => {
  await seedTestData(TEST_DATA_DIR);
});

afterAll(async () => {
  await cleanupTestData([TEST_DATA_DIR]);
});
```

**Utilities:**
- `seedTestData()` — Create test data directories and seed fixtures
- `createTaskMarkdown()` — Generate task files from templates
- `seedMultipleStatuses()` — Seed tasks across multiple statuses
- `cleanupTestData()` — Remove test data directory

**Auto-cleanup:** State is automatically wiped before and after test runs to ensure deterministic behavior.

---

## Troubleshooting

### Build Errors

**Symptom:** Tests fail with "Cannot find module" errors

**Cause:** AOF not built or stale build artifacts

**Fix:**
```bash
# Clean and rebuild
rm -rf dist/
npm run build
npm run test:e2e
```

---

### State Pollution Between Tests

**Symptom:** Tests pass individually but fail when run together

**Cause:** Incomplete cleanup between tests

**Fix:**
```bash
# Manually clean up test state
rm -rf ~/.openclaw-aof-e2e-test

# Re-run tests
npm run test:e2e
```

**Prevention:** Ensure all tests use proper cleanup hooks:
```typescript
afterEach(async () => {
  await cleanupTestData([TEST_DATA_DIR]);
});
```

---

### Tests Fail Intermittently

**Symptom:** Tests pass locally but fail in CI, or pass/fail randomly

**Causes:**
1. **Timing-sensitive assertions** — Using fixed `setTimeout()` instead of event-driven waits
2. **Resource contention** — Multiple tests competing for same resources
3. **State leakage** — Previous test state affecting current test

**Fix:**
```typescript
// ❌ BAD: Fixed timeout (timing-dependent)
await new Promise(resolve => setTimeout(resolve, 1000));
expect(task.status).toBe("active");

// ✅ GOOD: Event-driven wait (deterministic)
await waitForCondition(
  () => task.status === "active",
  { timeoutMs: 5000, message: "Task should transition to active" }
);
```

**CI Mode:** Tests automatically use 2x timeout multipliers when `CI=true` is set.

---

### Task Files Not Found

**Symptom:** `ENOENT: no such file or directory` errors

**Cause:** Test data not seeded or incorrect paths

**Fix:**
```bash
# Verify test data directory exists
ls -la ~/.openclaw-aof-e2e-test/aof-test-data/tasks/

# Re-seed test data
npm run build
npm run test:e2e
```

**Check:** Ensure `seedTestData()` is called in `beforeAll()` hooks.

---

### Metrics Endpoint Returns Empty

**Symptom:** Metrics endpoint returns empty string or no data

**Cause:** No tasks exist when metrics are queried

**Fix:**
```typescript
// Seed tasks before querying metrics
await seedMultipleStatuses(TEST_DATA_DIR, [
  { status: "inbox", count: 2 },
  { status: "ready", count: 3 },
  { status: "active", count: 1 },
]);

const metrics = await getMetrics();
expect(metrics).toContain("aof_tasks_total");
```

---

### CI Tests Timeout

**Symptom:** Tests timeout in CI but pass locally

**Cause:** CI environments are slower (I/O, CPU, network)

**Fix:** CI mode automatically applies 2x timeout multipliers. No action needed.

**Manual override:**
```bash
# Force CI mode locally to test timeouts
CI=true npm run test:e2e
```

---

## Debugging Tips

### Enable Verbose Logging

```bash
# Run tests with verbose output
npm run test:e2e:verbose
```

This enables:
- Gateway subprocess logs (stdout/stderr)
- HTTP request/response logging
- Detailed test execution traces

---

### Inspect Failure Artifacts

On test failure, artifacts are automatically preserved:

```bash
# List failures
ls tests/e2e/failures/

# Inspect latest failure
cd tests/e2e/failures/<test-name>-<timestamp>/

# View task files
ls aof-data/tasks/*/

# View events
cat aof-data/events/YYYY-MM-DD.jsonl

# View metadata
cat metadata.json
```

**Metadata includes:**
- Test name
- Timestamp
- Node version
- Platform
- CI mode flag

---

### Run Tests in Isolation

```bash
# Run single test suite
npm run test:e2e -- tests/e2e/suites/04-dispatch-flow.test.ts

# Run single test case
npm run test:e2e -- -t "should transition task from ready to active"
```

---

### Debug TypeScript Source

Tests are written in TypeScript and run via vitest:

```bash
# Add breakpoints in test files
debugger; // Add this line

# Run with Node debugger
node --inspect-brk node_modules/.bin/vitest run --config tests/vitest.e2e.config.ts
```

---

### Manual Inspection During Test

Add a pause to inspect state during test execution:

```typescript
it("should do something", async () => {
  await seedTestData(TEST_DATA_DIR);
  
  // PAUSE HERE FOR 60 SECONDS
  await new Promise(resolve => setTimeout(resolve, 60000));
  
  // Now manually inspect:
  // ls ~/.openclaw-aof-e2e-test/aof-test-data/tasks/
});
```

---

## CI/CD Integration

E2E tests run automatically in GitHub Actions on:
- Every push to `main` or `develop` branches
- Every pull request to `main`

**Workflow:** `.github/workflows/e2e-tests.yml`

**CI-specific behavior:**
- **2x timeout multipliers** — Gateway startup, health checks, test timeouts
- **Automatic artifact upload** — Failure artifacts uploaded as GitHub Actions artifacts
- **Retention:** Artifacts kept for 7 days
- **Build verification** — Unit tests run before E2E tests

**CI logs:**
```yaml
steps:
  - name: Build AOF
    run: npm run build
  
  - name: Run unit tests
    run: npm test
  
  - name: Run E2E tests
    run: npm run test:e2e
    env:
      CI: true
  
  - name: Upload test artifacts on failure
    if: failure()
    uses: actions/upload-artifact@v4
    with:
      name: e2e-test-failures-${{ github.sha }}
      path: tests/e2e/failures/
```

**Downloading artifacts:**
1. Go to failed workflow run
2. Click "Artifacts" section
3. Download `e2e-test-failures-<sha>.zip`
4. Extract and inspect `aof-data/` and `metadata.json`

---

## Performance

**Current performance (as of 2026-02-07):**
- **Total execution time:** ~7.08 seconds
- **Total tests:** 133 tests
- **Bottlenecks:**
  - Drift detection: ~2.5s (external command execution)
  - Concurrent dispatch: ~1.6s (race condition testing)
  - Dispatch flow: ~0.9s (multi-step workflows)

**Performance targets:**
- ✅ Full suite execution: < 10 seconds
- ✅ Average test: < 100ms
- ✅ Suite startup: < 1 second

**Optimization strategies:**
- Use in-memory TaskStore where possible
- Parallelize independent test suites (current: sequential)
- Mock expensive operations (file I/O, external commands)

---

## Writing New E2E Tests

### Test Template

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { seedTestData, cleanupTestData } from "../utils/test-data.js";
import { homedir } from "node:os";
import { join } from "node:path";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "aof-test-data");

describe("E2E: Your Test Suite", () => {
  beforeAll(async () => {
    await seedTestData(TEST_DATA_DIR);
  });

  afterAll(async () => {
    await cleanupTestData([TEST_DATA_DIR]);
  });

  it("should do something", async () => {
    // Arrange: Set up test data
    const task = await createTestTask({ status: "inbox" });
    
    // Act: Execute operation
    await taskStore.transitionTask(task.id, "ready");
    
    // Assert: Verify outcome
    const updated = await taskStore.getTask(task.id);
    expect(updated.status).toBe("ready");
  });
});
```

### Best Practices

1. **Test one thing per test** — Keep tests focused on a single behavior
2. **Use descriptive names** — Test names should describe the behavior being verified
3. **Clean state** — Always start from clean state (use `beforeAll`, `afterAll`, `afterEach`)
4. **Deterministic assertions** — Avoid timing-dependent assertions
5. **Fast feedback** — Keep individual tests under 1 second when possible
6. **Meaningful errors** — Use descriptive error messages in assertions

### Anti-Patterns to Avoid

```typescript
// ❌ BAD: Multiple unrelated assertions in one test
it("should do everything", async () => {
  expect(task.status).toBe("active");
  expect(metrics.total).toBe(10);
  expect(events.length).toBe(5);
  // Too much in one test!
});

// ✅ GOOD: One behavior per test
it("should transition task to active", async () => {
  expect(task.status).toBe("active");
});

it("should update metrics", async () => {
  expect(metrics.total).toBe(10);
});
```

### Adding to Coverage Table

When adding new test suites, update the coverage table in this README:

```markdown
| **11-your-new-suite** | X | Your description | ~XXXms |
```

---

## Test Architecture

### Library-Level E2E Tests (Current)

Tests directly import and test AOF components:

```typescript
import { TaskStore } from "../../core/task-store.js";
import { EventLogger } from "../../core/event-logger.js";

const taskStore = new TaskStore(dataDir);
const result = await taskStore.transitionTask("task-001", "active");
expect(result.ok).toBe(true);
```

**Advantages:**
- ✅ **Fast** — No HTTP overhead, no subprocess management
- ✅ **Deterministic** — No network timing issues
- ✅ **Debuggable** — Direct function calls, easy to step through
- ✅ **CI-friendly** — No external dependencies

**Limitations:**
- ⚠️ Does not test OpenClaw plugin integration
- ⚠️ Does not test HTTP gateway endpoints (tested separately in suite 08)

### Future: Full Gateway E2E Tests

**When OpenClaw plugin loading is supported**, gateway-level E2E tests will:
- Start real OpenClaw gateway subprocess
- Load AOF as a plugin
- Test full agent dispatch workflows
- Verify tool calls work end-to-end

Infrastructure already exists in `setup/gateway-manager.ts` (currently unused).

---

## Contributing

When contributing new E2E tests:

1. **Follow existing test structure** — Place tests in `tests/e2e/suites/`
2. **Use test utilities** — Import from `../utils/test-data.js`
3. **Add documentation** — Update this README's coverage table
4. **Ensure determinism** — Run tests 10 times consecutively before merging:
   ```bash
   for i in {1..10}; do npm run test:e2e || exit 1; done
   ```
5. **Check performance** — Keep suite execution time under 10 seconds
6. **Preserve on failure** — Use `preserveFailureArtifacts()` for complex tests

---

## References

- **Design Doc:** `docs/E2E-TEST-HARNESS-DESIGN.md`
- **Task Cards:** `tasks/done/e2e-*.md`
- **AOF Architecture:** `README.md`
- **Vitest Documentation:** https://vitest.dev/
- **AOF Plugin Adapter:** `src/openclaw/adapter.ts` (for gateway integration)

---

## FAQ

### Why are these called "E2E" if they don't test the full system?

These are **library-level E2E tests** — they test AOF end-to-end, but at the library/module level rather than the HTTP/gateway level. They verify that all AOF components work together correctly without requiring external dependencies.

### Why not test against a real OpenClaw gateway?

OpenClaw 2026.2.6 does not currently support loading custom plugins via configuration. Infrastructure for gateway-level testing exists (`gateway-manager.ts`) and will be activated when plugin loading is supported.

### How do I test OpenClaw integration manually?

See `docs/E2E-TEST-HARNESS-DESIGN.md` for manual testing procedures using `openclaw` CLI.

### Can I run tests in parallel?

Currently tests run sequentially (`singleFork: true`) to avoid state pollution. This may be relaxed in the future with better test isolation.

### What if a test fails only in CI?

1. Download failure artifacts from GitHub Actions
2. Check `CI=true` timeout behavior
3. Look for timing-sensitive assertions
4. Test locally with `CI=true npm run test:e2e`

---

**Last Updated:** 2026-02-07  
**Test Count:** 133 tests  
**Status:** ✅ All passing
