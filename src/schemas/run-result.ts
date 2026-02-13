import { z } from "zod";
import { TaskId } from "./task.js";
import { CompletionOutcome, TestReport } from "./protocol.js";

export const RunResult = z.object({
  taskId: TaskId,
  agentId: z.string(),
  completedAt: z.string().datetime(),
  outcome: CompletionOutcome,
  summaryRef: z.string(),
  handoffRef: z.string(),
  deliverables: z.array(z.string()).default([]),
  tests: TestReport,
  blockers: z.array(z.string()).default([]),
  notes: z.string(),
});
export type RunResult = z.infer<typeof RunResult>;
