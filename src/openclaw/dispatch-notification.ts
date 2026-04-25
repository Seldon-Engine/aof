/**
 * Plugin-local pre-send transform for `aof_dispatch` that translates a
 * captured OpenClaw session route into a core-agnostic SubscriptionDelivery
 * payload on `params.notifyOnCompletion`. Runs BEFORE the IPC call because
 * the capture state lives in the plugin-local
 * `OpenClawToolInvocationContextStore`.
 *
 * Phase 46 / Bug 2C: also injects `params.actor` from `captured.actor`
 * (which is the agentId from the OpenClaw before_tool_call event) when
 * params.actor is absent. Closes the createdBy:"unknown" gap on
 * plugin-originated tasks even when the agent doesn't pass actor
 * explicitly. Defense-in-depth — the daemon-side IPC route injection
 * is the primary fix (see src/ipc/routes/invoke-tool.ts).
 *
 * Precedence for params.actor:
 *   1. explicit (caller-supplied) params.actor wins
 *   2. captured.actor (agentId from before_tool_call)
 *   3. undefined (handler's own ?? "unknown" fallback kicks in)
 *
 * Precedence for notifyOnCompletion:
 *   - explicit object passed by caller wins (per-field override).
 *   - `false` disables entirely (caller opt-out), BUT actor injection
 *     still runs (Phase 46 — actor is needed for createdBy even when
 *     notifications are disabled).
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
  // Phase 46 / Bug 2C: consume captured context BEFORE the
  // notifyOnCompletion=false early-return so actor injection runs
  // regardless of notification preference. The consume side-effect
  // moves slightly earlier in the call graph (was: only on non-false
  // paths; now: always). consumeToolCall is idempotent in the sense
  // that double-reading the same toolCallId returns undefined the
  // second time, which is fine — no other caller reads the same id.
  const captured = store.consumeToolCall(toolCallId);

  // Phase 46 / Bug 2C: inject params.actor from captured?.actor when caller
  // didn't supply one. Explicit params.actor (if present and a non-empty
  // string) wins over captured.actor.
  const existingActor =
    typeof params.actor === "string" && params.actor.length > 0
      ? params.actor
      : undefined;
  const enriched: Record<string, unknown> =
    !existingActor && captured?.actor
      ? { ...params, actor: captured.actor }
      : params;

  const raw = params.notifyOnCompletion;
  if (raw === false) return enriched;

  const explicit = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  const { kind: rawKind, ...explicitRest } = explicit ?? {};
  const kind =
    typeof rawKind === "string" && rawKind.trim().length > 0 ? rawKind.trim() : undefined;

  if (!explicit && !captured) return enriched;

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
  return { ...enriched, notifyOnCompletion: delivery };
}
