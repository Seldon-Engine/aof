/**
 * No-op detector -- identifies agent sessions with zero tool calls.
 *
 * A session with zero tool calls is flagged as a suspected no-op.
 * This catches the Phase 25 incident pattern: an agent that claims
 * completion but never actually used any tools.
 *
 * Intentionally simple. The complexity lives in the session parser,
 * not the detector. "Meaningful tool call" = any tool call at all.
 */

/** Result of no-op detection. */
export interface NoopResult {
  /** Whether this session was flagged as a no-op (zero tool calls). */
  noopDetected: boolean;
  /** True when session file was missing/unreadable and detection was skipped. */
  skipped?: boolean;
}

/** Options for detectNoop. */
export interface NoopDetectOpts {
  /** Number of tool calls extracted from the session. */
  toolCallCount: number;
  /** Whether the session file was missing or unreadable. */
  sessionMissing: boolean;
}

/**
 * Detect whether a session is a no-op (zero tool calls).
 *
 * If the session file was missing/unreadable, detection is skipped
 * entirely -- a missing file is not suspicious, just unavailable.
 */
export function detectNoop(opts: NoopDetectOpts): NoopResult {
  if (opts.sessionMissing) {
    return { noopDetected: false, skipped: true };
  }

  if (opts.toolCallCount === 0) {
    return { noopDetected: true };
  }

  return { noopDetected: false };
}
