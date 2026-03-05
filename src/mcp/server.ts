#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AofMcpServer } from "./adapter.js";
import { DEFAULT_AOF_ROOT } from "../projects/resolver.js";

const dataDir = process.env["AOF_ROOT"] ?? DEFAULT_AOF_ROOT;

const server = new AofMcpServer({
  dataDir,
});

const transport = new StdioServerTransport();

server.start(transport).catch((error) => {
  console.error("Failed to start AOF MCP server", error);
  process.exitCode = 1;
});
