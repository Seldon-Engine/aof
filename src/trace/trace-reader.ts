/**
 * Trace reader -- loads trace-N.json files from a task's run directory.
 *
 * Reads, validates (via TraceSchema), and returns traces sorted by attempt
 * number. Corrupted or invalid files are silently skipped.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { TraceSchema } from "../schemas/trace.js";
import type { TraceSchema as TraceSchemaType } from "../schemas/trace.js";

/** Pattern matching trace-N.json filenames (N = one or more digits). */
const TRACE_FILE_RE = /^trace-(\d+)\.json$/;

/**
 * Read all valid trace files from a task directory.
 *
 * @param taskDir - Absolute path to the task's run directory
 *   (e.g. `<projectRoot>/state/runs/<taskId>`)
 * @returns Parsed traces sorted by attemptNumber (ascending).
 *   Returns [] if the directory is missing or contains no trace files.
 */
export async function readTraceFiles(
  taskDir: string,
): Promise<TraceSchemaType[]> {
  let entries: string[];
  try {
    entries = await readdir(taskDir);
  } catch {
    // Directory doesn't exist or isn't readable
    return [];
  }

  // Filter to trace-N.json and pair with extracted number for sorting
  const traceFiles: { name: string; num: number }[] = [];
  for (const entry of entries) {
    const m = TRACE_FILE_RE.exec(entry);
    if (m) {
      traceFiles.push({ name: entry, num: parseInt(m[1]!, 10) });
    }
  }

  if (traceFiles.length === 0) {
    return [];
  }

  // Sort numerically by the extracted number
  traceFiles.sort((a, b) => a.num - b.num);

  const results: TraceSchemaType[] = [];
  for (const { name } of traceFiles) {
    try {
      const raw = await readFile(join(taskDir, name), "utf-8");
      const parsed = JSON.parse(raw);
      const validated = TraceSchema.parse(parsed);
      results.push(validated);
    } catch {
      // Skip corrupted / malformed / invalid-schema files
    }
  }

  return results;
}
