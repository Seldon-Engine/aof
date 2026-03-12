#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AofMcpServer } from "./adapter.js";
import { getConfig } from "../config/registry.js";

const dataDir = getConfig().core.dataDir;

const server = new AofMcpServer({
  dataDir,
});

const transport = new StdioServerTransport();

server.start(transport).catch((error) => {
  console.error("Failed to start AOF MCP server", error);
  process.exitCode = 1;
});
