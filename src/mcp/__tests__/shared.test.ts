/**
 * Tests for callbackDepth propagation through AofMcpContext (SAFE-01).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import { EventLogger } from "../../events/logger.js";
import { createAofMcpContext } from "../shared.js";

describe("createAofMcpContext callbackDepth (SAFE-01)", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "aof-mcp-shared-"));
    const store = new FilesystemTaskStore(dataDir);
    await store.init();
    // Clean up env var
    delete process.env.AOF_CALLBACK_DEPTH;
  });

  afterEach(async () => {
    delete process.env.AOF_CALLBACK_DEPTH;
    await rm(dataDir, { recursive: true, force: true });
  });

  it("returns context with callbackDepth from options", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      callbackDepth: 2,
    });

    expect(ctx.callbackDepth).toBe(2);
  });

  it("defaults callbackDepth to 0 when not provided", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
    });

    expect(ctx.callbackDepth).toBe(0);
  });

  it("reads AOF_CALLBACK_DEPTH env var as fallback", async () => {
    process.env.AOF_CALLBACK_DEPTH = "5";

    const ctx = await createAofMcpContext({
      dataDir,
    });

    expect(ctx.callbackDepth).toBe(5);
  });

  it("options.callbackDepth takes precedence over env var", async () => {
    process.env.AOF_CALLBACK_DEPTH = "5";

    const ctx = await createAofMcpContext({
      dataDir,
      callbackDepth: 1,
    });

    expect(ctx.callbackDepth).toBe(1);
  });

  it("handles invalid AOF_CALLBACK_DEPTH env var gracefully", async () => {
    process.env.AOF_CALLBACK_DEPTH = "not-a-number";

    const ctx = await createAofMcpContext({
      dataDir,
    });

    expect(ctx.callbackDepth).toBe(0);
  });
});
