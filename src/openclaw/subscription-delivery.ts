/**
 * @module openclaw/subscription-delivery
 *
 * Phase 44: promotes the dispatcher-identity envelope from a plugin-local interface to a
 * first-class Zod schema. Extends SubscriptionDelivery's `kind`-based polymorphism with a
 * typed `openclaw-chat` subtype that carries the captured dispatcher route + identity.
 *
 * Passthrough-compatible: unknown fields flow through untouched so Phase 999.4 can extend
 * the same shape for project-wide subscriptions without a schema break.
 */
import { z } from "zod";

export const OPENCLAW_CHAT_DELIVERY_KIND = "openclaw-chat" as const;

export const OpenClawChatDelivery = z
  .object({
    kind: z.literal(OPENCLAW_CHAT_DELIVERY_KIND).describe(
      "Delivery kind tag; always 'openclaw-chat' for this schema",
    ),

    // Addressable identity — captured at aof_dispatch time in the plugin.
    sessionKey: z.string().optional().describe(
      "OpenClaw session key, e.g. 'agent:<agentId>:<platform>:<chatType>:<chatId>[:topic:<topicId>]'",
    ),
    sessionId: z.string().optional().describe("OpenClaw session id (platform-independent)"),
    channel: z.string().optional().describe("Platform channel (e.g. 'telegram', 'matrix', 'slack')"),
    threadId: z.string().optional().describe("Thread / topic id within the channel"),
    target: z.string().optional().describe(
      "Platform-specific recipient (e.g. chat id, room id); fallback when sessionKey cannot be parsed",
    ),

    // NEW in Phase 44 — promoted from the drop-floor of today's capture.
    dispatcherAgentId: z.string().optional().describe(
      "Agent id that originated the aof_dispatch call (captured.actor). Used for observability and as the key for 999.4 project-wide subscription lookups. NOT the subscriberId dedupe tag.",
    ),
    capturedAt: z.string().datetime().optional().describe(
      "ISO-8601 timestamp when the plugin captured the dispatcher route (before_tool_call event time)",
    ),
    pluginId: z.string().default("openclaw").describe(
      "IPC envelope plugin id; defaults to 'openclaw' for this delivery kind. " +
      "Always present at runtime (mergeDispatchNotificationRecipient injects it unconditionally).",
    ),

    // NEW in Phase 44 — refines what kind of wake-up this is.
    wakeUpMode: z
      .enum(["chat-message", "agent-callback-fallback"])
      .optional()
      .describe(
        "Wake-up delivery mode: 'chat-message' uses runtime.channel.outbound.loadAdapter(platform).sendText; " +
          "'agent-callback-fallback' is set by the notifier when parseSessionKey fails (subagent sessionKey) " +
          "so the audit trail records why the wake-up was lost.",
      ),
  })
  .passthrough();

export type OpenClawChatDeliveryType = z.infer<typeof OpenClawChatDelivery>;
