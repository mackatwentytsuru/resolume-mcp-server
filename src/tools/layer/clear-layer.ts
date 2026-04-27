import { z } from "zod";
import { errorResult, textResult, type ToolDefinition } from "../types.js";

const inputSchema = {
  layer: z
    .number()
    .int()
    .min(1)
    .max(9999)
    .describe("1-based layer index. Use resolume_get_composition to list valid indices."),
  confirm: z
    .boolean()
    .describe(
      "Must be true to confirm the destructive action. Clearing a layer disconnects all clips on it — pass `confirm: true` only when the user has explicitly asked to clear or stop playback."
    ),
} as const;

export const clearLayerTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_clear_layer",
  title: "Clear layer",
  description:
    "Disconnects all clips on the given layer (the layer goes black). DESTRUCTIVE: requires `confirm: true`. Useful for emergency stop or explicit clear.",
  destructive: true,
  inputSchema,
  handler: async ({ layer, confirm }, ctx) => {
    if (!confirm) {
      return errorResult(
        "Refusing to clear layer without confirm=true. Ask the user to confirm before retrying."
      );
    }
    await ctx.client.clearLayer(layer);
    return textResult(`Cleared layer ${layer}.`);
  },
};
