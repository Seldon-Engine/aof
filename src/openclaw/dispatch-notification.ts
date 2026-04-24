/**
 * Plugin-local pre-send transform for `aof_dispatch` that translates a
 * captured OpenClaw session route into a core-agnostic SubscriptionDelivery
 * payload on `params.notifyOnCompletion`. Runs BEFORE the IPC call because
 * the capture state lives in the plugin-local
 * `OpenClawToolInvocationContextStore`.
 *
 * Precedence:
 *   - explicit object passed by caller wins (per-field override).
 *   - `false` disables entirely (caller opt-out).
 *   - `true` / undefined triggers auto-capture from the invocation context.
 *
 * @module openclaw/dispatch-notification
 */

import type { OpenClawToolInvocationContextStore } from "./tool-invocation-context.js";
import { OPENCLAW_CHAT_DELIVERY_KIND } from "./openclaw-chat-delivery.js";

export function mergeDispatchNotificationRecipient(
  params: Record<string, unknown>,
  toolCallId: string,
  store: OpenClawToolInvocationContextStore,
): Record<string, unknown> {
  const raw = params.notifyOnCompletion;
  if (raw === false) return params;

  const captured = store.consumeToolCall(toolCallId);
  const explicit = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  const { kind: rawKind, ...explicitRest } = explicit ?? {};
  const kind =
    typeof rawKind === "string" && rawKind.trim().length > 0 ? rawKind.trim() : undefined;

  if (!explicit && !captured) return params;

  // Phase 44 identity enrichment (dispatcherAgentId/capturedAt/pluginId) only
  // applies on the pure auto-capture path. When the caller passes an explicit
  // notifyOnCompletion object, they own the delivery shape — do not inject
  // Phase 44 fields on top. Existing (pre-Phase-44) captured fields
  // (target/sessionKey/sessionId/channel/threadId) remain additive from
  // captured beneath the explicit overrides for backwards compatibility.
  const delivery: Record<string, unknown> = {
    ...(captured
      ? {
          target: captured.replyTarget,
          sessionKey: captured.sessionKey,
          sessionId: captured.sessionId,
          channel: captured.channel,
          threadId: captured.threadId,
          ...(explicit
            ? {}
            : {
                dispatcherAgentId: captured.actor,
                capturedAt: captured.capturedAt,
                pluginId: "openclaw",
              }),
        }
      : {}),
    ...explicitRest,
    kind: kind ?? OPENCLAW_CHAT_DELIVERY_KIND,
  };
  for (const k of Object.keys(delivery)) {
    if (delivery[k] === undefined) delete delivery[k];
  }
  return { ...params, notifyOnCompletion: delivery };
}
