/**
 * Phase 43 — D-06 IPC tool invoke round-trip (RED scaffold, Wave 0).
 *
 * Covers the `POST /v1/tool/invoke` single-envelope contract (D-06):
 *   - Parametric over a selection of tools from `toolRegistry`.
 *   - Success path returns `{ result: ... }`.
 *   - Missing `name` returns `{ error: { kind: "validation" } }`.
 *   - Unknown tool returns `{ error: { kind: "not-found" } }`.
 *
 * RED status: This scaffold will fail against the current daemon because the
 *   `/v1/tool/invoke` route is not yet mounted (Wave 1 adds it). When
 *   `AOF_INTEGRATION=1` is unset the whole block skips so the unit suite
 *   (`npm test`) stays green.
 *
 * Tool selection (documented in 43-02-SUMMARY.md):
 *   - `aof_status_report`:     empty object params — safest round-trip probe.
 *   - `aof_task_subscribe`:    needs { taskId, subscriberId } — exercises the
 *                              non-empty param path without mutating real state
 *                              (daemon runs dryRun=true → no scheduler firing).
 *   Additional tools (aof_dispatch, aof_task_cancel, …) are deferred; they
 *   require deeper fixture setup (valid task file, agent org chart) and
 *   would make the RED scaffold too brittle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  startTestDaemon,
  type TestDaemon,
} from "./helpers/daemon-harness.js";
import { invokeTool } from "./helpers/plugin-ipc-client.js";

const SHOULD_RUN = process.env.AOF_INTEGRATION === "1";

describe.skipIf(!SHOULD_RUN)(
  "Phase 43 — tool invoke round-trip (D-06)",
  () => {
    let daemon: TestDaemon;

    beforeEach(async () => {
      daemon = await startTestDaemon();
    });

    afterEach(async () => {
      await daemon.stop();
    });

    it.each([
      {
        name: "aof_status_report",
        params: {} as Record<string, unknown>,
      },
      {
        name: "aof_task_subscribe",
        params: {
          taskId: "fake-task-id-43-02",
          subscriberId: "aof-test-subscriber",
        } as Record<string, unknown>,
      },
    ])(
      "round-trip: $name returns { result }",
      async ({ name, params }) => {
        const response = await invokeTool(daemon.socketPath, {
          name,
          params,
          toolCallId: `test-${name}-${Date.now()}`,
        });

        // RED: until Wave 1 mounts /v1/tool/invoke this will fail — the daemon
        // currently returns 404 "Not Found". Wave 1 must make this pass by
        // routing to toolRegistry[name].handler.
        expect(response.error).toBeUndefined();
        expect(response).toHaveProperty("result");
      },
    );

    it("invalid envelope (missing name) returns validation error", async () => {
      const response = await invokeTool(daemon.socketPath, {
        // @ts-expect-error — intentionally malformed for validation path
        name: undefined,
        params: {},
        toolCallId: "test-invalid-envelope",
      });

      expect(response.error).toBeDefined();
      expect(response.error?.kind).toBe("validation");
    });

    it("unknown tool name returns not-found error", async () => {
      const response = await invokeTool(daemon.socketPath, {
        name: "aof_this_tool_does_not_exist_43_02",
        params: {},
        toolCallId: "test-unknown-tool",
      });

      expect(response.error).toBeDefined();
      expect(response.error?.kind).toBe("not-found");
    });
  },
);
