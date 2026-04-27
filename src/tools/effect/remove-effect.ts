import { z } from "zod";
import { errorResult, textResult, type ToolDefinition } from "../types.js";

const inputSchema = {
  layer: z
    .number()
    .int()
    .min(1)
    .max(9999)
    .describe("1-based layer index."),
  effectIndex: z
    .number()
    .int()
    .min(1)
    .max(99)
    .describe(
      "1-based effect position on the layer. Call resolume_list_layer_effects to enumerate. Index 1 is typically the built-in Transform effect — do not remove it unless the user explicitly asked."
    ),
  confirm: z
    .boolean()
    .describe(
      "Must be true to confirm. Removing an effect is destructive and cannot be undone via the API. Pass true only when the user explicitly asked to remove an effect."
    ),
} as const;

export const removeEffectFromLayerTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_remove_effect_from_layer",
  title: "Remove video effect from layer",
  description:
    "Removes the video effect at the given 1-based position from a layer's effect chain. DESTRUCTIVE: requires `confirm: true`. Call resolume_list_layer_effects first to see what's installed.",
  destructive: true,
  inputSchema,
  handler: async ({ layer, effectIndex, confirm }, ctx) => {
    if (!confirm) {
      return errorResult(
        "Refusing to remove effect without confirm=true. Ask the user to confirm before retrying."
      );
    }
    await ctx.client.removeEffectFromLayer(layer, effectIndex);
    return textResult(
      `Removed effect at index ${effectIndex} from layer ${layer}.`
    );
  },
};
