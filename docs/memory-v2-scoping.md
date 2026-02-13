# Memory V2 Scoping Memo — AOF Integration

**Date:** 2026-02-07  
**Author:** swe-pm (subagent)  
**Status:** Completed  
**Completed:** 2026-02-07 — Phase 1.3 delivered (190 tests passing).  
**Related:** TASK-2026-02-06-003 | AOF BRD v2 FR-6 | Memory-v2-Integration.md

---

## Executive Summary

Memory V2 integration enables AOF to manage per-agent memory scoping via `memorySearch.extraPaths` configuration derived from the org chart. This **reduces token waste by 30% (target)** and **improves recall quality** by excluding logs/archives/noise from agent memory search.

**Phase 1 scope:** Configuration generation + audit tooling only. Lifecycle management (auto-create/retire paths) and medallion aggregation deferred to Phase 2+.

---

## In Scope (Phase 1)

### 1. Org Chart Schema Extension
Add `memoryPools` section to org-chart-v1 schema defining:
- **Hot tier:** `_Core/` (always indexed; all agents)
- **Warm tier:** Role/domain-scoped directories (selective indexing)
- **Cold tier:** Explicit exclusions (Logs/, Approvals/, _archived/)

**Example schema addition:**
```yaml
memoryPools:
  hot:
    path: Resources/OpenClaw/_Core
    description: Canonical operator context (always indexed)
    agents: [all]  # implicit
  warm:
    - id: runbooks
      path: Resources/OpenClaw/Runbooks
      roles: [main, openclaw-custodian, swe-*]
    - id: swe-suite
      path: Resources/OpenClaw/Agents/swe-suite
      roles: [swe-*]
    - id: ops
      path: Resources/OpenClaw/Ops
      roles: [main, openclaw-custodian]
  cold:  # never indexed
    - Logs
    - Approvals
    - _archived
```

### 2. Config Generator
**Command:** `aof memory generate`

**Behavior:**
- Read org chart `memoryPools` section
- For each agent, resolve roles → warm directories
- Generate per-agent `memorySearch.extraPaths` config
- Output: `~/Projects/AOF/org/generated/memory-config.json`

**Output format:**
```json
{
  "agents": {
    "main": {
      "memorySearch": {
        "extraPaths": [
          "/path/to/vault/Resources/OpenClaw/_Core",
          "/path/to/vault/Resources/OpenClaw/Runbooks",
          "/path/to/vault/Resources/OpenClaw/Ops",
          "/path/to/vault/Resources/OpenClaw/Architecture",
          "/path/to/vault/Resources/OpenClaw/Policies",
          "/path/to/vault/Resources/OpenClaw/Agents/_Shared"
        ]
      }
    },
    "swe-backend": {
      "memorySearch": {
        "extraPaths": [
          "/path/to/vault/Resources/OpenClaw/_Core",
          "/path/to/vault/Resources/OpenClaw/Runbooks",
          "/path/to/vault/Resources/OpenClaw/Architecture",
          "/path/to/vault/Resources/OpenClaw/Agents/swe-suite"
        ]
      }
    }
  }
}
```

**Application strategy (Phase 1):**
- Human-in-the-loop: operator manually merges generated config into `~/.openclaw/openclaw.json`
- Backup required before merge
- Reindex memory after config update

### 3. Audit Command
**Command:** `aof memory audit`

**Behavior:**
- Compare org chart policy vs actual `openclaw.json` agent configs
- Detect drift:
  - Missing paths (agent should have access but doesn't)
  - Forbidden paths (agent has access to cold dirs)
  - Extra paths (agent has undocumented access)
  - Orphan agents (in openclaw.json but not in org chart)

**Output:**
```
Memory V2 Audit Report
======================
✓ main: config matches policy
✗ swe-backend: missing path Resources/OpenClaw/Architecture
✗ swe-qa: includes forbidden path Resources/OpenClaw/Logs
⚠ researcher: not defined in org chart memory pools

Summary: 2 violations, 1 warning
```

**Integration:** Run daily as part of scheduler health check; emit Matrix alert if drift detected.

### 4. Linter Integration
**Existing tool:** `~/.openclaw/workspace/scripts/memory_v2_lint.py`

**AOF integration:**
- `aof memory lint` wraps existing Python linter
- Validates:
  - `_Core/` has exactly canonical docs (≤10 files, ≤50KB total)
  - No agent extraPaths includes forbidden substrings
  - Per-agent mappings match AGENT_PATH_MAP
- AOF linter extends with org-chart-aware validation (checks against `memoryPools` schema)

### 5. Documentation
- Update BRD FR-6 with implementation details
- Add Memory V2 section to Technical Roadmap (Phase 1.3)
- Create runbook: "How to add a new agent with memory scoping"
- Update org chart example with `memoryPools` section

---

## Out of Scope (Phase 1)

Deferred to Phase 2+ or backlog:

### 1. Path Lifecycle Management
- Auto-create directories when agents added to org chart
- Auto-retire/archive directories when agents removed
- Validation that paths exist before config generation

**Rationale:** Adds complexity; linter warnings sufficient for Phase 1.

### 2. Medallion Aggregation Pipeline
- Cold → Warm promotion (weekly/monthly rollups)
- Warm → Hot curation (with approval workflow)
- Auto-archival of stale warm docs

**Rationale:** Separate project; Memory V2 scoping is prerequisite.

### 3. Retrieval Observability
- Metrics for retrieval hits per pool
- Token consumption per agent per pool
- Recall quality metrics (precision/recall)

**Rationale:** Requires upstream OpenClaw instrumentation; not available in Phase 1.

### 4. Policy-Driven Redaction
- Role-based access control (prevent certain roles from accessing sensitive pools)
- Dynamic scoping based on task context
- Per-task memory scope overrides

**Rationale:** Adds significant complexity; Phase 1 uses static role mappings only.

### 5. Automatic Config Application
- `aof memory apply` command to merge generated config into openclaw.json
- Backup/rollback automation
- Dry-run mode with diff preview

**Rationale:** Defer to Phase 2 for safety; Phase 1 is manual merge only.

---

## Schema Changes Required

### Org Chart v1 Schema (`org-chart-v1.schema.json`)

**New top-level section:**
```json
{
  "memoryPools": {
    "type": "object",
    "required": ["hot", "warm", "cold"],
    "properties": {
      "hot": {
        "type": "object",
        "properties": {
          "path": { "type": "string" },
          "description": { "type": "string" },
          "agents": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["path"]
      },
      "warm": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": { "type": "string" },
            "path": { "type": "string" },
            "description": { "type": "string" },
            "roles": { "type": "array", "items": { "type": "string" } }
          },
          "required": ["id", "path", "roles"]
        }
      },
      "cold": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Path substrings that must never appear in extraPaths"
      }
    }
  }
}
```

**Backward compatibility:**
- `memoryPools` is optional in v1.0 (allows gradual migration)
- If missing, generator emits warning and uses hardcoded defaults
- v1.1+ makes `memoryPools` required

---

## Implementation Milestones

### M1: Schema + Linter (Week 1)
**Deliverables:**
- [ ] Add `memoryPools` section to `org-chart-v1.schema.json`
- [ ] Update schema linter to validate memory pool definitions
- [ ] Create reference `org-chart.yaml` with memory mappings for SWE suite + main + custodian
- [ ] Update `aof lint` command to validate memory pools

**Dependencies:** None (foundational)

---

### M2: Config Generator (Week 1-2)
**Deliverables:**
- [ ] Implement `aof memory generate` command
- [ ] Role wildcard expansion (e.g., `swe-*` → all SWE agents)
- [ ] Path resolution (relative → absolute)
- [ ] Output to `~/Projects/AOF/org/generated/memory-config.json`
- [ ] Unit tests for role mapping logic

**Dependencies:** M1 (schema)

---

### M3: Audit Command (Week 2)
**Deliverables:**
- [ ] Implement `aof memory audit` command
- [ ] Drift detection (missing/forbidden/extra paths)
- [ ] Integration with scheduler health check (daily run)
- [ ] Matrix alert on drift detection

**Dependencies:** M2 (generator; needed to compute expected config)

---

### M4: Integration Testing (Week 2-3)
**Deliverables:**
- [ ] Test config generation for all agents (SWE suite + main + custodian + personal-admin)
- [ ] Validate against existing `memory_v2_lint.py` (no regressions)
- [ ] Measure token consumption baseline (1 week sampling: 10 tasks/agent)
- [ ] Deploy generated config to staging environment
- [ ] Verify memory search behavior (cold dirs excluded, warm dirs included)

**Dependencies:** M1, M2, M3

---

### M5: Documentation & Deployment (Week 3)
**Deliverables:**
- [ ] Update BRD FR-6 with implementation reference
- [ ] Add Memory V2 section to Technical Roadmap (Phase 1.3)
- [ ] Create runbook: "Adding a New Agent with Memory Scoping"
- [ ] Update operator console to show memory audit status
- [ ] Deployment checklist (backup config, apply generated config, reindex memory)

**Dependencies:** M4 (testing complete)

---

## Dependencies

### Critical Path
1. **OpenClaw core capability:** Per-agent `memorySearch.extraPaths` override support
   - **Status:** ✅ Already exists (confirmed via memory_v2_lint.py)
   - **Verification:** Agent configs in `openclaw.json` support per-agent overrides

2. **Org chart v1 finalized:** Schema must be stable before generator implementation
   - **Status:** 🟡 In progress (Phase 1.1)
   - **Blocker:** If schema changes after M2, generator must be refactored

3. **Baseline measurement:** Token consumption baseline required to validate success metric
   - **Status:** ❌ Not started
   - **Action:** Run 1-week measurement before Memory V2 deployment (OTEL + manual sampling)

### Optional Dependencies
- **Prometheus metrics:** Token accounting per agent (deferred to Phase 2; manual sampling sufficient for Phase 1)
- **Animated org chart UI:** Metadata fields for graph layout (out of scope; no blocker)

---

## Risks & Mitigations

### 1. Schema Coupling Risk
**Risk:** Org chart schema evolves frequently; memory mappings become stale and brittle.

**Impact:** High (config generation breaks on schema changes)

**Mitigation:**
- Use role-based wildcards (`swe-*`, `admin-*`) instead of enumerating all agents
- Version schema (`schemaVersion: 1`); generator supports migration
- Add schema validation to CI/CD pipeline (fail fast on breaking changes)

**Status:** Mitigated

---

### 2. Config Application Gap
**Risk:** Generated config isn't automatically applied; manual copy-paste is error-prone.

**Impact:** Medium (operator mistakes cause drift or memory misconfiguration)

**Mitigation:**
- Phase 1: Manual merge with backup requirement (documented procedure)
- Phase 2: Implement `aof memory apply --dry-run` with diff preview + rollback
- Add audit command to scheduler health check (daily drift detection)

**Status:** Accepted for Phase 1; mitigation planned for Phase 2

---

### 3. Baseline Measurement Missing
**Risk:** Can't validate 30% token reduction without accurate baseline.

**Impact:** High (success metric unverifiable)

**Mitigation:**
- **Action required:** Run 1-week token consumption measurement before deployment
  - Sample 10 tasks per agent per day
  - Use OTEL token accounting + manual log analysis
  - Document baseline in `~/Projects/AOF/docs/metrics-baseline.md`

**Status:** Acknowledged; action item assigned to swe-pm

---

### 4. Path Lifecycle Complexity
**Risk:** Directories referenced in org chart don't exist; agents fail to start or search returns empty results.

**Impact:** Medium (agents degraded; operator intervention required)

**Mitigation:**
- Linter validates path existence (emits warnings for missing dirs)
- Generator includes path existence check (fail with actionable error message)
- Out of scope for Phase 1: auto-creation (defer to Phase 2)

**Status:** Mitigated (validation only; no auto-creation)

---

### 5. Drift Detection Latency
**Risk:** Audit command runs on-demand only; drift may go unnoticed for days.

**Impact:** Low (drift causes token waste but doesn't break functionality)

**Mitigation:**
- Add `aof memory audit` to daily scheduler health check
- Emit Matrix alert if drift detected (immediate notification)
- Include drift status in operator console dashboard

**Status:** Mitigated (automated daily checks)

---

### 6. Rollback Difficulty
**Risk:** If Memory V2 scoping breaks agent functionality, rolling back is manual and slow.

**Impact:** Medium (RTO increases if operators must manually revert config)

**Mitigation:**
- **Pre-deployment:** Backup `openclaw.json` before applying generated config
- **Testing:** Deploy to staging environment first (1 week validation before production)
- **Rollback procedure:** Documented in runbook (restore backup, restart gateway, reindex memory)

**Status:** Mitigated (procedural controls)

---

## Success Metrics (from BRD FR-6)

### Quantified Targets

1. **Token efficiency:**
   - **Target:** 30% reduction in per-task token consumption
   - **Baseline:** TBD (measure for 1 week before deployment)
   - **Measurement:** OTEL token accounting + weekly sampling (10 tasks/agent)

2. **Noise reduction:**
   - **Target:** Cold directory documents appear in <5% of memory retrieval results
   - **Baseline:** TBD (measure for 1 week with current unscoped memory)
   - **Measurement:** Sample 20 memory queries/week; grep for cold paths in results

3. **Runbook adherence:**
   - **Target:** 90% of tasks include "Runbook compliance" section in deliverables
   - **Baseline:** 0% (not enforced currently)
   - **Measurement:** Manual sampling (10 tasks/week) or automated grep of output artifacts

4. **Drift detection latency:**
   - **Target:** <5 minutes (time from drift occurrence to Matrix alert)
   - **Measurement:** Timestamp delta between config change and audit alert

### Phase 1 Specific Metrics

- **Config generation accuracy:** 100% of agents have valid extraPaths (no schema errors)
- **Linter pass rate:** 100% (no violations in generated config)
- **Audit command coverage:** 100% of agents checked daily

---

## BRD/Roadmap Updates Needed

### BRD v2 (AOF-BRD-v2.md)

**Section 7.1 FR-6 (Memory v2 Integration):**
- Add reference: "See Memory-v2-Scoping.md for detailed implementation plan"
- Update "Missing piece" note: "Phase 1 (M2) implements config generator; M3 implements audit command"
- Add dependency note: "Requires baseline token measurement before deployment (action: swe-pm)"

**Section 13 (Migration Plan):**
- Add Phase A substep: "Measure token consumption baseline (1 week)"
- Add Phase B verification: "Deploy Memory V2 scoping to staging; validate token reduction"

### Technical Roadmap (AOF-Technical-Roadmap.md)

**Phase 1 — Org Chart MVP (2–3 weeks):**
- Split Phase 1 into **Phase 1.1** (Org Chart core) and **Phase 1.3** (Memory V2 scoping)
- Add explicit dependency: Phase 2 (Execution bridging) depends on Phase 1.3 completion

**New Phase 1.3 deliverables:**
- Config generator (`aof memory generate`)
- Audit command (`aof memory audit`)
- Schema extension (`memoryPools` section)
- Baseline measurement and validation

### User Stories (AOF-User-Stories.md)

**No new user stories required.** Memory V2 is infrastructure; no user-facing workflows.

**Optional documentation story (backlog):**
- US-15: As an operator, I want a runbook for adding new agents with memory scoping, so I can onboard agents consistently.

---

## Recommendation

**Approve for implementation.** Phase 1 scope is well-defined, incremental, and defers complexity appropriately:

✅ **Clear deliverables:** Config generation + audit tooling only  
✅ **No OpenClaw core changes required:** Leverages existing `extraPaths` capability  
✅ **Graceful degradation:** Linter warnings + manual merge (no auto-magic)  
✅ **Measurable success:** Token reduction + noise reduction metrics defined  
✅ **Low risk:** Manual config application with backup requirement  
✅ **Incremental:** Lifecycle management and medallion deferred to Phase 2+  

**Proceed to implementation (M1–M5).**

---

## Next Actions

### Immediate (this week)
1. **swe-architect:** Review and approve this scoping memo
2. **swe-pm:** Measure token consumption baseline (1 week sampling)
3. **swe-backend:** Implement M1 (schema extension + linter updates)

### Phase 1.3 (Weeks 1-3)
4. **swe-backend:** Implement M2 (config generator)
5. **swe-backend:** Implement M3 (audit command)
6. **swe-qa:** Execute M4 (integration testing)
7. **swe-tech-writer:** Execute M5 (documentation updates)

### Post-Phase 1
8. **Retrospective:** Review token reduction metrics; validate 30% target achieved
9. **Phase 2 scoping:** Automatic config application + path lifecycle management

---

**End of memo.**
