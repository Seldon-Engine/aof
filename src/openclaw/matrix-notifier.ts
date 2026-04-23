/**
 * Matrix notification adapter for OpenClaw.
 *
 * Uses OpenClaw's message tool to send notifications to Matrix rooms.
 * This file is NOT part of the core library — it's OpenClaw-specific.
 */

import { createLogger } from "../logging/index.js";
import type { NotificationAdapter } from "../events/notifier.js";

const log = createLogger("matrix-notifier");

/**
 * Optional per-delivery context forwarded by OpenClawChatDeliveryNotifier.
 * Transport adapters that need the subscription/task identity (e.g. the
 * daemon's QueueBackedMessageTool) consume this; simple transports ignore it.
 */
export interface ChatDeliveryContext {
  subscriptionId: string;
  taskId: string;
  toStatus: string;
  delivery?: Record<string, unknown>;
}

export interface MatrixMessageTool {
  send(target: string, message: string, ctx?: ChatDeliveryContext): Promise<void>;
}

export class MatrixNotifier implements NotificationAdapter {
  private readonly messageTool: MatrixMessageTool;

  constructor(messageTool: MatrixMessageTool) {
    this.messageTool = messageTool;
  }

  async send(channel: string, message: string): Promise<void> {
    try {
      await this.messageTool.send(channel, message);
    } catch (err) {
      // Log error but don't fail — notifications are best-effort
      log.error({ err, channel }, "failed to send notification");
    }
  }
}

/**
 * Mock Matrix message tool for testing.
 */
export class MockMatrixMessageTool implements MatrixMessageTool {
  readonly sent: Array<{ target: string; message: string }> = [];

  async send(target: string, message: string): Promise<void> {
    this.sent.push({ target, message });
  }
}
