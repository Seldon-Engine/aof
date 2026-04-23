/**
 * Plugin-side chat-message sender — the transport half of the chat-delivery
 * loop. Lives in the OpenClaw gateway process where platform-specific send
 * primitives (`api.runtime.channel.telegram.sendMessageTelegram`, etc.) are
 * actually reachable.
 *
 * The daemon renders the message and enqueues a `ChatDeliveryRequest`; the
 * long-polling plugin pulls each request and hands it to `sendChatDelivery`,
 * which:
 *   1. Resolves the platform from `delivery.channel` or by parsing the
 *      OpenClaw `sessionKey` (`agent:<agentId>:<platform>:<chatType>:<id>[:topic:<topicId>]`).
 *   2. Resolves the recipient address from `delivery.target` (preferred) or
 *      the chatId segment of the sessionKey.
 *   3. Dispatches to the matching plugin-sdk send function via
 *      `api.runtime.channel.<platform>.sendMessage<Platform>`.
 *
 * Platforms are wired on demand — adding Discord/Slack/WhatsApp is a matter
 * of adding an entry to `SEND_FN_BY_PLATFORM`. Unknown platforms throw so the
 * ACK-path reports the failure to the daemon instead of silently dropping.
 *
 * @module openclaw/chat-message-sender
 */

import { createLogger } from "../logging/index.js";
import type { ChatDeliveryRequest } from "../ipc/schemas.js";
import type { OpenClawApi } from "./types.js";

const log = createLogger("chat-message-sender");

interface PluginRuntimeChannel {
  telegram?: {
    sendMessageTelegram?: (
      to: string,
      text: string,
      opts?: { messageThreadId?: number; silent?: boolean; token?: string },
    ) => Promise<unknown>;
  };
  discord?: {
    sendMessageDiscord?: (to: string, text: string, opts?: Record<string, unknown>) => Promise<unknown>;
  };
  slack?: {
    sendMessageSlack?: (to: string, text: string, opts?: Record<string, unknown>) => Promise<unknown>;
  };
  signal?: {
    sendMessageSignal?: (to: string, text: string, opts?: Record<string, unknown>) => Promise<unknown>;
  };
  whatsapp?: {
    sendMessageWhatsApp?: (to: string, text: string, opts?: Record<string, unknown>) => Promise<unknown>;
  };
  imessage?: {
    sendMessageIMessage?: (to: string, text: string, opts?: Record<string, unknown>) => Promise<unknown>;
  };
  line?: {
    sendMessageLine?: (to: string, text: string, opts?: Record<string, unknown>) => Promise<unknown>;
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
  const runtimeChannel = (api.runtime as { channel?: PluginRuntimeChannel } | undefined)?.channel;
  if (!runtimeChannel) {
    throw new Error("api.runtime.channel not available — plugin-sdk version mismatch");
  }

  const parsed = parseSessionKey(req.delivery.sessionKey);
  const platform = req.delivery.channel ?? parsed?.platform;
  if (!platform) {
    throw new Error(
      `cannot resolve platform for delivery (sessionKey=${req.delivery.sessionKey ?? "<none>"}, channel=<none>)`,
    );
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

  switch (platform) {
    case "telegram": {
      const sendFn = runtimeChannel.telegram?.sendMessageTelegram;
      if (!sendFn) throw new Error("runtime.channel.telegram.sendMessageTelegram not available");
      const messageThreadId =
        threadIdRaw !== undefined && threadIdRaw !== ""
          ? Number.parseInt(threadIdRaw, 10)
          : undefined;
      const opts = messageThreadId !== undefined && Number.isFinite(messageThreadId)
        ? { messageThreadId }
        : undefined;
      await sendFn(target, req.message, opts);
      return;
    }
    case "discord": {
      const sendFn = runtimeChannel.discord?.sendMessageDiscord;
      if (!sendFn) throw new Error("runtime.channel.discord.sendMessageDiscord not available");
      await sendFn(target, req.message);
      return;
    }
    case "slack": {
      const sendFn = runtimeChannel.slack?.sendMessageSlack;
      if (!sendFn) throw new Error("runtime.channel.slack.sendMessageSlack not available");
      await sendFn(target, req.message);
      return;
    }
    case "signal": {
      const sendFn = runtimeChannel.signal?.sendMessageSignal;
      if (!sendFn) throw new Error("runtime.channel.signal.sendMessageSignal not available");
      await sendFn(target, req.message);
      return;
    }
    case "whatsapp": {
      const sendFn = runtimeChannel.whatsapp?.sendMessageWhatsApp;
      if (!sendFn) throw new Error("runtime.channel.whatsapp.sendMessageWhatsApp not available");
      await sendFn(target, req.message);
      return;
    }
    case "imessage": {
      const sendFn = runtimeChannel.imessage?.sendMessageIMessage;
      if (!sendFn) throw new Error("runtime.channel.imessage.sendMessageIMessage not available");
      await sendFn(target, req.message);
      return;
    }
    case "line": {
      const sendFn = runtimeChannel.line?.sendMessageLine;
      if (!sendFn) throw new Error("runtime.channel.line.sendMessageLine not available");
      await sendFn(target, req.message);
      return;
    }
    default:
      throw new Error(`unsupported platform: ${platform}`);
  }
}
