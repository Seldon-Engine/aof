/**
 * Test helper: read task files from filesystem for state assertions.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseTaskFile } from "../store/task-store.js";

export async function readTasksInDir(dir: string): Promise<Array<ReturnType<typeof parseTaskFile>>> {
  const files = await readdir(dir).catch(() => []);
  const tasks = [];
  for (const file of files.filter(f => f.endsWith(".md"))) {
    const content = await readFile(join(dir, file), "utf-8");
    try { tasks.push(parseTaskFile(content)); } catch { /* skip unparseable */ }
  }
  return tasks;
}
