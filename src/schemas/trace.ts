/**
 * Trace schema -- structured record of an agent session's tool usage.
 *
 * Every completed agent session produces a trace record by parsing the
 * OpenClaw session JSONL. Same schema shape for both summary and debug
 * modes -- debug just has more data in the same fields.
 */

import { z } from "zod";

/** Individual tool call captured from session JSONL. */
export const ToolCallTrace = z.object({
  /** Tool name (e.g. "Write", "Read", "Bash"). */
  name: z.string(),
  /** Stringified tool input. Truncated to 200 chars in summary mode. */
  input: z.string(),
  /** Tool output/result text. Only populated in debug mode. */
  output: z.string().optional(),
  /** Original tool call ID from session JSONL. */
  toolCallId: z.string().optional(),
});
export type ToolCallTrace = z.infer<typeof ToolCallTrace>;

/** Trace metadata -- parsing stats and mode info. */
export const TraceMeta = z.object({
  /** Capture verbosity mode. */
  mode: z.enum(["summary", "debug"]),
  /** Count of unknown JSONL entry types encountered. */
  unknownEntries: z.number().int().nonnegative().default(0),
  /** Count of malformed JSONL lines that failed to parse. */
  parseErrors: z.number().int().nonnegative().default(0),
  /** Whether content was truncated (e.g. 1MB debug cap). */
  truncated: z.boolean().default(false),
  /** Total number of JSONL entries successfully parsed. */
  totalEntriesParsed: z.number().int().nonnegative(),
});
export type TraceMeta = z.infer<typeof TraceMeta>;

/** Session-level metadata extracted from JSONL. */
export const TraceSession = z.object({
  /** Path to the raw session JSONL file. */
  sessionFilePath: z.string(),
  /** Session duration in milliseconds. */
  durationMs: z.number().nonnegative(),
  /** Model ID from model_change entry. */
  model: z.string().optional(),
  /** Provider from model_change entry. */
  provider: z.string().optional(),
  /** Thinking level from thinking_level_change entry. */
  thinkingLevel: z.string().optional(),
});
export type TraceSession = z.infer<typeof TraceSession>;

/** Full trace record -- written as trace-N.json alongside run_result.json. */
export const TraceSchema = z.object({
  /** Schema version (always 1). */
  version: z.literal(1),
  /** Task ID this trace belongs to. */
  taskId: z.string(),
  /** Session ID from OpenClaw. */
  sessionId: z.string(),
  /** Attempt number (1-based, for trace-N.json naming). */
  attemptNumber: z.number().int().positive(),
  /** ISO-8601 timestamp when trace was captured. */
  capturedAt: z.string().datetime(),
  /** Session-level metadata. */
  session: TraceSession,
  /** Extracted tool calls. */
  toolCalls: z.array(ToolCallTrace),
  /** Number of tool calls (convenience field). */
  toolCallCount: z.number().int().nonnegative(),
  /** Reasoning/thinking text from assistant messages. Debug mode only. */
  reasoning: z.array(z.string()).optional(),
  /** Whether this session was flagged as a no-op (zero tool calls). */
  noopDetected: z.boolean(),
  /** Parsing metadata. */
  meta: TraceMeta,
});
export type TraceSchema = z.infer<typeof TraceSchema>;
