/**
 * Plugin-side chat-message sender — the transport half of the chat-delivery
 * loop. Lives in the OpenClaw gateway process where the outbound adapter
 * registry is reachable.
 *
 * The daemon renders the message and enqueues a `ChatDeliveryRequest`; the
 * long-polling plugin pulls each request and hands it to `sendChatDelivery`,
 * which:
 *   1. Resolves the platform from `delivery.channel` or by parsing the
 *      OpenClaw `sessionKey` (`agent:<agentId>:<platform>:<chatType>:<id>[:topic:<topicId>]`).
 *   2. Resolves the recipient address from `delivery.target` (preferred) or
 *      the chatId segment of the sessionKey.
 *   3. Dispatches via the unified outbound adapter API:
 *      `await api.runtime.channel.outbound.loadAdapter(platform)` → `adapter.sendText({...})`.
 *
 * The legacy per-platform API (`api.runtime.channel.telegram.sendMessageTelegram`)
 * was consolidated into `runtime.channel.outbound` in recent OpenClaw builds.
 * The adapter returned by `loadAdapter(id)` exposes `sendText` / `sendMedia` /
 * `sendPoll` — we use `sendText` here since completion notifications are
 * always plain text.
 *
 * @module openclaw/chat-message-sender
 */

import { createLogger } from "../logging/index.js";
import type { ChatDeliveryRequest } from "../ipc/schemas.js";
import type { OpenClawApi } from "./types.js";

const log = createLogger("chat-message-sender");

/**
 * Thrown when sendChatDelivery cannot resolve a platform for the delivery — either
 * parseSessionKey returned undefined (e.g. 4-part subagent sessionKey `agent:X:subagent:Y`)
 * AND the caller did not set an explicit `delivery.channel`.
 *
 * The `kind = "no-platform"` tag is consumed by OpenClawChatDeliveryNotifier's catch
 * branch to trigger the agent-callback-fallback audit record (Phase 44 D-44-AGENT-CALLBACK-FALLBACK).
 *
 * @module openclaw/chat-message-sender
 */
export class NoPlatformError extends Error {
  readonly kind = "no-platform" as const;
  constructor(public readonly sessionKey: string | undefined) {
    super(
      `cannot resolve platform for delivery (sessionKey=${sessionKey ?? "<none>"}, channel=<none>)`,
    );
    this.name = "NoPlatformError";
  }
}

interface OutboundSendTextParams {
  cfg?: unknown;
  to: string;
  text: string;
  threadId?: string | number;
  accountId?: string;
  silent?: boolean;
  replyToId?: string;
}

interface OutboundAdapter {
  sendText?: (params: OutboundSendTextParams) => Promise<unknown>;
  sendMedia?: (params: OutboundSendTextParams & { mediaUrl: string }) => Promise<unknown>;
}

interface PluginRuntimeChannel {
  outbound?: {
    loadAdapter?: (id: string) => Promise<OutboundAdapter | undefined>;
  };
}

interface ParsedSessionKey {
  platform: string;
  chatId: string;
  threadId?: string;
}

/**
 * Parse an OpenClaw sessionKey of the form
 * `agent:<agentId>:<platform>:<chatType>:<chatId>[:topic:<topicId>]`.
 * Returns `undefined` if the shape doesn't match — the sender will still try
 * `delivery.target` + `delivery.channel` separately.
 */
export function parseSessionKey(key: string | undefined): ParsedSessionKey | undefined {
  if (!key) return undefined;
  const parts = key.split(":");
  // Minimum: agent:<agentId>:<platform>:<chatType>:<chatId>  → 5 parts
  if (parts.length < 5 || parts[0] !== "agent") return undefined;
  const platform = parts[2];
  if (!platform) return undefined;
  const chatId = parts[4];
  if (!chatId) return undefined;
  let threadId: string | undefined;
  // Optional `:topic:<topicId>` suffix
  const topicIdx = parts.indexOf("topic", 5);
  if (topicIdx > 0 && parts.length > topicIdx + 1) {
    threadId = parts[topicIdx + 1];
  }
  return { platform, chatId, threadId };
}

/**
 * Dispatch a chat delivery by calling the platform-specific OpenClaw send
 * primitive. Throws on any failure — the caller wraps this in a try/catch to
 * translate to an ACK result.
 */
export async function sendChatDelivery(
  api: OpenClawApi,
  req: ChatDeliveryRequest,
): Promise<void> {
  const runtime = api.runtime as Record<string, unknown> | undefined;
  const runtimeChannel = (runtime as { channel?: PluginRuntimeChannel } | undefined)?.channel;
  if (!runtimeChannel) {
    log.error(
      { runtimeKeys: runtime ? Object.keys(runtime) : null },
      "api.runtime.channel not available — dumping runtime shape for diagnosis",
    );
    throw new Error("api.runtime.channel not available — plugin-sdk version mismatch");
  }

  const parsed = parseSessionKey(req.delivery.sessionKey);
  const platform = req.delivery.channel ?? parsed?.platform;
  if (!platform) {
    throw new NoPlatformError(req.delivery.sessionKey);
  }

  const target = req.delivery.target ?? parsed?.chatId;
  if (!target) {
    throw new Error(
      `cannot resolve target for delivery ${req.id} (sessionKey=${req.delivery.sessionKey ?? "<none>"}, target=<none>)`,
    );
  }

  const threadIdRaw = req.delivery.threadId ?? parsed?.threadId;

  log.info(
    { id: req.id, platform, target, threadId: threadIdRaw, taskId: req.taskId },
    "dispatching chat delivery",
  );

  // Unified outbound adapter API (post-consolidation plugin-sdk). The legacy
  // per-platform `runtime.channel.<platform>.sendMessage<Platform>` surface
  // was replaced by `runtime.channel.outbound.loadAdapter(channelId)` →
  // `adapter.sendText({...})`.
  const loadAdapter = runtimeChannel.outbound?.loadAdapter;
  if (typeof loadAdapter !== "function") {
    const channelKeys = Object.keys(runtimeChannel as Record<string, unknown>);
    log.error(
      { channelKeys },
      "runtime.channel.outbound.loadAdapter not available — dumping runtime.channel shape",
    );
    throw new Error("runtime.channel.outbound.loadAdapter not available");
  }

  const adapter = await loadAdapter(platform);
  if (!adapter?.sendText) {
    const channelKeys = Object.keys(runtimeChannel as Record<string, unknown>);
    const adapterKeys = adapter
      ? Object.keys(adapter as unknown as Record<string, unknown>)
      : null;
    log.error(
      { channelKeys, adapterKeys, platform },
      "outbound adapter missing sendText — dumping shape",
    );
    throw new Error(`outbound adapter for "${platform}" does not expose sendText`);
  }

  const cfg = (api.runtime as { config?: { loadConfig?: () => unknown } } | undefined)?.config?.loadConfig?.();
  const threadId =
    threadIdRaw !== undefined && threadIdRaw !== ""
      ? threadIdRaw
      : undefined;

  await adapter.sendText({
    cfg,
    to: target,
    text: req.message,
    ...(threadId !== undefined ? { threadId } : {}),
  });
}
