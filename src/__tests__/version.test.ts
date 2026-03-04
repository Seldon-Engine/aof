import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf-8"));

describe("VERSION", () => {
  it("matches package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("is valid semver", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
