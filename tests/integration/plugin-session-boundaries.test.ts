/**
 * Phase 43 — OpenClaw plugin session boundaries (RED scaffold, Wave 0).
 *
 * OpenClaw reloads the AOF plugin on every agent session. Phase 43's thin-
 * bridge design (D-11) must survive that reload:
 *   - `ensureDaemonIpcClient` returns the SAME `DaemonIpcClient` singleton on
 *     repeated `registerAofPlugin(api, opts)` calls (cachedClient module-level).
 *   - `startSpawnPollerOnce` is idempotent — double-register does NOT start
 *     two long-polls against the daemon.
 *   - Tool registrations are idempotent (safe to re-invoke `api.registerTool`
 *     for the same name across reload boundaries).
 *
 * RED status: Wave 0 scaffold. Both `src/openclaw/daemon-ipc-client.ts` and
 *   `src/openclaw/spawn-poller.ts` are Wave 3 files. Until they land, the
 *   assertions below are wrapped in `it.todo` blocks so the scaffold collects
 *   cleanly and does not trigger import-time failures.
 *
 * See 43-02-SUMMARY.md for the full list of Wave-3-dependent TODOs.
 */

import { describe, it } from "vitest";
// Type-only import — signals that Wave 3 assertions will consume the harness
// via startTestDaemon; no runtime wiring until the todos below are enabled.
import type { TestDaemon } from "./helpers/daemon-harness.js";

const SHOULD_RUN = process.env.AOF_INTEGRATION === "1";

// Suppress unused-type warnings while the assertions are it.todo.
export type __WaveThreeHarnessType = TestDaemon;

describe.skipIf(!SHOULD_RUN)(
  "Phase 43 — plugin session boundaries (D-11)",
  () => {
    // Wave 3 lands src/openclaw/daemon-ipc-client.ts + src/openclaw/spawn-poller.ts.
    // Until then we declare the contract via it.todo so vitest collects the file
    // cleanly and the RED coverage stays visible in the test report.

    it.todo(
      "double-register returns the same DaemonIpcClient singleton (enable after 43-06 lands)",
    );

    it.todo(
      "startSpawnPollerOnce is idempotent — second register does not open a second long-poll (enable after 43-06 lands)",
    );

    it.todo(
      "re-registering tools across OpenClaw session reload is a no-op on the daemon (enable after 43-06 lands)",
    );
  },
);
