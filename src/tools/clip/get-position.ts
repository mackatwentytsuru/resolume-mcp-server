import { jsonResult, type ToolDefinition } from "../types.js";
import { clipIndexSchema, layerIndexSchema } from "../schema-helpers.js";

const inputSchema = {
  layer: layerIndexSchema,
  clip: clipIndexSchema,
} as const;

export const getClipPositionTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_get_clip_position",
  title: "Get clip transport position",
  description:
    "Reads the normalized 0..1 transport position of a connected clip. " +
    "High-frequency-friendly: when the v0.5 CompositionStore is enabled (RESOLUME_CACHE=1) " +
    "this returns the cached value pushed by Resolume's OSC OUT broadcast. " +
    "When the cache is disabled or stale, falls back to a single REST GET on " +
    "/composition/layers/{layer}/clips/{clip}. " +
    "Response includes `source: \"cache\" | \"rest\"`; cache hits also include `ageMs` " +
    "(how stale the cached value was when read) so callers can tune their refresh cadence. " +
    "Returns position=null when the clip slot is empty or never observed.",
  inputSchema,
  stability: "stable",
  handler: async ({ layer, clip }, ctx) => {
    const result = await ctx.client.getClipPositionFastTagged(layer, clip);
    if (result.source === "cache") {
      return jsonResult({
        layer,
        clip,
        position: result.value,
        source: "cache",
        ageMs: result.ageMs,
      });
    }
    return jsonResult({
      layer,
      clip,
      position: result.value,
      source: "rest",
    });
  },
};
