import { jsonResult, type ToolDefinition } from "../types.js";

const inputSchema = {} as const;

export const cacheStatusTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_cache_status",
  title: "Report CompositionStore cache status",
  description:
    "Reports the in-memory CompositionStore cache state. Returns hydration flag, OSC liveness, mode (owner/shared/off), msgsReceived, rehydration counter, lastOscAt, and lastSeedAt. " +
    "Use after setting RESOLUME_CACHE=1 (owner) or =shared to verify OSC push is reaching the cache; if msgsReceived stays 0 or oscLive is false, port 7001 is not seeing Resolume traffic. " +
    "Read-only and side-effect-free; safe to call any time. When the cache is disabled, returns `{ enabled: false, mode: \"off\" }`.",
  inputSchema,
  stability: "stable",
  handler: async (_args, ctx) => {
    if (!ctx.store) {
      return jsonResult({ enabled: false, mode: "off" });
    }
    return jsonResult({ enabled: true, ...ctx.store.stats() });
  },
};
