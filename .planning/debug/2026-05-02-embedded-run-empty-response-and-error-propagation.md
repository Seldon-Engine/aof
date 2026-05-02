# 2026-05-02 — Embedded-run empty-response + error-propagation gap

## Symptom

Re-dispatched two spear-phishing-pipeline tasks via daemon IPC (with `timeoutMs: 3600000` to fix the original 5min-timeout deadletter). Both ran briefly (48s and 32s respectively), the AOF daemon log reported `agent run completed` cleanly with no error, but neither task called `aof_task_complete`. Completion-enforcement transitioned both to `blocked/` after one dispatch attempt.

- TASK-2026-05-02-Kmxfd5iy (Spear Phishing Pipeline: Neon Health re-dispatch) — 48,032 ms run, blocked
- TASK-2026-05-02-FNDgZMPG (Spear Phishing Pipeline: Medplum re-dispatch) — 32,397 ms run, blocked

Neither task left a session JSONL file in `~/.openclaw/agents/researcher/sessions/`. The sessions index `~/.openclaw/agents/researcher/sessions/sessions.json` has no entry for the dispatched sessionId.

## Root cause (proximate)

OpenClaw's embedded runner is detecting `incomplete turn` with `stopReason=stop payloads=0` — the model returned an HTTP 200 response with `stop_reason: "stop"` but produced **zero content** (no text, no tool calls, no thinking). OpenClaw logs this and "surfaces error to user" — but the surfacing path doesn't propagate the error back through `runEmbeddedPiAgent`'s return value's `meta` object. AOF sees clean `meta` and treats the run as a success.

Pattern from `~/.openclaw/logs/gateway.err.log`:

```
2026-05-01T23:14:56.069-04:00 [agent/embedded] incomplete turn detected:
  runId=d73e4a54-... sessionId=d73e4a54-... stopReason=stop payloads=0
  — surfacing error to user
```

This pattern appears 16+ times in the last 8 hours, every ~30 minutes (matches AOF scheduler poll interval). Affects multiple agents: `researcher`, `swe-backend`, `swe-qa`. All embedded subagent runs — heartbeat-driven main sessions are unaffected (verified: swe-architect's interactive Telegram session at 02:15-02:17 UTC worked fine).

## Root cause (deeper, possible)

Why would the model return `stop_reason: "stop"` with zero content?

Candidates (need verification):

1. **AGENTS.md truncation + prompt structure.** Gateway log shows `workspace bootstrap file AGENTS.md is 12136 chars (limit 10000); truncating in injected context` for every embedded run. If the truncation cuts in the middle of structured context (markdown section, tool-use guidance, etc.), the resulting prompt may look "complete-but-trivially-answerable" to the model.
2. **Empty-completion pattern from Anthropic.** Some prompt shapes produce empty completions on Anthropic — usually when the model interprets the prompt as "nothing to do" or hits an internal refusal that surfaces as silence rather than refusal text.
3. **Model selection mismatch.** The AOF dispatch passes `provider/model/authProfileId` from the agent config (post-Phase-43 fix). If the configured model doesn't accept the prompt shape, or if there's a model-version mismatch, this could surface as silent stop.
4. **Token-budget edge case.** If `max_tokens` is set very low, the model can stop with `stop_reason: "stop"` and zero content if the first sampled token is an end-of-turn marker.

There are also occasional explicit error returns from Anthropic — verified in the log:

```
2026-05-01T18:07:55 [agent/embedded] embedded run agent end:
  runId=30371d39-... isError=true
  model=claude-sonnet-4-6 provider=anthropic-api
  error=The AI service is temporarily overloaded. Please try again in a moment.
  rawError={"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}, ...}
```

These "hard error" entries show up only ~5 times in multi-day history, while `payloads=0` shows up 16+ times in 8 hours. The hard-error path correctly sets `isError=true` and presumably propagates back. The soft-error (`payloads=0`) path doesn't.

## Impact

**Most/all AOF-dispatched embedded runs are silently degrading.** Tasks dispatched this way:
1. Get spawned correctly
2. Agent receives the prompt
3. Model returns empty content
4. OpenClaw logs `incomplete turn` but returns clean meta
5. AOF reports `agent run completed`
6. `aof_task_complete` was never called
7. Completion-enforcement transitions to `blocked` (1st failure) → eventually `deadletter` (3rd failure)
8. Task stuck

Interactive sessions (heartbeat-driven main sessions) are unaffected because they don't go through `runEmbeddedPiAgent`'s embedded-run code path — they use the live agent's session-lane runner.

## Fix surface

**Upstream (OpenClaw):**
- `runEmbeddedPiAgent` should return `meta: { error: { kind: "incomplete_turn", message: "model returned 0 payloads" } }` for the `payloads=0` case, parallel to how it handles `overloaded_error` etc.
- Or: investigate why `payloads=0` is happening at all (the deeper root cause from candidates 1-4 above).

**AOF defensive (within our codebase):**
- `assign-helpers.ts:handleRunComplete` already checks `outcome.error` and classifies via `classifySpawnError`, but if OpenClaw returns clean meta, AOF sees no error to classify.
- Heuristic candidate: a run that lasts <60s with zero `aof_task_*` tool calls is probably a model failure, not a "the agent forgot." Could detect by looking at the EventLogger log for the dispatched task — if no `protocol.message.received` events fired, the agent never executed any tool, almost certainly didn't see anything useful.
- Add a new error classification: `errorClass: "model_silent_failure"` → deadletter immediately like `permanent`, don't burn retry budget on a model that's silently producing nothing.

**Phase 49E sub-bullet (architectural):**
- 49E-7: Embedded-run error-propagation contract. Make explicit which OpenClaw embedded-run failure modes propagate to `meta.error` and which don't; for the "don't" set, AOF needs defensive heuristics. Companion LADR: 0015-embedded-run-error-contract.md.

## What to do with the two blocked tasks

Leave them in `blocked/` for now. Re-dispatching when the model behavior is unstable would just produce more blocked tasks. Once the embedded-run failure mode is understood (or Anthropic's transient overload subsides), re-dispatch via the same IPC pattern — but verify a single test agent run completes successfully BEFORE re-dispatching real work.

## What this implies for the system right now

While the `payloads=0` pattern persists, **AOF dispatched-task success rate is roughly zero for embedded-run tasks**. This explains the daily-triage and pipeline tasks deadlettering throughout April. The 5min-timeout-bug + the 5min-timeout-fix didn't actually solve the broader silent-failure problem — it just stopped the timeout-specific failures while leaving this one unobserved.

Worth running an explicit dispatch test against a known-simple task (e.g. "respond with 'OK'") to characterize whether the `payloads=0` pattern is prompt-structure-dependent or universal across all embedded runs right now. If universal → Anthropic API issue or auth/credentials issue. If prompt-dependent → AOF or OpenClaw prompt assembly issue.

## Related artifacts

- Original deadletter cluster cleanup: `scripts/expunge-stale-subscriptions.mjs` (commit `77e9dfe`)
- Prompt-text mitigation for wake notifications (separate issue, same area): commit `9c1e5c8`
- AOF defensive heuristic + first-occurrence deadletter (commit `76e8ea6`)
- Instrumentation for next occurrence (this section's pointers — commit landing 2026-05-02)
- Phase 49E (wake-notification redesign + ephemeral-session redirect + subscription deadletter): `.planning/phases/49-architecture-realignment-delete-restructure-swap-wheels/49-CONTEXT.md`

---

## Debug recipe — when this fires next time

Step 1 — **Confirm it fired and how often.**
```bash
# Count silent-failure events in today's log
grep -c '"type":"silent_model_failure"' ~/.aof/data/events/$(date +%Y-%m-%d).jsonl

# Last 10 occurrences with full payload
grep '"type":"silent_model_failure"' ~/.aof/data/events/$(date +%Y-%m-%d).jsonl | tail -10 | python3 -m json.tool

# Or via metrics endpoint (if metrics scrape is up)
curl -s http://localhost:9090/metrics | grep aof_silent_model_failures_total
```

Step 2 — **Pick a representative failed task.** From the event payload you get `taskId`, `sessionId`, `agent`, `correlationId`, and an `investigation` block with `expectedSessionFile` + `grepHint`.

Step 3 — **Confirm the model returned nothing.**
```bash
# Match the AOF sessionId to the OpenClaw runId — they're the same UUID.
# Check OpenClaw's gateway error log for the underlying payloads=0 entry:
grep -E "incomplete turn detected.*sessionId=$SESSION_ID" ~/.openclaw/logs/gateway.err.log

# Check if the session file was written at all (true silent failures = missing/empty):
ls -la ~/.openclaw/agents/$AGENT/sessions/$SESSION_ID.jsonl 2>&1
```

If the OpenClaw log shows `payloads=0` and the session file is missing/empty: confirmed silent failure. The model HTTP-200'd with stop_reason="stop" and zero content.

Step 4 — **Determine scope.** Is this one task, one agent, one project, or universal?
```bash
# Group by agent
grep '"type":"silent_model_failure"' ~/.aof/data/events/*.jsonl | \
  python3 -c "import json,sys,collections; c=collections.Counter(); 
[c.update([json.loads(l.split(':',1)[1])['payload']['agent']]) for l in sys.stdin if 'silent_model_failure' in l]; 
print(c)"

# If it correlates with a specific agent → likely a per-agent prompt or model config issue
# If it spreads across all agents → likely an Anthropic API issue or AOF/OpenClaw global prompt problem
# If it correlates with a specific time-of-day pattern → likely an upstream rate-limit / capacity issue
```

Step 5 — **Determine root cause candidates.**
1. **Universal cross-agent + recent onset** → Anthropic capacity/credential issue. Check `~/.openclaw/logs/gateway.err.log` for `overloaded_error` or `401`/`429` entries near the failures.
2. **Per-agent + persistent** → That agent's `AGENTS.md` is being truncated (current limit 10000 chars; check `[agent/embedded] workspace bootstrap file AGENTS.md is X chars; truncating` log entries). Truncation can cut mid-sentence and produce malformed prompts.
3. **Per-prompt-shape** → Compare the `params.prompt` shape vs known-working dispatches. Most likely differentiator: the `formatTaskInstruction` template in `src/openclaw/openclaw-executor.ts:formatTaskInstruction` plus the routing payload.
4. **Model-version mismatch** → Verify `agent.model` config matches what OpenClaw is actually invoking. The Phase 47 dispatch-fix made AOF pass `provider/model/authProfileId` explicitly; if the agent's configured model is unsupported by the resolved auth profile, you can get silent stops.

Step 6 — **If root cause = transient (overload, rate limit):** wait it out and re-dispatch. Heuristic prevents wasted retries; the task is correctly deadlettered and visible in `aof_status_report`.

Step 7 — **If root cause = systemic (truncation, prompt shape, model mismatch):** file the upstream OpenClaw fix per Phase 49E-7 OR fix the AOF-side prompt assembly OR fix the agent config.

---

## CLEANUP CHECKLIST — what to remove when investigation closes

The instrumentation added in commit landing 2026-05-02 (after this doc) is investigation scaffolding. Some pieces are temporary; some should stay long-term as monitoring infrastructure. Track every `INSTRUMENTATION-2026-05-02` comment in source for the full inventory; this section is the authoritative removal/retention plan.

**Definition of "investigation closed":**
- Either: upstream OpenClaw fix lands so `payloads=0` propagates as `meta.error` AND the AOF defensive heuristic has fired zero times for ≥7 consecutive days post-fix
- Or: root cause is identified as something other than the OpenClaw error-contract gap (e.g. Anthropic capacity, AGENTS.md truncation), AOF defensive heuristic stays as a long-term safety net, and only the verbose investigation-pointer instrumentation is removed.

**REMOVE on close:**

| Item | File | Why remove |
|---|---|---|
| Cross-reference pointer block in `handleRunComplete` (`investigationPointers`, `expectedSessionFile`, `grepHint`) | `src/dispatch/assign-helpers.ts` | Verbose for normal operation; useful only while actively investigating. The `silent_model_failure` event payload's `agent` + `sessionId` are sufficient for any future repeat. |
| `silentFailureExpectedSessionFile` metadata field stamping | `src/dispatch/assign-helpers.ts` (in `taskForMeta.frontmatter.metadata` enforcement block) | Same reason as above — bloats task frontmatter for normal operation. |
| `phase: "49E-7"` field on the `silent_model_failure` event payload | `src/dispatch/assign-helpers.ts` | Phase reference becomes meaningless after cleanup; the event itself is self-explanatory. |
| This entire "Debug recipe" section | `.planning/debug/2026-05-02-...md` | Recipe targets the specific failure mode + investigation context. Once root cause is fixed, recipe becomes wrong/misleading. |
| This CLEANUP CHECKLIST | `.planning/debug/2026-05-02-...md` | Self-deletes when checklist is complete. |
| Phase 49E-7 entry in ROADMAP + 49-CONTEXT | `.planning/ROADMAP.md`, `.planning/phases/49-.../49-CONTEXT.md` | Done when investigation closes. Keep as historical record OR move to a "completed sub-plans" archive. |

**KEEP long-term (becomes monitoring infrastructure):**

| Item | File | Why keep |
|---|---|---|
| `silent_model_failure` event type in schema | `src/schemas/event.ts` | Defensive monitoring — if the failure mode returns post-fix, we want to see it immediately. Notification rule can target this event. |
| `aof_silent_model_failures_total` Prometheus counter | `src/metrics/exporter.ts` | Same reason — long-term safety net + zero-rate becomes a positive signal that the upstream fix is holding. |
| `isLikelyModelSilentFailure` heuristic + `errorClass: "model_silent_failure"` short-circuit | `src/dispatch/scheduler-helpers.ts`, `src/dispatch/failure-tracker.ts`, `src/dispatch/assign-helpers.ts` | Defensive: even with the upstream fix, we want immediate-deadletter behavior for any future silent-failure mode that appears (different OpenClaw bug, different model API quirk). The heuristic is generic enough to catch future variants. |
| Regression test `bug-2026-05-02-embedded-run-silent-failure-detection.test.ts` | `src/dispatch/__tests__/` | Standard regression-test convention. Prevents the heuristic from being accidentally removed in a future refactor. |
| Brief comment block in `handleRunComplete` referencing this debug doc + Phase 49E-7 | `src/dispatch/assign-helpers.ts` | One-line "see also" pointer is normal code documentation; a verbose instrumentation block isn't. |

**TODO before closing (to wire up the kept pieces fully):**

| Item | File | Status |
|---|---|---|
| Increment `silentModelFailuresTotal.inc({ agent, project })` from `handleRunComplete` | `src/dispatch/assign-helpers.ts` + `src/metrics/exporter.ts` | Counter is registered but not yet incremented. Needs metrics plumbed through OnRunCompleteContext (signature change cascades to executeAssignAction → handleAssign → executeActions). Defer until someone touches that path; until then `aof_silent_model_failures_total` reports `0` which still proves "no fires" via the event log instead. |
| Stronger heuristic signal: count `aof_task_*` tool invocations via EventLogger before classifying | `src/dispatch/scheduler-helpers.ts` (or new helper) | Today's heuristic is duration-based only. A 60s task that DID call `aof_task_update` (just not `_complete`) is currently classified as silent failure but probably isn't. Phase 49E-7 acceptance criterion. |
| Investigation note: did the original spear-phishing re-dispatch incident TASK-2026-05-02-Kmxfd5iy + FNDgZMPG re-test cleanly? | (this doc) | Test plan: dispatch a known-trivial task ("respond with 'OK' and call aof_task_complete with summary='ok'"); verify it completes. Re-dispatch the spear-phishing pair only after verification. |
