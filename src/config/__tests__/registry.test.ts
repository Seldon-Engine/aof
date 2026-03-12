import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getConfig, resetConfig, ConfigError, AofConfigSchema } from "../registry.js";

describe("Config Registry", () => {
  beforeEach(() => {
    resetConfig();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    resetConfig();
    vi.unstubAllEnvs();
  });

  describe("getConfig()", () => {
    it("returns object with core, dispatch, daemon, openclaw, integrations domains", () => {
      const config = getConfig();
      expect(config).toHaveProperty("core");
      expect(config).toHaveProperty("dispatch");
      expect(config).toHaveProperty("daemon");
      expect(config).toHaveProperty("openclaw");
      expect(config).toHaveProperty("integrations");
    });

    it("returns same cached instance on second call", () => {
      const a = getConfig();
      const b = getConfig();
      expect(a).toBe(b);
    });

    it("returns deeply frozen config (Object.isFrozen on nested objects)", () => {
      const config = getConfig();
      expect(Object.isFrozen(config)).toBe(true);
      expect(Object.isFrozen(config.core)).toBe(true);
      expect(Object.isFrozen(config.dispatch)).toBe(true);
      expect(Object.isFrozen(config.daemon)).toBe(true);
      expect(Object.isFrozen(config.openclaw)).toBe(true);
      expect(Object.isFrozen(config.integrations)).toBe(true);
    });

    it("uses defaults for missing optional fields", () => {
      const config = getConfig();
      expect(config.core.dataDir).toContain(".aof");
      expect(config.core.logLevel).toBe("info");
      expect(config.dispatch.defaultLeaseTtlMs).toBe(600_000);
      expect(config.dispatch.spawnTimeoutMs).toBe(120_000);
      expect(config.dispatch.maxConcurrency).toBe(3);
      expect(config.dispatch.maxDispatchesPerPoll).toBe(10);
      expect(config.daemon.pollIntervalMs).toBe(30_000);
      expect(config.openclaw.gatewayUrl).toBe("http://localhost:3000");
      expect(config.openclaw.stateDir).toContain(".openclaw");
    });
  });

  describe("validation errors", () => {
    it("throws ConfigError on invalid numeric env var", () => {
      vi.stubEnv("AOF_DEFAULT_LEASE_TTL_MS", "abc");
      expect(() => getConfig()).toThrow(ConfigError);
    });

    it("throws ConfigError listing ALL issues, not just the first", () => {
      vi.stubEnv("AOF_DEFAULT_LEASE_TTL_MS", "abc");
      vi.stubEnv("AOF_SPAWN_TIMEOUT_MS", "xyz");
      try {
        getConfig();
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        const configErr = err as ConfigError;
        expect(configErr.issues.length).toBeGreaterThanOrEqual(2);
      }
    });

    it("ConfigError.issues contains Zod issue objects with path and message", () => {
      vi.stubEnv("AOF_DEFAULT_LEASE_TTL_MS", "abc");
      try {
        getConfig();
        expect.unreachable("should have thrown");
      } catch (err) {
        const configErr = err as ConfigError;
        expect(configErr.issues[0]).toHaveProperty("path");
        expect(configErr.issues[0]).toHaveProperty("message");
      }
    });
  });

  describe("resetConfig()", () => {
    it("clears cache so next getConfig() re-reads env", () => {
      vi.stubEnv("AOF_LOG_LEVEL", "debug");
      const first = getConfig();
      expect(first.core.logLevel).toBe("debug");

      resetConfig();
      vi.stubEnv("AOF_LOG_LEVEL", "warn");
      const second = getConfig();
      expect(second.core.logLevel).toBe("warn");
      expect(first).not.toBe(second);
    });

    it("resetConfig({ core: { logLevel: 'debug' } }) overrides logLevel but keeps other defaults", () => {
      resetConfig({ core: { logLevel: "debug" } });
      const config = getConfig();
      expect(config.core.logLevel).toBe("debug");
      expect(config.dispatch.defaultLeaseTtlMs).toBe(600_000);
      expect(config.core.dataDir).toContain(".aof");
    });

    it("resetConfig with overrides produces a frozen result", () => {
      resetConfig({ core: { logLevel: "error" } });
      const config = getConfig();
      expect(Object.isFrozen(config)).toBe(true);
      expect(Object.isFrozen(config.core)).toBe(true);
    });
  });

  describe("unknown AOF_* env var warning", () => {
    it("triggers console.warn with closest match suggestion", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubEnv("AOF_DAAT_DIR", "/tmp/typo");
      resetConfig();
      getConfig();
      expect(warnSpy).toHaveBeenCalled();
      const msg = warnSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("AOF_DAAT_DIR"),
      );
      expect(msg).toBeDefined();
      expect(msg![0]).toContain("AOF_DATA_DIR");
      warnSpy.mockRestore();
    });
  });

  describe("AOF_ROOT backward compat", () => {
    it("reads AOF_ROOT as fallback when AOF_DATA_DIR is not set", () => {
      vi.stubEnv("AOF_ROOT", "/custom/root");
      const config = getConfig();
      expect(config.core.dataDir).toBe("/custom/root");
    });

    it("AOF_DATA_DIR takes precedence over AOF_ROOT when both set", () => {
      vi.stubEnv("AOF_DATA_DIR", "/data-dir");
      vi.stubEnv("AOF_ROOT", "/root-dir");
      const config = getConfig();
      expect(config.core.dataDir).toBe("/data-dir");
    });
  });

  describe("CFG-04: no upward dependencies", () => {
    it("registry.ts imports nothing from dispatch/, service/, store/, protocol/", async () => {
      const { readFile } = await import("node:fs/promises");
      const source = await readFile(
        new URL("../../registry.ts", import.meta.url),
        "utf-8",
      );
      expect(source).not.toMatch(/from\s+["'].*dispatch/);
      expect(source).not.toMatch(/from\s+["'].*service/);
      expect(source).not.toMatch(/from\s+["'].*store/);
      expect(source).not.toMatch(/from\s+["'].*protocol/);
    });
  });
});
