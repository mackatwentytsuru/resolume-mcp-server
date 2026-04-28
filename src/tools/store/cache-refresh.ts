import { jsonResult, errorResult, type ToolDefinition } from "../types.js";

const inputSchema = {} as const;

export const cacheRefreshTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_cache_refresh",
  title: "Force a full REST re-seed of the CompositionStore",
  description:
    "Forces a full REST seed of the in-memory CompositionStore cache and returns the timing { durationMs, revision }. Use as a recovery hatch after detecting drift — for example, when resolume_cache_status reports oscLive=false or msgsReceived stalled despite Resolume running, or after Resolume itself was restarted. This bumps the snapshot revision regardless of whether anything actually changed. Should NOT be called frequently; the cache normally re-seeds itself on structural drift via debounced background refetches. When RESOLUME_CACHE is unset, returns an error explaining how to enable the cache.",
  inputSchema,
  stability: "stable",
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
