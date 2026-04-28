import { z } from "zod";
import { jsonResult, type ToolDefinition } from "../types.js";

const inputSchema = {
  layer: z
    .number()
    .int()
    .min(1)
    .describe("1-based layer index. Use resolume_get_composition to list valid indices."),
  clip: z
    .number()
    .int()
    .min(1)
    .describe("1-based clip (column) index within the layer."),
} as const;

export const getClipPositionTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_get_clip_position",
  title: "Get clip transport position",
  description:
    "Reads the normalized 0..1 transport position of a connected clip. High-frequency-friendly: when the v0.5 CompositionStore is enabled (RESOLUME_CACHE=1) this returns the cached value pushed by Resolume's OSC OUT broadcast (~325 msg/s aggregate, sub-ms read latency). When the cache is disabled or stale, falls back to a single REST GET on /composition/layers/{layer}/clips/{clip}. The response includes a `source: \"cache\" | \"rest\"` field so callers can tell which path was taken. Returns position=null when the clip slot is empty or never observed.",
  inputSchema,
  stability: "stable",
  handler: async ({ layer, clip }, ctx) => {
    const { value, source } = await ctx.client.getClipPositionFastTagged(layer, clip);
    return jsonResult({
      layer,
      clip,
      position: value,
      source,
    });
  },
};
