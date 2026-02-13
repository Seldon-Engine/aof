import { describe, it, expect } from "vitest";
import { renderCLI, renderJSON, renderJSONL } from "../renderers.js";
import type { ViewSnapshot, WatchEvent } from "../parser.js";

describe("renderers", () => {
  describe("renderCLI", () => {
    it("renders empty kanban view", () => {
      const snapshot: ViewSnapshot = {
        viewType: "kanban",
        timestamp: "2026-02-07T19:45:00.000Z",
        data: {
          columns: [
            { name: "backlog", tasks: [], count: 0 },
            { name: "in-progress", tasks: [], count: 0 },
            { name: "done", tasks: [], count: 0 },
          ],
          totalTasks: 0,
        },
      };

      const output = renderCLI(snapshot);

      expect(output).toContain("📋 AOF Kanban");
      expect(output).toContain("2026-02-07");
      expect(output).toContain("Total: 0 tasks");
    });

    it("renders kanban with tasks", () => {
      const snapshot: ViewSnapshot = {
        viewType: "kanban",
        timestamp: "2026-02-07T19:45:00.000Z",
        data: {
          columns: [
            {
              name: "backlog",
              count: 1,
              tasks: [
                { id: "TSK-001", title: "Backlog task", priority: "normal" },
              ],
            },
            {
              name: "in-progress",
              count: 2,
              tasks: [
                { id: "CTX-005", title: "Context Steward Phase 1", assignee: "swe-backend", priority: "high" },
                { id: "P5-001", title: "Real-time View Inspector", assignee: "swe-backend", priority: "high" },
              ],
            },
            {
              name: "done",
              count: 1,
              tasks: [
                { id: "REQ-002", title: "Context Bundling Protocol", assignee: "swe-backend", priority: "critical" },
              ],
            },
          ],
          totalTasks: 4,
        },
      };

      const output = renderCLI(snapshot);

      expect(output).toContain("📋 AOF Kanban");
      expect(output).toContain("🚧");
      expect(output).toContain("IN-PROGRESS");
      expect(output).toContain("(2)");
      expect(output).toContain("CTX-005");
      expect(output).toContain("Context Steward Phase 1");
      expect(output).toContain("@swe-backend");
      expect(output).toContain("HIGH");
      expect(output).toContain("✅");
      expect(output).toContain("DONE");
      expect(output).toContain("(1)");
      expect(output).toContain("📋");
      expect(output).toContain("BACKLOG");
      expect(output).toContain("Total: 4 tasks");
    });

    it("renders mailbox view", () => {
      const snapshot: ViewSnapshot = {
        viewType: "mailbox",
        timestamp: "2026-02-07T19:45:00.000Z",
        data: {
          agentId: "swe-backend",
          inbox: [
            { id: "TSK-001", title: "New task", from: "pm" },
            { id: "TSK-002", title: "Another task" },
          ],
          processing: [
            { id: "TSK-003", title: "Working on it" },
          ],
          outbox: [
            { id: "TSK-004", title: "Completed", to: "qa" },
          ],
        },
      };

      const output = renderCLI(snapshot);

      expect(output).toContain("📬 Mailbox: swe-backend");
      expect(output).toContain("📥");
      expect(output).toContain("INBOX");
      expect(output).toContain("(2)");
      expect(output).toContain("TSK-001");
      expect(output).toContain("New task");
      expect(output).toContain("from: pm");
      expect(output).toContain("⚙️");
      expect(output).toContain("PROCESSING");
      expect(output).toContain("(1)");
      expect(output).toContain("TSK-003");
      expect(output).toContain("📤");
      expect(output).toContain("OUTBOX");
      expect(output).toContain("TSK-004");
      expect(output).toContain("to: qa");
    });

    it("applies ANSI color codes", () => {
      const snapshot: ViewSnapshot = {
        viewType: "kanban",
        timestamp: "2026-02-07T19:45:00.000Z",
        data: {
          columns: [
            {
              name: "in-progress",
              count: 1,
              tasks: [{ id: "TSK-001", title: "Task", priority: "critical" }],
            },
          ],
          totalTasks: 1,
        },
      };

      const output = renderCLI(snapshot);

      // Check for ANSI escape codes (colors)
      expect(output).toMatch(/\x1b\[\d+m/); // Contains ANSI codes
    });

    it("handles empty mailbox gracefully", () => {
      const snapshot: ViewSnapshot = {
        viewType: "mailbox",
        timestamp: "2026-02-07T19:45:00.000Z",
        data: {
          agentId: "swe-qa",
          inbox: [],
          processing: [],
          outbox: [],
        },
      };

      const output = renderCLI(snapshot);

      expect(output).toContain("📬 Mailbox: swe-qa");
      expect(output).toContain("📥");
      expect(output).toContain("INBOX");
      expect(output).toContain("(0)");
      expect(output).toContain("⚙️");
      expect(output).toContain("PROCESSING");
      expect(output).toContain("📤");
      expect(output).toContain("OUTBOX");
    });

    it("truncates long task IDs", () => {
      const snapshot: ViewSnapshot = {
        viewType: "kanban",
        timestamp: "2026-02-07T19:45:00.000Z",
        data: {
          columns: [
            {
              name: "backlog",
              count: 1,
              tasks: [
                { id: "VERY-LONG-TASK-ID-2026-02-07-123456", title: "Task" },
              ],
            },
          ],
          totalTasks: 1,
        },
      };

      const output = renderCLI(snapshot);

      // Should truncate ID to reasonable length (e.g., first 8-10 chars)
      expect(output).not.toContain("VERY-LONG-TASK-ID-2026-02-07-123456");
      expect(output).toMatch(/VERY-LONG|VERY-LO/);
    });
  });

  describe("renderJSON", () => {
    it("renders valid JSON", () => {
      const snapshot: ViewSnapshot = {
        viewType: "kanban",
        timestamp: "2026-02-07T19:45:00.000Z",
        data: {
          columns: [
            { name: "backlog", tasks: [], count: 0 },
          ],
          totalTasks: 0,
        },
      };

      const output = renderJSON(snapshot);
      const parsed = JSON.parse(output);

      expect(parsed.viewType).toBe("kanban");
      expect(parsed.timestamp).toBe("2026-02-07T19:45:00.000Z");
      expect(parsed.data.totalTasks).toBe(0);
    });

    it("preserves all snapshot data", () => {
      const snapshot: ViewSnapshot = {
        viewType: "mailbox",
        timestamp: "2026-02-07T19:45:00.000Z",
        data: {
          agentId: "swe-backend",
          inbox: [
            { id: "TSK-001", title: "Task 1", from: "pm" },
          ],
          processing: [
            { id: "TSK-002", title: "Task 2" },
          ],
          outbox: [
            { id: "TSK-003", title: "Task 3", to: "qa" },
          ],
        },
      };

      const output = renderJSON(snapshot);
      const parsed = JSON.parse(output);

      expect(parsed.data.agentId).toBe("swe-backend");
      expect(parsed.data.inbox).toHaveLength(1);
      expect(parsed.data.inbox[0].from).toBe("pm");
      expect(parsed.data.outbox[0].to).toBe("qa");
    });

    it("formats JSON with indentation", () => {
      const snapshot: ViewSnapshot = {
        viewType: "kanban",
        timestamp: "2026-02-07T19:45:00.000Z",
        data: {
          columns: [],
          totalTasks: 0,
        },
      };

      const output = renderJSON(snapshot);

      // Should be pretty-printed (contains newlines and spaces)
      expect(output).toContain("\n");
      expect(output).toMatch(/  /); // Indentation
    });
  });

  describe("renderJSONL", () => {
    it("renders watch event as single-line JSON", () => {
      const event: WatchEvent = {
        type: "add",
        path: "/path/to/task.md",
        viewType: "kanban",
        timestamp: "2026-02-07T19:45:00.000Z",
      };

      const output = renderJSONL(event);
      const lines = output.trim().split("\n");

      expect(lines).toHaveLength(1);
      
      const parsed = JSON.parse(lines[0]);
      expect(parsed.type).toBe("add");
      expect(parsed.path).toBe("/path/to/task.md");
      expect(parsed.viewType).toBe("kanban");
    });

    it("includes snapshot when provided", () => {
      const event: WatchEvent = {
        type: "change",
        path: "/path/to/task.md",
        viewType: "kanban",
        timestamp: "2026-02-07T19:45:00.000Z",
      };

      const snapshot: ViewSnapshot = {
        viewType: "kanban",
        timestamp: "2026-02-07T19:45:00.000Z",
        data: {
          columns: [{ name: "backlog", tasks: [], count: 0 }],
          totalTasks: 0,
        },
      };

      const output = renderJSONL(event, snapshot);
      const parsed = JSON.parse(output.trim());

      expect(parsed.event).toBeDefined();
      expect(parsed.event.type).toBe("change");
      expect(parsed.snapshot).toBeDefined();
      expect(parsed.snapshot.viewType).toBe("kanban");
    });

    it("renders event without snapshot", () => {
      const event: WatchEvent = {
        type: "remove",
        path: "/path/to/task.md",
        viewType: "mailbox",
        timestamp: "2026-02-07T19:45:00.000Z",
      };

      const output = renderJSONL(event);
      const parsed = JSON.parse(output.trim());

      expect(parsed.type).toBe("remove");
      expect(parsed.snapshot).toBeUndefined();
    });

    it("produces valid JSONL for streaming", () => {
      const events: WatchEvent[] = [
        { type: "add", path: "/a.md", viewType: "kanban", timestamp: "2026-02-07T19:45:00.000Z" },
        { type: "change", path: "/b.md", viewType: "kanban", timestamp: "2026-02-07T19:45:01.000Z" },
        { type: "remove", path: "/c.md", viewType: "kanban", timestamp: "2026-02-07T19:45:02.000Z" },
      ];

      const outputs = events.map(e => renderJSONL(e));
      const combined = outputs.join("");
      const lines = combined.trim().split("\n");

      expect(lines).toHaveLength(3);
      
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }

      const parsed = lines.map(l => JSON.parse(l));
      expect(parsed[0].type).toBe("add");
      expect(parsed[1].type).toBe("change");
      expect(parsed[2].type).toBe("remove");
    });

    it("does not include newlines in JSON content", () => {
      const event: WatchEvent = {
        type: "add",
        path: "/path/with\nnewline.md",
        viewType: "kanban",
        timestamp: "2026-02-07T19:45:00.000Z",
      };

      const output = renderJSONL(event);
      const lines = output.trim().split("\n");

      // Should be exactly one line despite newline in path
      expect(lines).toHaveLength(1);
      
      const parsed = JSON.parse(lines[0]);
      expect(parsed.path).toContain("\n"); // Preserved in JSON
    });
  });

  describe("edge cases", () => {
    it("handles undefined optional fields", () => {
      const snapshot: ViewSnapshot = {
        viewType: "kanban",
        timestamp: "2026-02-07T19:45:00.000Z",
        data: {
          columns: [
            {
              name: "backlog",
              count: 1,
              tasks: [
                { id: "TSK-001", title: "Minimal task" }, // No assignee or priority
              ],
            },
          ],
          totalTasks: 1,
        },
      };

      expect(() => renderCLI(snapshot)).not.toThrow();
      expect(() => renderJSON(snapshot)).not.toThrow();

      const cliOutput = renderCLI(snapshot);
      expect(cliOutput).toContain("TSK-001");
      expect(cliOutput).toContain("Minimal task");
    });

    it("handles empty strings gracefully", () => {
      const snapshot: ViewSnapshot = {
        viewType: "kanban",
        timestamp: "2026-02-07T19:45:00.000Z",
        data: {
          columns: [
            {
              name: "backlog",
              count: 1,
              tasks: [
                { id: "", title: "", assignee: "", priority: "" },
              ],
            },
          ],
          totalTasks: 1,
        },
      };

      expect(() => renderCLI(snapshot)).not.toThrow();
      expect(() => renderJSON(snapshot)).not.toThrow();
    });
  });
});
