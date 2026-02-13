/**
 * Drift detection module — Compare org chart vs OpenClaw reality
 */

export { detectDrift } from "./detector.js";
export { createAdapter, FixtureAdapter, LiveAdapter } from "./adapters.js";
export { formatDriftReport } from "./formatter.js";
export type { 
  DriftReport, 
  OpenClawAgent, 
  MissingAgent, 
  ExtraAgent, 
  AgentMismatch,
  NeedsPermissionProfile,
} from "./detector.js";
export type { AgentAdapter } from "./adapters.js";
