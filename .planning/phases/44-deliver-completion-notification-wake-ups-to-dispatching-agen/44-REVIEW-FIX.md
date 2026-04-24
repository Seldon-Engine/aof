---
phase: 44
fixed_at: 2026-04-24
review_path: .planning/phases/44-deliver-completion-notification-wake-ups-to-dispatching-agen/44-REVIEW.md
iteration: 1
findings_in_scope: 3
fixed: 2
skipped: 0
status: all_fixed
---

# Phase 44: Code Review Fix Report

**Fixed at:** 2026-04-24
**Source review:** .planning/phases/44-deliver-completion-notification-wake-ups-to-dispatching-agen/44-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 3 (WR-01, WR-02, WR-03 — critical+warning scope; info findings IN-01..IN-05 excluded by scope)
- Fixed: 2 commits (WR-01 and WR-02 resolved together as a single coordinated fix per the reviewer's Option 1 guidance)
- Skipped: 0

All three in-scope warnings were addressed. Per the reviewer's own analysis, WR-01 and WR-02 have the same root cause (the boot-time race between the recovery IIFE and the live notifier + polling loop) and the reviewer's preferred fix (Option 1 / Option B — "gate the live listener attach until replay completes") resolves both with a single code change. They are therefore captured in one atomic commit rather than two artificially split commits.

## Fixed Issues

### WR-01 + WR-02: Serialize wake-up replay before attaching live listener

**Files modified:** `src/daemon/daemon.ts`
**Commit:** 04dd8b7
**Applied fix:**

Moved `logger.addOnEvent((event) => chatNotifier.handleEvent(event))` from its original position immediately after `chatNotifier` construction (pre-IIFE) into the tail of the async recovery IIFE — executed only after `replayUnnotifiedTerminals(store)` resolves for the base store AND for every discovered project store.

This matches the reviewer's Option 1 (WR-01) and Option B (WR-02) simultaneously:
- **WR-01 closed:** the live `handleEvent` path cannot race the replay's per-subscription `notifiedStatuses` read-modify-write window, because the live listener literally does not exist until replay has drained.
- **WR-02 closed:** polling still starts at `service.start()` (unchanged fire-and-forget semantics preserved — T-44-10's startup-latency goal is intact), but any transition the poller produces during the boot window is held at the `logger.addOnEvent` boundary: no live handler is attached yet, so the event is a no-op for the chat-notifier path. Once replay completes and the listener attaches, subsequent transitions flow normally. Terminal transitions that happen during the replay window are already handled by the replay's own terminal-status scan — delivering exactly once via the shared `notifiedStatuses` ledger.

The IIFE's outer `.catch()` safety net still fires if any synchronous setup throws, and the inner `try/catch` blocks still isolate per-project failures. An extended comment block was added at the IIFE to document the WR-01/WR-02 rationale for future readers.

**Verification:**
- Tier 1: re-read the modified region (lines 194-253) — `addOnEvent` now lives at line 250, inside the IIFE body, after both the unscoped-store replay and the per-project replay loop.
- Tier 2: `npx tsc --noEmit` clean (no new diagnostics).

**Requires human verification:** No — this is a structural ordering change, not a logic bug. The reviewer explicitly preferred this shape ("Option 1 is simpler and matches the invariant the docstring already claims").

---

### WR-03: Anchor `parseSessionKey` topic suffix to exact index

**Files modified:** `src/openclaw/chat-message-sender.ts`
**Commit:** 43d65a4
**Applied fix:**

Replaced the free linear scan `parts.indexOf("topic", 5)` with an explicit positional check `parts.length >= 7 && parts[5] === "topic"`, matching the sessionKey schema's documented shape `agent:<agentId>:<platform>:<chatType>:<chatId>[:topic:<topicId>]` where the suffix anchor lives at exactly index 5.

This removes the silent-mis-route hazard where a chatId or chatType segment literally equal to the 7-character string `"topic"` would be consumed by the topic-suffix scan and produce a bogus `threadId` binding. No existing test in the tree constructs a 6-part key (that's the exact foot-gun shape the fix closes), so no test updates were needed; the existing 4-part and 5-part test fixtures in `src/openclaw/__tests__/openclaw-chat-delivery.test.ts` are unaffected by the tighter anchor.

Added an inline comment documenting the rationale and explicitly referencing the review finding ID.

**Verification:**
- Tier 1: re-read the modified region (lines 93-102) — new anchor check is present, comment explains why.
- Tier 2: `npx tsc --noEmit` clean.

**Requires human verification:** No — this is a shape-tightening fix that strictly narrows the set of inputs accepted as "has topic suffix." It cannot introduce new behavior for any input that was previously being parsed correctly (6-part keys and 7-part keys where parts[5] === "topic" behave identically; 7-part keys where parts[5] !== "topic" — the bug case — now correctly fall through).

---

_Fixed: 2026-04-24_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
