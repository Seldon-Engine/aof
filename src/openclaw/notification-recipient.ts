import type { Task } from "../schemas/task.js";

export interface OpenClawNotificationRecipient {
  kind: "openclaw-session";
  sessionKey?: string;
  sessionId?: string;
  replyTarget?: string;
  channel?: string;
  threadId?: string;
  actor?: string;
  capturedAt: string;
}

const METADATA_KEY = "notificationRecipient";

export function getNotificationRecipient(task: Task): OpenClawNotificationRecipient | undefined {
  const candidate = task.frontmatter.metadata?.[METADATA_KEY];
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const recipient = candidate as Record<string, unknown>;
  if (recipient.kind !== "openclaw-session") {
    return undefined;
  }

  return {
    kind: "openclaw-session",
    sessionKey: typeof recipient.sessionKey === "string" ? recipient.sessionKey : undefined,
    sessionId: typeof recipient.sessionId === "string" ? recipient.sessionId : undefined,
    replyTarget: typeof recipient.replyTarget === "string" ? recipient.replyTarget : undefined,
    channel: typeof recipient.channel === "string" ? recipient.channel : undefined,
    threadId: typeof recipient.threadId === "string" ? recipient.threadId : undefined,
    actor: typeof recipient.actor === "string" ? recipient.actor : undefined,
    capturedAt:
      typeof recipient.capturedAt === "string"
        ? recipient.capturedAt
        : new Date().toISOString(),
  };
}

export function mergeNotificationRecipient(
  metadata: Record<string, unknown> | undefined,
  recipient: OpenClawNotificationRecipient,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [METADATA_KEY]: recipient,
  };
}
