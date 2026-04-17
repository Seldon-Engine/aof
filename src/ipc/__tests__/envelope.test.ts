/**
 * Phase 43 — Wave 0 RED test
 *
 * Covers decisions:
 * - D-06: single invokeTool envelope + error kind shape
 * - D-13: pluginId reserved, defaults to "openclaw"
 *
 * RED anchor: imports from "../schemas.js", which does NOT yet exist. Wave 1
 * lands `src/ipc/schemas.ts` exporting the Zod schemas referenced below.
 */

import { describe, it, expect } from "vitest";
import {
  InvokeToolRequest,
  InvokeToolResponse,
  IpcError,
  IpcErrorKind,
  SpawnRequest,
  SpawnResultPost,
  SessionEndEvent,
  AgentEndEvent,
  BeforeCompactionEvent,
} from "../schemas.js"; // INTENTIONALLY MISSING — Wave 1 creates this module (D-06).

describe("IPC envelope schemas (D-06, D-13)", () => {
  describe("InvokeToolRequest", () => {
    it("D-13: pluginId defaults to 'openclaw' when omitted", () => {
      const parsed = InvokeToolRequest.parse({
        name: "aof_dispatch",
        params: {},
        toolCallId: "t1",
      });
      expect(parsed.pluginId).toBe("openclaw");
    });

    it("D-13: pluginId accepts explicit forward-compat values (e.g. 'slack')", () => {
      const parsed = InvokeToolRequest.parse({
        name: "aof_dispatch",
        params: {},
        toolCallId: "t1",
        pluginId: "slack",
      });
      expect(parsed.pluginId).toBe("slack");
    });

    it("D-06: rejects payloads missing required fields", () => {
      const result = InvokeToolRequest.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((i) => i.path.join("."));
        expect(paths).toEqual(expect.arrayContaining(["name", "params", "toolCallId"]));
      }
    });

    it("D-06: callbackDepth defaults to 0 and accepts explicit integer", () => {
      const zero = InvokeToolRequest.parse({
        name: "aof_dispatch",
        params: {},
        toolCallId: "t1",
      });
      expect(zero.callbackDepth).toBe(0);

      const two = InvokeToolRequest.parse({
        name: "aof_dispatch",
        params: {},
        toolCallId: "t1",
        callbackDepth: 2,
      });
      expect(two.callbackDepth).toBe(2);
    });

    it("D-06: params passes through as record<string, unknown>", () => {
      const parsed = InvokeToolRequest.parse({
        name: "aof_dispatch",
        params: { title: "X", brief: "Y", nested: { z: 1 } },
        toolCallId: "t1",
      });
      expect(parsed.params).toEqual({ title: "X", brief: "Y", nested: { z: 1 } });
    });
  });

  describe("InvokeToolResponse", () => {
    it("D-06: accepts `{ result }` shape", () => {
      const parsed = InvokeToolResponse.parse({ result: { ok: true } });
      expect(parsed).toEqual({ result: { ok: true } });
    });

    it("D-06: accepts `{ error }` envelope with canonical IpcErrorKind", () => {
      const parsed = InvokeToolResponse.parse({
        error: { kind: "validation", message: "bad" },
      });
      expect(parsed).toEqual({ error: { kind: "validation", message: "bad" } });
    });
  });

  describe("IpcError + IpcErrorKind", () => {
    it("D-06: IpcErrorKind enumerates exactly the canonical set", () => {
      // Every canonical kind must parse.
      const kinds = [
        "validation",
        "not-found",
        "permission",
        "timeout",
        "internal",
        "unavailable",
      ] as const;
      for (const kind of kinds) {
        expect(IpcErrorKind.parse(kind)).toBe(kind);
      }
    });

    it("D-06: IpcErrorKind rejects unknown kinds", () => {
      const result = IpcErrorKind.safeParse("bogus");
      expect(result.success).toBe(false);
    });

    it("D-06: IpcError accepts optional `details`", () => {
      const parsed = IpcError.parse({
        kind: "validation",
        message: "bad params",
        details: { issues: [{ path: ["x"], message: "required" }] },
      });
      expect(parsed.kind).toBe("validation");
      expect(parsed.details).toBeDefined();
    });
  });

  describe("SpawnRequest (D-09)", () => {
    it("accepts minimal required fields", () => {
      const parsed = SpawnRequest.parse({
        id: "spawn-1",
        taskId: "task-1",
        taskPath: "/tmp/tasks/ready/task-1",
        agent: "swe-backend",
        priority: "normal",
        routing: {},
      });
      expect(parsed.id).toBe("spawn-1");
      expect(parsed.agent).toBe("swe-backend");
    });

    it("rejects payload missing required field `taskId`", () => {
      const result = SpawnRequest.safeParse({
        id: "spawn-1",
        taskPath: "/tmp/tasks/ready/task-1",
        agent: "swe-backend",
        priority: "normal",
        routing: {},
      });
      expect(result.success).toBe(false);
    });
  });

  describe("SpawnResultPost (D-09)", () => {
    it("accepts success outcome", () => {
      const parsed = SpawnResultPost.parse({
        sessionId: "s1",
        success: true,
        aborted: false,
        durationMs: 100,
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts failure outcome with structured error", () => {
      const parsed = SpawnResultPost.parse({
        sessionId: "s1",
        success: false,
        aborted: false,
        error: { kind: "exception", message: "boom" },
        durationMs: 42,
      });
      expect(parsed.error).toEqual({ kind: "exception", message: "boom" });
    });
  });

  describe("Session lifecycle events (D-07)", () => {
    it("SessionEndEvent parses a minimal payload", () => {
      // Exact field set is Wave 1 implementation detail; the test just
      // anchors the export name for the RED→GREEN contract.
      const parsed = SessionEndEvent.parse({ sessionId: "s1", agentId: "a1" });
      expect(parsed).toBeDefined();
    });

    it("AgentEndEvent parses a minimal payload", () => {
      const parsed = AgentEndEvent.parse({ agentId: "a1" });
      expect(parsed).toBeDefined();
    });

    it("BeforeCompactionEvent parses a minimal payload", () => {
      const parsed = BeforeCompactionEvent.parse({});
      expect(parsed).toBeDefined();
    });
  });
});
