/**
 * Warm tier aggregation — transform cold events into warm docs.
 *
 * V1: Deterministic rule-based aggregation (no LLM).
 * V2: LLM-based summarization (future).
 */

import { readdir, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { BaseEvent } from "../schemas/event.js";

export interface AggregationRule {
  id: string;
  name: string;
  filter: (event: BaseEvent) => boolean;
  aggregate: (events: BaseEvent[]) => string;
  output: {
    path: string; // Relative to warm/
  };
}

export interface AggregationOptions {
  customRules?: AggregationRule[];
  since?: Date; // Only process events after this date (future optimization)
}

export interface AggregationResult {
  eventsProcessed: number;
  warmDocsUpdated: number;
  errors: Array<{ rule: string; error: string }>;
  durationMs: number;
}

/**
 * Default aggregation rules (v1).
 */
const DEFAULT_RULES: AggregationRule[] = [
  {
    id: "recent-completions",
    name: "Recent Task Completions",
    filter: (event) =>
      event.type === "task.transitioned" && event.payload?.to === "done",
    aggregate: (events) => {
      // Sort events for deterministic output
      const sorted = events.slice().sort((a, b) => {
        const timeCompare = a.timestamp.localeCompare(b.timestamp);
        if (timeCompare !== 0) return timeCompare;
        return a.eventId - b.eventId;
      });

      // Use latest event timestamp for "Last updated" (deterministic)
      const lastTimestamp = sorted.length > 0
        ? sorted[sorted.length - 1]!.timestamp
        : new Date().toISOString();

      const lines = [
        "# Recent Task Completions",
        "",
        "Last updated: " + lastTimestamp,
        "",
      ];

      for (const event of sorted) {
        const taskId = event.taskId ?? "unknown";
        const title = event.payload?.title ?? "Untitled";
        const priority = event.payload?.priority ?? "normal";
        const actor = event.actor ?? "system";
        const timestamp = event.timestamp;

        lines.push(`- **${taskId}** (${priority}): ${title}`);
        lines.push(`  - Completed by: ${actor}`);
        lines.push(`  - At: ${timestamp}`);
        lines.push("");
      }

      return lines.join("\n");
    },
    output: {
      path: "status/recent-completions.md",
    },
  },
  {
    id: "known-issues",
    name: "Known Issues",
    filter: (event) =>
      event.type === "task.transitioned" && event.payload?.to === "blocked",
    aggregate: (events) => {
      // Use latest event timestamp for deterministic output
      const sorted = events.slice().sort((a, b) => {
        const timeCompare = a.timestamp.localeCompare(b.timestamp);
        if (timeCompare !== 0) return timeCompare;
        return a.eventId - b.eventId;
      });

      const lastTimestamp = sorted.length > 0
        ? sorted[sorted.length - 1]!.timestamp
        : new Date().toISOString();

      const lines = [
        "# Known Issues",
        "",
        "Blocked tasks and recurring issues.",
        "",
        "Last updated: " + lastTimestamp,
        "",
      ];

      const issueMap = new Map<string, number>();
      for (const event of sorted) {
        const reason = typeof event.payload?.reason === "string" 
          ? event.payload.reason 
          : "Unknown reason";
        issueMap.set(reason, (issueMap.get(reason) ?? 0) + 1);
      }

      const sortedIssues = Array.from(issueMap.entries()).sort((a, b) => b[1] - a[1]);

      for (const [issue, count] of sortedIssues) {
        lines.push(`- **${issue}** (${count} occurrence${count > 1 ? "s" : ""})`);
      }

      lines.push("");
      return lines.join("\n");
    },
    output: {
      path: "known-issues/blocked-tasks.md",
    },
  },
];

/**
 * Warm tier aggregator.
 */
export class WarmAggregator {
  private readonly coldRoot: string;
  private readonly warmRoot: string;
  private readonly rules: AggregationRule[];

  constructor(
    dataDir: string,
    options: AggregationOptions = {},
  ) {
    this.coldRoot = join(dataDir, "cold");
    this.warmRoot = join(dataDir, "warm");
    this.rules = [...DEFAULT_RULES, ...(options.customRules ?? [])];
  }

  /**
   * Run aggregation: process cold events and update warm docs.
   */
  async aggregate(): Promise<AggregationResult> {
    const start = performance.now();
    const errors: Array<{ rule: string; error: string }> = [];
    let eventsProcessed = 0;
    let warmDocsUpdated = 0;

    // 1. Load all events from cold tier
    const events = await this.loadColdEvents();
    eventsProcessed = events.length;

    // 2. Apply each rule
    for (const rule of this.rules) {
      try {
        const filtered = events.filter(rule.filter);
        if (filtered.length === 0) continue;

        const content = rule.aggregate(filtered);
        const outputPath = join(this.warmRoot, rule.output.path);

        // Check if content changed (incremental update)
        let existingContent = "";
        try {
          existingContent = await readFile(outputPath, "utf-8");
        } catch {
          // File doesn't exist yet
        }

        if (existingContent === content) {
          // Skip write if content unchanged
          continue;
        }

        // Enforce size limit (100KB warn, 150KB hard)
        const sizeBytes = Buffer.byteLength(content, "utf-8");
        if (sizeBytes > 150_000) {
          errors.push({
            rule: rule.id,
            error: `Output exceeds 150KB limit: ${sizeBytes} bytes`,
          });
          continue;
        }

        await mkdir(join(outputPath, ".."), { recursive: true });
        await writeFileAtomic(outputPath, content, "utf-8");

        warmDocsUpdated += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ rule: rule.id, error: message });
      }
    }

    const durationMs = Math.round(performance.now() - start);

    return {
      eventsProcessed,
      warmDocsUpdated,
      errors,
      durationMs,
    };
  }

  /**
   * Load all events from cold tier (JSONL files).
   */
  private async loadColdEvents(): Promise<BaseEvent[]> {
    const logsDir = join(this.coldRoot, "logs");
    const events: BaseEvent[] = [];

    let files: string[];
    try {
      files = await readdir(logsDir);
    } catch {
      return events; // Logs directory doesn't exist yet
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;

      const filePath = join(logsDir, file);
      const content = await readFile(filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as BaseEvent;
          events.push(event);
        } catch {
          // Skip malformed lines
        }
      }
    }

    return events;
  }
}
