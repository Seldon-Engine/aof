# Context Engineering Analysis — Update Summary

**Date:** 2026-02-07  
**Updated by:** swe-ai  
**Reason:** Integration of Martin Fowler/Thoughtworks article alongside Anthropic article

---

## What Changed

### Major Additions

1. **New Section 0: Context Interfaces & Decision Modes** (800+ lines)
   - Context interface taxonomy (Tools, MCP, Skills)
   - Decision mode matrix: Autonomous vs Manual vs Deterministic
   - Skills as lazy-loaded context bundles (practical implementation)
   - Claude Code's context stack comparison
   - Context transparency requirements
   - Probabilistic thinking & graceful degradation
   - Build-up-gradually principle

2. **Skills Pattern Integration** (Section 0.4)
   - Skill manifest frontmatter design
   - Lazy loading protocol (`list_skills`, `load_skill` tools)
   - Skills + budget allocation integration
   - AOF warm tier → Skills mapping

3. **Decision Mode Tracking** (Section 0.2)
   - Track who decides to load context (LLM vs human vs AOF)
   - Unified decision model with metrics
   - Utilization/waste by decision mode
   - Visualization: `aof context decisions` command

4. **Context Transparency** (Section 0.6)
   - Real-time budget visibility (`aof context status`)
   - Per-component attribution
   - Predictive warnings
   - Post-task analysis

5. **Probabilistic Thinking** (Section 0.7)
   - Graceful degradation over rigid enforcement
   - Confidence scoring for context decisions
   - Failure modes & fallback strategies

### Enhanced Sections

1. **Section 1.2.3: Dynamic Budget Allocation**
   - Added autonomy-based allocation (low/medium/high)
   - Integrated decision modes into budget model
   - Reserve budget for autonomous loading (5-15%)

2. **Section 7: Priority Matrix**
   - Added Skills pattern (P1, high impact)
   - Added decision mode tracking (P0, critical visibility)
   - Added context transparency dashboard (P0)
   - Added autonomy-based allocation (P2)
   - Added MCP integration (P3)

3. **Section 8: Conclusion**
   - Comprehensive integration of both articles
   - Comparison: Anthropic (theory) + Fowler (practice)
   - Critical gaps identified (8 total)
   - Three transformative changes highlighted
   - Updated success metrics (70-85% improvement target)

### Document Statistics

- **Original:** 1,682 lines
- **Updated:** 2,483 lines
- **Added:** 801 lines (48% increase)
- **New sections:** 1 (Section 0)
- **Enhanced sections:** 3 (1.2.3, 7, 8)

---

## Key Insights from Fowler Integration

1. **Skills are the practical implementation of progressive disclosure**
   - Warm tier should be lazy-loaded, not preloaded
   - Expected impact: 40-60% reduction in warm tier waste
   - Implementation: ~1 week effort

2. **Decision modes are a critical architectural dimension**
   - Must track who decides to load context (LLM vs human vs AOF)
   - Enables empirical optimization (which mode is most efficient?)
   - Informs budget allocation strategy

3. **Context transparency is non-negotiable**
   - Real-time visibility: `aof context status`
   - Post-task analysis: `aof context analyze`
   - Predictive warnings before budget exhaustion

4. **Probabilistic thinking changes the design approach**
   - Graceful degradation > rigid enforcement
   - Fallback strategies for every failure mode
   - Confidence scoring for low-certainty decisions

5. **Claude Code's stack provides a reference architecture**
   - CLAUDE.md (always) → Rules (path-scoped) → Skills (lazy) → Subagents → MCP → Hooks → Plugins
   - AOF maps well: Hot → Warm (to be Skills) → Cold (search) → Subagents (existing)
   - Gaps: Path-scoped rules, MCP integration, event hooks

---

## Priority Changes

### New P0 (Week 1)
- **Decision mode tracking** — Critical visibility (1 day)
- **Context transparency dashboard** — Real-time budget view (2 days)

### Elevated to P1 (Weeks 3-4)
- **Skills pattern** — Biggest single impact (40-60% savings, 1 week)

### Added to P3 (Month 3+)
- **MCP server integration** — Protocol-based context retrieval

---

## Implementation Impact

**Original targets:**
- 30 days: 30-50% reduction (tool clearing)
- 60 days: 40-60% reduction (signal density + hybrid retrieval)
- 90 days: 60-80% reduction (strategy plugins)

**Updated targets (with Fowler integration):**
- 30 days: 40-60% reduction (tool clearing + decision tracking + transparency)
- 60 days: 60-75% reduction (+ Skills pattern: 40-60% warm tier savings)
- 90 days: 70-85% reduction (+ autonomy-based allocation)

**Skills pattern alone justifies immediate prioritization** — 40-60% warm tier savings for ~1 week effort.

---

## Next Actions

1. **Demerzel/swe-architect review** — Approve integrated analysis
2. **Prioritize P0 items** — Decision tracking (1d) + transparency dashboard (2d)
3. **Baseline measurement** — 1 week token tracking (all modes: autonomous, manual, deterministic)
4. **Skills pattern implementation** — Week 2-3 (skill manifest + lazy loading tools)
5. **A/B test** — Validate Skills pattern savings (week 4)

---

## Conclusion

The Fowler/Thoughtworks article provides **critical practical guidance** that complements Anthropic's theoretical foundation:

- **Anthropic:** What to optimize (attention budget, signal density, compaction)
- **Fowler:** How to implement (Skills, decision modes, transparency, probabilistic thinking)

The integration is **highly synergistic** — Fowler's Skills pattern is the practical implementation of Anthropic's progressive disclosure principle. Combined, they provide a complete roadmap for AOF's context engineering evolution.

**The Skills pattern (40-60% savings, 1 week effort) should be prioritized immediately.**

---

**End of summary.**
