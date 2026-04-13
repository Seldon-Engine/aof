type UnknownRecord = Record<string, unknown>;

/**
 * Captured OpenClaw session route — plugin-local idiom (sessionKey/sessionId
 * are OpenClaw concepts). Translated at dispatch time into a core-agnostic
 * SubscriptionDelivery payload before ever crossing into AOF core.
 */
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

type StoredRecipient = {
  recipient: OpenClawNotificationRecipient;
  expiresAt: number;
};

const DEFAULT_ROUTE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_SESSION_ROUTES = 2048;
const DEFAULT_MAX_TOOL_CALLS = 2048;

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
  private readonly bySessionKey = new Map<string, StoredRecipient>();
  private readonly bySessionId = new Map<string, StoredRecipient>();
  private readonly byToolCallId = new Map<string, StoredRecipient>();
  private readonly routeTtlMs: number;
  private readonly maxSessionRoutes: number;
  private readonly maxToolCalls: number;
  private readonly now: () => number;

  constructor(options: {
    routeTtlMs?: number;
    maxSessionRoutes?: number;
    maxToolCalls?: number;
    now?: () => number;
  } = {}) {
    this.routeTtlMs = options.routeTtlMs ?? DEFAULT_ROUTE_TTL_MS;
    this.maxSessionRoutes = options.maxSessionRoutes ?? DEFAULT_MAX_SESSION_ROUTES;
    this.maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.now = options.now ?? (() => Date.now());
  }

  captureMessageRoute(event: unknown): void {
    this.pruneExpired();
    const recipient = extractRecipient(event);
    if (!recipient) {
      return;
    }

    if (recipient.sessionKey) {
      this.storeRecipient(this.bySessionKey, recipient.sessionKey, recipient, this.maxSessionRoutes);
    }
    if (recipient.sessionId) {
      this.storeRecipient(this.bySessionId, recipient.sessionId, recipient, this.maxSessionRoutes);
    }
  }

  captureToolCall(event: unknown): void {
    this.pruneExpired();
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
      ? this.getRecipient(this.bySessionKey, recipient.sessionKey)
      : recipient.sessionId
        ? this.getRecipient(this.bySessionId, recipient.sessionId)
        : undefined;

    this.storeRecipient(
      this.byToolCallId,
      toolCallId,
      mergeRecipients(recipient, fallback),
      this.maxToolCalls,
    );
  }

  consumeToolCall(toolCallId: string): OpenClawNotificationRecipient | undefined {
    this.pruneExpired();
    const recipient = this.getRecipient(this.byToolCallId, toolCallId);
    this.byToolCallId.delete(toolCallId);
    return recipient;
  }

  clearToolCall(event: unknown): void {
    const toolCallId = extractToolCallId(event);
    if (toolCallId) {
      this.byToolCallId.delete(toolCallId);
    }
  }

  clearSessionRoute(event: unknown): void {
    const recipient = extractRecipient(event);
    if (recipient?.sessionKey) {
      this.bySessionKey.delete(recipient.sessionKey);
    }
    if (recipient?.sessionId) {
      this.bySessionId.delete(recipient.sessionId);
    }
    this.pruneExpired();
  }

  clearAll(): void {
    this.bySessionKey.clear();
    this.bySessionId.clear();
    this.byToolCallId.clear();
  }

  private storeRecipient(
    map: Map<string, StoredRecipient>,
    key: string,
    recipient: OpenClawNotificationRecipient,
    maxEntries: number,
  ): void {
    map.set(key, {
      recipient,
      expiresAt: this.now() + this.routeTtlMs,
    });

    while (map.size > maxEntries) {
      const oldestKey = map.keys().next().value;
      if (!oldestKey) {
        break;
      }
      map.delete(oldestKey);
    }
  }

  private getRecipient(
    map: Map<string, StoredRecipient>,
    key: string,
  ): OpenClawNotificationRecipient | undefined {
    const entry = map.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      map.delete(key);
      return undefined;
    }
    return entry.recipient;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const map of [this.bySessionKey, this.bySessionId, this.byToolCallId]) {
      for (const [key, entry] of map.entries()) {
        if (entry.expiresAt <= now) {
          map.delete(key);
        }
      }
    }
  }
}
