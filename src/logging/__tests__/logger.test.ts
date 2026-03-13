import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import pino from "pino";
import { resetConfig } from "../../config/registry.js";
import { createLogger, resetLogger } from "../index.js";

describe("Logger Factory", () => {
  beforeEach(() => {
    resetConfig({ core: { logLevel: "debug" } });
    resetLogger();
  });

  afterEach(() => {
    resetLogger();
    resetConfig();
  });

  describe("createLogger()", () => {
    it("returns a logger with expected methods (info, warn, error, debug)", () => {
      const log = createLogger("test-component");
      expect(typeof log.info).toBe("function");
      expect(typeof log.warn).toBe("function");
      expect(typeof log.error).toBe("function");
      expect(typeof log.debug).toBe("function");
    });

    it("returns a logger that can create child loggers", () => {
      const log = createLogger("parent");
      const child = log.child({ sub: "child" });
      expect(typeof child.info).toBe("function");
      expect(typeof child.warn).toBe("function");
    });
  });

  describe("JSON output", () => {
    it("writes JSON containing level, time, component, and msg fields", async () => {
      const stream = new PassThrough();
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));

      // Create a test logger that writes to our stream instead of stderr
      const testRoot = pino(
        { level: "debug", timestamp: pino.stdTimeFunctions.isoTime },
        stream,
      );
      const log = testRoot.child({ component: "test-json" });

      log.info("hello structured");

      // Give async serialization a tick
      await new Promise((resolve) => setTimeout(resolve, 50));

      const output = Buffer.concat(chunks).toString();
      const lines = output.trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(1);

      const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(parsed).toHaveProperty("level");
      expect(parsed).toHaveProperty("time");
      expect(parsed).toHaveProperty("component", "test-json");
      expect(parsed).toHaveProperty("msg", "hello structured");
    });
  });

  describe("log level filtering", () => {
    it("setting level to 'error' suppresses info and warn output", async () => {
      const stream = new PassThrough();
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));

      const testRoot = pino(
        { level: "error", timestamp: pino.stdTimeFunctions.isoTime },
        stream,
      );
      const log = testRoot.child({ component: "level-test" });

      log.info("should not appear");
      log.warn("should not appear either");
      log.error("should appear");

      await new Promise((resolve) => setTimeout(resolve, 50));

      const output = Buffer.concat(chunks).toString().trim();
      const lines = output.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(parsed).toHaveProperty("msg", "should appear");
    });

    it("createLogger respects config log level", () => {
      resetLogger();
      resetConfig({ core: { logLevel: "error" } });
      const log = createLogger("level-config");
      expect(log.level).toBe("error");
    });
  });

  describe("child logger component field", () => {
    it("includes component in every log line", async () => {
      const stream = new PassThrough();
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));

      const testRoot = pino({ level: "debug" }, stream);
      const log = testRoot.child({ component: "my-module" });

      log.info("test message");
      await new Promise((resolve) => setTimeout(resolve, 50));

      const output = Buffer.concat(chunks).toString().trim();
      const parsed = JSON.parse(output) as Record<string, unknown>;
      expect(parsed).toHaveProperty("component", "my-module");
    });
  });

  describe("resetLogger()", () => {
    it("allows re-initialization with different config", () => {
      // First initialization with debug level
      const log1 = createLogger("reset-test");
      expect(log1.level).toBe("debug");

      // Reset and re-initialize with error level
      resetLogger();
      resetConfig({ core: { logLevel: "error" } });

      const log2 = createLogger("reset-test");
      expect(log2.level).toBe("error");
    });
  });

  describe("error serialization", () => {
    it("error objects logged via { err } field include stack trace", async () => {
      const stream = new PassThrough();
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));

      const testRoot = pino(
        { level: "debug", timestamp: pino.stdTimeFunctions.isoTime },
        stream,
      );
      const log = testRoot.child({ component: "err-test" });

      const testError = new Error("something broke");
      log.error({ err: testError }, "operation failed");

      await new Promise((resolve) => setTimeout(resolve, 50));

      const output = Buffer.concat(chunks).toString().trim();
      const parsed = JSON.parse(output) as Record<string, unknown>;
      expect(parsed).toHaveProperty("err");

      const errObj = parsed["err"] as Record<string, unknown>;
      expect(errObj).toHaveProperty("message", "something broke");
      expect(errObj).toHaveProperty("stack");
      expect(typeof errObj["stack"]).toBe("string");
      expect(errObj["stack"] as string).toContain("something broke");
    });
  });

  describe("EventLogger isolation", () => {
    it("src/events/ has no imports of src/logging/", async () => {
      const { execSync } = await import("node:child_process");
      const result = execSync(
        'grep -r "from.*logging" src/events/ --include="*.ts" 2>/dev/null || true',
        { encoding: "utf-8" },
      );
      expect(result.trim()).toBe("");
    });
  });
});
