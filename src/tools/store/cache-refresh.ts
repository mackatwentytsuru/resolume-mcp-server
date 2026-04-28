import { jsonResult, errorResult, type ToolDefinition } from "../types.js";

const inputSchema = {} as const;

export const cacheRefreshTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_cache_refresh",
  title: "Force a full REST re-seed of the CompositionStore",
  description:
    "Operator escape hatch — forces a full REST seed of the CompositionStore cache. " +
    "Returns `{ durationMs, revision }` on success, or `{ throttled: true, retryAfterMs }` if called within 500 ms of the last refresh. " +
    "Use only for recovery (after Resolume restart, or when cache_status shows oscLive=false despite Resolume running). The cache normally re-seeds itself on structural drift, so routine use is unnecessary. " +
    "Marked alpha; hidden under default `RESOLUME_TOOLS_STABILITY=beta`.",
  inputSchema,
  stability: "alpha",
  handler: async (_args, ctx) => {
    if (!ctx.store) {
      return errorResult(
        "Cache is disabled. Set RESOLUME_CACHE=1 (owner) or =shared (shared) and restart the server to enable."
      );
    }
    const result = await ctx.store.refresh();
    return jsonResult(result);
  },
};
