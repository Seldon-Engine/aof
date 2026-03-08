/**
 * Session JSONL parser -- extracts structured tool call data from
 * OpenClaw session files.
 *
 * Fully defensive: never throws on malformed data, missing files,
 * or unknown entry types. All errors are counted, not surfaced.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { access, constants } from "node:fs/promises";
import type { ToolCallTrace } from "../schemas/trace.js";

/** Options for parseSession. */
export interface ParseSessionOpts {
  /** If true, include full tool inputs/outputs and reasoning text. */
  debug: boolean;
}

/** Result of parsing a session JSONL file. */
export interface ParsedSession {
  /** Extracted tool calls. */
  toolCalls: ToolCallTrace[];
  /** Total number of tool calls. */
  toolCallCount: number;
  /** Model ID from model_change entries. */
  model?: string;
  /** Provider from model_change entries. */
  provider?: string;
  /** Thinking level from thinking_level_change entries. */
  thinkingLevel?: string;
  /** Reasoning/thinking text (debug mode only). */
  reasoning?: string[];
  /** Count of unknown JSONL entry types. */
  unknownEntries: number;
  /** Count of malformed JSONL lines. */
  parseErrors: number;
  /** Total JSONL entries successfully parsed. */
  totalEntriesParsed: number;
}

/** Maximum input string length in summary mode. */
const SUMMARY_INPUT_LIMIT = 200;

/** Known entry types that we handle (or intentionally skip). */
const KNOWN_TYPES = new Set([
  "session",
  "model_change",
  "thinking_level_change",
  "message",
  "custom",
]);

/**
 * Parse a session JSONL file into structured tool call data.
 *
 * Never throws. If the file is missing or unreadable, returns an
 * empty ParsedSession with zero counts.
 */
export async function parseSession(
  filePath: string,
  opts: ParseSessionOpts,
): Promise<ParsedSession> {
  const result: ParsedSession = {
    toolCalls: [],
    toolCallCount: 0,
    unknownEntries: 0,
    parseErrors: 0,
    totalEntriesParsed: 0,
  };

  // Check file exists before attempting to stream
  try {
    await access(filePath, constants.R_OK);
  } catch {
    return result;
  }

  // Map from toolCallId -> index in toolCalls array for toolResult matching
  const toolCallIndex = new Map<string, number>();

  try {
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, { encoding: "utf-8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      stream.on("error", () => {
        // File read error -- just resolve with what we have
        resolve();
      });

      rl.on("line", (line: string) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;

        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(trimmed);
        } catch {
          result.parseErrors++;
          return;
        }

        result.totalEntriesParsed++;
        const entryType = entry.type as string | undefined;

        if (!entryType || !KNOWN_TYPES.has(entryType)) {
          result.unknownEntries++;
          return;
        }

        switch (entryType) {
          case "session":
            // Session metadata -- nothing to extract beyond what we already track
            break;

          case "model_change":
            result.model = entry.modelId as string | undefined;
            result.provider = entry.provider as string | undefined;
            break;

          case "thinking_level_change":
            result.thinkingLevel = entry.thinkingLevel as string | undefined;
            break;

          case "message":
            processMessage(entry, opts, result, toolCallIndex);
            break;

          case "custom":
            // Intentionally skipped
            break;
        }
      });

      rl.on("close", () => resolve());
      rl.on("error", () => resolve());
    });
  } catch {
    // Catch-all: never throw
  }

  result.toolCallCount = result.toolCalls.length;
  return result;
}

/**
 * Process a message entry from the JSONL stream.
 */
function processMessage(
  entry: Record<string, unknown>,
  opts: ParseSessionOpts,
  result: ParsedSession,
  toolCallIndex: Map<string, number>,
): void {
  const message = entry.message as Record<string, unknown> | undefined;
  if (!message) return;

  const role = message.role as string | undefined;
  if (!role) return;

  if (role === "assistant") {
    processAssistantMessage(message, opts, result, toolCallIndex);
  } else if (role === "toolResult") {
    processToolResult(message, opts, result, toolCallIndex);
  }
}

/**
 * Process an assistant message -- extract tool calls and reasoning.
 */
function processAssistantMessage(
  message: Record<string, unknown>,
  opts: ParseSessionOpts,
  result: ParsedSession,
  toolCallIndex: Map<string, number>,
): void {
  const content = message.content as unknown[] | undefined;
  if (!Array.isArray(content)) return;

  for (const item of content) {
    const contentItem = item as Record<string, unknown>;
    const contentType = contentItem.type as string | undefined;

    if (contentType === "toolCall" || contentType === "tool_use") {
      const toolCall = extractToolCall(contentItem, contentType, opts);
      if (toolCall) {
        const idx = result.toolCalls.length;
        result.toolCalls.push(toolCall);
        if (toolCall.toolCallId) {
          toolCallIndex.set(toolCall.toolCallId, idx);
        }
      }
    } else if (contentType === "thinking" && opts.debug) {
      const thinkingText = contentItem.thinking as string | undefined;
      if (thinkingText) {
        if (!result.reasoning) result.reasoning = [];
        result.reasoning.push(thinkingText);
      }
    }
  }
}

/**
 * Extract a tool call from a content item.
 * Handles both "toolCall" (with arguments) and "tool_use" (with input) formats.
 */
function extractToolCall(
  item: Record<string, unknown>,
  contentType: string,
  opts: ParseSessionOpts,
): ToolCallTrace | null {
  const name = item.name as string | undefined;
  if (!name) return null;

  const toolCallId = item.id as string | undefined;

  // Get raw input: "toolCall" uses "arguments", "tool_use" uses "input"
  const rawInput = contentType === "toolCall" ? item.arguments : item.input;

  let inputStr: string;
  if (typeof rawInput === "string") {
    inputStr = rawInput;
  } else if (rawInput && typeof rawInput === "object") {
    inputStr = JSON.stringify(rawInput);
  } else {
    inputStr = "";
  }

  // Truncate in summary mode
  if (!opts.debug && inputStr.length > SUMMARY_INPUT_LIMIT) {
    inputStr = inputStr.slice(0, SUMMARY_INPUT_LIMIT);
  }

  return {
    name,
    input: inputStr,
    toolCallId,
  };
}

/**
 * Process a toolResult message -- match to tool call by toolCallId.
 * Only populates output in debug mode.
 */
function processToolResult(
  message: Record<string, unknown>,
  opts: ParseSessionOpts,
  result: ParsedSession,
  toolCallIndex: Map<string, number>,
): void {
  if (!opts.debug) return;

  const toolCallId = message.toolCallId as string | undefined;
  if (!toolCallId) return;

  const idx = toolCallIndex.get(toolCallId);
  if (idx === undefined) return;

  const content = message.content as unknown[] | undefined;
  if (!Array.isArray(content)) return;

  // Concatenate text content items
  const outputParts: string[] = [];
  for (const item of content) {
    const contentItem = item as Record<string, unknown>;
    if (contentItem.type === "text" && typeof contentItem.text === "string") {
      outputParts.push(contentItem.text);
    }
  }

  if (outputParts.length > 0 && result.toolCalls[idx]) {
    result.toolCalls[idx].output = outputParts.join("\n");
  }
}
