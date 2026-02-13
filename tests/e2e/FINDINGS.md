# E2E Test Implementation Findings

**Date:** 2026-02-07  
**Phase:** E2E Phase 1 - Foundation Setup  
**Status:** BLOCKED — Design assumptions invalid

## Critical Discovery

The E2E test harness design document assumes OpenClaw 2026.2.6 supports loading custom plugins via config:

```json
{
  "plugins": [
    {
      "name": "aof",
      "path": "/path/to/aof/dist/index.js",
      "options": { ... }
    }
  ]
}
```

**This plugin loading mechanism does not exist in OpenClaw 2026.2.6.**

### Evidence

1. **OpenClaw config validation rejects custom plugin paths:**
   ```
   - plugins: Invalid input: expected object, received array
   ```

2. **Actual OpenClaw plugin format (built-in only):**
   ```json
   {
     "plugins": {
       "enabled": true,
       "allow": ["diagnostics-otel", "matrix", ...],
       "entries": {
         "matrix": { "enabled": true },
         ...
       }
     }
   }
   ```

3. **OpenClaw 2026.2.6 only supports built-in plugins** that are enabled/disabled, not dynamically loaded from external files.

## Impact on E2E Tests

**All plugin-based E2E test scenarios are blocked:**
- ✗ Plugin registration test (can't load AOF as plugin)
- ✗ Tool execution via gateway (no plugin = no tools registered)
- ✗ Service registration (aof-scheduler can't be loaded)
- ✗ Gateway endpoints (/metrics, /aof/status can't be registered)
- ✗ Full dispatch workflows (requires plugin integration)

## Possible Solutions

### Option 1: Standalone E2E Tests (Recommended for Phase 1)
Test AOF as a **library** without OpenClaw gateway integration:
- ✅ TaskStore operations (create, update, transition, lease management)
- ✅ Event logging (JSONL append, daily rotation)
- ✅ Metrics collection (Prometheus format)
- ✅ Org chart validation and linting
- ✅ Scheduler logic (dry-run mode)
- ✅ View generation (mailbox, board)

**Status:** This is testable NOW and provides value

### Option 2: Wait for OpenClaw Plugin API
If OpenClaw plans to support custom plugins in a future version:
- Escalate to swe-architect
- Update design doc with actual plugin API when available
- Implement plugin-based E2E tests when supported

### Option 3: Alternative Integration Approach
AOF could integrate with OpenClaw differently:
- HTTP server exposing AOF tools
- OpenClaw agents call AOF via HTTP (not as plugin)
- Separate daemon process

**Status:** Requires architecture decision

### Option 4: Mock OpenClaw API
Create a minimal mock `OpenClawApi` implementation for E2E tests:
- Simulates plugin registration
- No real OpenClaw gateway required
- Tests AOF adapter logic in isolation

**Status:** Less valuable than testing actual integration

## Recommendation

**For Phase 1 delivery**, implement **Option 1: Standalone E2E Tests**:

1. ✅ Test AOF library functionality end-to-end
2. ✅ Verify TaskStore, EventLogger, Metrics work in isolation
3. ✅ Test scheduler logic (dry-run mode)
4. ✅ Verify view generation
5. ✅ Validate against test fixtures

**These tests provide immediate value and catch regressions** in AOF's core logic, even without OpenClaw integration.

**For future phases**: Escalate plugin loading question to architect and decide on proper integration approach.

## Files Created (Still Useful)

The infrastructure built in Phase 1 is reusable:
- ✅ `tests/e2e/utils/test-data.ts` — Test data seeding (works for standalone tests)
- ✅ `tests/e2e/fixtures/` — Task and org chart fixtures
- ⚠️ `tests/e2e/setup/gateway-manager.ts` — Blocked (needs OpenClaw plugin support)
- ✅ `tests/vitest.e2e.config.ts` — Vitest E2E config (works for standalone)
- ✅ Test structure and npm scripts

## Next Steps

1. **Document finding** ✅ (this file)
2. **Pivot to standalone E2E tests** for Phase 1
3. **Report to architect** for plugin integration decision
4. **Update design doc** with actual OpenClaw capabilities
5. **Deliver working E2E tests** for AOF library (non-plugin mode)

## Test Coverage (Phase 1 - Revised)

### Testable NOW (Standalone)
- TaskStore CRUD operations
- Status transitions (inbox → ready → active → done)
- Lease acquire/renew/release/expire
- Event logging (append, rotation)
- Metrics collection and Prometheus format
- Org chart validation and linting
- Scheduler dry-run logic
- View generation (mailbox, board)
- Config get/set/validate

### Blocked (Requires Plugin Support)
- Plugin registration in OpenClaw gateway
- Tool registration (aof_task_update, etc.)
- Gateway endpoints (/metrics, /aof/status)
- Agent spawn integration
- Full dispatch workflows with real OpenClaw agents

---

**Conclusion:** Phase 1 can still deliver value by testing AOF's core library functionality. Plugin-based integration tests require architecture decision and/or OpenClaw API changes.
