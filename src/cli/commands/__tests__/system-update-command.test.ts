import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const checkForUpdatesMock = vi.fn();
const setChannelMock = vi.fn();
const selfUpdateMock = vi.fn();
const rollbackUpdateMock = vi.fn();
const runMigrationsMock = vi.fn();

vi.mock("../../../packaging/channels.js", () => ({
  getChannel: vi.fn(),
  setChannel: setChannelMock,
  checkForUpdates: checkForUpdatesMock,
  getVersionManifest: vi.fn(),
}));

vi.mock("../../../packaging/updater.js", () => ({
  selfUpdate: selfUpdateMock,
  rollbackUpdate: rollbackUpdateMock,
}));

vi.mock("../../../packaging/migrations.js", () => ({
  runMigrations: runMigrationsMock,
}));

vi.mock("../../../packaging/installer.js", () => ({
  install: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
}));

describe("registerUpdateCommand", () => {
  let root: string;
  let program: Command;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aof-update-command-"));
    program = new Command();
    program.exitOverride();
    program.option("--root <path>");
    program.setOptionValue("root", root);

    checkForUpdatesMock.mockReset();
    setChannelMock.mockReset();
    selfUpdateMock.mockReset();
    rollbackUpdateMock.mockReset();
    runMigrationsMock.mockReset();

    checkForUpdatesMock.mockResolvedValue({
      updateAvailable: true,
      currentVersion: "1.14.3",
      latestVersion: "1.14.4",
      manifest: {
        changelog: "Bug fixes",
      },
    });

    selfUpdateMock.mockResolvedValue({
      success: true,
      version: "1.14.4",
      backupCreated: true,
      backupPath: "/tmp/aof-backup",
    });

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    await rm(root, { recursive: true, force: true });
  });

  it("uses the v-prefixed GitHub tarball asset when updating", async () => {
    const { registerUpdateCommand } = await import("../system-commands.js");
    registerUpdateCommand(program);

    await program.parseAsync(["node", "aof", "update", "--yes"]);

    expect(selfUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        aofRoot: root,
        targetVersion: "1.14.4",
        downloadUrl: "https://github.com/d0labs/aof/releases/download/v1.14.4/aof-v1.14.4.tar.gz",
      }),
    );
  });
});
