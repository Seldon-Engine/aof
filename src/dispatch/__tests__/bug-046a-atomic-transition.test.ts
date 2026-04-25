/**
 * BUG-046a (Phase 46 / Bug 1A): atomic save+transition.
 *
 * Before Phase 46, `transitionToDeadletter` did:
 *   - `store.save(task)` to stamp deadletter* metadata
 *   - then `store.transition(taskId, "deadletter")` to move the file
 * as two separate awaits. A crash, ENOSPC, or rename failure between
 * them left the file in `tasks/ready/` (or wherever it was) with
 * `frontmatter.status: deadletter` — the exact split-state that
 * produced the 5 ghost tasks and 172 MB log spin-loop on 2026-04-24.
 *
 * Phase 46 collapses the two writes into a single
 * `store.transition(id, "deadletter", { metadataPatch })` call so the
 * stamp and the rename happen inside the same TaskLocks per-task
 * critical section, with the metadata patch applied BEFORE
 * writeFileAtomic in the new-location write — making the partial-state
 * window structurally impossible.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { transitionToDeadletter } from "../failure-tracker.js";

// Suppress structured logger noise (matches the pattern used in
// task-store-concurrent-transition.test.ts).
vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }),
}));

// Module-level mock of node:fs/promises so test case 2 can fault-inject
// `rename` regardless of whether consumers (task-mutations.ts) use named
// or namespace imports. Named imports bind statically at module load,
// so vi.spyOn on the namespace would not intercept them — vi.mock on
// the module itself does. The mock factory passes everything through
// by default; individual tests override `rename` via the exported
// `__renameMock` reference.
const renameOverride = { fn: null as null | ((from: string, to: string) => Promise<void>) };
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      if (renameOverride.fn) {
        return renameOverride.fn(from, to);
      }
      return actual.rename(from, to);
    }),
  };
});

describe("Phase 46 / Bug 1A — atomic transitionToDeadletter", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let eventLogger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-bug046a-"));
    eventLogger = new EventLogger(join(tmpDir, "events"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    renameOverride.fn = null;
  });

  afterEach(async () => {
    renameOverride.fn = null;
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Helper: walk a freshly created task through backlog → ready →
  // in-progress → blocked so transitionToDeadletter has a valid source
  // state to operate from.
  async function createBlockedTask(): Promise<string> {
    const task = await store.create({
      title: "deadletter candidate",
      body: "b",
      createdBy: "test",
      routing: { agent: "swe-frontend" },
    });
    const id = task.frontmatter.id;
    await store.transition(id, "ready");
    await store.transition(id, "in-progress");
    await store.transition(id, "blocked");

    // Simulate accumulated dispatch failures so deadletter is the
    // expected next move.
    const pre = await store.get(id);
    pre!.frontmatter.metadata = {
      ...pre!.frontmatter.metadata,
      dispatchFailures: 3,
      errorClass: "transient",
    };
    await store.save(pre!);

    return id;
  }

  it("stamps deadletter metadata AND moves file to deadletter/ in a single atomic operation", async () => {
    const id = await createBlockedTask();

    await transitionToDeadletter(
      store,
      eventLogger,
      id,
      'Agent error: exception: No API key found for provider "openai"',
    );

    // File is at tasks/deadletter/<id>.md — read directly to bypass any
    // store-level self-heal logic.
    const deadletterPath = join(tmpDir, "tasks", "deadletter", `${id}.md`);
    const raw = await readFile(deadletterPath, "utf8");
    expect(raw).toMatch(/status:\s*deadletter/);
    expect(raw).toMatch(/deadletterReason:/);
    expect(raw).toMatch(/deadletterLastError:.*No API key/);
    expect(raw).toMatch(/deadletterErrorClass:\s*transient/);
    expect(raw).toMatch(/deadletterFailureCount:\s*3/);
    expect(raw).toMatch(/deadletterAt:/);

    // And the task is gone from the original (blocked) location.
    const blockedDir = join(tmpDir, "tasks", "blocked");
    const blockedEntries = await readdir(blockedDir).catch(() => [] as string[]);
    expect(blockedEntries.filter((e) => e === `${id}.md`)).toHaveLength(0);

    // Cross-check via the store API (it should agree).
    const after = await store.get(id);
    expect(after?.frontmatter.status).toBe("deadletter");
    expect(after?.frontmatter.metadata.deadletterReason).toBe("max_dispatch_failures");
    expect(after?.frontmatter.metadata.deadletterFailureCount).toBe(3);
  });

  it("rollback: if rename fails, frontmatter status remains the original (NOT 'deadletter')", async () => {
    const id = await createBlockedTask();

    // Fault-inject the COMPANION-DIR rename only — the .md write happens
    // via writeFileAtomic (NOT rename) per task-mutations.ts:194, but
    // the companion-dir move uses rename() at task-mutations.ts:199.
    // Failing the companion-dir rename triggers the existing rollback
    // (unlink the new-location .md) at lines 200-211, leaving the OLD
    // file untouched — i.e. the partial-state window is closed because
    // the original file's frontmatter was never modified on disk.
    renameOverride.fn = async (from: string, to: string) => {
      // Match the companion-dir rename: /tasks/<status>/<id>/ paths
      // (no trailing .md).
      if (
        (from.includes(`/tasks/blocked/${id}`) && !from.endsWith(".md")) ||
        (to.includes(`/tasks/deadletter/${id}`) && !to.endsWith(".md"))
      ) {
        throw new Error("simulated companion-dir rename failure");
      }
      // For everything else, do the real rename via the actual fs/promises.
      const actual = await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
      return actual.rename(from, to);
    };

    // Pre-create a companion dir so the rename path is exercised. Without
    // a companion dir present, transitionTask's rename call hits ENOENT
    // and silently passes — we need rename to actually be attempted on
    // a real source path.
    await store.writeTaskOutput(id, "evidence.txt", "trace data");

    // The transition should propagate the rename failure.
    await expect(
      transitionToDeadletter(store, eventLogger, id, "simulated upstream"),
    ).rejects.toThrow(/simulated companion-dir rename failure/);

    // After rollback, the task file MUST still be at its original
    // (blocked) location with the ORIGINAL frontmatter.status: "blocked"
    // — NOT "deadletter". And NO deadletter* metadata fields should be
    // present in the on-disk frontmatter (that's the partial-state we
    // are guarding against).
    const blockedPath = join(tmpDir, "tasks", "blocked", `${id}.md`);
    const raw = await readFile(blockedPath, "utf8");
    expect(raw).toMatch(/status:\s*blocked/);
    expect(raw).not.toMatch(/status:\s*deadletter/);
    expect(raw).not.toMatch(/deadletterReason:/);

    // And no orphan file should be lingering at the deadletter location.
    const deadletterDir = join(tmpDir, "tasks", "deadletter");
    const deadletterEntries = await readdir(deadletterDir).catch(() => [] as string[]);
    expect(deadletterEntries.filter((e) => e === `${id}.md`)).toHaveLength(0);
  });

  it("no separate save() call is observable in the failure-tracker code path", async () => {
    const id = await createBlockedTask();

    // Wrap the store with a Proxy that counts save() and transition()
    // calls. This pins the architecture: all deadletter metadata flows
    // through transition()'s metadataPatch — no future regression where
    // someone re-introduces the split-write `save() + transition()`.
    let saveCount = 0;
    let transitionCount = 0;

    const counterProxy = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "save") {
          return async (task: Parameters<ITaskStore["save"]>[0]) => {
            saveCount++;
            return target.save(task);
          };
        }
        if (prop === "transition") {
          return async (
            taskId: Parameters<ITaskStore["transition"]>[0],
            newStatus: Parameters<ITaskStore["transition"]>[1],
            opts?: Parameters<ITaskStore["transition"]>[2],
          ) => {
            transitionCount++;
            return target.transition(taskId, newStatus, opts);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ITaskStore;

    await transitionToDeadletter(counterProxy, eventLogger, id, "boom");

    // The architectural invariant: transitionToDeadletter must NOT call
    // store.save() — the metadata stamp is delivered atomically through
    // store.transition's metadataPatch.
    expect(saveCount).toBe(0);
    expect(transitionCount).toBe(1);
  });
});
