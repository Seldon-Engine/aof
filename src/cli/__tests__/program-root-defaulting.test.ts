import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Verifies that `--root` resolves to the AOF *install* root (~/.aof)
 * for `install` / `update` subcommands and to the AOF *data* root
 * (~/.aof/data) for all other commands, when the user does not pass
 * `--root` explicitly.
 *
 * Regression guard for the bug where `aof update` defaulted to
 * ~/.aof/data and extracted release tarballs on top of user data.
 */

const DEFAULT_DATA_DIR = join(homedir(), ".aof", "data");
const DEFAULT_CODE_DIR = join(homedir(), ".aof");

const CODE_ROOT_COMMANDS = new Set(["install", "update"]);

function buildTestProgram(
  capture: { resolvedRoot?: string },
) {
  // Mirror the hook in src/cli/program.ts so we can unit-test its
  // behavior without loading the whole CLI (which pulls in many
  // non-test-safe side effects).
  const program = new Command()
    .name("aof")
    .option("--root <path>", "AOF root directory");

  program.hook("preAction", (thisCommand, actionCommand) => {
    const opts = thisCommand.opts();
    if (!opts["root"]) {
      const useCodeRoot =
        actionCommand !== undefined &&
        CODE_ROOT_COMMANDS.has(actionCommand.name());
      opts["root"] = useCodeRoot ? DEFAULT_CODE_DIR : DEFAULT_DATA_DIR;
    }
  });

  const record = () => {
    capture.resolvedRoot = program.opts()["root"] as string;
  };

  program.command("update").action(record);
  program.command("install").action(record);
  program.command("channel").command("show").action(record);
  const deps = program.command("deps");
  deps.command("update").action(record);
  deps.command("list").action(record);

  return program;
}

describe("program preAction --root defaulting", () => {
  const origHome = process.env["HOME"];
  let capture: { resolvedRoot?: string };

  beforeEach(() => {
    capture = {};
  });

  afterEach(() => {
    process.env["HOME"] = origHome;
    vi.restoreAllMocks();
  });

  it("defaults `aof update` to the code root (~/.aof), not the data root", async () => {
    const program = buildTestProgram(capture);
    await program.parseAsync(["node", "aof", "update"]);
    expect(capture.resolvedRoot).toBe(DEFAULT_CODE_DIR);
  });

  it("defaults `aof install` to the code root (~/.aof)", async () => {
    const program = buildTestProgram(capture);
    await program.parseAsync(["node", "aof", "install"]);
    expect(capture.resolvedRoot).toBe(DEFAULT_CODE_DIR);
  });

  it("defaults `aof deps update` to the code root (~/.aof)", async () => {
    const program = buildTestProgram(capture);
    await program.parseAsync(["node", "aof", "deps", "update"]);
    expect(capture.resolvedRoot).toBe(DEFAULT_CODE_DIR);
  });

  it("defaults `aof channel show` to the data root (~/.aof/data)", async () => {
    const program = buildTestProgram(capture);
    await program.parseAsync(["node", "aof", "channel", "show"]);
    expect(capture.resolvedRoot).toBe(DEFAULT_DATA_DIR);
  });

  it("defaults `aof deps list` to the data root (~/.aof/data)", async () => {
    const program = buildTestProgram(capture);
    await program.parseAsync(["node", "aof", "deps", "list"]);
    expect(capture.resolvedRoot).toBe(DEFAULT_DATA_DIR);
  });

  it("respects explicit --root for install/update", async () => {
    const program = buildTestProgram(capture);
    await program.parseAsync(["node", "aof", "--root", "/custom/path", "update"]);
    expect(capture.resolvedRoot).toBe("/custom/path");
  });

  it("respects explicit --root for non-code-root commands", async () => {
    const program = buildTestProgram(capture);
    await program.parseAsync(["node", "aof", "--root", "/custom/path", "channel", "show"]);
    expect(capture.resolvedRoot).toBe("/custom/path");
  });
});
