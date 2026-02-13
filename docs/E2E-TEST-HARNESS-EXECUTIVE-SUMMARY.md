# AOF E2E Test Harness — Executive Summary

**Status:** DESIGN COMPLETE — READY FOR IMPLEMENTATION  
**Architect:** swe-architect  
**Implementation Owner:** swe-qa  
**Priority:** CRITICAL  
**Delivery Target:** 8 working days  
**Date:** 2026-02-07

---

## TL;DR

AOF has **279 passing unit tests, zero E2E tests.** Everything is mocked. We've designed a comprehensive E2E test harness where AOF runs inside a **real OpenClaw gateway** with real tool calls, real spawns, and real state transitions.

**Decision: Profile-based approach** (not Docker) for speed, simplicity, and CI compatibility.

**Deliverable:** 9 test suites, 20+ tests, covering all critical AOF workflows from plugin registration through concurrent dispatch and metrics endpoints.

---

## Design Decisions

### 1. Profile-Based > Docker (Recommended)

**✅ Profile-Based Approach:**
```bash
openclaw --profile aof-e2e-test gateway run --port 19003
```

**Why:**
- ✅ No Docker dependency (avoids Colima QEMU panics on Mule)
- ✅ Fast startup (<2s gateway boot)
- ✅ Easy debugging (logs/state directly accessible)
- ✅ CI-compatible (GitHub Actions without Docker setup)
- ✅ Matches production deployment patterns

**❌ Docker Approach:**
- Deferred to Phase 4.6+ (optional enhancement)
- Use case: Hermetic CI environments, multi-version testing
- Blocked by: Docker instability on Mule

### 2. Mock Model Provider

**Options:**
1. **Built-in OpenClaw mock provider** (if exists in 2026.2.6)
2. **Custom test provider** (fallback implementation)

**Decision:** Try built-in first, implement custom if needed. Mock provider ensures:
- Fast test execution (no API latency)
- Zero cost (no model API charges)
- Deterministic behavior (no LLM variability)

### 3. Test Data Strategy

**Fixtures:**
- Minimal org chart (3 test agents)
- Task templates (simple, multi-step, concurrent, timeout)
- Expected outputs (metrics baseline, status schema)

**Seeding:**
- Clean state before each test
- Event-driven assertions (not fixed sleeps)
- Preserve artifacts on failure

---

## Test Coverage (9 Test Suites)

| # | Suite | Scenarios | Critical Path |
|---|-------|-----------|---------------|
| 1 | Plugin Registration | Services, tools, CLIs, endpoints register | ✅ Blocker |
| 2 | Tool Execution | aof_task_update, aof_task_complete, aof_status_report | ✅ Blocker |
| 3 | Dispatch Flow | Ready → Active → Done (full lifecycle) | ✅ Blocker |
| 4 | View Updates | Mailbox, Kanban reflect state changes | ✅ Blocker |
| 5 | Resume Protocol | Stale lease detection, move to review/ | ✅ Blocker |
| 6 | Metrics Endpoint | Prometheus format, real-time updates | ⚠️ Important |
| 7 | Status Endpoint | Scheduler health, task counts | ⚠️ Important |
| 8 | Concurrent Dispatch | Lease manager prevents double-spawn | ✅ Blocker |
| 9 | Drift Detection | Org chart vs OpenClaw reality | ⚠️ Important |

**Total:** 20+ test scenarios covering all core AOF functionality.

---

## Task Breakdown for swe-qa

### Phase 1: Foundation (Days 1-2)
**Task:** `e2e-01-foundation-setup`  
**Effort:** 16 hours

- E2E directory structure
- `GatewayManager` class (start/stop OpenClaw subprocess)
- Test data seeding/cleanup utilities
- First passing test: Plugin Registration
- `npm run test:e2e` command

**Acceptance:** One test passes consistently, gateway lifecycle works.

### Phase 2: Core Tests (Days 3-5)
**Task:** `e2e-02-core-tests`  
**Effort:** 24 hours

- Test 1.2: Tool Execution
- Test 1.3: Dispatch → Spawn → Complete
- Test 1.4: View Updates
- Test 1.5: Resume Protocol

**Acceptance:** 7 tests pass, all critical workflows verified.

### Phase 3: Endpoints & Advanced (Days 6-7)
**Task:** `e2e-03-endpoints-advanced`  
**Effort:** 16 hours

- Test 1.6: Metrics Endpoint
- Test 1.7: Status Endpoint
- Test 1.8: Concurrent Dispatch
- Test 1.9: Drift Detection

**Acceptance:** 10 tests pass, observability and reliability verified.

### Phase 4: CI/CD Integration (Day 8)
**Task:** `e2e-04-ci-integration`  
**Effort:** 8 hours

- GitHub Actions workflow
- Artifact preservation on failure
- Comprehensive documentation (tests/e2e/README.md)
- Troubleshooting guide

**Acceptance:** Tests run in CI, failures preserved, documentation complete.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Vitest Test Process                                        │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  GatewayManager (test utility)                        │  │
│  │  - Spawns OpenClaw gateway subprocess                 │  │
│  │  - Generates test config (isolated profile)           │  │
│  │  - API wrappers (callTool, callCli, etc.)            │  │
│  └───────────────────────────────────────────────────────┘  │
│         │ HTTP/WebSocket                                     │
│         ▼                                                     │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  OpenClaw Gateway (subprocess)                        │  │
│  │  --profile aof-e2e-test                               │  │
│  │  --port 19003                                         │  │
│  └───────────────────────────────────────────────────────┘  │
│         │ Plugin API                                         │
│         ▼                                                     │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  AOF Plugin (dist/index.js)                           │  │
│  │  - TaskStore, AOFService, Tools, Endpoints            │  │
│  └───────────────────────────────────────────────────────┘  │
│         │ Filesystem                                         │
│         ▼                                                     │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Test Data (~/.openclaw-aof-e2e-test/aof-test-data)  │  │
│  │  tasks/, org/, events/, views/                        │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Key Principles:**
- **Isolated state:** Every test run starts from clean slate
- **Subprocess management:** Gateway lifecycle controlled by test harness
- **Event-driven assertions:** No fixed sleeps, use `waitForCondition()`
- **TDD for infrastructure:** Test the harness itself (GatewayManager has unit tests)

---

## Key Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| OpenClaw lacks mock model provider | HIGH | Implement custom mock in tests/e2e/setup/mock-model.ts |
| OpenClaw plugin API incompatible | HIGH | Version-pin OpenClaw 2026.2.6, add API version assertions |
| Gateway startup timeout in CI | MEDIUM | Increase timeout (2x in CI), add retry logic |
| Test flakiness (timing) | MEDIUM | Use `waitForCondition()` not `sleep()`, add jitter tolerance |
| OpenClaw API undocumented | MEDIUM | Reverse-engineer from gateway source, escalate if blocked |

---

## Open Questions (Resolve in Phase 1)

### Q1: Does OpenClaw 2026.2.6 have built-in mock model provider?
**Action:** swe-qa tests `openclaw gateway --help` for mock provider options  
**Fallback:** Implement custom mock provider

### Q2: What is the exact HTTP API for calling tools/CLIs?
**Action:** Inspect gateway API endpoints (`/api/tools`, `/api/cli`)  
**Fallback:** Use `openclaw` CLI directly via `child_process`

### Q3: How does OpenClaw load plugins?
**Assumption:** Via `plugins` array in `openclaw.json`  
**Action:** Test with minimal config in Phase 1

### Q4: Can we programmatically spawn agents?
**Expected:** Scheduler handles this (existing AOF behavior)  
**Action:** Verify in Test 1.3 (Dispatch Flow)

---

## Success Criteria

### Functional
- ✅ All 20+ E2E tests pass consistently (10 runs, zero flakiness)
- ✅ Test execution time < 2 minutes for full suite
- ✅ Tests run in CI without manual intervention
- ✅ All critical AOF workflows verified against real OpenClaw

### Non-Functional
- ✅ Test code follows TDD (test the harness itself)
- ✅ Test failures include actionable error messages
- ✅ Artifacts preserved on failure (logs, state, config)
- ✅ Documentation enables independent debugging

### Acceptance
- ✅ swe-qa can run E2E tests locally without assistance
- ✅ CI pipeline runs E2E tests on every PR
- ✅ Test failures block merges to main
- ✅ **Xav has confidence in shipped AOF features**

---

## Timeline

```
Phase 1: Foundation          Days 1-2  (16 hrs)  ███████░░░░░░░░░
Phase 2: Core Tests          Days 3-5  (24 hrs)  ░░░░░░░███████░░
Phase 3: Endpoints/Advanced  Days 6-7  (16 hrs)  ░░░░░░░░░░░███░░
Phase 4: CI Integration      Day 8     (8 hrs)   ░░░░░░░░░░░░░███
─────────────────────────────────────────────────
Total: 8 days (64 hours)
```

**Assumptions:**
- swe-qa full-time focus (no context switching)
- No major OpenClaw API incompatibilities discovered
- Design decisions hold (no pivot required)

---

## Deliverables

### Design Documents
- ✅ `docs/E2E-TEST-HARNESS-DESIGN.md` (36KB, comprehensive spec)
- ✅ `docs/E2E-TEST-HARNESS-EXECUTIVE-SUMMARY.md` (this document)

### Task Cards (Ready for swe-qa)
- ✅ `tasks/inbox/e2e-01-foundation-setup.md`
- ✅ `tasks/inbox/e2e-02-core-tests.md`
- ✅ `tasks/inbox/e2e-03-endpoints-advanced.md`
- ✅ `tasks/inbox/e2e-04-ci-integration.md`

### Code Deliverables (by swe-qa)
- `tests/e2e/setup/gateway-manager.ts` (core infrastructure)
- `tests/e2e/suites/*.test.ts` (9 test suites, 20+ tests)
- `tests/e2e/README.md` (comprehensive documentation)
- `.github/workflows/e2e-tests.yml` (CI pipeline)

---

## Next Steps

### Immediate (Now)
1. **Architect:** Report design completion to Demerzel
2. **Demerzel:** Review and approve design
3. **Architect:** Spawn swe-qa with task `e2e-01-foundation-setup`

### Phase 1 (Days 1-2)
1. **swe-qa:** Implement GatewayManager and test infrastructure
2. **swe-qa:** Resolve open questions (mock provider, API format, plugin loading)
3. **swe-qa:** Get first test passing (Plugin Registration)
4. **swe-qa:** Report Phase 1 completion to architect

### Phase 2-4 (Days 3-8)
1. **swe-qa:** Implement remaining test suites per task cards
2. **Architect:** Code review at each phase boundary
3. **swe-qa:** CI integration and documentation
4. **Architect:** Final review and merge to main

### Post-Delivery
1. **All agents:** Run E2E tests before major AOF changes
2. **swe-qa:** Add new E2E tests as new features ship
3. **Architect:** Monitor CI stability and test execution time

---

## Why This Matters

AOF is a **critical reliability layer** for Xav's multi-agent system. Today:
- ✅ 279 unit tests pass (but everything is mocked)
- ❌ Zero confidence that AOF works against real OpenClaw
- ❌ No way to catch regressions in real workflows
- ❌ No way to verify dispatcher, scheduler, views, metrics work end-to-end

After this work:
- ✅ E2E tests verify **every critical workflow** against real OpenClaw
- ✅ CI blocks broken code from reaching main
- ✅ Failure artifacts enable fast debugging
- ✅ **Confidence that shipped features actually work**

This is the **missing confidence layer** that's been blocking trust in everything shipped so far.

---

## Architect's Recommendation

**APPROVE AND PROCEED.**

The design is comprehensive, pragmatic, and deliverable in 8 days. Profile-based approach avoids Docker complexity while providing full E2E coverage. Task breakdown is clear and actionable.

**Spawn swe-qa immediately** with `e2e-01-foundation-setup` task. This is critical infrastructure that unblocks confidence in all AOF work.

---

**Sign-off:** swe-architect  
**Ready for:** Implementation by swe-qa  
**Blocking:** Confidence in all shipped AOF features
