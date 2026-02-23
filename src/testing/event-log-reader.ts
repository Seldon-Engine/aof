/**
 * Test helper: read and parse event log JSONL files for ODD assertions.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { BaseEvent } from "../schemas/event.js";

export async function readEventLogEntries(eventsDir: string): Promise<BaseEvent[]> {
  const files = await readdir(eventsDir).catch(() => []);
  const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));
  const entries: BaseEvent[] = [];
  for (const file of jsonlFiles) {
    const content = await readFile(join(eventsDir, file), "utf-8");
    for (const line of content.split("\n").filter(Boolean)) {
      try { entries.push(JSON.parse(line) as BaseEvent); } catch { /* skip malformed */ }
    }
  }
  return entries;
}

export function findEvents(entries: BaseEvent[], type: string): BaseEvent[] {
  return entries.filter(e => e.type === type);
}

export function expectEvent(entries: BaseEvent[], type: string): BaseEvent {
  const found = entries.find(e => e.type === type);
  if (!found) throw new Error(`Expected event type "${type}" but not found. Got: ${entries.map(e => e.type).join(", ")}`);
  return found;
}
