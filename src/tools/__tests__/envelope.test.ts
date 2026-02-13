import { describe, it, expect } from "vitest";
import { wrapResponse, compactResponse, type ToolResponseEnvelope } from "../envelope.js";

describe("ToolResponseEnvelope", () => {
  describe("wrapResponse", () => {
    it("creates envelope with summary only", () => {
      const result = wrapResponse("Task updated");
      
      expect(result).toEqual({
        summary: "Task updated",
      });
    });

    it("creates envelope with summary and details", () => {
      const result = wrapResponse("Task updated", "Full details here");
      
      expect(result).toEqual({
        summary: "Task updated",
        details: "Full details here",
      });
    });

    it("creates envelope with metadata", () => {
      const result = wrapResponse(
        "Task completed",
        undefined,
        { taskId: "TSK-001", status: "done" },
      );
      
      expect(result).toEqual({
        summary: "Task completed",
        meta: { taskId: "TSK-001", status: "done" },
      });
    });

    it("creates envelope with warnings", () => {
      const result = wrapResponse(
        "Task updated",
        "Details",
        undefined,
        ["No agent assigned"],
      );
      
      expect(result).toEqual({
        summary: "Task updated",
        details: "Details",
        warnings: ["No agent assigned"],
      });
    });

    it("omits empty warnings array", () => {
      const result = wrapResponse("Task updated", "Details", undefined, []);
      
      expect(result).toEqual({
        summary: "Task updated",
        details: "Details",
      });
    });

    it("creates full envelope with all fields", () => {
      const result = wrapResponse(
        "Task updated",
        "Full details",
        { taskId: "TSK-001", status: "in-progress", charCount: 42 },
        ["Warning 1", "Warning 2"],
      );
      
      expect(result).toEqual({
        summary: "Task updated",
        details: "Full details",
        warnings: ["Warning 1", "Warning 2"],
        meta: { taskId: "TSK-001", status: "in-progress", charCount: 42 },
      });
    });
  });

  describe("compactResponse", () => {
    it("creates compact response with summary only", () => {
      const result = compactResponse("Status: 5 tasks active");
      
      expect(result).toEqual({
        summary: "Status: 5 tasks active",
      });
      expect(result.details).toBeUndefined();
    });

    it("creates compact response with metadata", () => {
      const result = compactResponse(
        "Task completed",
        { taskId: "TSK-001", status: "done" },
      );
      
      expect(result).toEqual({
        summary: "Task completed",
        meta: { taskId: "TSK-001", status: "done" },
      });
      expect(result.details).toBeUndefined();
    });
  });
});
