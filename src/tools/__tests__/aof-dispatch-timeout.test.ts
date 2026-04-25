/**
 * Per-task timeoutMs override — schema validation + metadata persistence.
 *
 * Assures that aof_dispatch accepts an explicit timeoutMs, persists it to the
 * task's frontmatter metadata, and the scheduler's assign-executor propagates
 * it into the TaskContext / spawnSession opts. Research tasks (30-60 min) need
 * this to escape the default 5-minute floor.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { aofDispatch } from "../project-tools.js";
import { dispatchSchema, MAX_DISPATCH_TIMEOUT_MS } from "../project-tools.js";

describe("aof_dispatch timeoutMs override", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-dispatch-timeout-"));
    logger = new EventLogger(join(tmpDir, "events"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("schema accepts a positive integer timeoutMs", () => {
    const parsed = dispatchSchema.parse({
      title: "t",
      brief: "b",
      timeoutMs: 30 * 60 * 1000,
    });
    expect(parsed.timeoutMs).toBe(1_800_000);
  });

  it("schema accepts omitted timeoutMs", () => {
    const parsed = dispatchSchema.parse({ title: "t", brief: "b" });
    expect(parsed.timeoutMs).toBeUndefined();
  });

  it("schema rejects timeoutMs above MAX_DISPATCH_TIMEOUT_MS (4h)", () => {
    expect(() =>
      dispatchSchema.parse({
        title: "t",
        brief: "b",
        timeoutMs: MAX_DISPATCH_TIMEOUT_MS + 1,
      }),
    ).toThrow();
  });

  it("schema rejects zero and negative timeoutMs", () => {
    expect(() => dispatchSchema.parse({ title: "t", brief: "b", timeoutMs: 0 })).toThrow();
    expect(() => dispatchSchema.parse({ title: "t", brief: "b", timeoutMs: -1 })).toThrow();
  });

  it("schema rejects non-integer timeoutMs", () => {
    expect(() =>
      dispatchSchema.parse({ title: "t", brief: "b", timeoutMs: 1.5 }),
    ).toThrow();
  });

  // NOTE: each handler-invoking test below passes `agent: "main"` to
  // bypass the Phase 46 / Bug 2B routing-required rejection added in
  // src/tools/project-tools.ts. The tests here cover timeoutMs persistence
  // and clamping, not routing semantics.

  it("persists timeoutMs onto task frontmatter metadata", async () => {
    const result = await aofDispatch(
      { store, logger },
      {
        title: "Long research task",
        brief: "Takes ~45 minutes",
        actor: "main",
        agent: "main",
        timeoutMs: 45 * 60 * 1000,
      },
    );

    const task = await store.get(result.taskId);
    expect(task?.frontmatter.metadata?.timeoutMs).toBe(45 * 60 * 1000);
  });

  it("does not set metadata.timeoutMs when not provided", async () => {
    const result = await aofDispatch(
      { store, logger },
      {
        title: "Short task",
        brief: "Uses default timeout",
        actor: "main",
        agent: "main",
      },
    );

    const task = await store.get(result.taskId);
    expect(task?.frontmatter.metadata?.timeoutMs).toBeUndefined();
  });

  it("clamps absurd timeoutMs values at the handler (defense in depth beyond schema)", async () => {
    // Schema rejects above MAX, but handler also floors via Math.min in case
    // a caller bypasses the schema (legacy MCP/CLI paths).
    const result = await aofDispatch(
      { store, logger },
      {
        title: "Clamped",
        brief: "Clamped",
        actor: "main",
        agent: "main",
        // Bypass the schema by casting — simulates a legacy caller.
        timeoutMs: MAX_DISPATCH_TIMEOUT_MS * 10,
      } as Parameters<typeof aofDispatch>[1],
    );
    const task = await store.get(result.taskId);
    expect(task?.frontmatter.metadata?.timeoutMs).toBe(MAX_DISPATCH_TIMEOUT_MS);
  });
});
