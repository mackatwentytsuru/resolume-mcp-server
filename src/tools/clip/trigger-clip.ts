import { z } from "zod";
import { textResult, type ToolDefinition } from "../types.js";

const inputSchema = {
  layer: z
    .number()
    .int()
    .min(1)
    .max(9999)
    .describe("1-based layer index. Use resolume_get_composition to list valid indices."),
  clip: z
    .number()
    .int()
    .min(1)
    .max(9999)
    .describe("1-based clip (column) index within the layer."),
} as const;

export const triggerClipTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_trigger_clip",
  title: "Trigger clip",
  description:
    "Connects (plays) the clip at the given layer/clip indices. This is the most common VJ action — equivalent to clicking the clip in Resolume. Indices are 1-based. ⚠️ When composition beat-snap is wider than your trigger gap (e.g. snap=1 Bar but you trigger every 500ms), Resolume coalesces overlapping triggers — only the LAST trigger in each snap window connects. Tools cannot detect this; check beat-snap and pace triggers accordingly.",
  inputSchema,
  handler: async ({ layer, clip }, ctx) => {
    await ctx.client.triggerClip(layer, clip);
    return textResult(`Connected clip layer=${layer} clip=${clip}.`);
  },
};
