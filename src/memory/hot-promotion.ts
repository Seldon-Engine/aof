/**
 * Hot tier promotion — gated updates to canonical core docs.
 *
 * Hot tier is <50KB total, stable, always indexed.
 * Promotions require review and size checks.
 */

import { readFile, writeFile, readdir, stat, mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";

export interface PromotionOptions {
  from: string; // Warm doc path
  to: string; // Hot doc path (relative to hot root)
  approved?: boolean; // Manual approval (default: false)
  reviewer?: string; // Who approved
  reason?: string; // Why promoted
}

export interface PromotionResult {
  success: boolean;
  requiresReview?: boolean;
  hotSize?: number;
  diff?: string;
  error?: string;
}

interface PromotionLogEntry {
  timestamp: string;
  from: string;
  to: string;
  reviewer: string;
  reason: string;
  hotSizeBefore: number;
  hotSizeAfter: number;
}

const HOT_SIZE_LIMIT = 50_000; // 50KB
const PROMOTION_LOG = ".promotion-log.jsonl";

export class HotPromotion {
  private readonly dataDir: string;
  private readonly hotRoot: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.hotRoot = join(dataDir, "hot");
  }

  /**
   * Promote a warm doc to hot tier with gated review.
   */
  async promote(opts: PromotionOptions): Promise<PromotionResult> {
    if (!opts.approved) {
      const diff = await this.generateDiff(opts.from, opts.to);
      return {
        success: false,
        requiresReview: true,
        diff,
      };
    }

    try {
      // 1. Check hot tier size before promotion
      const hotSizeBefore = await this.getHotSize();
      const warmContent = await readFile(opts.from, "utf-8");
      const warmSize = Buffer.byteLength(warmContent, "utf-8");

      // 2. Check if promotion would exceed limit
      let toSize = 0;
      try {
        const existing = await readFile(opts.to, "utf-8");
        toSize = Buffer.byteLength(existing, "utf-8");
      } catch {
        // File doesn't exist yet
      }

      const hotSizeAfter = hotSizeBefore - toSize + warmSize;

      if (hotSizeAfter > HOT_SIZE_LIMIT) {
        return {
          success: false,
          hotSize: hotSizeAfter,
          error: `Promotion would exceed hot tier size limit: ${hotSizeAfter} > ${HOT_SIZE_LIMIT} bytes`,
        };
      }

      // 3. Apply promotion (atomic write)
      await mkdir(join(opts.to, ".."), { recursive: true });
      await writeFileAtomic(opts.to, warmContent, "utf-8");

      // 4. Log promotion
      await this.logPromotion({
        timestamp: new Date().toISOString(),
        from: opts.from,
        to: opts.to,
        reviewer: opts.reviewer ?? "cli",
        reason: opts.reason ?? "manual promotion",
        hotSizeBefore,
        hotSizeAfter,
      });

      return {
        success: true,
        hotSize: hotSizeAfter,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Promotion failed: ${message}`,
      };
    }
  }

  /**
   * Generate diff between warm and hot docs.
   */
  async generateDiff(warmPath: string, hotPath: string): Promise<string> {
    try {
      const warmContent = await readFile(warmPath, "utf-8");
      let hotContent = "";
      try {
        hotContent = await readFile(hotPath, "utf-8");
      } catch {
        // Hot file doesn't exist
      }

      const lines = [
        `--- ${hotPath} (current)`,
        `+++ ${warmPath} (candidate)`,
        "",
      ];

      if (!hotContent) {
        lines.push("(new file)");
        lines.push("");
        lines.push(...warmContent.split("\n").map(line => `+ ${line}`));
      } else {
        // Simple line-by-line diff (v1: no smart diff algorithm)
        const hotLines = hotContent.split("\n");
        const warmLines = warmContent.split("\n");
        const maxLen = Math.max(hotLines.length, warmLines.length);

        for (let i = 0; i < maxLen; i++) {
          const hotLine = hotLines[i] ?? "";
          const warmLine = warmLines[i] ?? "";
          if (hotLine !== warmLine) {
            if (hotLine) lines.push(`- ${hotLine}`);
            if (warmLine) lines.push(`+ ${warmLine}`);
          }
        }
      }

      return lines.join("\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error generating diff: ${message}`;
    }
  }

  /**
   * Calculate total hot tier size (excluding review log).
   */
  async getHotSize(): Promise<number> {
    try {
      return await this.recursiveDirSize(this.hotRoot);
    } catch {
      return 0;
    }
  }

  /**
   * Recursively calculate directory size, excluding promotion log.
   */
  private async recursiveDirSize(dir: string): Promise<number> {
    let total = 0;

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name === PROMOTION_LOG) continue; // Exclude log
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          total += await this.recursiveDirSize(fullPath);
        } else if (entry.isFile()) {
          const stats = await stat(fullPath);
          total += stats.size;
        }
      }
    } catch {
      // Directory doesn't exist or unreadable
    }

    return total;
  }

  /**
   * Log a promotion event.
   */
  private async logPromotion(entry: PromotionLogEntry): Promise<void> {
    await mkdir(this.hotRoot, { recursive: true });
    const logPath = join(this.hotRoot, PROMOTION_LOG);
    const line = JSON.stringify(entry) + "\n";
    await appendFile(logPath, line, "utf-8");
  }
}
