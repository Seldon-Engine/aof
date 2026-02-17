/**
 * Task parsing and serialization utilities.
 * Pure functions for converting between Markdown files and Task objects.
 */

import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { TaskFrontmatter, Task } from "../schemas/task.js";

const FRONTMATTER_FENCE = "---";

/** Parse a Markdown file with YAML frontmatter into Task. */
export function parseTaskFile(raw: string, filePath?: string): Task {
  const lines = raw.split("\n");

  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    throw new Error("Task file must start with YAML frontmatter (---)");
  }

  const endIdx = lines.indexOf(FRONTMATTER_FENCE, 1);
  if (endIdx === -1) {
    throw new Error("Unterminated YAML frontmatter (missing closing ---)");
  }

  const yamlBlock = lines.slice(1, endIdx).join("\n");
  const body = lines.slice(endIdx + 1).join("\n").trim();
  const rawFrontmatter = parseYaml(yamlBlock) as unknown;
  const frontmatter = TaskFrontmatter.parse(rawFrontmatter);

  return { frontmatter, body, path: filePath };
}

/** Serialize a Task back to Markdown with YAML frontmatter. */
export function serializeTask(task: Task): string {
  const yaml = stringifyYaml(task.frontmatter, { lineWidth: 120 });
  return `${FRONTMATTER_FENCE}\n${yaml}${FRONTMATTER_FENCE}\n\n${task.body}\n`;
}

/**
 * Extract Instructions and Guidance sections from a task body.
 * 
 * Returns an object with optional `instructions` and `guidance` properties.
 * Empty string means section header exists but no content.
 * Undefined means section header does not exist.
 * Case-insensitive section matching.
 */
export function extractTaskSections(body: string): {
  instructions?: string;
  guidance?: string;
} {
  const lines = body.split("\n");
  const result: { instructions?: string; guidance?: string } = {};
  
  // Find section headers (case-insensitive)
  const sectionRegex = /^##\s+(.+?)\s*$/i;
  const sections: Array<{ name: string; startLine: number }> = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line?.match(sectionRegex);
    if (match) {
      sections.push({ name: match[1]!.toLowerCase(), startLine: i });
    }
  }
  
  // Extract content for each section
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const nextSection = sections[i + 1];
    const endLine = nextSection ? nextSection.startLine : lines.length;
    
    const contentLines = lines.slice(section.startLine + 1, endLine);
    const content = contentLines.join("\n").trim();
    
    // Store content even if empty (to distinguish from missing section)
    if (section.name === "instructions") {
      result.instructions = content;
    } else if (section.name === "guidance") {
      result.guidance = content;
    }
  }
  
  return result;
}

/** Compute SHA-256 content hash for a task body. */
export function contentHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}
