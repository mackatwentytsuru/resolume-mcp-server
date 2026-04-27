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
import { ResolumeRestClient } from "./resolume/rest.js";
import { CompositionStore } from "./resolume/composition-store/store.js";
import { registerTools } from "./server/registerTools.js";
import { NAME, VERSION } from "./version.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = ResolumeClient.fromConfig(config);

  // v0.5 CompositionStore — opt-in via RESOLUME_CACHE.
  // Default `mode === "off"` means store is not constructed and behavior is
  // bit-for-bit identical to v0.4: zero behavior change for existing users.
  let store: CompositionStore | undefined;
  if (config.cache.mode !== "off") {
    const rest = new ResolumeRestClient({
      baseUrl: `http://${config.host}:${config.port}`,
      timeoutMs: config.timeoutMs,
    });
    store = new CompositionStore({
      options: {
        oscHost: config.osc.host,
        oscOutPort: config.osc.outPort,
        mode: config.cache.mode,
      },
      rest,
    });
    // start() never throws — it logs hydration failures to stderr and lets
    // the reconnect loop retry. We `void` it on purpose so MCP boot is not
    // blocked on Resolume being up.
    void store.start();
    process.stderr.write(
      `[resolume-mcp] CompositionStore enabled in ${config.cache.mode.toUpperCase()} mode (RESOLUME_CACHE).\n`
    );
  }

  const server = new McpServer({
    name: NAME,
    version: VERSION,
  });

  registerTools(server, { client, osc: config.osc, store });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown: flush the cache socket on SIGINT/SIGTERM.
  if (store) {
    const shutdown = async () => {
      try {
        await store!.stop();
      } catch {
        /* best-effort */
      }
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  }

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
