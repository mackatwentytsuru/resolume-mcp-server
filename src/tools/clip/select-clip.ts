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

export const selectClipTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_select_clip",
  title: "Select clip",
  description:
    "Selects the clip in the Resolume UI without playing it. Useful for visual targeting or preparing a clip before triggering. Indices are 1-based.",
  inputSchema,
  handler: async ({ layer, clip }, ctx) => {
    await ctx.client.selectClip(layer, clip);
    return textResult(`Selected clip layer=${layer} clip=${clip}.`);
  },
};
