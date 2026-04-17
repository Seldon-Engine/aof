/**
 * Tests for project-management tools (aof_project_create / _list /
 * _add_participant). Validates schema shapes and handler behaviour against a
 * real `vaultRoot` on tmp disk.
 */

import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  projectCreateSchema,
  projectListSchema,
  projectAddParticipantSchema,
  aofProjectCreate,
  aofProjectList,
  aofProjectAddParticipant,
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

    it("projectAddParticipantSchema requires project + agent", () => {
      expect(() => projectAddParticipantSchema.parse({})).toThrow();
      expect(() => projectAddParticipantSchema.parse({ project: "a" })).toThrow();
      expect(() => projectAddParticipantSchema.parse({ agent: "a" })).toThrow();
      expect(
        projectAddParticipantSchema.parse({ project: "a", agent: "b" }),
      ).toEqual({ project: "a", agent: "b" });
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

  describe("aofProjectAddParticipant", () => {
    async function seedProject(
      ctx: ToolContext & { vaultRoot: string },
      id: string,
    ): Promise<string> {
      const projectRoot = join(ctx.vaultRoot, "Projects", id);
      await mkdir(projectRoot, { recursive: true });
      await writeFile(
        join(projectRoot, "project.yaml"),
        stringifyYaml({
          id,
          title: id,
          status: "active",
          type: "ops",
          owner: { team: "team-x", lead: "lead-x" },
          participants: [],
          routing: {},
          memory: {},
          links: {},
        }),
        "utf-8",
      );
      return projectRoot;
    }

    it("appends a new participant to the manifest", async () => {
      const ctx = await buildCtx(tmpDir);
      const projectRoot = await seedProject(ctx, "gamma");

      const result = (await aofProjectAddParticipant(ctx, {
        project: "gamma",
        agent: "agent-a",
      })) as { success: boolean; participants: string[] };

      expect(result.success).toBe(true);
      expect(result.participants).toEqual(["agent-a"]);

      const manifest = parseYaml(
        await readFile(join(projectRoot, "project.yaml"), "utf-8"),
      );
      expect(manifest.participants).toEqual(["agent-a"]);
    });

    it("is idempotent when participant already present", async () => {
      const ctx = await buildCtx(tmpDir);
      await seedProject(ctx, "delta");

      await aofProjectAddParticipant(ctx, {
        project: "delta",
        agent: "agent-b",
      });
      const result = (await aofProjectAddParticipant(ctx, {
        project: "delta",
        agent: "agent-b",
      })) as { success: boolean; message?: string; participants: string[] };

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/already/i);
      expect(result.participants).toEqual(["agent-b"]);
    });
  });
});
