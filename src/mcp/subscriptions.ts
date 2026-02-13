import { join } from "node:path";
import { ViewWatcher, type WatchEvent } from "../views/watcher.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { parseTaskPath, resolveAssignedAgent, resolveTask, type AofMcpContext } from "./shared.js";

interface Subscriber {
  sessionId: string;
  sendNotification: RequestHandlerExtra<ServerRequest, ServerNotification>["sendNotification"];
}

interface SubscriptionRecord {
  uri: string;
  subscribers: Map<string, Subscriber>;
}

export interface SubscriptionOptions {
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 200;

export class SubscriptionManager {
  private readonly ctx: AofMcpContext;
  private readonly debounceMs: number;
  private readonly subscriptions = new Map<string, SubscriptionRecord>();
  private readonly pending = new Set<string>();
  private debounceTimer?: NodeJS.Timeout;
  private watcher?: ViewWatcher;

  constructor(ctx: AofMcpContext, options: SubscriptionOptions = {}) {
    this.ctx = ctx;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  async start(): Promise<void> {
    const tasksDir = join(this.ctx.dataDir, "tasks");
    this.watcher = new ViewWatcher({
      viewDir: tasksDir,
      viewType: "auto",
      debounceMs: this.debounceMs,
      onEvent: (event) => {
        void this.handleWatchEvent(event);
      },
    });
    await this.watcher.start();
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = undefined;
    }
    this.subscriptions.clear();
  }

  subscribe(uri: string, extra: RequestHandlerExtra<ServerRequest, ServerNotification>): void {
    if (!isSubscribableUri(uri)) {
      throw new McpError(ErrorCode.InvalidParams, `Subscription not supported for ${uri}`);
    }

    const sessionId = extra.sessionId ?? "default";
    const record = this.subscriptions.get(uri) ?? { uri, subscribers: new Map() };
    record.subscribers.set(sessionId, { sessionId, sendNotification: extra.sendNotification });
    this.subscriptions.set(uri, record);

    void extra.sendNotification({
      method: "notifications/resources/updated",
      params: { uri },
    });
  }

  unsubscribe(uri: string, extra: RequestHandlerExtra<ServerRequest, ServerNotification>): void {
    const sessionId = extra.sessionId ?? "default";
    const record = this.subscriptions.get(uri);
    if (!record) return;
    record.subscribers.delete(sessionId);
    if (record.subscribers.size === 0) {
      this.subscriptions.delete(uri);
    }
  }

  async handleWatchEvent(event: WatchEvent): Promise<void> {
    const uris = await mapWatchEventToUris(this.ctx, event);
    if (uris.length === 0) return;
    for (const uri of uris) {
      if (!this.subscriptions.has(uri)) continue;
      this.pending.add(uri);
    }

    if (this.pending.size === 0) return;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.flushPending();
    }, this.debounceMs);
  }

  private async flushPending(): Promise<void> {
    const uris = Array.from(this.pending);
    this.pending.clear();

    for (const uri of uris) {
      const record = this.subscriptions.get(uri);
      if (!record) continue;
      for (const subscriber of record.subscribers.values()) {
        await subscriber.sendNotification({
          method: "notifications/resources/updated",
          params: { uri },
        });
      }
    }
  }
}

export async function mapWatchEventToUris(ctx: AofMcpContext, event: WatchEvent): Promise<string[]> {
  const info = parseTaskPath(event.path);
  if (!info) return [];

  const uris = new Set<string>();
  uris.add(`aof://tasks/${info.taskId}`);
  uris.add(`aof://tasks?status=${info.status}`);

  try {
    const task = await resolveTask(ctx.store, info.taskId);
    if (task.frontmatter.routing.team) {
      uris.add(`aof://views/kanban/${task.frontmatter.routing.team}`);
    }
    const agent = resolveAssignedAgent(task);
    if (agent) {
      uris.add(`aof://views/mailbox/${agent}`);
    }
  } catch {
    // Task might have been deleted or moved; ignore.
  }

  return Array.from(uris);
}

function isSubscribableUri(uri: string): boolean {
  if (uri.startsWith("aof://tasks/")) return true;
  if (uri.startsWith("aof://tasks?status=")) return true;
  if (uri.startsWith("aof://views/kanban/")) return true;
  if (uri.startsWith("aof://views/mailbox/")) return true;
  return false;
}
