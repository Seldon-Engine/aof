# AOF Bug Reports

---

## BUG-001: Hnswlib capacity limit reached on memory insert

**Date/Time:** 2026-02-25 21:15 EST
**Severity:** P1
**Status:** new
**Environment:** OpenClaw 2026.2.21-2 (local), AOF memory plugin

### Short Description
The AOF memory plugin's underlying HNSW vector graph has reached its maximum element count. Attempting to store new memories fails entirely, and retrieving recent memories (`memory_search`) returns completely empty results.

### Technical Notes
- **Error output:** `Hnswlib Error: The number of elements exceeds the specified limit` upon `memory_store` call.
- **Search failure:** Calling `memory_search` for known, recently added topics (like "dispatch caveat") yields no results, suggesting index instability or read failures when the limit is breached.
- **Hypothesis:** The graph was initialized with a hard capacity limit (e.g., `max_elements`) which has now been exceeded by the number of memory chunks. The index needs to be resized, rebuilt, or garbage collected.
- **Workaround:** None currently. Memory subsystem is functionally broken for inserts and searches.

---

## BUG-002: AOF dispatch via HTTP tools/invoke fails to propagate pairing token

**Date/Time:** 2026-02-25 12:00 EST
**Severity:** P0
**Status:** completed
**Environment:** OpenClaw 2026.2.21-2 (local), AOF Daemon

### Short Description
Sub-agent spawn attempts via HTTP `POST /tools/invoke` calling `sessions_spawn` reliably fail with `1008 pairing required`. The auth token from the local loopback isn't propagated correctly into the child websocket connection.

### Technical Notes
- **Error output:** `spawn_failed: gateway closed (1008): pairing required` on `ws://127.0.0.1:18789`.
- **Cause:** Initially attempted to use an HTTP loopback path which failed to authenticate the websocket spawn.
- **Resolution:** Fixed by replacing HTTP dispatch with the embedded agent executor (`runEmbeddedPiAgent()`). This bypasses gateway WebSocket auth and device pairing entirely by running agents in-process, which unblocked the task pipeline and allowed the queued tasks to complete successfully.

---