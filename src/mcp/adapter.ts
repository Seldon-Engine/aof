import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createAofMcpContext, type AofMcpOptions } from "./shared.js";
import { registerAofTools } from "./tools.js";
import { buildBoard, registerAofResources } from "./resources.js";
import { SubscriptionManager } from "./subscriptions.js";

export class AofMcpServer {
  readonly server: McpServer;
  subscriptions?: SubscriptionManager;
  private ctx?: Awaited<ReturnType<typeof createAofMcpContext>>;
  private readonly options: AofMcpOptions & { debounceMs?: number };

  constructor(options: AofMcpOptions & { debounceMs?: number }) {
    this.options = options;
    this.server = new McpServer({
      name: "aof",
      version: "0.1.0",
    }, {
      capabilities: {
        resources: {
          subscribe: true,
          listChanged: true,
        },
        tools: {
          listChanged: true,
        },
      },
    });
  }

  async start(transport: Transport): Promise<void> {
    // Initialize context (potentially async due to project resolution)
    this.ctx = await createAofMcpContext(this.options);
    
    // Register resources and tools
    registerAofResources(this.server, this.ctx);
    registerAofTools(this.server, this.ctx, async (team, status, priority) => buildBoard(this.ctx!, team, status, priority));

    // Initialize subscriptions
    this.subscriptions = new SubscriptionManager(this.ctx, {
      debounceMs: this.options.debounceMs,
    });

    this.server.server.setRequestHandler(SubscribeRequestSchema, async (request, extra) => {
      this.subscriptions?.subscribe(request.params.uri, extra);
      return {};
    });

    this.server.server.setRequestHandler(UnsubscribeRequestSchema, async (request, extra) => {
      this.subscriptions?.unsubscribe(request.params.uri, extra);
      return {};
    });

    await this.ctx.store.init();
    await this.subscriptions.start();
    await this.server.connect(transport);
  }

  async stop(): Promise<void> {
    if (this.subscriptions) {
      await this.subscriptions.stop();
    }
    await this.server.close();
  }
}
