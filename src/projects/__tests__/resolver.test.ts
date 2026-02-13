import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { resolveProject, projectExists } from "../resolver.js";

describe("project resolver", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-resolver-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves default project (_inbox)", async () => {
    const resolution = await resolveProject(undefined, tmpDir);

    expect(resolution.projectId).toBe("_inbox");
    expect(resolution.projectRoot).toBe(join(tmpDir, "Projects", "_inbox"));
    expect(resolution.vaultRoot).toBe(tmpDir);
  });

  it("resolves specific project", async () => {
    const resolution = await resolveProject("test-project", tmpDir);

    expect(resolution.projectId).toBe("test-project");
    expect(resolution.projectRoot).toBe(join(tmpDir, "Projects", "test-project"));
    expect(resolution.vaultRoot).toBe(tmpDir);
  });

  it("uses AOF_ROOT env var when vaultRoot not provided", async () => {
    const originalEnv = process.env["AOF_ROOT"];
    process.env["AOF_ROOT"] = tmpDir;

    try {
      const resolution = await resolveProject("my-project");

      expect(resolution.vaultRoot).toBe(tmpDir);
      expect(resolution.projectRoot).toBe(join(tmpDir, "Projects", "my-project"));
    } finally {
      if (originalEnv !== undefined) {
        process.env["AOF_ROOT"] = originalEnv;
      } else {
        delete process.env["AOF_ROOT"];
      }
    }
  });

  it("falls back to ~/Projects/AOF when no vaultRoot or env", async () => {
    const originalEnv = process.env["AOF_ROOT"];
    delete process.env["AOF_ROOT"];

    try {
      const resolution = await resolveProject("my-project");

      const expectedVaultRoot = join(homedir(), "Projects", "AOF");
      expect(resolution.vaultRoot).toBe(expectedVaultRoot);
      expect(resolution.projectRoot).toBe(join(expectedVaultRoot, "Projects", "my-project"));
    } finally {
      if (originalEnv !== undefined) {
        process.env["AOF_ROOT"] = originalEnv;
      }
    }
  });

  it("checks if project exists", async () => {
    const projectDir = join(tmpDir, "Projects", "existing-project");
    await mkdir(projectDir, { recursive: true });

    const exists = await projectExists(projectDir);
    expect(exists).toBe(true);

    const notExists = await projectExists(join(tmpDir, "Projects", "nonexistent"));
    expect(notExists).toBe(false);
  });
});
