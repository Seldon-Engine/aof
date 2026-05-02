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
- Phase 49E (wake-notification redesign + ephemeral-session redirect + subscription deadletter): `.planning/phases/49-architecture-realignment-delete-restructure-swap-wheels/49-CONTEXT.md`
