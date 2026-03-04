# Requirements: AOF

**Defined:** 2026-03-03
**Core Value:** Tasks never get dropped -- they survive gateway restarts, API failures, rate limits, and agent crashes, always resuming and completing end-to-end without human intervention.

## v1.4 Requirements

Requirements for Context Optimization milestone. Each maps to roadmap phases.

### Skill Compression

- [ ] **SKILL-01**: Agent receives a compact cheatsheet SKILL.md (~150 lines) covering all tools, workflows, and protocols without verbose examples
- [ ] **SKILL-02**: CLI reference section removed from SKILL.md (agents don't run CLI commands)
- [ ] **SKILL-03**: Notification events table removed from SKILL.md (agents emit events via tools, don't need full table)
- [ ] **SKILL-04**: Verbose YAML org chart examples replaced with minimal inline examples
- [ ] **SKILL-05**: Parameter tables removed from SKILL.md (tool JSON schemas provide this)
- [ ] **SKILL-06**: Org chart setup guidance preserved in compressed skill for agent-led provisioning
- [ ] **SKILL-07**: Context injection supports tiered delivery (seed tier for simple tasks, full tier for complex tasks)

### Tool Descriptions

- [ ] **TOOL-01**: Tool descriptions in tools.ts reduced to schema + one-liner (no inline examples or redundant parameter docs)
- [ ] **TOOL-02**: Projects skill merged into main compressed skill (single file)
- [ ] **TOOL-03**: No functionality lost -- all tool parameters and schemas remain correct after trimming

### Measurement

- [ ] **MEAS-01**: Before/after token count documented proving 50%+ total context reduction
- [ ] **MEAS-02**: Automated test fails if total context injection exceeds defined token budget

## Future Requirements

### Self-Healing (deferred to v1.5)

- **HEAL-01**: Circuit breaker for repeated agent failures
- **HEAL-02**: Dead-letter resurrection with retry policy
- **HEAL-03**: Stuck session recovery

### Observability (deferred to v2)

- **OBS-01**: OpenTelemetry integration
- **OBS-02**: Basic telemetry collection

## Out of Scope

| Feature | Reason |
|---------|--------|
| Dynamic context based on task content | Over-engineering for v1.4 -- static tiers sufficient |
| Per-agent skill customization | All agents use same tools -- one skill fits all |
| MCP resource description trimming | Already minimal (~1KB), not worth optimizing |
| Skill versioning / migration | Single file replacement, no migration needed |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SKILL-01 | Phase 21 | Pending |
| SKILL-02 | Phase 21 | Pending |
| SKILL-03 | Phase 21 | Pending |
| SKILL-04 | Phase 21 | Pending |
| SKILL-05 | Phase 21 | Pending |
| SKILL-06 | Phase 21 | Pending |
| SKILL-07 | Phase 23 | Pending |
| TOOL-01 | Phase 22 | Pending |
| TOOL-02 | Phase 22 | Pending |
| TOOL-03 | Phase 22 | Pending |
| MEAS-01 | Phase 24 | Pending |
| MEAS-02 | Phase 24 | Pending |

**Coverage:**
- v1.4 requirements: 12 total
- Mapped to phases: 12
- Unmapped: 0

---
*Requirements defined: 2026-03-03*
*Last updated: 2026-03-03 after roadmap creation*
