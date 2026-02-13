# BUG-001 + BUG-004: AOF Agent Adoption — Prompt & Guidance Updates
**Date:** 2026-02-08  
**Agent:** swe-ai (subagent)  
**Status:** ✅ Complete

---

## Changes Delivered

### 1. Updated `prompts/agent-guide.md`
**Added comprehensive adoption guidance:**
- ✅ Tool Adoption Checklist section with decision trees
- ✅ When to use `aof_dispatch` (with ✅/❌ scenarios)
- ✅ When to use `aof_task_update` (progress tracking)
- ✅ When to use `aof_task_complete` (task closure)
- ✅ When to use `aof_status_report` (status overview)
- ✅ Quick Reference section documenting all parameters
- ✅ Explicit examples showing typical usage patterns
- ✅ Clear fallback strategy: "Use `aof_dispatch` for delegation; fallback to `sessions_spawn` only if AOF tools unavailable"

**Key improvements:**
- Decision criteria for when to create tasks vs use other tools
- Complete parameter documentation with examples
- Return value documentation (`taskId`, `status`, `filePath`)
- Common mistakes to avoid

### 2. Enhanced `prompts/tool-descriptions.md`
**Expanded `aof_dispatch` documentation:**
- ✅ Complete parameter table (required vs optional)
- ✅ Return value structure documented
- ✅ Multiple usage examples:
  - Basic delegation
  - With dependencies (`dependsOn`)
  - Team-routed with metadata
- ✅ Explicit instruction: "**Use instead of `sessions_spawn` when AOF tools are available**"
- ✅ All routing options documented: `agent`, `team`, `role`
- ✅ Priority levels: `low` | `medium` | `high` | `critical`
- ✅ Metadata and tags usage

### 3. Created `prompts/adoption-checklist.md`
**New comprehensive adoption guide:**
- ✅ Decision flow diagram for task delegation
- ✅ Detailed "When to Use" sections for each tool
- ✅ Common mistakes reference table
- ✅ Quick reference table mapping needs to tools
- ✅ Fallback strategy when AOF tools unavailable
- ✅ Real-world scenario examples (✅ use vs ❌ don't use)

**Content:**
- 6.1 KB comprehensive checklist
- Covers all 4 AOF tools: `aof_dispatch`, `aof_task_update`, `aof_task_complete`, `aof_status_report`
- Clear decision trees and example scenarios

---

## Acceptance Criteria Met

### Requirement 1: Update agent guidance docs ✅
- [x] Updated `prompts/agent-guide.md` with AOF tool preference
- [x] Updated `prompts/tool-descriptions.md` with complete docs
- [x] Added explicit instruction: "Use `aof_dispatch` for delegation when available; fallback to `sessions_spawn` only if AOF tools unavailable"
- [x] Added usage examples with typical parameters (title, brief, agent, priority)
- [x] Added lightweight checklist for when to create tasks vs use other tools

### Requirement 2: Document `aof_dispatch` ✅
- [x] **Required parameters:** `title`, `brief`/`description`
- [x] **Optional routing:** `agent`, `team`, `role`
- [x] **Optional metadata:** `priority`, `dependsOn`, `parentId`, `metadata`, `tags`, `actor`
- [x] **Returns:** `taskId`, `status`, `filePath`
- [x] Complete examples showing all parameter patterns

### Requirement 3: Adoption checklist ✅
- [x] When to create a task (delegation, async work, tracked deliverables, work >10s)
- [x] When to use `aof_task_update` (starting work, progress, blockers, status changes)
- [x] When to use `aof_task_complete` (all AC met, outputs delivered, verification done)
- [x] When to use `aof_status_report` (queue check, status overview, workload check)

---

## Test Results

```bash
$ cd ~/Projects/AOF && npm test

Test Files  1 failed | 70 passed (71)
      Tests  2 failed | 701 passed (703)
```

**Status:** ✅ 701/703 tests passing (99.7%)

**Pre-existing failures (unrelated to prompt changes):**
1. `scheduler.test.ts` - end-to-end flow lease event timing issue
2. `scheduler.test.ts` - invalid state transition test (backlog → done)

**Note:** These failures are in scheduler logic tests, not related to prompt/documentation changes. All prompt files are markdown documentation; no code logic was modified.

---

## Files Modified/Created

| File | Action | Size | Purpose |
|------|--------|------|---------|
| `prompts/agent-guide.md` | Modified | 3.9 KB | Core agent operating manual with adoption guidance |
| `prompts/tool-descriptions.md` | Modified | 3.8 KB | Detailed tool reference with complete parameter docs |
| `prompts/adoption-checklist.md` | Created | 6.1 KB | Comprehensive decision trees and usage scenarios |

**Total additions:** ~4 KB of new guidance content  
**No production code modified** (documentation only)

---

## Key Messages for Agents (Now in Prompts)

### Primary directive:
> "Use `aof_dispatch` for task delegation when AOF tools are available; fallback to `sessions_spawn` only if AOF tools are unavailable"

### Decision criteria:
- **Use `aof_dispatch`:** Work >10s, has deliverables, needs tracking, delegation, async work
- **Don't use `aof_dispatch`:** Quick queries, exploratory work, immediate responses, tools unavailable

### Required fields:
- `title` (concise, <80 chars)
- `brief` (with acceptance criteria)
- Returns: `taskId`, `status`, `filePath`

---

## Next Steps (Post-Adoption)

1. **Monitor tool usage** after prompts deployed
   - Track `aof_dispatch` vs `sessions_spawn` usage
   - Identify agents not adopting AOF tools

2. **Integration** (per `integration-guide.md`)
   - Deploy updated prompts to agent workspaces
   - Add `AOF.md` quickstart to pilot agents
   - Enable AOF tools in OpenClaw config

3. **Validation** (BUG-001 completion criteria)
   - Create 2-3 tasks via `aof_dispatch` (not manual)
   - Verify tasks in `aof_status_report`
   - Confirm event log shows `task.created` events

---

## Rules Compliance

✅ **Source changes only** — No OpenClaw config modified  
✅ **No production enablement** — Plugin not enabled in config  
✅ **Tests run** — 701/703 passing (pre-existing failures documented)  
✅ **AOF project scope** — All changes in `~/Projects/AOF/prompts/`  

---

## Summary

Agent adoption guidance is now **complete and comprehensive**. All three prompt files explicitly instruct agents to prefer `aof_dispatch` over `sessions_spawn` when AOF tools are available, with clear decision criteria, examples, and fallback strategies.

The adoption checklist provides detailed scenarios for when to use each tool, complete with real-world examples and common mistakes to avoid.

**Ready for deployment:** Prompts can be integrated into agent workspaces per `integration-guide.md`.
