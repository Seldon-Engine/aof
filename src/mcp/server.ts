#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AofMcpServer } from "./adapter.js";
import { getConfig } from "../config/registry.js";
import { createLogger } from "../logging/index.js";

const log = createLogger("mcp");

const dataDir = getConfig().core.dataDir;

const server = new AofMcpServer({
  dataDir,
});

const transport = new StdioServerTransport();

server.start(transport).catch((error) => {
  log.error({ err: error }, "failed to start AOF MCP server");
  process.exitCode = 1;
});
