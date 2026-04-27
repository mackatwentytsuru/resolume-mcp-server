import { z } from "zod";
import { textResult, type ToolDefinition } from "../types.js";

const inputSchema = {
  layer: z
    .number()
    .int()
    .min(1)
    .max(9999)
    .describe("1-based layer index. Use resolume_get_composition to list valid indices."),
  opacity: z
    .number()
    .min(0)
    .max(1)
    .describe("Opacity in the range 0..1. 0 is fully transparent, 1 is fully opaque."),
} as const;

export const setLayerOpacityTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_set_layer_opacity",
  title: "Set layer opacity",
  description:
    "Fades a layer in or out by setting its master opacity. Use small steps over multiple calls for smooth fades, or a single call for instant changes.",
  inputSchema,
  handler: async ({ layer, opacity }, ctx) => {
    await ctx.client.setLayerOpacity(layer, opacity);
    return textResult(`Set layer ${layer} opacity to ${opacity}.`);
  },
};
