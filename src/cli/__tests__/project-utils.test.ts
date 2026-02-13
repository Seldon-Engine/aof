import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProjectStore, getViewsDir, getMailboxViewsDir, getKanbanViewsDir } from "../project-utils.js";

describe("CLI project utilities", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-cli-project-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates TaskStore for default project (_inbox)", async () => {
    // Create Projects/_inbox structure
    const inboxDir = join(tmpDir, "Projects", "_inbox");
    await mkdir(join(inboxDir, "tasks", "backlog"), { recursive: true });

    const { store, projectRoot, vaultRoot } = await createProjectStore({
      vaultRoot: tmpDir,
    });

    expect(store).toBeDefined();
    expect(store.projectId).toBe("_inbox");
    expect(projectRoot).toBe(inboxDir);
    expect(vaultRoot).toBe(tmpDir);
  });

  it("creates TaskStore for specific project", async () => {
    const projectId = "test-project";
    const projectDir = join(tmpDir, "Projects", projectId);
    await mkdir(join(projectDir, "tasks", "backlog"), { recursive: true });

    const { store, projectRoot, vaultRoot } = await createProjectStore({
      projectId,
      vaultRoot: tmpDir,
    });

    expect(store).toBeDefined();
    expect(store.projectId).toBe(projectId);
    expect(projectRoot).toBe(projectDir);
    expect(vaultRoot).toBe(tmpDir);
  });

  it("resolves views directory correctly", () => {
    const projectRoot = "/path/to/project";
    expect(getViewsDir(projectRoot)).toBe("/path/to/project/views");
  });

  it("resolves mailbox views directory correctly", () => {
    const projectRoot = "/path/to/project";
    expect(getMailboxViewsDir(projectRoot)).toBe("/path/to/project/views/mailbox");
  });

  it("resolves kanban views directory correctly", () => {
    const projectRoot = "/path/to/project";
    expect(getKanbanViewsDir(projectRoot)).toBe("/path/to/project/views/kanban");
  });
});
