/**
 * Phase 46 / Bug 2B (BUG-046d) — `aof_dispatch` must reject task creation
 * when no routing target is provided (no `agent`, no `team`, no `role`).
 *
 * Background: a tags-only task can never dispatch — the scheduler refuses
 * tags-only routing at dispatch time
 * (`src/dispatch/task-dispatcher.ts:191-250` "task has tags-only routing
 * (not supported), needs explicit agent/role/team assignment") and the
 * failure counter is NOT incremented for this path, so the task sits in
 * `ready/` forever, re-evaluated every poll. On 2026-04-25 this silently
 * stranded 5 growth-lead tasks for 21 minutes before the dispatching
 * agent gave up.
 *
 * Fix: reject empty-routing at create time in `aofDispatch`. Before
 * rejecting, attempt to default from the project owner — but treat
 * `"system"` (case-insensitive) as a sentinel meaning "no real owner",
 * per CONTEXT.md addendum Q3, so we don't swap one silent routing
 * failure for another.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { aofDispatch } from "../project-tools.js";
import { buildProjectManifest, writeProjectManifest } from "../../projects/manifest.js";

describe("Phase 46 / Bug 2B — routing required at create time", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-bug-046d-"));
    logger = new EventLogger(join(tmpDir, "events"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects aof_dispatch when agent, team, and role are all absent", async () => {
    await expect(
      aofDispatch(
        { store, logger },
        {
          title: "no routing probe",
          brief: "no agent, no team, no role",
          actor: "main",
        },
      ),
    ).rejects.toThrow(/requires a routing target|tags-only routing is not supported/i);
  });

  it("does NOT write the task file when routing rejection fires", async () => {
    const beforeCount = (await store.list()).length;

    await expect(
      aofDispatch(
        { store, logger },
        {
          title: "should-not-persist",
          brief: "rejected for empty routing",
          actor: "main",
        },
      ),
    ).rejects.toThrow();

    const afterCount = (await store.list()).length;
    expect(afterCount).toBe(beforeCount);
  });

  it("defaults routing.agent from project.owner.lead when no explicit routing", async () => {
    // Build a project-scoped store with project.yaml at projectRoot
    const projectPath = join(tmpDir, "Projects", "test-proj-lead");
    await mkdir(projectPath, { recursive: true });
    const manifest = buildProjectManifest("test-proj-lead", {
      title: "Lead Default Test",
      type: "swe",
      owner: { team: "engineering", lead: "main" },
    });
    await writeProjectManifest(projectPath, manifest);

    const projectStore = new FilesystemTaskStore(projectPath, {
      projectId: "test-proj-lead",
    });
    await projectStore.init();
    const projectLogger = new EventLogger(join(projectPath, "events"));

    const result = await aofDispatch(
      { store: projectStore, logger: projectLogger, projectId: "test-proj-lead" },
      {
        title: "default-from-lead",
        brief: "should default agent from owner.lead",
        actor: "coordinator",
        project: "test-proj-lead",
      },
    );

    expect(result.taskId).toMatch(/^TASK-/);
    const created = await projectStore.get(result.taskId);
    expect(created?.frontmatter.routing.agent).toBe("main");
    expect(created?.frontmatter.routing.team).toBeUndefined();
  });

  it("defaults routing.team from project.owner.team when lead is 'system'", async () => {
    const projectPath = join(tmpDir, "Projects", "test-proj-team");
    await mkdir(projectPath, { recursive: true });
    const manifest = buildProjectManifest("test-proj-team", {
      title: "Team Default Test",
      type: "swe",
      owner: { team: "growth", lead: "system" },
    });
    await writeProjectManifest(projectPath, manifest);

    const projectStore = new FilesystemTaskStore(projectPath, {
      projectId: "test-proj-team",
    });
    await projectStore.init();
    const projectLogger = new EventLogger(join(projectPath, "events"));

    const result = await aofDispatch(
      { store: projectStore, logger: projectLogger, projectId: "test-proj-team" },
      {
        title: "default-from-team",
        brief: "should default team from owner.team when lead='system'",
        actor: "coordinator",
        project: "test-proj-team",
      },
    );

    expect(result.taskId).toMatch(/^TASK-/);
    const created = await projectStore.get(result.taskId);
    expect(created?.frontmatter.routing.team).toBe("growth");
    expect(created?.frontmatter.routing.agent).toBeUndefined();
  });

  it("treats owner.team === 'system' AND owner.lead === 'system' as sentinel (both skipped → rejection)", async () => {
    // The _inbox / event-calendar-2026 case: pure placeholder owner.
    const projectPath = join(tmpDir, "Projects", "test-proj-system");
    await mkdir(projectPath, { recursive: true });
    const manifest = buildProjectManifest("test-proj-system", {
      title: "System Sentinel Test",
      type: "admin",
      owner: { team: "system", lead: "system" },
    });
    await writeProjectManifest(projectPath, manifest);

    const projectStore = new FilesystemTaskStore(projectPath, {
      projectId: "test-proj-system",
    });
    await projectStore.init();
    const projectLogger = new EventLogger(join(projectPath, "events"));

    await expect(
      aofDispatch(
        { store: projectStore, logger: projectLogger, projectId: "test-proj-system" },
        {
          title: "system-sentinel-probe",
          brief: "should fall through to rejection — both fields are 'system'",
          actor: "coordinator",
          project: "test-proj-system",
        },
      ),
    ).rejects.toThrow(/requires a routing target|tags-only routing is not supported/i);
  });

  it("treats owner.team='SYSTEM' (uppercase) as sentinel — case-insensitive", async () => {
    // Defends T-46-05-05: caller crafting owner.team="SYSTEM" must NOT
    // bypass the sentinel check.
    const projectPath = join(tmpDir, "Projects", "test-proj-uppercase");
    await mkdir(projectPath, { recursive: true });
    const manifest = buildProjectManifest("test-proj-uppercase", {
      title: "Uppercase System Sentinel Test",
      type: "admin",
      owner: { team: "SYSTEM", lead: "System" },
    });
    await writeProjectManifest(projectPath, manifest);

    const projectStore = new FilesystemTaskStore(projectPath, {
      projectId: "test-proj-uppercase",
    });
    await projectStore.init();
    const projectLogger = new EventLogger(join(projectPath, "events"));

    await expect(
      aofDispatch(
        { store: projectStore, logger: projectLogger, projectId: "test-proj-uppercase" },
        {
          title: "uppercase-sentinel-probe",
          brief: "should also fall through to rejection (case-insensitive)",
          actor: "coordinator",
          project: "test-proj-uppercase",
        },
      ),
    ).rejects.toThrow(/requires a routing target|tags-only routing is not supported/i);
  });

  it("accepts dispatch with only role set (no agent, no team) — role is a truthy routing target", async () => {
    const result = await aofDispatch(
      { store, logger },
      {
        title: "role-only probe",
        brief: "role on its own should be sufficient",
        actor: "main",
        role: "coordinator",
      },
    );

    expect(result.taskId).toMatch(/^TASK-/);
    const created = await store.get(result.taskId);
    expect(created?.frontmatter.routing.role).toBe("coordinator");
    expect(created?.frontmatter.routing.agent).toBeUndefined();
    expect(created?.frontmatter.routing.team).toBeUndefined();
  });

  it("accepts dispatch with explicit agent — bypasses defaulting and rejection", async () => {
    // Baseline: explicit routing always works regardless of project context.
    const result = await aofDispatch(
      { store, logger },
      {
        title: "explicit agent baseline",
        brief: "explicit agent should bypass new validation entirely",
        actor: "main",
        agent: "swe-backend",
      },
    );

    expect(result.taskId).toMatch(/^TASK-/);
    const created = await store.get(result.taskId);
    expect(created?.frontmatter.routing.agent).toBe("swe-backend");
  });
});
