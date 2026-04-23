/**
 * Chat-delivery poller — plugin-side long-poll loop that drains
 * `GET /v1/deliveries/wait` and dispatches each received `ChatDeliveryRequest`
 * to `sendChatDelivery` (which calls the platform-specific OpenClaw outbound
 * send inside the gateway process).
 *
 * Mirrors `spawn-poller.ts` — same module-scope idempotency gate, same
 * exponential backoff on transport errors, same fire-and-forget handler
 * invocation so one slow send cannot stall the loop.
 *
 * @module openclaw/chat-delivery-poller
 */

import { createLogger } from "../logging/index.js";
import type { DaemonIpcClient } from "./daemon-ipc-client.js";
import type { OpenClawApi } from "./types.js";
import { sendChatDelivery } from "./chat-message-sender.js";
import type { ChatDeliveryRequest } from "../ipc/schemas.js";

const log = createLogger("chat-delivery-poller");

const WAIT_TIMEOUT_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

let chatDeliveryPollerStarted = false;

/**
 * Start the long-poll loop if it is not already running. Safe to call from
 * every `registerAofPlugin` invocation — subsequent calls are no-ops. The
 * module-scope gate survives OpenClaw's per-session plugin reload cycle
 * (same trick as `startSpawnPollerOnce`).
 */
export function startChatDeliveryPollerOnce(client: DaemonIpcClient, api: OpenClawApi): void {
  if (chatDeliveryPollerStarted) {
    log.debug("chat delivery poller already started — skip");
    return;
  }
  chatDeliveryPollerStarted = true;
  log.info({ socketPath: client.socketPath }, "chat delivery poller starting");

  void runLoop(client, api).catch((err) => {
    log.error({ err }, "chat delivery poller loop terminated unexpectedly");
    chatDeliveryPollerStarted = false;
  });
}

/** Test helper — stop the loop. It exits after the current waitForChatDelivery resolves. */
export function stopChatDeliveryPoller(): void {
  chatDeliveryPollerStarted = false;
}

/** Test helper — observe current gate state. */
export function isChatDeliveryPollerStarted(): boolean {
  return chatDeliveryPollerStarted;
}

async function runLoop(client: DaemonIpcClient, api: OpenClawApi): Promise<void> {
  let backoffMs = INITIAL_BACKOFF_MS;

  while (chatDeliveryPollerStarted) {
    try {
      const req = await client.waitForChatDelivery(WAIT_TIMEOUT_MS);
      if (!req) {
        backoffMs = INITIAL_BACKOFF_MS;
        continue;
      }

      log.info(
        { id: req.id, subscriptionId: req.subscriptionId, taskId: req.taskId },
        "delivery received",
      );

      // Fire-and-forget: don't block the loop on send latency.
      void dispatchAndAck(client, api, req);

      backoffMs = INITIAL_BACKOFF_MS;
    } catch (err) {
      log.warn({ err, backoffMs }, "delivery poll error, retrying after backoff");
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  log.info("chat delivery poller stopped");
}

async function dispatchAndAck(
  client: DaemonIpcClient,
  api: OpenClawApi,
  req: ChatDeliveryRequest,
): Promise<void> {
  try {
    await sendChatDelivery(api, req);
    await client.postChatDeliveryResult(req.id, { success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, id: req.id, taskId: req.taskId }, "chat delivery send failed");
    try {
      await client.postChatDeliveryResult(req.id, {
        success: false,
        error: { kind: "send-failed", message },
      });
    } catch (ackErr) {
      log.error({ ackErr, id: req.id }, "posting chat-delivery failure ACK failed");
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
