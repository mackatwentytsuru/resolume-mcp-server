#!/usr/bin/env node

/**
 * Resolume MCP Server — stdio entry point.
 *
 * Architecture:
 *   LLM (Claude) <--stdio--> MCP Server (this) <--HTTP--> Resolume Web Server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { ResolumeClient } from "./resolume/client.js";
import { registerTools } from "./server/registerTools.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = ResolumeClient.fromConfig(config);

  const server = new McpServer({
    name: "resolume-mcp-server",
    version: "0.1.0",
  });

  registerTools(server, { client });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const isLoopback =
    config.host === "127.0.0.1" || config.host === "localhost" || config.host === "::1";
  process.stderr.write(
    `[resolume-mcp] Connected. Targeting http://${config.host}:${config.port} (timeout ${config.timeoutMs}ms)\n`
  );
  if (!isLoopback) {
    process.stderr.write(
      `[resolume-mcp] WARNING: RESOLUME_HOST is not loopback. Make sure ${config.host} is your trusted local network.\n`
    );
  }
}

main().catch((err) => {
  process.stderr.write(`[resolume-mcp] Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
