import { describe, it, expect, vi } from "vitest";
import { MatrixNotifier, MockMatrixMessageTool } from "../matrix-notifier.js";

vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() }),
}));

describe("MatrixNotifier", () => {
  it("sends messages via message tool", async () => {
    const tool = new MockMatrixMessageTool();
    const notifier = new MatrixNotifier(tool);

    await notifier.send("#aof-dispatch", "Test message");

    expect(tool.sent).toHaveLength(1);
    expect(tool.sent[0]!.target).toBe("#aof-dispatch");
    expect(tool.sent[0]!.message).toBe("Test message");
  });

  it("handles send failures gracefully", async () => {
    const failingTool: MockMatrixMessageTool = {
      sent: [],
      async send() {
        throw new Error("Network error");
      },
    };

    const notifier = new MatrixNotifier(failingTool);

    // Should not throw
    await expect(notifier.send("#aof-dispatch", "Test")).resolves.toBeUndefined();
  });
});
