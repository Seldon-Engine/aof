# Requirements: AOF

**Defined:** 2026-03-03
**Core Value:** Tasks never get dropped -- they survive gateway restarts, API failures, rate limits, and agent crashes, always resuming and completing end-to-end without human intervention.

## v1.4 Requirements

Requirements for Context Optimization milestone. Each maps to roadmap phases.

### Skill Compression

- [x] **SKILL-01**: Agent receives a compact cheatsheet SKILL.md (~150 lines) covering all tools, workflows, and protocols without verbose examples
- [x] **SKILL-02**: CLI reference section removed from SKILL.md (agents don't run CLI commands)
- [x] **SKILL-03**: Notification events table removed from SKILL.md (agents emit events via tools, don't need full table)
- [x] **SKILL-04**: Verbose YAML org chart examples replaced with minimal inline examples
- [x] **SKILL-05**: Parameter tables removed from SKILL.md (tool JSON schemas provide this)
- [x] **SKILL-06**: Org chart setup guidance preserved in compressed skill for agent-led provisioning
- [x] **SKILL-07**: Context injection supports tiered delivery (seed tier for simple tasks, full tier for complex tasks)

### Tool Descriptions

- [x] **TOOL-01**: Tool descriptions in tools.ts reduced to schema + one-liner (no inline examples or redundant parameter docs)
- [x] **TOOL-02**: Projects skill merged into main compressed skill (single file)
- [x] **TOOL-03**: No functionality lost -- all tool parameters and schemas remain correct after trimming
- [x] **TOOL-04**: aof_dispatch accepts a `workflow` parameter so agents can compose DAG workflows through MCP tools (closes v1.2 TMPL-02 gap)

### Measurement

- [x] **MEAS-01**: Before/after token count documented proving 50%+ total context reduction
- [x] **MEAS-02**: Automated test fails if total context injection exceeds defined token budget

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
| SKILL-01 | Phase 22 | Complete |
| SKILL-02 | Phase 22 | Complete |
| SKILL-03 | Phase 22 | Complete |
| SKILL-04 | Phase 22 | Complete |
| SKILL-05 | Phase 22 | Complete |
| SKILL-06 | Phase 22 | Complete |
| SKILL-07 | Phase 23 | Complete |
| TOOL-01 | Phase 21 | Complete |
| TOOL-02 | Phase 21 | Complete |
| TOOL-03 | Phase 21 | Complete |
| TOOL-04 | Phase 21 | Complete |
| MEAS-01 | Phase 24 | Complete |
| MEAS-02 | Phase 24 | Complete |

**Coverage:**
- v1.4 requirements: 13 total
- Mapped to phases: 13
- Unmapped: 0

---
*Requirements defined: 2026-03-03*
*Last updated: 2026-03-03 after roadmap creation*
