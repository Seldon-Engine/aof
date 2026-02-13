# Process Gaps — AOF Project (2026-02-06)

**Status:** Identified during kanban reconciliation  
**Owner:** swe-architect  
**Date:** 2026-02-06

---

## Summary

During the kanban board reconciliation (Directive 2), the following process gaps and inconsistencies were identified and addressed:

---

## 1. Task Status Directory Mismatch

**Problem:** The canonical AOF task schema defines six valid statuses (`backlog`, `ready`, `in-progress`, `blocked`, `review`, `done`), but the filesystem included additional directories not in the schema:
- `pending/` — not a valid schema status
- `assigned/`, `cancelled/`, `failed/`, `deadletter/` — present in filesystem but not in schema

**Impact:** 
- Task files placed in `pending/` were not discoverable by the scheduler
- Schema validation would fail on these tasks
- Linter could not enforce transitions properly

**Resolution:**
- Removed stub tasks from `pending/`
- Created proper task files with schema-compliant status values (`backlog`, `done`)
- **Recommendation:** Either remove unsupported status directories OR extend the schema to include them with clear semantics

---

## 2. Stub Tasks Without Content

**Problem:** Two stub tasks existed in `pending/` with:
- Empty body content (no acceptance criteria, no context)
- No assignees
- UUID-based IDs instead of schema-compliant `TASK-YYYY-MM-DD-NNN` format

**Impact:**
- Tasks were not actionable
- IDs did not match the schema `TaskId` regex
- Parser would accept them but linter would flag them

**Resolution:**
- Deleted stub tasks: `7d761f54-60e1-4ad3-97fe-d78fcb6f7554.md`, `670b51c2-c947-4624-8907-65b057a1cdfe.md`
- Created proper replacement tasks with schema-compliant IDs and full frontmatter

---

## 3. Completed Work Not Reflected on Board

**Problem:** Significant completed work (P1.1 Org Chart, P1.2 Drift Manager, Prometheus Metrics) had no task cards in the canonical task store.

**Impact:**
- Board did not reflect reality
- No audit trail of what was completed or who did it
- Process discipline eroded (work happened outside the system)

**Resolution:**
- Created canonical task cards in `tasks/done/` with:
  - Full YAML frontmatter (all required fields)
  - Acceptance criteria with test counts
  - Status transition logs
  - Proper assignees (`swe-architect`, `swe-backend`)

---

## 4. Empty Derived Views

**Problem:** The `views/kanban/` directory was empty despite the BRD specifying it as a derived view over the canonical task store.

**Impact:**
- The kanban board script at `~/.openclaw/workspace/scripts/kanban_board.py` pointed to a different location (`~/.openclaw/workspace/kanban/swe`)
- No single source of truth for team visibility
- Drift between where tasks lived vs where the board looked

**Resolution:**
- Created `views/kanban/` directory structure with lanes (`backlog`, `in-progress`, `review`, `blocked`, `done`)
- Populated view tasks (minimal frontmatter) pointing to canonical tasks
- Symlinked `~/.openclaw/workspace/kanban/swe` → `~/Projects/AOF/views/kanban`
- Verified board script works: `python3 ~/.openclaw/workspace/scripts/kanban_board.py`

---

## 5. No Process for "Work Without a Card"

**Problem:** Work was completed (P1.1, P1.2, metrics) without creating task cards first or updating the board afterward.

**Impact:**
- Process discipline broke down
- Board became stale and untrustworthy
- Architect lost visibility into what was in progress

**Resolution:**
- Documented the mandate: **No work happens without a card**
- Updated AGENTS.md to emphasize kanban board discipline for SWE agents
- Established expectation: all work flows through `backlog → ready → in-progress → review → done`

---

## 6. Unclear Ownership of Board Maintenance

**Problem:** Unclear who is responsible for keeping the board up to date.

**Impact:**
- Tasks got done but not moved to `done/`
- No one felt accountable for board hygiene

**Resolution:**
- Clarified in process docs: **swe-architect owns the board**
- Specialists update their own task cards (logs, notes) and move to `review` when done
- Architect moves from `review → done` after acceptance

---

## 7. Schema vs Implementation Drift

**Problem:** Task schema defines `TaskId` format as `TASK-YYYY-MM-DD-NNN` but some tasks used UUIDs.

**Impact:**
- IDs did not match the regex in `src/schemas/task.ts`
- Broke assumptions in scheduler and linter

**Resolution:**
- Enforced schema-compliant IDs for all new tasks
- **Recommendation:** Add a migration script or linter rule to catch non-compliant IDs

---

## 8. Missing BRD Goal: Session Entropy

**Problem:** The BRD did not explicitly call out session entropy as a problem AOF solves, even though this is a core motivator.

**Impact:**
- Implicit requirement, not tracked or measured
- Process discipline issues (like stale boards) were symptoms of this unaddressed problem

**Resolution:**
- Added new Goal #5 to BRD v2: **Session Entropy Resistance**
- Articulated the problem: "Long-running agent sessions suffer from entropy—tasks get lost, kanban boards go stale, state drifts from ephemeral session memory."
- Made explicit: AOF must provide durable task state that survives session compaction, restarts, and context loss

---

## Recommendations for Future Process Improvements

1. **Automated Linter in CI:** Run `npx aof lint` on every commit to catch schema violations early
2. **Daily Board Reconciliation:** Architect runs a daily check comparing git activity vs kanban board state
3. **Mandatory Task Creation:** Update agent prompts to refuse work without a task card
4. **Board View Generation:** Consider automated view regeneration on task state changes (Phase 2 feature)
5. **Status Directory Cleanup:** Either remove unsupported directories (`pending/`, `assigned/`, etc.) or extend schema to include them with clear transition rules
6. **Pre-commit Hook:** Add a pre-commit hook that validates task IDs match schema regex

---

## Lessons Learned

1. **Tooling alone doesn't enforce process.** The scheduler, linter, and CLI existed but weren't used consistently.
2. **Friction kills discipline.** If creating a task card is harder than just doing the work, people skip it.
3. **Visibility creates accountability.** Once the board was populated, gaps became obvious.
4. **The SWE team must dogfood AOF.** If we don't use our own tools, how can we expect others to?

---

**Next Steps:**
- [ ] Review and approve this gap analysis (swe-architect)
- [ ] Share with Demerzel for awareness
- [ ] Add linter to CI pipeline
- [ ] Schedule weekly board review cadence
