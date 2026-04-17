/**
 * Envelope Zod schema tests — Wave 0 anchor for Phase 43 Plan 03.
 *
 * Each test asserts a wire-contract invariant that both sides of the
 * plugin↔daemon IPC rely on:
 *   - InvokeToolRequest is `.strict()` (unknown envelope fields rejected).
 *   - `pluginId` defaults to "openclaw" when omitted (D-13).
 *   - `callbackDepth` is clamped to a non-negative integer, defaults to 0.
 *   - InvokeToolResponse is a `result | error` union — never both.
 *   - IpcError.kind is constrained to the documented set.
 *   - SpawnRequest carries a nonnegative `callbackDepth` (Open Q5).
 *   - Session-event envelopes are `.passthrough()` so gateway extras survive.
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
  MessageReceivedEvent,
} from "../schemas.js";

describe("IPC envelope schemas", () => {
  describe("InvokeToolRequest", () => {
    it("parses a minimal well-formed envelope and applies defaults", () => {
      const parsed = InvokeToolRequest.parse({
        name: "aof_status_report",
        params: {},
        toolCallId: "call-1",
      });
      expect(parsed.pluginId).toBe("openclaw");
      expect(parsed.callbackDepth).toBe(0);
      expect(parsed.name).toBe("aof_status_report");
    });

    it("rejects unknown top-level fields (strict mode)", () => {
      const result = InvokeToolRequest.safeParse({
        name: "aof_status_report",
        params: {},
        toolCallId: "call-1",
        unexpectedField: 42,
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing required fields", () => {
      expect(
        InvokeToolRequest.safeParse({ params: {}, toolCallId: "c" }).success,
      ).toBe(false); // missing name
      expect(
        InvokeToolRequest.safeParse({ name: "aof_status_report", toolCallId: "c" })
          .success,
      ).toBe(false); // missing params
      expect(
        InvokeToolRequest.safeParse({ name: "aof_status_report", params: {} })
          .success,
      ).toBe(false); // missing toolCallId
    });

    it("rejects negative callbackDepth (T-43-07 clamp)", () => {
      const result = InvokeToolRequest.safeParse({
        name: "aof_status_report",
        params: {},
        toolCallId: "call-1",
        callbackDepth: -1,
      });
      expect(result.success).toBe(false);
    });

    it("accepts callbackDepth=0 and positive integers", () => {
      expect(
        InvokeToolRequest.safeParse({
          name: "aof_status_report",
          params: {},
          toolCallId: "c",
          callbackDepth: 0,
        }).success,
      ).toBe(true);
      expect(
        InvokeToolRequest.safeParse({
          name: "aof_status_report",
          params: {},
          toolCallId: "c",
          callbackDepth: 5,
        }).success,
      ).toBe(true);
    });

    it("preserves arbitrary params payload", () => {
      const parsed = InvokeToolRequest.parse({
        name: "aof_dispatch",
        params: { taskTitle: "t", agent: "swe", nested: { a: 1 } },
        toolCallId: "call-1",
      });
      expect(parsed.params.taskTitle).toBe("t");
      expect(parsed.params.agent).toBe("swe");
      expect((parsed.params.nested as Record<string, unknown>).a).toBe(1);
    });

    it("accepts explicit pluginId override (multi-plugin reservation)", () => {
      const parsed = InvokeToolRequest.parse({
        pluginId: "slack",
        name: "aof_status_report",
        params: {},
        toolCallId: "call-1",
      });
      expect(parsed.pluginId).toBe("slack");
    });
  });

  describe("InvokeToolResponse", () => {
    it("accepts a result envelope", () => {
      const r = InvokeToolResponse.parse({ result: { ok: true } });
      expect("result" in r).toBe(true);
    });

    it("accepts an error envelope", () => {
      const r = InvokeToolResponse.parse({
        error: { kind: "validation", message: "bad" },
      });
      expect("error" in r).toBe(true);
    });

    it("rejects an unknown-shape payload", () => {
      expect(InvokeToolResponse.safeParse({}).success).toBe(false);
      expect(InvokeToolResponse.safeParse({ other: 1 }).success).toBe(false);
    });
  });

  describe("IpcError / IpcErrorKind", () => {
    it("enumerates the documented error kinds", () => {
      const kinds: IpcErrorKind[] = [
        "validation",
        "not-found",
        "permission",
        "timeout",
        "internal",
        "unavailable",
      ];
      for (const k of kinds) {
        expect(IpcErrorKind.safeParse(k).success).toBe(true);
      }
    });

    it("rejects unknown error kinds", () => {
      expect(IpcErrorKind.safeParse("boom").success).toBe(false);
    });

    it("accepts optional details payload", () => {
      const e = IpcError.parse({
        kind: "validation",
        message: "bad",
        details: { field: "name" },
      });
      expect(e.details?.field).toBe("name");
    });
  });

  describe("SpawnRequest", () => {
    it("parses a minimal SpawnRequest and applies callbackDepth default", () => {
      const parsed = SpawnRequest.parse({
        id: "s-1",
        taskId: "t-1",
        taskPath: "tasks/ready/t-1",
        agent: "swe-backend",
        priority: "normal",
        routing: {},
      });
      expect(parsed.callbackDepth).toBe(0);
    });

    it("rejects negative callbackDepth on SpawnRequest", () => {
      const result = SpawnRequest.safeParse({
        id: "s-1",
        taskId: "t-1",
        taskPath: "tasks/ready/t-1",
        agent: "swe-backend",
        priority: "normal",
        routing: {},
        callbackDepth: -3,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("SpawnResultPost", () => {
    it("parses a successful result", () => {
      const parsed = SpawnResultPost.parse({
        sessionId: "sess-1",
        success: true,
        aborted: false,
        durationMs: 1234,
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts an optional error payload", () => {
      const parsed = SpawnResultPost.parse({
        sessionId: "sess-1",
        success: false,
        aborted: false,
        error: { kind: "timeout", message: "exceeded" },
        durationMs: 42,
      });
      expect(parsed.error?.kind).toBe("timeout");
    });
  });

  describe("Session-event envelopes (A1: 4 forwarded)", () => {
    it("SessionEndEvent passthrough preserves extras", () => {
      const parsed = SessionEndEvent.parse({
        sessionId: "s",
        customGatewayField: "kept",
      });
      // passthrough: custom fields survive
      expect((parsed as Record<string, unknown>).customGatewayField).toBe("kept");
    });

    it("AgentEndEvent is the same passthrough shape", () => {
      const parsed = AgentEndEvent.parse({ agentId: "swe-backend", extra: 1 });
      expect((parsed as Record<string, unknown>).extra).toBe(1);
    });

    it("BeforeCompactionEvent accepts empty body", () => {
      expect(BeforeCompactionEvent.safeParse({}).success).toBe(true);
    });

    it("MessageReceivedEvent passes through protocol envelopes", () => {
      const parsed = MessageReceivedEvent.parse({
        sessionKey: "abc",
        from: "swe-backend",
        content: "ack",
      });
      expect((parsed as Record<string, unknown>).from).toBe("swe-backend");
    });
  });
});
