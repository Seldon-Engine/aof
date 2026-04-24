---
phase: 44
status: partial
created: 2026-04-24
source_scenario: A
---

# Phase 44 — UAT Scenario A: Observations

## Scenario A outcome: PARTIAL PASS (Phase 44 side works; OpenClaw Telegram extension is broken)

### Phase 44 contracts: all satisfied

The wake-up for the `review` transition delivered successfully to the dispatcher's Telegram topic. Every Phase 44 invariant was observed in the daemon log for `TASK-2026-04-24-001` (aof project):

- `wake-up.attempted` fired with `dispatcherAgentId: "main"` (D-44-IDENTITY)
- `wake-up.delivered` fired for `toStatus: review` (D-44-GOAL on the live `review` transition)
- Subscription on disk carries `capturedAt`, `pluginId: "openclaw"`, `dispatcherAgentId: "main"` (D-44-SCHEMA)
- Recovery pass ran on daemon boot and replayed 9 + 4 stale subscriptions (D-44-RECOVERY)
- `wake-up.*` structured events present with full identity fields (D-44-OBSERVABILITY)

The user observed the review wake-up in the Telegram chat as `"Task ready for review: TASK-2026-04-24-001 ..."`.

### OpenClaw Telegram extension: broken, unrelated to Phase 44

The `done` wake-up failed at the OpenClaw boundary. Two distinct errors repeat across every historical and recent wake-up in the daemon log:

1. `Telegram bot token missing for account "default" (set channels.telegram.accounts.default.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`
2. `Cannot find module './send-DlzbQJQs.js'` — `Require stack: /opt/homebrew/lib/node_modules/openclaw/dist/extensions/telegram/channel-De1dz7WA.js`

Both errors are visible in the daemon log for task IDs dating back to 2026-04-18, well before Phase 44 deployed. Phase 44 actually made them observable for the first time via the `wake-up.failed` telemetry — previously they were swallowed by the older delivery chain.

### Evidence

```
# Daemon log for TASK-2026-04-24-001 probe:
rg "wake-up\." ~/.aof/data/logs/daemon-stderr.log | rg TASK-2026-04-24-001

16:09:05.739  wake-up.attempted      toStatus=review  dispatcherAgentId=main   ✓
16:09:06.236  wake-up.delivered      toStatus=review  dispatcherAgentId=main   ✓  ← user saw this
16:09:06.259  wake-up.attempted      toStatus=done                              ✓
16:09:06.279  wake-up.failed         toStatus=done    kind=send-failed          ✗  OpenClaw
16:09:06.284  wake-up.attempted      toStatus=done    (retry)                   ✓
16:09:06.301  wake-up.failed         toStatus=done    kind=send-failed          ✗  OpenClaw
```

```
# Subscription on disk (TASK-2026-04-24-001 in aof project):
~/.aof/data/Projects/aof/tasks/done/TASK-2026-04-24-001/subscriptions.json

{
  "id": "e9d0dca1-cc74-474f-a274-e0ad652545ac",
  "delivery": {
    "kind": "openclaw-chat",
    "sessionKey": "agent:main:telegram:group:-1003844680528:topic:1",
    "sessionId": "ccdef039-8276-4ce5-9fe4-6ef86d877f2f",
    "dispatcherAgentId": "main",        ← Phase 44 ✓
    "capturedAt": "2026-04-24T16:09:02.667Z",   ← Phase 44 ✓
    "pluginId": "openclaw"               ← Phase 44 ✓
  },
  "notifiedStatuses": ["review"],        ← review delivered successfully
  "attempts": [
    { "attemptedAt": "16:09:05.739Z", "success": true,  "toStatus": "review" },
    { "attemptedAt": "16:09:06.259Z", "success": false, "toStatus": "done",
      "error": { "kind": "send-failed",
                 "message": "Telegram bot token missing for account 'default' ..." } },
    { "attemptedAt": "16:09:06.284Z", "success": false, "toStatus": "done",
      "error": { "kind": "send-failed",
                 "message": "Cannot find module './send-DlzbQJQs.js' ..." } }
  ]
}
```

## Follow-up work (separate from Phase 44)

The OpenClaw Telegram extension issues should be tracked independently of AOF Phase 44:

1. **Bot token config** — `channels.telegram.accounts.default.botToken` or `TELEGRAM_BOT_TOKEN` is not reaching the gateway process. Check the `op run` wrapper's env-file and 1Password state. Possible regression from the last OpenClaw upgrade.

2. **Missing chunk `./send-DlzbQJQs.js`** — this is a broken chunk hash reference inside the installed OpenClaw package at `/opt/homebrew/lib/node_modules/openclaw/dist/extensions/telegram/`. Either the package was upgraded in-place without clearing caches, or a webpack/rollup chunk split was generated against a different entry graph. Running `npm install -g openclaw@latest --force` or reinstalling the OpenClaw gateway should restore the missing chunk.

Both issues pre-date Phase 44. Neither affects the Phase 44 acceptance criteria.

## Recommended resolution

- Close Phase 44 as PASSED based on the review-status wake-up delivery (the acceptance criterion is "dispatcher session receives wake-up when task transitions to terminal-like state"; `review` is a terminal-like state in the notifyOn default set).
- File the two OpenClaw issues under a new openclaw-side ticket (out-of-scope for AOF).
- Optionally: defer Scenarios B, C, D until the OpenClaw Telegram extension is repaired, at which point the full suite can be re-run.
