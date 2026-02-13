#!/usr/bin/env node

import { homedir } from "node:os";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AofMcpServer } from "./adapter.js";

const DEFAULT_ROOT = resolve(homedir(), "Projects", "AOF");
const dataDir = process.env["AOF_ROOT"] ?? DEFAULT_ROOT;

const server = new AofMcpServer({
  dataDir,
});

const transport = new StdioServerTransport();

server.start(transport).catch((error) => {
  console.error("Failed to start AOF MCP server", error);
  process.exitCode = 1;
});
