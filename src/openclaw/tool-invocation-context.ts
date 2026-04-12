import type { OpenClawNotificationRecipient } from "./notification-recipient.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? (value as UnknownRecord) : undefined;
}

function getNested(value: unknown, path: string): unknown {
  return path.split(".").reduce((current: unknown, key: string) => {
    const record = asRecord(current);
    return record ? record[key] : undefined;
  }, value);
}

function getFirstString(value: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const candidate = getNested(value, path);
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function extractToolName(event: unknown): string | undefined {
  return getFirstString(event, [
    "toolName",
    "name",
    "tool.name",
    "payload.toolName",
    "payload.name",
  ]);
}

function extractToolCallId(event: unknown): string | undefined {
  return getFirstString(event, [
    "toolCallId",
    "callId",
    "id",
    "payload.toolCallId",
    "payload.callId",
    "payload.id",
  ]);
}

function extractRecipient(event: unknown): OpenClawNotificationRecipient | undefined {
  const sessionKey = getFirstString(event, [
    "sessionKey",
    "session.key",
    "payload.sessionKey",
    "context.sessionKey",
  ]);
  const sessionId = getFirstString(event, [
    "sessionId",
    "session.id",
    "payload.sessionId",
    "context.sessionId",
  ]);
  const replyTarget = getFirstString(event, [
    "replyTarget",
    "target",
    "lastTo",
    "route.target",
    "payload.replyTarget",
    "payload.target",
    "payload.lastTo",
  ]);

  if (!sessionKey && !sessionId && !replyTarget) {
    return undefined;
  }

  return {
    kind: "openclaw-session",
    sessionKey,
    sessionId,
    replyTarget,
    channel: getFirstString(event, [
      "channel",
      "lastChannel",
      "route.channel",
      "payload.channel",
      "payload.lastChannel",
    ]),
    threadId: getFirstString(event, [
      "threadId",
      "topicId",
      "payload.threadId",
      "payload.topicId",
    ]),
    actor: getFirstString(event, [
      "agentId",
      "fromAgent",
      "payload.agentId",
      "payload.fromAgent",
    ]),
    capturedAt: new Date().toISOString(),
  };
}

function mergeRecipients(
  primary: OpenClawNotificationRecipient,
  fallback?: OpenClawNotificationRecipient,
): OpenClawNotificationRecipient {
  if (!fallback) {
    return primary;
  }

  return {
    kind: "openclaw-session",
    sessionKey: primary.sessionKey ?? fallback.sessionKey,
    sessionId: primary.sessionId ?? fallback.sessionId,
    replyTarget: primary.replyTarget ?? fallback.replyTarget,
    channel: primary.channel ?? fallback.channel,
    threadId: primary.threadId ?? fallback.threadId,
    actor: primary.actor ?? fallback.actor,
    capturedAt: primary.capturedAt,
  };
}

export class OpenClawToolInvocationContextStore {
  private readonly bySessionKey = new Map<string, OpenClawNotificationRecipient>();
  private readonly bySessionId = new Map<string, OpenClawNotificationRecipient>();
  private readonly byToolCallId = new Map<string, OpenClawNotificationRecipient>();

  captureMessageRoute(event: unknown): void {
    const recipient = extractRecipient(event);
    if (!recipient) {
      return;
    }

    if (recipient.sessionKey) {
      this.bySessionKey.set(recipient.sessionKey, recipient);
    }
    if (recipient.sessionId) {
      this.bySessionId.set(recipient.sessionId, recipient);
    }
  }

  captureToolCall(event: unknown): void {
    if (extractToolName(event) !== "aof_dispatch") {
      return;
    }

    const toolCallId = extractToolCallId(event);
    if (!toolCallId) {
      return;
    }

    const recipient = extractRecipient(event);
    if (!recipient) {
      return;
    }

    const fallback = recipient.sessionKey
      ? this.bySessionKey.get(recipient.sessionKey)
      : recipient.sessionId
        ? this.bySessionId.get(recipient.sessionId)
        : undefined;

    this.byToolCallId.set(toolCallId, mergeRecipients(recipient, fallback));
  }

  consumeToolCall(toolCallId: string): OpenClawNotificationRecipient | undefined {
    const recipient = this.byToolCallId.get(toolCallId);
    if (recipient) {
      this.byToolCallId.delete(toolCallId);
    }
    return recipient;
  }

  clearToolCall(event: unknown): void {
    const toolCallId = extractToolCallId(event);
    if (toolCallId) {
      this.byToolCallId.delete(toolCallId);
    }
  }
}
