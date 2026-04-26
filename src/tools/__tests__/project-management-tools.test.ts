/**
 * Tests for project-management tools (aof_project_create / aof_project_list).
 *
 * `aof_project_add_participant` was removed 2026-04-26 along with the
 * project.participants field — its corresponding describe block is gone.
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  projectCreateSchema,
  projectListSchema,
  aofProjectCreate,
  aofProjectList,
} from "../project-management-tools.js";
import type { ToolContext } from "../types.js";
import { FilesystemTaskStore } from "../../store/task-store.js";
import { EventLogger } from "../../events/logger.js";

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

async function buildCtx(vaultRoot: string): Promise<ToolContext & { vaultRoot: string }> {
  const store = new FilesystemTaskStore(vaultRoot);
  await store.init();
  const logger = new EventLogger(join(vaultRoot, "events"));
  return { store, logger, vaultRoot } as ToolContext & { vaultRoot: string };
}

describe("project-management-tools", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-project-mgmt-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("schemas", () => {
    it("projectCreateSchema accepts minimum input", () => {
      expect(projectCreateSchema.parse({ id: "alpha" })).toEqual({ id: "alpha" });
    });

    it("projectCreateSchema rejects empty id", () => {
      expect(() => projectCreateSchema.parse({ id: "" })).toThrow();
    });

    it("projectCreateSchema rejects unknown type", () => {
      expect(() =>
        projectCreateSchema.parse({ id: "alpha", type: "quantum" }),
      ).toThrow();
    });

    it("projectListSchema accepts empty object", () => {
      expect(projectListSchema.parse({})).toEqual({});
    });
  });

  describe("aofProjectCreate", () => {
    it("scaffolds a new project directory and manifest", async () => {
      const ctx = await buildCtx(tmpDir);
      const result = (await aofProjectCreate(ctx, {
        id: "alpha",
        title: "Alpha Project",
        type: "swe",
      })) as { projectId: string; projectRoot: string };

      expect(result.projectId).toBe("alpha");
      expect(result.projectRoot).toBe(join(tmpDir, "Projects", "alpha"));

      const manifestYaml = await readFile(
        join(result.projectRoot, "project.yaml"),
        "utf-8",
      );
      const manifest = parseYaml(manifestYaml);
      expect(manifest.id).toBe("alpha");
      expect(manifest.title).toBe("Alpha Project");
      expect(manifest.type).toBe("swe");
    });
  });

  describe("aofProjectList", () => {
    it("returns only the seeded _inbox project when no user projects exist", async () => {
      const ctx = await buildCtx(tmpDir);
      // FilesystemTaskStore.init() seeds an _inbox project on first use — this
      // is existing behaviour (see src/store/task-store.ts), so the list is
      // not strictly empty but contains exactly that one entry.
      const result = (await aofProjectList(ctx, {})) as {
        projects: Array<{ id: string }>;
      };
      expect(result.projects.map((p) => p.id)).toEqual(["_inbox"]);
    });

    it("lists discovered projects", async () => {
      const ctx = await buildCtx(tmpDir);
      await aofProjectCreate(ctx, {
        id: "alpha",
        title: "Alpha",
        type: "swe",
      });
      await aofProjectCreate(ctx, {
        id: "beta",
        title: "Beta",
        type: "ops",
      });

      const result = (await aofProjectList(ctx, {})) as {
        projects: Array<{ id: string }>;
      };
      const ids = result.projects.map((p) => p.id).sort();
      expect(ids).toContain("alpha");
      expect(ids).toContain("beta");
    });
  });

});
