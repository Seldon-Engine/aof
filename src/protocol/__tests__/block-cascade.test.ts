/**
 * Tests for opt-in block cascade via ProtocolRouter.
 *
 * Verifies:
 *  - cascadeBlocks=false (default): dependents are NOT blocked when upstream is blocked.
 *  - cascadeBlocks=true: direct dependents in backlog/ready are blocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTestHarness, type TestHarness } from "../../testing/index.js";
import { EventLogger } from "../../events/logger.js";
import { ProtocolRouter } from "../router.js";
import { acquireLease } from "../../store/lease.js";
import type { ProtocolEnvelope } from "../../schemas/protocol.js";

// Mock structured logger to suppress output during tests
vi.mock("../../logging/index.js", () => ({
  createLogger: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStatusUpdateEnvelope(
  taskId: string,
  status: "blocked",
  blockers: string[],
): ProtocolEnvelope {
  return {
    protocol: "aof",
    version: 1,
    projectId: "test-project",
    type: "status.update",
    taskId,
    fromAgent: "swe-backend",
    toAgent: "system",
    sentAt: new Date().toISOString(),
    payload: {
      status,
      blockers,
    },
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("ProtocolRouter block cascade (AOF-cd1d)", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness("aof-block-cascade-test");
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  /**
   * Creates an in-progress task leased to swe-backend, so the protocol
   * router will accept status.update messages from that agent.
   */
  async function createInProgressTask(opts: { dependsOn?: string[] } = {}) {
    const task = await harness.store.create({
      title: "Upstream task",
      createdBy: "test",
      dependsOn: opts.dependsOn,
    });
    await harness.store.transition(task.frontmatter.id, "ready");
    const leased = await acquireLease(harness.store, task.frontmatter.id, "swe-backend", {
      writeRunArtifacts: false,
    });
    return leased!;
  }

  async function createDependentTask(
    dependsOnId: string,
    targetStatus: "backlog" | "ready" = "backlog",
  ) {
    const task = await harness.store.create({
      title: "Dependent task",
      createdBy: "test",
      dependsOn: [dependsOnId],
    });
    if (targetStatus === "ready") {
      await harness.store.transition(task.frontmatter.id, "ready");
    }
    return task;
  }

  // ── cascadeBlocks=false (default) ─────────────────────────────────────────

  describe("cascadeBlocks=false (default)", () => {
    it("does NOT cascade block to dependents when upstream is blocked", async () => {
      const router = new ProtocolRouter({ store: harness.store, logger: harness.logger });

      const upstream = await createInProgressTask();
      const dependent = await createDependentTask(upstream.frontmatter.id);

      const envelope = makeStatusUpdateEnvelope(
        upstream.frontmatter.id,
        "blocked",
        ["External API unavailable"],
      );
      await router.handleStatusUpdate(envelope, harness.store);

      // Upstream should be blocked
      const upstreamAfter = await harness.store.get(upstream.frontmatter.id);
      expect(upstreamAfter?.frontmatter.status).toBe("blocked");

      // Dependent should remain untouched (backlog)
      const dependentAfter = await harness.store.get(dependent.frontmatter.id);
      expect(dependentAfter?.frontmatter.status).toBe("backlog");
    });

    it("does NOT cascade when cascadeBlocks is explicitly false", async () => {
      const router = new ProtocolRouter({ store: harness.store, logger: harness.logger, cascadeBlocks: false });

      const upstream = await createInProgressTask();
      const dependent = await createDependentTask(upstream.frontmatter.id, "ready");

      await router.handleStatusUpdate(
        makeStatusUpdateEnvelope(upstream.frontmatter.id, "blocked", ["Blocker A"]),
        harness.store,
      );

      const dependentAfter = await harness.store.get(dependent.frontmatter.id);
      expect(dependentAfter?.frontmatter.status).toBe("ready");
    });
  });

  // ── cascadeBlocks=true ────────────────────────────────────────────────────

  describe("cascadeBlocks=true", () => {
    it("blocks a backlog dependent when upstream transitions to blocked", async () => {
      const router = new ProtocolRouter({ store: harness.store, logger: harness.logger, cascadeBlocks: true });

      const upstream = await createInProgressTask();
      const dependent = await createDependentTask(upstream.frontmatter.id);

      await router.handleStatusUpdate(
        makeStatusUpdateEnvelope(upstream.frontmatter.id, "blocked", ["Missing spec"]),
        harness.store,
      );

      const upstreamAfter = await harness.store.get(upstream.frontmatter.id);
      expect(upstreamAfter?.frontmatter.status).toBe("blocked");

      const dependentAfter = await harness.store.get(dependent.frontmatter.id);
      expect(dependentAfter?.frontmatter.status).toBe("blocked");
      expect(dependentAfter?.frontmatter.metadata.blockReason).toContain(
        `upstream blocked: ${upstream.frontmatter.id}`,
      );
    });

    it("blocks a ready dependent when upstream is blocked", async () => {
      const router = new ProtocolRouter({ store: harness.store, logger: harness.logger, cascadeBlocks: true });

      const upstream = await createInProgressTask();
      const dependent = await createDependentTask(upstream.frontmatter.id, "ready");

      await router.handleStatusUpdate(
        makeStatusUpdateEnvelope(upstream.frontmatter.id, "blocked", ["API key missing"]),
        harness.store,
      );

      const dependentAfter = await harness.store.get(dependent.frontmatter.id);
      expect(dependentAfter?.frontmatter.status).toBe("blocked");
    });

    it("does NOT cascade to tasks that are NOT dependents", async () => {
      const router = new ProtocolRouter({ store: harness.store, logger: harness.logger, cascadeBlocks: true });

      const upstream = await createInProgressTask();
      // Unrelated task — no dependency on upstream
      const unrelated = await harness.store.create({
        title: "Unrelated task",
        createdBy: "test",
      });

      await router.handleStatusUpdate(
        makeStatusUpdateEnvelope(upstream.frontmatter.id, "blocked", ["Issue"]),
        harness.store,
      );

      const unrelatedAfter = await harness.store.get(unrelated.frontmatter.id);
      expect(unrelatedAfter?.frontmatter.status).toBe("backlog");
    });

    it("does NOT cascade when task is already blocked (idempotent transition)", async () => {
      const router = new ProtocolRouter({ store: harness.store, logger: harness.logger, cascadeBlocks: true });

      const upstream = await createInProgressTask();
      const dependent = await createDependentTask(upstream.frontmatter.id);

      // First: block upstream (cascades to dependent)
      await router.handleStatusUpdate(
        makeStatusUpdateEnvelope(upstream.frontmatter.id, "blocked", ["First block"]),
        harness.store,
      );

      // Dependent is now blocked — cascadeOnBlock only targets backlog/ready
      const dependentAfter = await harness.store.get(dependent.frontmatter.id);
      expect(dependentAfter?.frontmatter.status).toBe("blocked");

      // A second block message for the same upstream (idempotent: upstream already blocked,
      // transitionTask won't move it again, so no cascade fires a second time)
      await router.handleStatusUpdate(
        makeStatusUpdateEnvelope(upstream.frontmatter.id, "blocked", ["Second block"]),
        harness.store,
      );

      // Dependent should still be blocked (unchanged), not double-blocked error
      const dependentFinal = await harness.store.get(dependent.frontmatter.id);
      expect(dependentFinal?.frontmatter.status).toBe("blocked");
    });

    it("emits dependency.cascaded event for block cascade", async () => {
      const events: string[] = [];
      const eventsDir = join(harness.tmpDir, "events2");
      await mkdir(eventsDir, { recursive: true });
      const trackingLogger = new EventLogger(eventsDir, {
        onEvent: (e) => { events.push(e.type); },
      });
      const router = new ProtocolRouter({ store: harness.store, logger: trackingLogger, cascadeBlocks: true });

      const upstream = await createInProgressTask();
      await createDependentTask(upstream.frontmatter.id);

      await router.handleStatusUpdate(
        makeStatusUpdateEnvelope(upstream.frontmatter.id, "blocked", ["Blocked"]),
        harness.store,
      );

      expect(events).toContain("dependency.cascaded");
    });
  });
});
