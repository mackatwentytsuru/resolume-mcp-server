import { jsonResult, type ToolDefinition } from "../types.js";

const inputSchema = {} as const;

export const cacheStatusTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_cache_status",
  title: "Report CompositionStore cache status",
  description:
    "Diagnostics tool that reports the in-memory CompositionStore cache state: hydration flag, OSC liveness, mode (owner/shared/off), total OSC messages received, rehydration counter, last OSC packet timestamp, and last REST seed timestamp. Use this AFTER setting RESOLUME_CACHE=1 (owner) or =shared to verify the cache is actually receiving OSC pushes — if msgsReceived stays at 0 or oscLive remains false, your OSC OUT port (default 7001) is not seeing Resolume traffic. When the cache is disabled, returns { enabled: false, mode: \"off\" }. Read-only and side-effect free; safe to call any time.",
  inputSchema,
  stability: "stable",
  handler: async (_args, ctx) => {
    if (!ctx.store) {
      return jsonResult({ enabled: false, mode: "off" });
    }
    return jsonResult({ enabled: true, ...ctx.store.stats() });
  },
};
