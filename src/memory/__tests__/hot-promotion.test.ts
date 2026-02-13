import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HotPromotion, type PromotionOptions } from "../hot-promotion.js";

describe("HotPromotion", () => {
  let tmpDir: string;
  let promotion: HotPromotion;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hot-promotion-test-"));
    promotion = new HotPromotion(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("promote", () => {
    it("promotes warm doc to hot tier with confirmation", async () => {
      const warmDir = join(tmpDir, "warm", "runbooks");
      const hotDir = join(tmpDir, "hot");
      await mkdir(warmDir, { recursive: true });
      await mkdir(hotDir, { recursive: true });

      const warmDoc = join(warmDir, "deploy.md");
      await writeFile(warmDoc, "# Deploy Runbook\n\nSteps...", "utf-8");

      const opts: PromotionOptions = {
        from: warmDoc,
        to: join(hotDir, "DEPLOY.md"),
        approved: true, // Pre-approved for test
      };

      const result = await promotion.promote(opts);

      expect(result.success).toBe(true);
      expect(result.hotSize).toBeLessThan(50_000);
    });

    it("rejects promotion when hot tier exceeds size limit", async () => {
      const warmDir = join(tmpDir, "warm");
      const hotDir = join(tmpDir, "hot");
      await mkdir(warmDir, { recursive: true });
      await mkdir(hotDir, { recursive: true });

      // Create large hot docs (>50KB total)
      const largeContent = "x".repeat(51_000);
      await writeFile(join(hotDir, "large.md"), largeContent, "utf-8");

      const warmDoc = join(warmDir, "small.md");
      await writeFile(warmDoc, "# Small doc", "utf-8");

      const opts: PromotionOptions = {
        from: warmDoc,
        to: join(hotDir, "new.md"),
        approved: true,
      };

      const result = await promotion.promote(opts);

      expect(result.success).toBe(false);
      expect(result.error).toContain("size limit");
    });

    it("requires approval when approved=false", async () => {
      const warmDir = join(tmpDir, "warm");
      const hotDir = join(tmpDir, "hot");
      await mkdir(warmDir, { recursive: true });
      await mkdir(hotDir, { recursive: true });

      const warmDoc = join(warmDir, "test.md");
      await writeFile(warmDoc, "# Test", "utf-8");

      const opts: PromotionOptions = {
        from: warmDoc,
        to: join(hotDir, "test.md"),
        approved: false,
      };

      const result = await promotion.promote(opts);

      expect(result.success).toBe(false);
      expect(result.requiresReview).toBe(true);
    });

    it("generates diff preview", async () => {
      const warmDir = join(tmpDir, "warm");
      const hotDir = join(tmpDir, "hot");
      await mkdir(warmDir, { recursive: true });
      await mkdir(hotDir, { recursive: true });

      const warmDoc = join(warmDir, "test.md");
      await writeFile(warmDoc, "# Updated\n\nNew content", "utf-8");

      const hotDoc = join(hotDir, "test.md");
      await writeFile(hotDoc, "# Old\n\nOld content", "utf-8");

      const diff = await promotion.generateDiff(warmDoc, hotDoc);

      expect(diff).toContain("Updated");
      expect(diff).toContain("Old");
    });
  });

  describe("getHotSize", () => {
    it("calculates total hot tier size", async () => {
      const hotDir = join(tmpDir, "hot");
      await mkdir(hotDir, { recursive: true });

      await writeFile(join(hotDir, "a.md"), "aaa", "utf-8");
      await writeFile(join(hotDir, "b.md"), "bbbb", "utf-8");

      const size = await promotion.getHotSize();

      expect(size).toBe(7); // 3 + 4 bytes
    });

    it("excludes review log from size calculation", async () => {
      const hotDir = join(tmpDir, "hot");
      await mkdir(hotDir, { recursive: true });

      await writeFile(join(hotDir, "doc.md"), "content", "utf-8");
      await writeFile(join(hotDir, ".promotion-log.jsonl"), "log data", "utf-8");

      const size = await promotion.getHotSize();

      expect(size).toBe(7); // Only doc.md counted
    });
  });
});
