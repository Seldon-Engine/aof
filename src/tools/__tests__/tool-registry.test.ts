import { describe, it, expect } from "vitest";
import { toolRegistry, type ToolDefinition } from "../tool-registry.js";
import { z } from "zod";

describe("toolRegistry", () => {
  const expectedTools = [
    "aof_dispatch",
    "aof_task_update",
    "aof_task_complete",
    "aof_status_report",
    "aof_task_edit",
    "aof_task_cancel",
    "aof_task_dep_add",
    "aof_task_dep_remove",
    "aof_task_block",
    "aof_task_unblock",
    "aof_context_load",
  ];

  it("contains all expected tool names", () => {
    const toolNames = Object.keys(toolRegistry);
    for (const name of expectedTools) {
      expect(toolNames).toContain(name);
    }
  });

  it("each entry has description, schema, and handler", () => {
    for (const [name, def] of Object.entries(toolRegistry)) {
      expect(def.description, `${name} missing description`).toBeTruthy();
      expect(def.schema, `${name} missing schema`).toBeDefined();
      expect(def.handler, `${name} missing handler`).toBeTypeOf("function");
    }
  });

  it("each schema is a valid Zod type", () => {
    for (const [name, def] of Object.entries(toolRegistry)) {
      expect(def.schema instanceof z.ZodType, `${name} schema is not a ZodType`).toBe(true);
    }
  });

  it("handlers are async functions", () => {
    for (const [name, def] of Object.entries(toolRegistry)) {
      // Verify handler returns a promise when called (it's async)
      expect(def.handler.constructor.name, `${name} handler is not async`).toBe("AsyncFunction");
    }
  });
});
