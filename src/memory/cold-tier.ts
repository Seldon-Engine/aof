/**
 * Cold tier — raw, immutable event logs, transcripts, and incident details.
 *
 * Write-heavy, read-rarely. Never indexed by Memory V2.
 * Uses JSONL format for efficient append and grep.
 */

import { mkdir, appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BaseEvent } from "../schemas/event.js";

export interface ColdTierOptions {
  /** Maximum file size in bytes before rotation (default 1MB). */
  maxFileSizeBytes?: number;
}

export interface IncidentReport {
  id: string;
  summary: string;
  severity: "critical" | "high" | "medium" | "low";
  timestamp: string;
  reporter: string;
  details: string;
}

/**
 * Cold tier manager for raw data storage.
 */
export class ColdTier {
  private readonly coldRoot: string;
  private readonly maxFileSizeBytes: number;
  private currentLogFile?: string;
  private currentLogSize = 0;

  constructor(
    dataDir: string,
    options: ColdTierOptions = {},
  ) {
    this.coldRoot = join(dataDir, "cold");
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? 1_048_576; // 1MB
  }

  /**
   * Log an event to cold tier (JSONL format).
   */
  async logEvent(event: BaseEvent): Promise<void> {
    const logsDir = join(this.coldRoot, "logs");
    await mkdir(logsDir, { recursive: true });

    const line = JSON.stringify(event) + "\n";
    const lineSize = Buffer.byteLength(line, "utf-8");

    // Check if we need a new file (rotation)
    if (!this.currentLogFile || this.currentLogSize + lineSize > this.maxFileSizeBytes) {
      this.currentLogFile = join(logsDir, this.generateTimestampedFilename("jsonl"));
      this.currentLogSize = 0;
    }

    await appendFile(this.currentLogFile, line, "utf-8");
    this.currentLogSize += lineSize;
  }

  /**
   * Log an agent session transcript to cold tier.
   */
  async logTranscript(sessionId: string, transcript: string): Promise<void> {
    const transcriptsDir = join(this.coldRoot, "transcripts");
    await mkdir(transcriptsDir, { recursive: true });

    const filename = `${this.generateTimestampedFilename("txt")}-${sessionId}.txt`;
    const filePath = join(transcriptsDir, filename);

    await appendFile(filePath, transcript, "utf-8");
  }

  /**
   * Log an incident report to cold tier.
   */
  async logIncident(incident: IncidentReport): Promise<void> {
    const incidentsDir = join(this.coldRoot, "incidents");
    await mkdir(incidentsDir, { recursive: true });

    const filename = `${this.generateTimestampedFilename("json")}-${incident.id}.json`;
    const filePath = join(incidentsDir, filename);

    await appendFile(filePath, JSON.stringify(incident, null, 2), "utf-8");
  }

  /**
   * Get current file size (for testing/monitoring).
   */
  async getCurrentLogSize(): Promise<number> {
    if (!this.currentLogFile) return 0;

    try {
      const stats = await stat(this.currentLogFile);
      return stats.size;
    } catch {
      return 0;
    }
  }

  /**
   * Generate ISO-8601-like timestamped filename.
   * Format: YYYY-MM-DDTHH-MM-SS-mmmZ.ext
   */
  private generateTimestampedFilename(extension: string): string {
    const now = new Date();
    const iso = now.toISOString(); // "2026-02-07T12:34:56.789Z"
    
    // Replace colons and dots with hyphens for filesystem safety
    const timestamp = iso
      .replace(/:/g, "-")
      .replace(/\./g, "-");

    return `${timestamp}.${extension}`;
  }
}
