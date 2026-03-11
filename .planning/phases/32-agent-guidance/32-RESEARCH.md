# Phase 32: Agent Guidance - Research

**Researched:** 2026-03-11
**Domain:** SKILL.md documentation update (subscription/callback behavior)
**Confidence:** HIGH

## Summary

Phase 32 is a documentation-only phase: update SKILL.md to document subscription tools, the `subscribe` parameter on `aof_dispatch`, callback behavior, and idempotency expectations. No code changes are required beyond the SKILL.md file itself.

The primary challenge is the **token budget constraint**. The committed SKILL.md is 1704 tokens -- already at the 50% reduction ceiling (1705.5). Adding any content breaks the `achieves 50%+ reduction from pre-v1.4 baseline` test. Additionally, there are **uncommitted changes** in the working tree that added 6 tool table rows (edit, cancel, block, unblock, dep_add, dep_remove), pushing SKILL.md to 1887 tokens. The phase must address the budget test -- either by compressing existing content to make room, or by adjusting the test ceiling to account for legitimate feature growth.

**Primary recommendation:** Add the subscription documentation (~25 lines, ~200 tokens) and adjust the budget gate test ceiling to accommodate v1.8 feature growth, since the current ceiling was set for v1.4 content and does not account for subscription/callback features.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Add a dedicated `## Subscriptions & Callbacks` section after `## Completion Protocol`
- Add `aof_task_subscribe` and `aof_task_unsubscribe` to the existing Agent Tools table
- Update `aof_dispatch` tool table row to mention `subscribe` param
- Match existing SKILL.md density -- terse bullet points, no prose, ~25 lines for new section
- Contract-focused callback description: "You receive a session with task results. Process it and exit."
- Idempotency as one-line warning: at-least-once delivery, design handlers to be idempotent
- Document depth limit (3) and 2-minute timeout
- Subscribe-at-dispatch: `subscribe: true` (completion) or `subscribe: "all"` (every transition)
- Standalone subscribe/unsubscribe: tool table entries sufficient, no extra guidance
- Subscriber must be a valid agent ID from org chart
- Two-line granularity comparison: `completion` vs `all`
- `all` is superset of `completion` -- no need for both
- Brief usage guidance for each granularity
- Do NOT describe batched transition payload details

### Claude's Discretion
- Exact wording and line ordering within the new section
- Whether to use a small table or bullet list for granularity comparison
- How to compress the tool table descriptions for subscribe/unsubscribe

### Deferred Ideas (OUT OF SCOPE)
None.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| GUID-01 | SKILL.md documents callback behavior and idempotency expectations for agents | Tool table rows, new Subscriptions & Callbacks section, budget gate adjustment |
</phase_requirements>

## Architecture Patterns

### Current SKILL.md Structure (206 lines committed)
```
skills/aof/SKILL.md
  - YAML frontmatter (name, description, version, requires)
  - # AOF -- Agentic Ops Fabric (intro line)
  - ## Agent Tools (table, 13 rows currently)
  - ## DAG Workflows (composing, examples, key fields, conditions, pitfalls)
  - ## Workflow Patterns (coordinator, worker, blocked, dependency chains)
  - ## Inter-Agent Protocols (envelope, types table, outcomes table)
  - ## Org Chart (example yaml, agent id note)
  - ## Projects (bullet list)
  - ## Completion Protocol (one-line rule)
  + ## Subscriptions & Callbacks (NEW -- insert after Completion Protocol)
```

### Tool Table Row Pattern
Existing rows follow: `| tool_name | terse purpose | { return_fields } |`. No parameter details -- schemas provide those at call time.

### Section Density Pattern
Sections use terse bullet points, no prose paragraphs. Cross-references between sections where relevant (e.g., "see DAG section").

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Token counting | Custom tokenizer | `estimateTokens()` from `src/context/budget.ts` | 4-chars-per-token heuristic already used by CI test |

## Common Pitfalls

### Pitfall 1: Budget Gate Test Failure
**What goes wrong:** Adding any content to SKILL.md breaks the `achieves 50%+ reduction from pre-v1.4 baseline` test because committed SKILL.md is already at 1704 tokens (ceiling is 1705.5).
**Why it happens:** The 50% reduction ceiling was set in v1.4 (Phase 24) based on pre-v1.4 SKILL.md of 3411 tokens. The ceiling does not account for new features added in v1.8.
**How to avoid:** Adjust the budget gate test. Two options:
  1. **Bump PRE_V14_SKILL_BASELINE_TOKENS test or change the reduction target** -- e.g., require 40% reduction instead of 50%, or raise the baseline
  2. **Replace the 50% test with a hard ceiling** -- the `BUDGET_CEILING_TOKENS = 2150` test already provides the real guard; the 50% reduction test is a legacy metric
**Recommendation:** Raise `BUDGET_CEILING_TOKENS` to accommodate v1.8 additions (current total ~1872 committed; after additions ~2100; set ceiling to ~2500) and either relax or remove the 50% reduction assertion since it was a one-time improvement metric, not an ongoing invariant.
**File:** `src/context/__tests__/context-budget-gate.test.ts`

### Pitfall 2: Uncommitted Working Tree Changes
**What goes wrong:** The working tree already has uncommitted SKILL.md changes (6 new tool table rows added: edit, cancel, block, unblock, dep_add, dep_remove) that push tokens to 1887. These were not part of any committed phase.
**Why it happens:** Prior work added these rows but did not commit or adjust the budget test.
**How to avoid:** Phase 32 plan should account for these existing uncommitted changes. Either commit them as part of Phase 32 or revert them if unintended.
**Assessment:** These rows are **correct** -- they match tools registered in `src/mcp/tools.ts` and were missing from the prior compressed SKILL.md. Phase 32 should include them in the commit.

### Pitfall 3: subscribe Parameter Name Mismatch
**What goes wrong:** The CONTEXT.md mentions `subscribe: true` for completion, but the actual Zod schema uses `subscribe: z.enum(["completion", "all"])` -- there is no boolean `true` value.
**Why it happens:** CONTEXT.md used shorthand notation.
**How to avoid:** In SKILL.md, document the actual API: `subscribe: "completion"` or `subscribe: "all"`. Do not use `subscribe: true`.

### Pitfall 4: Exceeding ~25 Line Target
**What goes wrong:** New section grows beyond the ~25 line target, inflating context for every agent session.
**Why it happens:** Temptation to add examples, explain payload structure, or cover edge cases.
**How to avoid:** Stick strictly to contract-level documentation. Count lines before committing.

## Code Examples

### Current Tool Table Row Format (from SKILL.md)
```markdown
| `aof_dispatch` | Create task and assign to agent/team. Accepts `workflow` param (see DAG section). | `{ taskId, status, assignedAgent, filePath, sessionId }` |
```

### New Tool Table Rows (to add)
```markdown
| `aof_task_subscribe` | Subscribe to task outcome notifications | `{ subscriptionId, taskId, granularity, status }` |
| `aof_task_unsubscribe` | Cancel a task outcome subscription | `{ subscriptionId, status }` |
```

### Updated aof_dispatch Row (add subscribe mention)
```markdown
| `aof_dispatch` | Create task and assign to agent/team. Accepts `workflow` (see DAG section) and `subscribe` params. | `{ taskId, status, assignedAgent, filePath, sessionId, subscriptionId }` |
```

### New Section Draft (~22 lines)
```markdown
## Subscriptions & Callbacks

Subscribe to task notifications. Callbacks spawn a new session to the subscriber agent with task results.

- **Subscribe at dispatch:** `subscribe: "completion"` or `subscribe: "all"` param on `aof_dispatch`
- **Subscribe later:** `aof_task_subscribe` tool (subscriberId must be a valid org chart agent ID)
- **Unsubscribe:** `aof_task_unsubscribe` with the subscriptionId

### Granularity

| Granularity | Fires | Use for |
|-------------|-------|---------|
| `completion` | Once on terminal state (done/cancelled/deadletter) | React-on-done workflows |
| `all` | Every status change, batched per poll cycle | Progress monitoring |

`all` is a superset of `completion` -- no need for both on the same task.

### Callback Handler Contract

- You receive a session with task results as context. Process it and exit.
- Delivery is at-least-once. You may receive the same callback more than once. Design handlers to be idempotent.
- Callback chains are depth-limited to 3.
- Callback sessions have a 2-minute timeout -- keep handlers lightweight.
```

## Token Budget Analysis

### Current State (committed)
| Component | Chars | Tokens |
|-----------|-------|--------|
| SKILL.md (committed) | 6814 | 1704 |
| Tool descriptions (tools.ts) | 670 | 168 |
| **Total** | **7484** | **1872** |

### After Phase 32 Additions (estimated)
| Component | Chars | Tokens |
|-----------|-------|--------|
| SKILL.md (with uncommitted rows + new section) | ~8400 | ~2100 |
| Tool descriptions (tools.ts, unchanged) | 670 | 168 |
| **Total** | **~9070** | **~2268** |

### Budget Test Thresholds
| Test | Current Threshold | After Phase 32 |
|------|-------------------|----------------|
| `BUDGET_CEILING_TOKENS` | 2150 | Needs bump to ~2500 |
| 50% reduction from baseline | < 1705.5 | Needs relaxation or removal |
| Regression check (4x inflate) | > ceiling | Auto-adjusts with ceiling |
| Completion protocol content | Pass | Pass (section preserved) |

### Recommended Budget Adjustments
1. Set `BUDGET_CEILING_TOKENS = 2500` (provides ~10% headroom over ~2268 estimated total)
2. Change 50% reduction test to 40% reduction: `expect(skillTokens).toBeLessThan(PRE_V14_SKILL_BASELINE_TOKENS * 0.6)` -- this gives ceiling of 2046, enough for ~2100 SKILL.md tokens
3. OR remove the percentage test entirely and rely solely on the hard ceiling

## Open Questions

1. **Uncommitted SKILL.md changes**
   - What we know: 6 tool table rows were added to working tree but never committed
   - What's unclear: Whether these were from a prior phase that forgot to commit or manual edits
   - Recommendation: Include them in Phase 32 commit since they are correct and needed

2. **Budget test philosophy**
   - What we know: The 50% reduction test was a one-time v1.4 improvement metric
   - What's unclear: Whether the user considers it a permanent invariant or a legacy assertion
   - Recommendation: Relax to 40% or remove; the hard ceiling test is the real guard

## Sources

### Primary (HIGH confidence)
- `skills/aof/SKILL.md` -- current file (read directly, 206 lines)
- `src/context/__tests__/context-budget-gate.test.ts` -- budget gate test (read directly)
- `src/mcp/tools.ts` -- tool registrations and schemas (read directly)
- `src/dispatch/callback-delivery.ts` -- callback behavior constants (read directly)
- `src/context/budget.ts` -- token estimation logic (read directly)

### Verification
- Ran `vitest run context-budget-gate` -- confirmed 50% reduction test already fails on working tree
- Measured committed vs working tree token counts via `wc -c` and `git show`

## Metadata

**Confidence breakdown:**
- SKILL.md content: HIGH -- all source material read from actual codebase
- Token budget analysis: HIGH -- measured directly, ran test to confirm
- Callback behavior details: HIGH -- read from callback-delivery.ts constants and schemas
- Budget adjustment recommendation: MEDIUM -- user may have different preference on test philosophy

**Research date:** 2026-03-11
**Valid until:** 2026-04-11 (stable -- documentation phase, no external dependencies)
