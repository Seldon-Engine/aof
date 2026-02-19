/**
 * SeverityResolver — determines severity for a matched rule.
 *
 * In the current design, severity is declared on each rule. This module
 * provides a typed resolver and the critical-event check that bypasses
 * deduplication.
 *
 * Future: runtime severity escalation (e.g. promote warn→critical after N
 * occurrences within a window) can be added here without touching engine.ts.
 */

import type { Severity } from "./rules.js";
import type { BaseEvent } from "../../schemas/event.js";

/**
 * Event types that are always treated as critical, regardless of rule config.
 * These bypass deduplication and are never suppressed.
 */
export const ALWAYS_CRITICAL_EVENTS: ReadonlySet<string> = new Set([
  "system.shutdown",
  "task.abandoned",
  "task.deadletter",
  "gate_timeout_escalation",
]);

export class SeverityResolver {
  /**
   * Returns the effective severity for a matched rule + event combination.
   *
   * If the event type is in ALWAYS_CRITICAL_EVENTS, severity is promoted to
   * "critical" regardless of what the rule says.
   */
  resolve(ruleSeverity: Severity, event: BaseEvent): Severity {
    if (this.isAlwaysCritical(event.type)) return "critical";
    return ruleSeverity;
  }

  /**
   * Returns true if the event should never be suppressed by deduplication.
   * This is true when:
   * - The event type is in ALWAYS_CRITICAL_EVENTS, OR
   * - The matched rule has neverSuppress: true
   */
  neverSuppress(event: BaseEvent, ruleNeverSuppress?: boolean): boolean {
    return ruleNeverSuppress === true || this.isAlwaysCritical(event.type);
  }

  private isAlwaysCritical(eventType: string): boolean {
    return ALWAYS_CRITICAL_EVENTS.has(eventType);
  }
}
