/**
 * Matrix notification adapter for OpenClaw.
 *
 * Uses OpenClaw's message tool to send notifications to Matrix rooms.
 * This file is NOT part of the core library — it's OpenClaw-specific.
 */

import type { NotificationAdapter } from "../events/notifier.js";

export interface MatrixMessageTool {
  send(target: string, message: string): Promise<void>;
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
      console.error(`Failed to send notification to ${channel}:`, err);
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
