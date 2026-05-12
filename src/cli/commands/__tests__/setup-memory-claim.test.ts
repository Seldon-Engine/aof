/**
 * Unit tests for `decideMemoryClaim` — the decision logic gating whether
 * `aof setup` claims `plugins.slots.memory` for AOF. Replaces the previous
 * unconditional-claim behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@inquirer/prompts", () => ({
  confirm: vi.fn(),
}));

import { confirm } from "@inquirer/prompts";
import { decideMemoryClaim } from "../setup.js";

const mockConfirm = vi.mocked(confirm);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("decideMemoryClaim — mode='never'", () => {
  it("never claims, regardless of slot state", async () => {
    expect(await decideMemoryClaim("never", undefined, false)).toMatchObject({ claim: false });
    expect(await decideMemoryClaim("never", "memory-core", false)).toMatchObject({ claim: false });
    expect(await decideMemoryClaim("never", "aof", true)).toMatchObject({ claim: false });
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});

describe("decideMemoryClaim — empty slot", () => {
  it("always claims when slot is empty (auto, non-interactive)", async () => {
    const r = await decideMemoryClaim("auto", undefined, true);
    expect(r.claim).toBe(true);
    expect(r.displacing).toBeUndefined();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("always claims when slot is empty (auto, interactive — no prompt)", async () => {
    const r = await decideMemoryClaim("auto", undefined, false);
    expect(r.claim).toBe(true);
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});

describe("decideMemoryClaim — slot already AOF", () => {
  it("re-asserts ownership (idempotent)", async () => {
    const r = await decideMemoryClaim("auto", "aof", false);
    expect(r.claim).toBe(true);
    expect(r.displacing).toBeUndefined();
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});

describe("decideMemoryClaim — another plugin holds the slot", () => {
  it("mode='auto' + non-interactive → SKIP, leaves other plugin alone", async () => {
    const r = await decideMemoryClaim("auto", "memory-core", true);
    expect(r.claim).toBe(false);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(r.reason).toMatch(/memory-core/);
  });

  it("mode='auto' + interactive → PROMPT; user accepts → claim with displacing set", async () => {
    mockConfirm.mockResolvedValue(true);

    const r = await decideMemoryClaim("auto", "memory-core", false);

    expect(mockConfirm).toHaveBeenCalledOnce();
    expect(r.claim).toBe(true);
    expect(r.displacing).toBe("memory-core");
  });

  it("mode='auto' + interactive → PROMPT; user declines → skip", async () => {
    mockConfirm.mockResolvedValue(false);

    const r = await decideMemoryClaim("auto", "memory-core", false);

    expect(mockConfirm).toHaveBeenCalledOnce();
    expect(r.claim).toBe(false);
    expect(r.reason).toMatch(/declined/i);
  });

  it("mode='force' → claim without prompting, regardless of auto flag", async () => {
    const r1 = await decideMemoryClaim("force", "memory-core", true);
    const r2 = await decideMemoryClaim("force", "memory-core", false);

    expect(r1.claim).toBe(true);
    expect(r1.displacing).toBe("memory-core");
    expect(r2.claim).toBe(true);
    expect(r2.displacing).toBe("memory-core");
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});
