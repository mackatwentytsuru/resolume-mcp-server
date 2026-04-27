import { z } from "zod";
import { textResult, type ToolDefinition } from "../types.js";

const inputSchema = {
  layer: z
    .number()
    .int()
    .min(1)
    .max(9999)
    .describe("1-based layer index."),
  bypassed: z
    .boolean()
    .describe("true to mute the layer (skip rendering), false to enable it."),
} as const;

export const setLayerBypassTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_set_layer_bypass",
  title: "Set layer bypass",
  description:
    "Toggles whether a layer is bypassed (muted). Bypassed layers are not rendered. Use this for quick mute/unmute without losing the connected clip.",
  inputSchema,
  handler: async ({ layer, bypassed }, ctx) => {
    await ctx.client.setLayerBypass(layer, bypassed);
    return textResult(`Layer ${layer} bypass = ${bypassed}.`);
  },
};
