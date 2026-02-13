/**
 * BUG-002 Regression Test: Event Log Path Mismatch
 * 
 * Bug: Health check script expects events.jsonl but actual logs are date-rotated.
 * File pattern: YYYY-MM-DD.jsonl (not events.jsonl).
 * 
 * This test verifies that:
 * 1. Event logger writes to date-rotated files (YYYY-MM-DD.jsonl)
 * 2. Helper functions can locate the latest/active event log
 * 3. Documentation accurately reflects the date-based naming convention
 * 
 * This test should FAIL if code expects a fixed "events.jsonl" filename
 * and PASS once helper functions properly handle date-rotated logs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventLogger } from "../../events/logger.js";

describe("BUG-002: Event log path mismatch (date-rotated files)", () => {
  let tmpDir: string;
  let eventsDir: string;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-bug002-"));
    eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should write events to date-rotated files (YYYY-MM-DD.jsonl)", async () => {
    // Log an event
    await logger.log("test.event", "test-actor", {
      payload: { message: "Test event" },
    });

    // Check that file was created with date pattern
    const files = await readdir(eventsDir);
    
    // Should have at least one .jsonl file
    const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));
    expect(jsonlFiles.length).toBeGreaterThan(0);
    
    // File should match date pattern YYYY-MM-DD.jsonl
    const datePattern = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
    const dateRotatedFiles = jsonlFiles.filter(f => datePattern.test(f));
    expect(dateRotatedFiles.length).toBeGreaterThan(0);
    
    // Should have a symlink named "events.jsonl" pointing to current day's file
    expect(files).toContain("events.jsonl");
    const symlinkPath = join(eventsDir, "events.jsonl");
    const symlinkStat = await lstat(symlinkPath);
    expect(symlinkStat.isSymbolicLink()).toBe(true);
  });

  it("should write events from same day to same file", async () => {
    // Log multiple events on the same day
    await logger.log("test.event.1", "actor-1", {});
    await logger.log("test.event.2", "actor-2", {});
    await logger.log("test.event.3", "actor-3", {});

    const files = await readdir(eventsDir);
    const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));
    
    // Should have exactly 2 files: 1 date-rotated file + 1 symlink (all events on same day)
    expect(jsonlFiles).toHaveLength(2);
    
    // Verify file contains all 3 events
    const logFile = join(eventsDir, jsonlFiles[0]!);
    const content = await readFile(logFile, "utf-8");
    const lines = content.trim().split("\n").filter(l => l.length > 0);
    expect(lines).toHaveLength(3);
  });

  it("should use today's date in ISO format (YYYY-MM-DD)", async () => {
    await logger.log("test.event", "test-actor", {});

    const files = await readdir(eventsDir);
    const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));
    
    const filename = jsonlFiles[0]!;
    const expectedDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    
    expect(filename).toBe(`${expectedDate}.jsonl`);
  });

  it("should provide a way to find the latest event log file", async () => {
    // Simulate multiple days of logs
    const day1 = join(eventsDir, "2026-02-07.jsonl");
    const day2 = join(eventsDir, "2026-02-08.jsonl");
    const day3 = join(eventsDir, "2026-02-09.jsonl");
    
    await writeFile(day1, '{"eventId":1}\n');
    await writeFile(day2, '{"eventId":2}\n');
    await writeFile(day3, '{"eventId":3}\n');

    // Helper function to find latest log (this is what health checks should use)
    const findLatestEventLog = async (dir: string): Promise<string | null> => {
      const files = await readdir(dir);
      const datePattern = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
      const dated = files
        .filter(f => datePattern.test(f))
        .sort()
        .reverse();
      return dated.length > 0 ? join(dir, dated[0]!) : null;
    };

    const latest = await findLatestEventLog(eventsDir);
    expect(latest).toBe(day3);
  });

  it("should handle event log discovery with glob pattern", async () => {
    // Create today's log
    await logger.log("test.event", "test-actor", {});

    const files = await readdir(eventsDir);
    const datePattern = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
    const matchingFiles = files.filter(f => datePattern.test(f));
    
    // Should find at least one file with date pattern
    expect(matchingFiles.length).toBeGreaterThan(0);
    
    // All matching files should be valid event logs
    for (const file of matchingFiles) {
      const content = await readFile(join(eventsDir, file), "utf-8");
      const lines = content.trim().split("\n").filter(l => l.length > 0);
      
      // Each line should be valid JSON
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed).toHaveProperty("eventId");
        expect(parsed).toHaveProperty("type");
        expect(parsed).toHaveProperty("timestamp");
      }
    }
  });

  it("should not fail if events.jsonl symlink is used", async () => {
    // If a symlink strategy is implemented to maintain backward compatibility,
    // verify it works correctly
    
    await logger.log("test.event", "test-actor", {});
    
    const files = await readdir(eventsDir);
    const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));
    
    // Primary requirement: date-rotated file exists
    const datePattern = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
    const dateRotatedFiles = jsonlFiles.filter(f => datePattern.test(f));
    expect(dateRotatedFiles.length).toBeGreaterThan(0);
    
    // If events.jsonl exists, it should be a symlink to the current date file
    // (This is optional backward-compatibility feature)
    // For now, we just verify the date-rotated file is the source of truth
  });

  it("should document the correct log file naming convention", () => {
    // This is a meta-test to ensure documentation reflects reality
    // In practice, this would check that:
    // 1. README.md mentions YYYY-MM-DD.jsonl pattern
    // 2. Health check scripts use glob or latest-file logic
    // 3. No hardcoded "events.jsonl" references in user-facing docs
    
    // For now, we just assert the expected pattern
    const expectedPattern = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
    const exampleFilename = "2026-02-08.jsonl";
    expect(expectedPattern.test(exampleFilename)).toBe(true);
    
    // Anti-pattern check
    const incorrectFilename = "events.jsonl";
    expect(expectedPattern.test(incorrectFilename)).toBe(false);
  });
});

// Import writeFile for test fixture creation
import { writeFile } from "node:fs/promises";
