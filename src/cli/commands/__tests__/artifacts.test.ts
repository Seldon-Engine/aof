import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerArtifactCommands } from "../artifacts.js";

describe("artifact CLI commands", () => {
  let tmpDir: string;
  let logs: string[];

  beforeEach(async () => {
    tmpDir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(tmpdir(), "aof-artifacts-cli-test-")));
    logs = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message ?? "")));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("registers archive/list/restore commands and prints machine-readable summaries", async () => {
    const program = new Command();
    program.exitOverride();
    registerArtifactCommands(program);

    const sourceDir = join(tmpDir, "payload");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "file.txt"), "payload", "utf-8");
    const archiveRoot = join(tmpDir, "archives");

    await program.parseAsync([
      "node", "aof", "artifacts", "archive", sourceDir,
      "--project", "cli-demo",
      "--title", "CLI Demo",
      "--tag", "cli",
      "--archive-root", archiveRoot,
    ]);
    const summary = JSON.parse(logs.at(-1)!);
    expect(summary).toMatchObject({ project: "cli-demo", title: "CLI Demo", tags: ["cli"] });

    await program.parseAsync(["node", "aof", "artifacts", "list", "--json", "--archive-root", archiveRoot]);
    const rows = JSON.parse(logs.at(-1)!);
    expect(rows[0]).toMatchObject({ id: summary.id, project: "cli-demo", title: "CLI Demo", tags: ["cli"] });

    const destParent = join(tmpDir, "restored");
    await program.parseAsync([
      "node", "aof", "artifacts", "restore", summary.id,
      "--dest", destParent,
      "--archive-root", archiveRoot,
    ]);
    const restoreSummary = JSON.parse(logs.at(-1)!);
    expect(restoreSummary).toMatchObject({ archiveId: summary.id, restoredPath: join(destParent, "payload") });
  });
});
